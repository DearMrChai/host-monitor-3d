// 原型本地服务：把设备清单存成同目录的 设备清单.json、分区表存成 分区.json、设置存成 设置.json，
// 页面上的编辑实时写回这三个文件。零依赖，node 22 直接跑；只监听 127.0.0.1。
//   node serve.mjs            → http://127.0.0.1:8123/monitor-wall.html
// 为什么要有它：file:// 下浏览器不能写盘，"编辑同步修改配置文件"必须走一次本地 HTTP。
import { createServer } from "node:http";
import { readFile, writeFile, rename, appendFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const FILE = path.join(DIR, "设备清单.json");
const ZFILE = path.join(DIR, "分区.json");
const SFILE = path.join(DIR, "设置.json");
const PORT = Number(process.env.PORT || 8123);
const MAX_BYTES = 64 * 1024;
const TIERS = new Set(["laptop", "matx", "atx", "eatx", "itx", "nas", "switch", "router"]);
// zone 留空 = 页面按档位自动落区，所以默认清单里全是空串。
// 分区不再是固定那四个（2026-09-23）：设备上这一格只校验"长得像 key"，至于有没有这个区，
// 由页面按 分区.json 自己判。这里写死名单的话，页面里新建的分区一落盘就被服端清成空串。
const ZONE_KEY = /^[a-z0-9_-]{1,24}$/;
const ZONE_MAX = 9;

// 三台网络设备没有屏幕，os 那一格对它们不起作用，填 linux 只是别让下拉显示"Windows"那么别扭
const DEFAULTS = [
  { name: "笔记本", tier: "laptop", zone: "", power: true, os: "win", host: "", user: "", pass: "" },
  { name: "ITX", tier: "itx", zone: "", power: true, os: "win", host: "", user: "", pass: "" },
  { name: "mATX", tier: "matx", zone: "", power: true, os: "win", host: "", user: "", pass: "" },
  { name: "ATX", tier: "atx", zone: "", power: true, os: "win", host: "", user: "", pass: "" },
  { name: "E-ATX", tier: "eatx", zone: "", power: true, os: "win", host: "", user: "", pass: "" },
  { name: "NAS", tier: "nas", zone: "", power: true, os: "linux", host: "", user: "", pass: "" },
  { name: "交换机", tier: "switch", zone: "", power: true, os: "linux", host: "", user: "", pass: "" },
  { name: "路由器", tier: "router", zone: "", power: true, os: "linux", host: "", user: "", pass: "" },
];

// 只认这八个字段，字符串截断、布尔归一，档位不在表里就退回 mATX——配置文件被人手改过也不能把页面搞崩
// ⚠ pass 是明文口令：2026-09-23 你明确说"可以先写进配置文件"，所以这里收 pass 字段。
//    这个文件因此变成敏感文件：不要拷进仓库、不要进分享包、不要截图外传。
function normalize(list) {
  if (!Array.isArray(list)) return null;
  const out = [];
  for (const it of list.slice(0, 32)) {
    if (!it || typeof it !== "object") continue;
    const s = (v, n) => (typeof v === "string" ? v.slice(0, n) : "");
    const zone = s(it.zone, 24);
    out.push({
      name: s(it.name, 24) || "(未命名)",
      tier: TIERS.has(it.tier) ? it.tier : "matx",
      zone: ZONE_KEY.test(zone) ? zone : "",
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
    await save(FILE, DEFAULTS);
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

// 分区表：服务端不预置内容（"默认四个区摆在哪"是页面的事，两处各写一份必然走散）。
// 文件还没生成过就回 { list: null }，页面保持它内置的默认摆位，改一次才生成本文件。
function normalizeZones(list) {
  if (!Array.isArray(list)) return null;
  const out = [];
  const seen = new Set();
  for (const it of list.slice(0, ZONE_MAX)) {
    if (!it || typeof it !== "object") continue;
    const key = typeof it.key === "string" ? it.key.slice(0, 24) : "";
    const cn = typeof it.cn === "string" ? it.cn.slice(0, 12) : "";
    const at = Array.isArray(it.at) ? it.at : [];
    const x = Number(at[0]), z = Number(at[1]);
    if (!ZONE_KEY.test(key) || seen.has(key)) continue;
    if (!Number.isFinite(x) || !Number.isFinite(z)) continue;
    if (Math.abs(x) > 100000 || Math.abs(z) > 100000) continue;   // 手改文件写个天文数字，页面全景会退到看不见
    seen.add(key);
    out.push({ key, cn: cn || ("分区 " + (out.length + 1)), at: [Math.round(x), Math.round(z)] });
  }
  return out.length ? out : null;
}
async function loadZones() {
  if (!existsSync(ZFILE)) return { source: "none", list: null };
  try {
    const parsed = normalizeZones(JSON.parse(await readFile(ZFILE, "utf8")));
    if (!parsed) return { source: "invalid", list: null };
    return { source: "file", list: parsed };
  } catch (e) {
    return { source: "unreadable", list: null };
  }
}

// 设置文件（设置弹窗里那几项）：三组，键名跟页面代码里用的名字一模一样 —— 不另起一套中文键，
// 多一层映射就多一处会走散的地方。
// 范围（哪一格 0.02~1、哪一格 200~5000）**不在服务端再抄一份**：那张真表是页面的
// PULSE_LIMITS / MON_LIMITS。这里只保"形状对、类型对"，越界值由页面钳回、再把钳过的结果写回来，
// 于是文件里躺的永远是"实际生效值"，人改文件时也能一眼看到自己写的值有没有被收掉。
// 顶层带 "_" 的字符串键（现在只有 _说明）是给人读的：磁盘上有就原样带走，没有就补 SET_NOTE 那一句。
const SET_SHAPE = {
  pulse: { enabled: "bool", pulseStartBrightness: "num", pulseEndBrightness: "num",
    upParticleBrightness: "num", travelK: "num" },
  ground: { rippleEnabled: "bool", rippleHeight: "num", rippleSpeed: "num",
    rippleThickness: "num", rippleBrightness: "num", rainEnabled: "bool", rainBrightness: "num" },
  monitor: { intervalMs: "num" },
};
// 文件第一行那句人话。放在服务端而不是页面里：整份删掉重建时也得有人写这一句，
// 否则"删了再打开"生出来的就是一份没有说明的裸 JSON。（页面只管值，不管文件长什么样。）
const SET_NOTE = "看板设置：pulse=脉冲 / ground=地面与雨 / monitor=采集频率。改这个文件即改看板，页面上每 5 秒自己读一次（不用刷新、不用碰那台机器的浏览器）；在页面里拖滑块/点开关也会写回这里。每一格的合法范围由页面把关，写了越界的值会被自动收进范围内、并把这个文件改写成实际生效值。三组少了哪一组就整组保持默认；整份删掉，下次打开页面会按默认值重新生成一份。";
function normalizeSettings(obj) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return null;
  const settings = {};
  let seen = 0;
  for (const g in SET_SHAPE) {
    const src = obj[g] && typeof obj[g] === "object" ? obj[g] : {};
    const out = {};
    for (const k in SET_SHAPE[g]) {
      const v = src[k];
      if (SET_SHAPE[g][k] === "bool") {
        if (typeof v === "boolean") { out[k] = v; seen++; }
      } else if (typeof v === "number" && Number.isFinite(v)) { out[k] = v; seen++; }
    }
    settings[g] = out;
  }
  if (!seen) return null;   // 三组一个认得的键都没有 = 这不是设置文件，别拿它去盖掉磁盘上的
  const extra = {};
  for (const k of Object.keys(obj)) if (k.startsWith("_") && typeof obj[k] === "string") extra[k] = obj[k].slice(0, 500);
  return { settings, extra };
}
// 文件还没生成过就回 { settings: null }，页面拿自己那套默认值写第一份（"部署后有个能改的东西"）。
// 文件存在但内容坏了（被手改残）同样回 null，页面会把生效值写回去 —— 坏文件不该一直坏着。
async function loadSettings() {
  if (!existsSync(SFILE)) return { source: "none", settings: null };
  try {
    const parsed = normalizeSettings(JSON.parse(await readFile(SFILE, "utf8")));
    if (!parsed) return { source: "invalid", settings: null };
    return { source: "file", settings: parsed.settings };
  } catch (e) {
    return { source: "unreadable", settings: null };
  }
}
async function saveSettings(settings, extra) {
  // 磁盘上原有的 _说明 原样带走（人改过那句话就照他改的）；文件不存在或没这句话，就补服务端这一份。
  let head = extra && Object.keys(extra).length ? Object.assign({}, extra) : {};
  if (!Object.keys(head).length) {
    try {
      const cur = JSON.parse(await readFile(SFILE, "utf8"));
      for (const k of Object.keys(cur)) if (k.startsWith("_") && typeof cur[k] === "string") head[k] = cur[k].slice(0, 500);
    } catch { /* 文件还不存在 */ }
  }
  if (!head._说明) head._说明 = SET_NOTE;
  // head 先放进去，_说明 才会排在文件最上面
  await save(SFILE, Object.assign(head, settings));
}

// 先写临时文件再改名：中途崩溃不会留下半个 JSON
async function save(file, list) {
  const tmp = file + ".tmp";
  await writeFile(tmp, JSON.stringify(list, null, 2) + "\n", "utf8");
  await rename(tmp, file);
}

function send(res, code, body, type = "application/json; charset=utf-8") {
  res.writeHead(code, { "content-type": type, "cache-control": "no-store" });
  res.end(body);
}

// ---------- 连通性 / 抓一帧 ----------
// 凭据存在 设备清单.json 里（你 2026-09-23 同意的），本文件不写死任何凭据；
// 每次探测只把页面传来的这几个值用一次：不进日志、不进响应体、不回显给调用方。
// 传输层已装好（npm i ssh2）；没装的话每条请求会明确报"未安装"，方便换机复现。
//
// 两种系统两套抓法（2026-09-23 加 win 分支：设备清单里的 os 那一格决定走哪条）：
//   linux → 一条 sh 命令拼起来（POSIX 工具齐全）
//   win   → Windows 的 OpenSSH 远端 shell 是 cmd.exe：带引号的 PowerShell 语句在 cmd 里会被
//           折腾得不成样子，所以整段脚本按 UTF-16LE 编码成 base64、用 -EncodedCommand 递进去
//           （命令行上只剩 A-Za-z0-9+/= 这些 cmd 不认识的特殊字符，引号地狱一次性绕开）。
//           数据取自 CIM（Win32_OperatingSystem / Win32_Processor / Win32_LogicalDisk）。
// 两边都输出同一套 KEY=value 行，再由下面同一段解析变成 frame。
const PROBE_SH = [
  "echo HOST=$(hostname)",
  'echo OS=$(. /etc/os-release 2>/dev/null && echo $PRETTY_NAME || uname -s)',
  "echo CORES=$(nproc)",
  "echo MEM=$(free -m | awk '/^Mem:/{print $2\",\"$3}')",
  "echo LOAD=$(awk '{print $1}' /proc/loadavg)",
  "echo DISK=$(df -B1 -P / | awk 'NR==2{print $2\",\"$3}')",
  "echo GPU=$(command -v nvidia-smi >/dev/null && nvidia-smi --query-gpu=utilization.gpu,memory.total,memory.used,temperature.gpu --format=csv,noheader,nounits 2>/dev/null | head -1 || echo none)",
].join("; ");

// LOAD 这一格两边含义不同：
//   linux 是 /proc/loadavg 的 1 分钟均值（负载，不直接是占用率），页面按 负载 ÷ 核数 × 100 换算；
//   win   没有负载均值可用，CIM 只给 LoadPercentage（就是占用率百分比）。
// 于是 win 这行输出的是"把占用率折成等效负载"（pct × 核数 ÷ 100），页面那条老公式照样成立，
// 同时又额外报一个 CPU= 真占用率，让"连通性测试"那几行显示的是百分比而不是一个假装的负载值。
const PROBE_PS = [
  // 这两行都不是装饰：英文名以下的系统名（"Microsoft Windows 10 企业版 LTSC"）走的是本机代码页，
  // 不按 UTF-8 出来，Node 那边读到的就是一堆乱码；$ProgressPreference 是为了别把进度条
  // 以 CLIXML 的形式糊到 stderr 上（不影响解析，但日志会难看得像出了错）。
  "[Console]::OutputEncoding=[Text.Encoding]::UTF8",
  "$ProgressPreference='SilentlyContinue'",
  "$ci=[System.Globalization.CultureInfo]::InvariantCulture",
  "$os=Get-CimInstance Win32_OperatingSystem -ErrorAction SilentlyContinue",
  "$cpu=@(Get-CimInstance Win32_Processor -ErrorAction SilentlyContinue)",
  "$cores=($cpu|Measure-Object -Property NumberOfCores -Sum).Sum",
  "$pct=($cpu|Measure-Object -Property LoadPercentage -Average).Average",
  '$dk=Get-CimInstance Win32_LogicalDisk -Filter "DeviceID=\'C:\'" -ErrorAction SilentlyContinue',
  "$gpu='none'",
  "if(Get-Command nvidia-smi -ErrorAction SilentlyContinue){$g=& nvidia-smi --query-gpu=utilization.gpu,memory.total,memory.used,temperature.gpu --format=csv,noheader,nounits 2>$null|Select-Object -First 1; if($g){$gpu=[string]$g}}",
  "Write-Output ('HOST='+$env:COMPUTERNAME)",
  "Write-Output ('OS='+$os.Caption)",
  "Write-Output ('CORES='+$cores)",
  "Write-Output ('MEM='+[math]::Round($os.TotalVisibleMemorySize/1024).ToString($ci)+','+[math]::Round(($os.TotalVisibleMemorySize-$os.FreePhysicalMemory)/1024).ToString($ci))",
  "Write-Output ('CPU='+[math]::Round($pct,0).ToString($ci))",
  "Write-Output ('LOAD='+[math]::Round($pct*$cores/100,2).ToString($ci))",
  "Write-Output ('DISK='+[string]$dk.Size+','+[string]($dk.Size-$dk.FreeSpace))",
  "Write-Output ('GPU='+$gpu)",
].join("; ");
const PROBE_PS_CMD = "powershell -NoProfile -ExecutionPolicy Bypass -EncodedCommand "
  + Buffer.from(PROBE_PS, "utf16le").toString("base64");

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

// 口令可以为空：办公那几台 Windows 是"账号 user、不设密码"，空口令是它们的正常配置，
// 不是"没填全"。所以这道门只看地址和用户名（linux 那几台口令不对的话，下面会如实报失败）。
function probe({ host, user, pass, os }) {
  return new Promise((resolve) => {
    if (!ssh2mod) return resolve({ ok: false, error: "本机未安装 ssh2（在项目目录跑 npm i ssh2 后重启 serve.mjs）" });
    if (!host || !user) return resolve({ ok: false, error: "地址或用户名为空" });
    // 只认准 "win" 两个字：别的（含没传）一律按 linux 那条老路子走，跟加这个分支之前一样
    const win = os === "win";
    // Windows 上 PowerShell 冷启动就要好几秒（实测 138 首次 5.4 s），8 s 那道线会把正常的连接掐掉
    const budget = win ? 25000 : 8000;
    const conn = new ssh2mod.Client();
    const timer = setTimeout(() => { conn.end(); resolve({ ok: false, error: "连接超时（" + Math.round(budget / 1000) + "s）" }); }, budget);
    const fail = (msg) => { clearTimeout(timer); conn.end(); resolve({ ok: false, error: String(msg).slice(0, 200) }); };
    conn.on("ready", () => {
      conn.exec(win ? PROBE_PS_CMD : PROBE_SH, { pty: false }, (err, stream) => {
        if (err) return fail(err.message);
        let out = "";
        stream.on("data", (c) => { out += c; });
        stream.stderr.on("data", () => {});
        stream.on("close", () => {
          clearTimeout(timer);
          conn.end();
          const kv = Object.fromEntries(out.split("\n").map((l) => l.trim()).filter(Boolean).map((l) => {
            const i = l.indexOf("=");
            return i < 0 ? [l, ""] : [l.slice(0, i), l.slice(i + 1).trim()];
          }));
          const pair = (s) => (s || "").split(",").map(Number);
          const [memTotal, memUsed] = pair(kv.MEM);
          const [diskTotal, diskUsed] = pair(kv.DISK);
          const gpu = kv.GPU && kv.GPU !== "none" ? kv.GPU.split(",").map(Number) : null;
          const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
          resolve({ ok: true, frame: {
            hostname: kv.HOST || "", os: kv.OS || "", cores: num(kv.CORES),
            load1: num(kv.LOAD),
            // 只有 Windows 报这个（CIM 给的占用率）。linux 那一栏是 null，页面按负载均值换算。
            cpuPct: kv.CPU === undefined ? null : Math.min(100, Math.max(0, num(kv.CPU))),
            memTotalMb: memTotal || 0, memUsedMb: memUsed || 0,
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
      try { r = await probe({ host: String(body.host || ""), user: String(body.user || ""),
        pass: String(body.pass || ""), os: String(body.os || "") }); }
      catch (e) { r = { ok: false, error: "服务内部错误：" + String((e && e.message) || e) }; }
      logProbe(String(body.host || "?"), r.ok, r.ok ? "" : r.error);
      // 抓不到也回 200：HTTP 这一层是成功的（请求到了、连也试过了），成败在 ok 那一格上。
      // 用 502 的话浏览器控制台会替每一台抓不到的机器记一条红色错误 —— 页面打开时本来就对
      // 每台填了地址的机器各抓一帧，看板机一开机就是几行红的，看着像坏了。
      send(res, 200, JSON.stringify(r));
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
          await save(FILE, list);
          send(res, 200, JSON.stringify({ ok: true, count: list.length }));
        } catch (e) {
          send(res, 400, JSON.stringify({ error: String(e.message || e) }));
        }
      });
      return;
    }
    return send(res, 405, JSON.stringify({ error: "只支持 GET / PUT" }));
  }
  // 分区表（页面"分区设置"那一格）：独立文件、独立端点，改分区不碰设备清单
  if (url.pathname === "/api/zones") {
    if (req.method === "GET") {
      const { source, list } = await loadZones();
      return send(res, 200, JSON.stringify({ list, source }));
    }
    if (req.method === "PUT") {
      let raw = "";
      req.on("data", (c) => { raw += c; if (raw.length > MAX_BYTES) req.destroy(); });
      req.on("end", async () => {
        try {
          const list = normalizeZones(JSON.parse(raw).list);
          if (!list) return send(res, 400, JSON.stringify({ error: "分区表为空或格式不对" }));
          await save(ZFILE, list);
          send(res, 200, JSON.stringify({ ok: true, count: list.length }));
        } catch (e) {
          send(res, 400, JSON.stringify({ error: String(e.message || e) }));
        }
      });
      return;
    }
    return send(res, 405, JSON.stringify({ error: "只支持 GET / PUT" }));
  }
  // 设置（"设置"弹窗里那几项：脉冲 / 地面与雨 / 采集频率）：也是独立文件、独立端点。
  // 双向：页面启动读它、拖滑块写回它；部署成看板后直接改这个 json，页面每 5 秒自己读一次。
  if (url.pathname === "/api/settings") {
    if (req.method === "GET") {
      const { source, settings } = await loadSettings();
      return send(res, 200, JSON.stringify({ settings, source }));
    }
    if (req.method === "PUT") {
      let raw = "";
      req.on("data", (c) => { raw += c; if (raw.length > MAX_BYTES) req.destroy(); });
      req.on("end", async () => {
        try {
          const parsed = normalizeSettings(JSON.parse(raw).settings);
          if (!parsed) return send(res, 400, JSON.stringify({ error: "设置内容为空或格式不对" }));
          await saveSettings(parsed.settings, parsed.extra);
          send(res, 200, JSON.stringify({ ok: true }));
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
  console.log(`分区文件：${ZFILE}`);
  console.log(`设置文件：${SFILE}（改它即改看板，页面每 5 秒读一次；页面里改也写回它）`);
});
