// 原型本地服务：把设备清单存成同目录的 设备清单.json，页面上的编辑实时写回这个文件。
// 零依赖，node 22 直接跑；只监听 127.0.0.1。
//   node serve.mjs            → http://127.0.0.1:8123/monitor-wall.html
// 为什么要有它：file:// 下浏览器不能写盘，"编辑同步修改配置文件"必须走一次本地 HTTP。
import { createServer } from "node:http";
import { readFile, writeFile, rename, appendFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const FILE = path.join(DIR, "设备清单.json");
const PORT = Number(process.env.PORT || 8123);
const MAX_BYTES = 64 * 1024;
const TIERS = new Set(["laptop", "matx", "atx", "eatx", "itx", "nas", "switch", "router"]);

// 三台网络设备没有屏幕，os 那一格对它们不起作用，填 linux 只是别让下拉显示"Windows"那么别扭
const DEFAULTS = [
  { name: "笔记本", tier: "laptop", power: true, os: "win", host: "", user: "", pass: "" },
  { name: "ITX", tier: "itx", power: true, os: "win", host: "", user: "", pass: "" },
  { name: "mATX", tier: "matx", power: true, os: "win", host: "", user: "", pass: "" },
  { name: "ATX", tier: "atx", power: true, os: "win", host: "", user: "", pass: "" },
  { name: "E-ATX", tier: "eatx", power: true, os: "win", host: "", user: "", pass: "" },
  { name: "NAS", tier: "nas", power: true, os: "linux", host: "", user: "", pass: "" },
  { name: "交换机", tier: "switch", power: true, os: "linux", host: "", user: "", pass: "" },
  { name: "路由器", tier: "router", power: true, os: "linux", host: "", user: "", pass: "" },
];

// 只认这七个字段，字符串截断、布尔归一，档位不在表里就退回 mATX——配置文件被人手改过也不能把页面搞崩
// ⚠ pass 是明文口令：2026-09-23 你明确说"可以先写进配置文件"，所以这里收 pass 字段。
//    这个文件因此变成敏感文件：不要拷进仓库、不要进分享包、不要截图外传。
function normalize(list) {
  if (!Array.isArray(list)) return null;
  const out = [];
  for (const it of list.slice(0, 32)) {
    if (!it || typeof it !== "object") continue;
    const s = (v, n) => (typeof v === "string" ? v.slice(0, n) : "");
    out.push({
      name: s(it.name, 24) || "(未命名)",
      tier: TIERS.has(it.tier) ? it.tier : "matx",
      power: it.power !== false,
      os: s(it.os, 8) === "linux" ? "linux" : "win",
      host: s(it.host, 64),
      user: s(it.user, 32),
      pass: s(it.pass, 64),
    });
  }
  return out.length ? out : null;
}

async function load() {
  if (!existsSync(FILE)) {
    await save(DEFAULTS);
    return { source: "seeded", list: DEFAULTS };
  }
  try {
    const parsed = normalize(JSON.parse(await readFile(FILE, "utf8")));
    if (!parsed) return { source: "invalid-fallback", list: DEFAULTS };
    return { source: "file", list: parsed };
  } catch (e) {
    return { source: "unreadable-fallback", list: DEFAULTS };
  }
}

// 先写临时文件再改名：中途崩溃不会留下半个 JSON
async function save(list) {
  const tmp = FILE + ".tmp";
  await writeFile(tmp, JSON.stringify(list, null, 2) + "\n", "utf8");
  await rename(tmp, FILE);
}

function send(res, code, body, type = "application/json; charset=utf-8") {
  res.writeHead(code, { "content-type": type, "cache-control": "no-store" });
  res.end(body);
}

// ---------- 连通性 / 抓一帧 ----------
// 凭据存在 设备清单.json 里（你 2026-09-23 同意的），本文件不写死任何凭据；
// 每次探测只把页面传来的这三个值用一次：不进日志、不进响应体、不回显给调用方。
// 传输层已装好（npm i ssh2）；没装的话每条请求会明确报"未安装"，方便换机复现。
const PROBE_SH = [
  "echo HOST=$(hostname)",
  'echo OS=$(. /etc/os-release 2>/dev/null && echo $PRETTY_NAME || uname -s)',
  "echo CORES=$(nproc)",
  "echo MEM=$(free -m | awk '/^Mem:/{print $2\",\"$3}')",
  "echo LOAD=$(awk '{print $1}' /proc/loadavg)",
  "echo DISK=$(df -B1 -P / | awk 'NR==2{print $2\",\"$3}')",
  "echo GPU=$(command -v nvidia-smi >/dev/null && nvidia-smi --query-gpu=utilization.gpu,memory.total,memory.used,temperature.gpu --format=csv,noheader,nounits 2>/dev/null | head -1 || echo none)",
].join("; ");

let ssh2mod = null;
try { ssh2mod = await import("ssh2"); } catch { /* 没装就是没装，下面会报出来 */ }

// 探测审计：只记时间 + 目标主机 + 成败 + 错误首行，绝不记用户名/口令。
// 有了它，"有没有偷偷连过某台机器"是可以在磁盘上查证的，不用凭印象说。
const LOG = path.join(DIR, "探测记录.log");
async function logProbe(host, ok, msg) {
  try {
    await appendFile(LOG, new Date().toISOString() + "  " + (ok ? "OK  " : "FAIL") + "  " + host + (msg ? "  " + String(msg).split("\n")[0].slice(0, 120) : "") + "\n");
  } catch { /* 日志写不进不影响主流程 */ }
}

// 只允许本机页面调：挡掉别的网站往这个端口上打
function sameOrigin(req) {
  const o = req.headers.origin;
  return !o || /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(o);
}

function probe({ host, user, pass }) {
  return new Promise((resolve) => {
    if (!ssh2mod) return resolve({ ok: false, error: "本机未安装 ssh2（在 素材 目录跑 npm i ssh2 后重启 serve.mjs）" });
    if (!host || !user) return resolve({ ok: false, error: "地址或用户名为空" });
    const conn = new ssh2mod.Client();
    const timer = setTimeout(() => { conn.end(); resolve({ ok: false, error: "连接超时（8s）" }); }, 8000);
    const fail = (msg) => { clearTimeout(timer); conn.end(); resolve({ ok: false, error: String(msg).slice(0, 200) }); };
    conn.on("ready", () => {
      conn.exec(PROBE_SH, { pty: false }, (err, stream) => {
        if (err) return fail(err.message);
        let out = "";
        stream.on("data", (c) => { out += c; });
        stream.stderr.on("data", () => {});
        stream.on("close", () => {
          clearTimeout(timer);
          conn.end();
          const kv = Object.fromEntries(out.split("\n").filter(Boolean).map((l) => {
            const i = l.indexOf("=");
            return [l.slice(0, i), l.slice(i + 1).trim()];
          }));
          const pair = (s) => (s || "").split(",").map(Number);
          const [memTotal, memUsed] = pair(kv.MEM);
          const [diskTotal, diskUsed] = pair(kv.DISK);
          const gpu = kv.GPU && kv.GPU !== "none" ? kv.GPU.split(",").map(Number) : null;
          resolve({ ok: true, frame: {
            hostname: kv.HOST || "", os: kv.OS || "", cores: Number(kv.CORES) || 0,
            load1: Number(kv.LOAD) || 0, memTotalMb: memTotal || 0, memUsedMb: memUsed || 0,
            diskTotalBytes: diskTotal || 0, diskUsedBytes: diskUsed || 0,
            gpu: gpu ? { util: gpu[0], memTotalMb: gpu[1], memUsedMb: gpu[2], temp: gpu[3] } : null,
            at: new Date().toISOString(),
          } });
        });
      });
    });
    conn.on("error", (e) => fail(e.message));
    conn.connect({ host, username: user, password: pass, readyTimeout: 8000, algorithms: { kex: ["ecdh-sha2-nistp256", "curve25519-sha256"] } });
  });
}

const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8", ".json": "application/json; charset=utf-8",
  ".css": "text/css; charset=utf-8" };

createServer(async (req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  if (url.pathname === "/api/probe") {
    if (!sameOrigin(req)) return send(res, 403, JSON.stringify({ ok: false, error: "来源不是本机" }));
    if (req.method !== "POST") return send(res, 405, JSON.stringify({ ok: false, error: "只支持 POST" }));
    let raw = "";
    req.on("data", (c) => { raw += c; if (raw.length > 4096) req.destroy(); });
    req.on("end", async () => {
      let body = {};
      try { body = JSON.parse(raw); } catch { return send(res, 400, JSON.stringify({ ok: false, error: "请求体不是 JSON" })); }
      // 这条 try/catch 是必需的：以前 probe 里一个笔误（ssh2 未定义）在 Promise 里抛出，
      // 变成 unhandled rejection → 整个服务被自己带崩，页面只看到一个断掉的连接
      let r;
      try { r = await probe({ host: String(body.host || ""), user: String(body.user || ""), pass: String(body.pass || "") }); }
      catch (e) { r = { ok: false, error: "服务内部错误：" + String((e && e.message) || e) }; }
      logProbe(String(body.host || "?"), r.ok, r.ok ? "" : r.error);
      send(res, r.ok ? 200 : 502, JSON.stringify(r));
    });
    return;
  }
  if (url.pathname === "/api/devices") {
    if (req.method === "GET") {
      const { source, list } = await load();
      return send(res, 200, JSON.stringify({ list, source }));
    }
    if (req.method === "PUT") {
      let raw = "";
      req.on("data", (c) => { raw += c; if (raw.length > MAX_BYTES) req.destroy(); });
      req.on("end", async () => {
        try {
          const list = normalize(JSON.parse(raw).list);
          if (!list) return send(res, 400, JSON.stringify({ error: "清单为空或格式不对" }));
          await save(list);
          send(res, 200, JSON.stringify({ ok: true, count: list.length }));
        } catch (e) {
          send(res, 400, JSON.stringify({ error: String(e.message || e) }));
        }
      });
      return;
    }
    return send(res, 405, JSON.stringify({ error: "只支持 GET / PUT" }));
  }

  if (req.method !== "GET") return send(res, 405, JSON.stringify({ error: "只支持 GET" }));
  // 目录穿越防护：解出来必须还在本目录内
  const rel = decodeURIComponent(url.pathname === "/" ? "monitor-wall.html" : url.pathname.slice(1));
  const abs = path.resolve(DIR, rel);
  if (abs !== DIR && !abs.startsWith(DIR + path.sep)) return send(res, 403, "forbidden", "text/plain");
  try {
    const buf = await readFile(abs);
    send(res, 200, buf, TYPES[path.extname(abs).toLowerCase()] || "application/octet-stream");
  } catch {
    send(res, 404, "not found", "text/plain");
  }
}).listen(PORT, "127.0.0.1", () => {
  console.log(`原型服务已起：http://127.0.0.1:${PORT}/monitor-wall.html`);
  console.log(`设备清单文件：${FILE}（页面编辑会写回这里；只监听 127.0.0.1）`);
});
