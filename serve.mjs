// 原型本地服务：把设备清单存成同目录的 devices.json、分区表存成 zones.json、设置存成 settings.json，
// 页面上的编辑实时写回这三个文件。零依赖，node 22 直接跑。
//   node serve.mjs            → http://127.0.0.1:8123/monitor-wall.html
//   HM_BIND=0.0.0.0 HM_OWNER=10.226.127.14 node serve.mjs
//        → 同网段 / ZeroTier 组内谁都能打开这块墙（只读），只有 HM_OWNER 里那几台能进设置、改清单、点"抓一帧"
//   HM_ALLOW=10.226.127.14,10.226.127.52 → 想连"看"也收到名单上时再加（不给 = 谁连得上谁就能看）
// 为什么要有它：file:// 下浏览器不能写盘，"编辑同步修改配置文件"必须走一次本地 HTTP。
import { createServer } from "node:http";
import { readFile, writeFile, rename, appendFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const FILE = path.join(DIR, "devices.json");
const ZFILE = path.join(DIR, "zones.json");
const SFILE = path.join(DIR, "settings.json");
const PORT = Number(process.env.PORT || 8123);
// 默认只认环回：这块墙看得见设备清单里的明文口令，别顺手把它摊到网段上。
// 要敞开时（比如那台机器自己没屏幕）用 HM_BIND 指定，并且**必须**同时用防火墙把来源收到信得过的
// 那几台机器上 —— 这个服务不做鉴权，能连上的人就等于能读走整份清单、也能借它往任意主机打 SSH。
const BIND = process.env.HM_BIND || "127.0.0.1";
const LOOPBACK = BIND === "127.0.0.1" || BIND === "localhost" || BIND === "::1";
// 两扇门（2026-09-24 用户裁的"乙"：组内都能看，只有配在程序里的那几台能改）：
//   看 = 打开墙 + 读脱敏清单 /api/hosts + 读帧缓存 /api/frames；闸门是 HM_ALLOW（不给 = 谁连得上谁都能看）。
//   改 = 写三个 json + 那份带明文口令的 /api/devices + 借道 SSH（POST /api/probe）；闸门是 HM_OWNER。
// 为什么这道检查必须在服务里做、不能只靠防火墙：138 那台的 Windows 防火墙三个 profile 全是关的
// （实测 Enabled=False），规则加上去也不会挡谁。
// ⚠ 口令这一维从来不是"来源对不对"能保住的东西：整份清单（含明文 pass）原本谁连得上谁就读得走，
//   所以放开"看"之前先把那条口子换成 /api/hosts（剥掉 user/pass，只留一个派生的 live）。
const ALLOW = (process.env.HM_ALLOW || "").split(",").map((s) => s.trim()).filter(Boolean);
// HM_OWNER 没给时退回吃 HM_ALLOW（老那行 `HM_BIND=0.0.0.0 HM_ALLOW=10.226.14` 的语义 = 那台既是观众也是主人，
// 升级这天不会出现"谁能看却没人能改"把他锁在自己墙外面）。两个都没给 = 只有环回能改（开发机就是这一档）。
const OWNER = (process.env.HM_OWNER !== undefined ? process.env.HM_OWNER : process.env.HM_ALLOW || "")
  .split(",").map((s) => s.trim()).filter(Boolean);
// 抓机器除了口令还可以认一把私钥：HM_SSH_KEY 指一个私钥文件路径。为什么需要它：14（笔记本）那台
// 账号始终无密码，而它的 sshd 又写着 PasswordAuthentication no —— 只有口令这一条路时，连"试"都试不到，
// 服务端直接回 All configured authentication methods failed。
// 只在启动时读一次；读不到就在启动日志里点名报出来，不像"静默退回口令"那样把配置错吞掉。
const SSH_KEY_FILE = process.env.HM_SSH_KEY || "";
let SSH_KEY = null;
let SSH_KEY_NOTE = "没配 HM_SSH_KEY：只有口令可试";
if (SSH_KEY_FILE) {
  try { SSH_KEY = readFileSync(SSH_KEY_FILE, "utf8"); SSH_KEY_NOTE = "已载入私钥 " + SSH_KEY_FILE; }
  catch (e) { SSH_KEY_NOTE = "⚠ HM_SSH_KEY 指的私钥读不到：" + SSH_KEY_FILE + "（" + (e.code || e.message) + "）⇒ 这台仍只能试口令"; }
}
// 两扇门都按 TCP 那一端的地址认（不是 X-Forwarded-For：本站没有反代，信头里的来源可以瞎写）。
function peerOf(req) {
  return String(req.socket.remoteAddress || "").replace(/^::ffff:/, "");
}
const loopOf = (ip) => ip === "127.0.0.1" || ip === "::1";
// 能不能连上这块墙（看）。名单没给 = 放开：138 现在就是这么摆给组内朋友看的。
function fromAllowed(req) {
  if (!ALLOW.length) return true;
  const ip = peerOf(req);
  return loopOf(ip) || ALLOW.includes(ip);
}
// 能不能改（含"借这台机器去敲别人的 SSH"）。环回永远是主人：本机 node serve.mjs 什么名单都不给也得能干活。
function fromOwner(req) {
  const ip = peerOf(req);
  return loopOf(ip) || OWNER.includes(ip);
}
const MAX_BYTES = 64 * 1024;
const TIERS = new Set(["laptop", "matx", "atx", "eatx", "itx", "nas", "switch", "router"]);
// zone 留空 = 页面按档位自动落区，所以默认清单里全是空串。
// 分区不再是固定那四个（2026-09-23）：设备上这一格只校验"长得像 key"，至于有没有这个区，
// 由页面按 zones.json 自己判。这里写死名单的话，页面里新建的分区一落盘就被服端清成空串。
const ZONE_KEY = /^[a-z0-9_-]{1,24}$/;
const ZONE_MAX = 9;

// 三台网络设备没有屏幕，os 那一格对它们不起作用，填 linux 只是别让下拉显示"Windows"那么别扭
const DEFAULTS = [
  { name: "笔记本", tier: "laptop", zone: "", power: true, hidden: false, os: "win", host: "", user: "", pass: "" },
  { name: "ITX", tier: "itx", zone: "", power: true, hidden: false, os: "win", host: "", user: "", pass: "" },
  { name: "mATX", tier: "matx", zone: "", power: true, hidden: false, os: "win", host: "", user: "", pass: "" },
  { name: "ATX", tier: "atx", zone: "", power: true, hidden: false, os: "win", host: "", user: "", pass: "" },
  { name: "E-ATX", tier: "eatx", zone: "", power: true, hidden: false, os: "win", host: "", user: "", pass: "" },
  { name: "NAS", tier: "nas", zone: "", power: true, hidden: false, os: "linux", host: "", user: "", pass: "" },
  { name: "交换机", tier: "switch", zone: "", power: true, hidden: false, os: "linux", host: "", user: "", pass: "" },
  { name: "路由器", tier: "router", zone: "", power: true, hidden: false, os: "linux", host: "", user: "", pass: "" },
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
      // 新需求 2（设备可隐藏）：藏起来 = 场景里不摆、列表里不占格、开机不抓帧；文件里留着这一行，
      // 想放出来把 true 改回去就行（页面上那个开关写的就是它）。
      hidden: it.hidden === true,
      os: s(it.os, 8) === "linux" ? "linux" : "win",
      host: s(it.host, 64),
      user: s(it.user, 32),
      pass: s(it.pass, 64),
    });
  }
  return out.length ? out : null;
}

// 派生一格 live：地址 + 用户名都填了 = 这台会去抓真数（页面原来就是拿这两个字段自己判的，
// 现在改成服务端算好给它 —— 因为"看"那扇门放开之后，观众拿不到 user 这一格，没法自己判）。
const withLive = (list) => list.map((d) => Object.assign({}, d, { live: !!(d.host && d.user) }));
// 脱敏那一步：墙上摆一台机器只需要"叫什么 / 哪一档 / 哪个区 / 开没开机 / 有没有真数可取 / 什么系统"。
// 用户名与口令就是这两个字段把 /api/devices 变成了敏感端点，所以给观众的那份整格去掉（不是置空串：
// 空串还在，页面里那句 if (d.user) 就会去猜"这台填了但没填全"）。
const SCRUB = ["user", "pass"];
const scrub = (list) => withLive(list).map((d) => {
  const o = Object.assign({}, d);
  for (const k of SCRUB) delete o[k];
  return o;
});

async function load() {
  if (!existsSync(FILE)) {
    // 只回道具、**不顺手把 DEFAULTS 写成 devices.json**（09-25 清账2 查出的一半）：
    // 原先这里先 save 再报 seeded，于是"道具"只在文件消失后的第一次请求里露一次脸 ——
    // 第二次刷新起 source 就成了 'file'，页面那句道具红字安静下来，屏上却还站着八台道具。
    // 对一块以"这些数是真抓的"为存在理由的墙，那种一次性提示等于没有提示。
    // 现在只要文件还没回来，每一次请求都如实报 seeded；主人真在弹窗里编辑一次，PUT 才把它落成文件。
    console.log("⚠ 没有 " + path.basename(FILE) + "：这一轮回的是内置道具名册（八台 demo 机器，负载是本地随机游走），"
      + "页面上会挂红字；把真清单写回这个文件就恢复正常。");
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
    out.push({ key, cn: cn || ("分区 " + (out.length + 1)), at: [Math.round(x), Math.round(z)],
      // 新需求 1（分区可整体关闭）：关掉 = 地面上不画这块地的边框与区名标注，里面的设备也不摆出来。
      // 跟"删掉分区"是两回事：key / 名字 / 位置 / 归属全留着，改回 false 就原样回来。
      off: it.off === true });
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
  ground: { rippleEnabled: "bool", rippleHeight: "num",
    rippleThickness: "num", rippleBrightness: "num", dotSeg: "num", dotSizeMm: "num", rainEnabled: "bool",
    rainBrightness: "num", rainCount: "num", rainDotMm: "num", rainFollowLoad: "bool",
    // ⚠ 新增一颗地面参数 = 三处都要点名，少一处就每次都静默丢掉那一格（同 probeEveryMs 那个缺陷）：
    // 这里的形状表、settings-ui.mjs 的写文件载荷、以及那边"读文件"那一串键名。verify-rain.mjs 对这三处的账。
    // 三档波速与三档节拍（2026-09-24 他裁的六根关联滑杆）。原来那一格 rippleSpeed 已经不存了：
    // 值搬进 STATES 的 speed / interval，老文件里残留的 rippleSpeed 这一认不到，就被顺手改写掉（不猜它想配谁）。
    rippleSpeedIdle: "num", rippleSpeedActive: "num", rippleSpeedAlert: "num",
    rippleIntervalIdle: "num", rippleIntervalActive: "num", rippleIntervalAlert: "num" },
  // probeEveryMs 这一格必须在这儿列着，否则 normalizeSettings 会在每次 PUT 时把它悄悄丢掉：
  // 页面写"抓帧间隔"→ 文件里只剩 intervalMs → 服务端那一轮永远按默认 15 s 歇。
  // 搬抓帧进服务端之前这一格只活在浏览器内存里（页面自己排下一轮），所以掉了我也不知道掉了；
  // 现在它是服务端唯一的节拍来源，掉一次就是"屏上那格滑杆从此不灵"。2026-09-24 舞台实测抓到（见 docs）。
  monitor: { intervalMs: "num", probeEveryMs: "num" },
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
// 凭据存在 devices.json 里（你 2026-09-23 同意的），本文件不写死任何凭据；
// 每次探测只把页面传来的这几个值用一次：不进日志、不进响应体、不回显给调用方。
// 传输层已装好（npm i ssh2）；没装的话每条请求会明确报"未安装"，方便换机复现。
//
// 两种系统两套抓法（设备清单里的 os 那一格决定走哪条），两边都是"整段脚本走 stdin"：
//   linux → sh -s
//   win   → powershell -NoProfile -ExecutionPolicy Bypass -Command -
// 2026-09-24 为什么从"拼一条命令行 / base64 -EncodedCommand"改成 stdin：
//   ① Windows 的 OpenSSH 远端 shell 是 cmd.exe，命令行总长 8191 字符 —— 字段一多，base64 那一段
//      直接把命令行撑爆，症状是 SSH 层 client-socket（看着像网络不通）。stdin 没有这个长度限制。
//   ② 走 stdin 时 PowerShell 是**一行一行**执行的：多行语句块（if/foreach 跨行）会静默不执行、
//      一个字都不输出。所以 PROBE_PS 必须收成单行（它是单行）。另一条实测：Add-Type 的 C# 源
//      也只能是单行字符串，多行 here-string 同样会静默断掉。
// 两边都输出同一套 KEY=value 行（同一个 KEY 多行 = 一组），再由下面同一段解析变成 frame。
// 记录内的字段顺序在两条脚本里必须完全一致：VOL / PDISK / NIC / DRATE / NETRATE / GPUINFO。
//
// 关于 LOAD 这一格：linux 出的是 /proc/loadavg 的 1 分钟均值（负载，不是占用率）；win 出的是
// "把 CIM 的 LoadPercentage 折成等效负载"（pct × 核数 ÷ 100）。两条都是老口径，页面那条
// 负载 ÷ 核数 × 100 的老公式照样成立；要真占用率看 frame.cpu.pct / frame.cpu.perCore。
// 原文各留一份在 00-暂存\hm3d-p2-sh.sh 与 00-暂存\hm3d-p2-win1.ps1，都已在真机上跑通过。
// 这里的脚本用 String.raw 原样收进来：里面的 \r \n \t \/ 是给 bash / awk / PowerShell 看的转义，
// 不能被 JS 先吃掉（普通模板串会把 \r \n 变成真字符、把 \d 变成 d）。
// 两段脚本正文在 probe/ 下（probe-linux.mjs / probe-win.mjs）：它们是给远端 shell 看的，
// 与本文件的 HTTP / 凭据 / 审计逻辑零共用符号，所以搬出去了；契约（下面这套 KEY=value 的读法）还在这儿。
import { PROBE_SH } from "./probe/probe-linux.mjs";
import { PROBE_PS } from "./probe/probe-win.mjs";
// 脚本整段走 stdin 的那两条命令。stdin 没有 cmd.exe 那条 8191 字符的上限，字段想加多少加多少。
const PROBE_CMD = { linux: "sh -s", win: "powershell -NoProfile -ExecutionPolicy Bypass -Command -" };

let ssh2mod = null;
try { ssh2mod = await import("ssh2"); } catch { /* 没装就是没装，下面会报出来 */ }

// 探测审计：只记时间 + 目标主机 + 成败 + 错误首行，绝不记用户名/口令。
// 有了它，"有没有偷偷连过某台机器"是可以在磁盘上查证的，不用凭印象说。
const LOG = path.join(DIR, "probe.log");
async function logProbe(host, ok, msg) {
  try {
    await appendFile(LOG, new Date().toISOString() + "  " + (ok ? "OK  " : "FAIL") + "  " + host + (msg ? "  " + String(msg).split("\n")[0].slice(0, 120) : "") + "\n");
  } catch { /* 日志写不进不影响主流程 */ }
}

// 只允许页面自己调：挡掉别的网站往这个端口上打。
// 口径是" Origin 的主机 == 请求打到的 Host "，不是写死 127.0.0.1 —— 写死的话，从
// http://10.226.127.138:8123 打开的页面发回 /api/probe 时自带 Origin: 10.226.127.138:8123，
// 会被自己挡掉，症状是"远端页面画得出来、但一台机器的数据都抓不到"。
// 同源比对仍然是真同源：evil.com 打过来照样 403。
function sameOrigin(req) {
  const o = req.headers.origin;
  if (!o) return true;
  try { return new URL(o).host === req.headers.host; } catch { return false; }
}

// ---------- 把 KEY=value 行变成一帧 ----------
// 同一个 KEY 出现多行 = 一组（VOL / PDISK / NIC / DRATE / NETRATE / GPUINFO 都是）。
// 老字段名一个不动（HOST/OS/CORES/MEM/LOAD/CPU/DISK/GPU）—— 那是"即配即用"的兼容面；
// 新字段取不到就是 null / 空数组，页面据此把那一块整个藏掉，绝不拿模拟值顶上。
function parseLines(out) {
  const recs = {};
  for (const raw of String(out || "").split("\n")) {
    const l = raw.replace(/\r/g, "").trim();
    if (!l || l[0] === "#") continue;
    const i = l.indexOf("=");
    if (i <= 0) continue;
    const k = l.slice(0, i).trim();
    if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(k)) continue;   // stderr / CLIXML 混进来的杂行不认
    (recs[k] || (recs[k] = [])).push(l.slice(i + 1).trim());
  }
  return recs;
}
const oneOf = (R, k) => (R[k] && R[k].length ? R[k][0] : undefined);
const numOf = (v) => (v != null && v !== "" && Number.isFinite(Number(v)) ? Number(v) : null);
const listOf = (R, k) => {
  const s = oneOf(R, k);
  if (s === undefined || s === "") return null;
  const a = s.split(",").map((x) => Number(x)).filter((x) => Number.isFinite(x));
  return a.length ? a : null;
};
const pairOf = (R, k) => { const a = listOf(R, k); return a && a.length >= 2 ? [a[0], a[1]] : null; };
// "只有和参照数组一样长才要"的那道闸（下面 coreMap / pcls 都按 perCore 的下标对齐，见那里）
const aligned = (a, ref) => (a && ref && a.length === ref.length ? a : null);
const clampPct = (v) => (v == null ? null : Math.min(100, Math.max(0, Math.round(v))));
const rowsOf = (R, k, n) => (R[k] || []).map((r) => r.split("|").map((x) => x.trim())).filter((f) => f.length >= n);
// nvidia-smi 的 [N/A] / [Not Supported] 一律变 null —— 编一个 0 出来最误导人
const csvNum = (s) => (s == null || s === "" || /^\[?(n\/?a|not supported)\]?$/i.test(s) ? null
  : (Number.isFinite(Number(s)) ? Number(s) : null));

function buildFrame(out) {
  const R = parseLines(out);
  const mem = pairOf(R, "MEM") || [0, 0];
  const swp = pairOf(R, "SWAP");
  const dsk = pairOf(R, "DISK");
  // 老字段 GPU=：两面都出这一行（nvidia-smi 第一行的 利用率,显存总量,显存已用,温度），
  // 解析方式跟加新字段之前一模一样，页面老代码不用改。
  const g = oneOf(R, "GPU");
  const gpu = g && g !== "none"
    ? (() => { const a = g.split(",").map(Number); return { util: a[0], memTotalMb: a[1], memUsedMb: a[2], temp: a[3] }; })()
    : null;
  // 新字段：显卡逐张（nvidia-smi 一行一张）。142 那台两张 2080 Ti 走的就是这里。
  const gpus = (R.GPUINFO || []).map((r) => {
    const f = r.split(",").map((x) => x.trim());
    return { name: f[0] || "", util: clampPct(csvNum(f[1])), memTotalMb: csvNum(f[2]), memUsedMb: csvNum(f[3]),
      tempC: csvNum(f[4]), powerW: csvNum(f[5]), powerLimitW: csvNum(f[6]), fanPct: csvNum(f[7]),
      clockMhz: csvNum(f[8]), driver: f[9] || "" };
  });
  // 有型号没指标的那种：nvidia-smi 不在，但 lspci / WMI 报了名字。名字是真数据，单独一栏，
  // 页面按"只有型号"画，不去编利用率。
  const gpuNames = (R.GPUNAME || []).slice(0, 8);
  const perCore = listOf(R, "PCU");
  const pctFromCores = perCore && perCore.length
    ? Math.round(perCore.reduce((a, b) => a + b, 0) / perCore.length) : null;
  const cpuPctWin = oneOf(R, "CPU") === undefined ? null : clampPct(Number(oneOf(R, "CPU")));
  // 速率是先按名字建索引、再并进对应那张网卡 / 那个卷
  const rates = {};
  for (const r of (R.NETRATE || [])) {
    const f = r.split("|");
    if (f.length >= 3) rates[f[0].trim()] = { rxBps: Number(f[1]) || 0, txBps: Number(f[2]) || 0 };
  }
  const drates = {};
  for (const r of (R.DRATE || [])) {
    const f = r.split("|");
    if (f.length >= 3) drates[f[0].trim()] = { readBps: Number(f[1]) || 0, writeBps: Number(f[2]) || 0 };
  }
  return {
    // ---- 老字段（一条不动）----
    hostname: oneOf(R, "HOST") || "", os: oneOf(R, "OS") || "",
    cores: numOf(oneOf(R, "CORES")) || 0, load1: numOf(oneOf(R, "LOAD")) || 0,
    // win 是 CIM 的真占用率；linux 没有这个数，就用刚采到的每逻辑核占用率求平均（不是拿负载均值假装）
    cpuPct: cpuPctWin !== null ? cpuPctWin : pctFromCores,
    memTotalMb: Math.round(mem[0] || 0), memUsedMb: Math.round(mem[1] || 0),
    diskTotalBytes: dsk ? dsk[0] : 0, diskUsedBytes: dsk ? dsk[1] : 0,
    gpu, at: new Date().toISOString(),
    // ---- 新字段（取不到就是 null / []）----
    uptimeSec: numOf(oneOf(R, "UP")),
    cpu: {
      model: oneOf(R, "CPUMODEL") || null,
      phys: numOf(oneOf(R, "CORES")), logical: numOf(oneOf(R, "LOGICAL")),
      p: numOf(oneOf(R, "CPUP")), e: numOf(oneOf(R, "CPUE")),
      pct: cpuPctWin !== null ? cpuPctWin : pctFromCores,
      maxMhz: numOf(oneOf(R, "CPUMAXMHZ")),
      curMhz: numOf(oneOf(R, "CPUCURMHZ")),        // 只有 linux 有；Windows 取不到实时频率
      tempC: numOf(oneOf(R, "CPUTEMP")),           // 只有 linux 有；Windows 取不到 CPU 温度
      perCore, perMhz: listOf(R, "PCFREQ"),        // perMhz 只有 linux 有
      // 每逻辑处理器 → 哪个物理核 / 是 P 还是 E（核数、卡片怎么摆全靠这两条）。
      // 两条都**必须和 perCore 一样长**才认：长度不等说明两路采的不是同一批逻辑处理器，
      // 按下标对齐就成了瞎猜 —— 宁可整段 null，让看板退回"没有核映射"那条路。
      coreMap: aligned(listOf(R, "PCORE"), perCore),
      pcls: aligned(oneOf(R, "PCLS") ? oneOf(R, "PCLS").split(",").map((x) => x.trim()) : null, perCore),
    },
    mem: {
      type: oneOf(R, "MEMTYPE") || null, speedMhz: numOf(oneOf(R, "MEMSPD")),
      modules: numOf(oneOf(R, "MMOD")), cacheMb: numOf(oneOf(R, "MEMCACHE")),
      swapTotalMb: swp ? swp[0] : null, swapUsedMb: swp ? swp[1] : null,
    },
    // VOL=id|sizeBytes|freeBytes|label|fs|model|bus|media（windows 的 label 是卷标、linux 的是挂载点）
    disks: rowsOf(R, "VOL", 3).map((f) => Object.assign({ id: f[0], sizeBytes: Number(f[1]) || 0,
      freeBytes: Number(f[2]) || 0, label: f[3] || "", fs: f[4] || "", model: f[5] || "",
      bus: f[6] || "", media: f[7] || "" }, drates[f[0]] || { readBps: null, writeBps: null })),
    // PDISK=name|sizeBytes|media|bus|health（整块物理盘；health 只有 windows 有）
    physDisks: rowsOf(R, "PDISK", 2).map((f) => ({ name: f[0], sizeBytes: Number(f[1]) || 0,
      media: f[2] || "", bus: f[3] || "", health: f[4] || "" })),
    gpus, gpuNames,
    // NIC=name|up|linkMbps|ip|mac|virtual|desc
    nics: rowsOf(R, "NIC", 4).map((f) => Object.assign({ name: f[0], up: f[1] === "1",
      linkMbps: Number(f[2]) || 0, ip: f[3] || "", mac: f[4] || "", virtual: f[5] === "1",
      desc: f[6] || "" }, rates[f[0]] || { rxBps: null, txBps: null })),
    done: oneOf(R, "DONE") === "1",
  };
}

// 口令可以为空：办公那几台 Windows 是"账号 user、不设密码"，空口令是它们的正常配置，
// 不是"没填全"。所以这道门只看地址和用户名（linux 那几台口令不对的话，下面会如实报失败）。
function probe({ host, user, pass, os }) {
  return new Promise((resolve) => {
    if (!ssh2mod) return resolve({ ok: false, error: "本机未安装 ssh2（在项目目录跑 npm i ssh2 后重启 serve.mjs）" });
    if (!host || !user) return resolve({ ok: false, error: "地址或用户名为空" });
    // 只认准 "win" 两个字：别的（含没传）一律按 linux 那条老路子走，跟加这个分支之前一样
    const win = os === "win";
    const script = win ? PROBE_PS : PROBE_SH;
    // Windows 上 PowerShell 冷启动就要好几秒（实测 138 / 195 各 10~11 s，含两次网速采样之间那 1 s），
    // 原来 25 s 那条线已经会掐掉正常的连接，放宽到 45 s；linux 实测 1.6 s，给 15 s。
    const budget = win ? 45000 : 15000;
    const conn = new ssh2mod.Client();
    const timer = setTimeout(() => { conn.end(); resolve({ ok: false, error: "连接超时（" + Math.round(budget / 1000) + "s）" }); }, budget);
    const fail = (msg) => { clearTimeout(timer); conn.end(); resolve({ ok: false, error: String(msg).slice(0, 200) }); };
    conn.on("ready", () => {
      conn.exec(win ? PROBE_CMD.win : PROBE_CMD.linux, { pty: false }, (err, stream) => {
        if (err) return fail(err.message);
        let out = "", errOut = "";
        stream.on("data", (c) => { out += c; });
        stream.stderr.on("data", (c) => { errOut += c; });
        stream.on("close", () => {
          clearTimeout(timer);
          conn.end();
          const frame = buildFrame(out);
          // 脚本最后一句是 DONE=1：没见到它就说明中途断了（sh 语法错、PowerShell 静默断块）。
          // 这时候宁可如实报失败，也不把半截数据当成一帧画到墙上。
          if (!frame.done) {
            const tail = String(errOut || out).replace(/\s+/g, " ").trim().slice(0, 140);
            return resolve({ ok: false, error: "脚本没跑完（没见到 DONE）" + (tail ? "：" + tail : "") });
          }
          resolve({ ok: true, frame });
        });
        // 脚本整段走 stdin：cmd.exe 那条 8191 字符的命令行限制就此绕开
        stream.end(script.endsWith("\n") ? script : script + "\n");
      });
    });
    conn.on("error", (e) => fail(e.message));
    // 私钥那一格只在真载入时才递进去：不配 HM_SSH_KEY 时这条 connect 与改动前逐字一致，
    // 有口令的那几台照旧走口令（两格都给时 ssh2 先试公钥、不行再试口令）。
    conn.connect({ host, username: user, password: pass, ...(SSH_KEY ? { privateKey: SSH_KEY } : {}),
      readyTimeout: 8000, algorithms: { kex: ["ecdh-sha2-nistp256", "curve25519-sha256"] } });
  });
}

// ---------- 抓帧这一轮：由本服务自己转（2026-09-24 夜从页面搬进来）----------
// 为什么必须搬：原来那圈 setTimeout 长在页面里，于是"谁的浏览器开着谁才喂这块墙"。放开"看"之后
// 观众那台拿不到凭据（口令本来就不该出这台风），也就发不出探针 —— 朋友打开只会看到一整片"—"。
// 搬进服务端之后：口令一次都不出这台机器，观众开页就有数，他那台笔记本的页关掉也不影响别人看。
// 一轮的规矩跟搬之前页面里那条一模一样：该抓的机器按顺序各抓一帧、每台之间歇 1.2 s，
// 抓完歇 settings.json 里那一格 probeEveryMs 再来下一轮（一轮本身实测 20~45 s，所以不能拿固定 setInterval 压着跑）。
const frames = new Map();   // host -> { ok, frame, error, at }
const ROUND_GAP_MS = 1200;      // 同一轮里两台之间，别同一瞬间捅四台
const EVERY_DEFAULT = 15000;
// 范围那张真表在页面的 MON_LIMITS；服务端这一夹只挡一件事：手改文件写出个"10 毫秒"把这台机器变成 SSH 轰炸机。
const EVERY_FLOOR = 3000, EVERY_CEIL = 600000;
let roundTimer = 0, roundRunning = false, roundNo = 0;
let roundStartedAt = 0, roundFinishedAt = 0, roundEveryMs = EVERY_DEFAULT;

function noteFrame(host, r) {
  frames.set(host, { ok: !!r.ok, frame: r.frame || null, error: r.ok ? "" : String(r.error || "").slice(0, 200),
    at: new Date().toISOString() });
}
// OK 那一行顺手把**这一帧本来就采到的原始数**带上（2026-09-25 深夜）。
// 为什么：他报"142 最近应该又一次超过 70 负载 98（我看到了画面）"，而页面那头的涟漪取证要
// "有人开着这页、帧在跑"才攒得到（后台标签页连 rAF 都不跑）—— 服务端这一轮明明已经拿到这帧数，
// 日志里却只留下一个 "OK"，于是"发生过"和"没证据"长得一模一样。
// ⚠ 这里**只搬运不判断**：百分比怎么并成档位长在 src/model.mjs 的口径 B（CPU∥GPU 取 max、内存只抬档），
// 服务端再抄一份判据就是两个真源、早晚走散 ⇒ 所以日志里是三个原始数，不是一个档位名。
function framePeek(frame) {
  if (!frame) return "";
  // 两张卡那台（142）逐张在 gpus 里、老字段 gpu 只是第一张 ⇒ 两边都收一遍再取 max，
  // 不拿"第一张空着"当成"这台机器空着"。取不到卡才是 "-"（0 是"这一秒真没活"，两码事）。
  const cards = [].concat(frame.gpus || []).concat(frame.gpu || []).filter(Boolean);
  const gpu = cards.length ? Math.max(...cards.map((x) => Number(x.util) || 0)) : "-";
  const mem = frame.memTotalMb ? ((Number(frame.memUsedMb) || 0) / Number(frame.memTotalMb) * 100).toFixed(1) + "%" : "-";
  return "  cpu=" + (frame.cpuPct === null || frame.cpuPct === undefined ? "-" : frame.cpuPct)
    + " gpu=" + gpu + " mem=" + mem;
}
// 每一轮跑完才回文件里读这一格：他在设置里改"抓帧间隔"，下一轮就跟上（不必重启服务）。
async function readEveryMs() {
  const { settings } = await loadSettings();
  const v = Number(settings && settings.monitor && settings.monitor.probeEveryMs);
  return Number.isFinite(v) ? Math.min(EVERY_CEIL, Math.max(EVERY_FLOOR, Math.round(v))) : EVERY_DEFAULT;
}
function roundInfo() {
  return { no: roundNo, running: roundRunning, startedAt: roundStartedAt, finishedAt: roundFinishedAt,
    everyMs: roundEveryMs, hosts: frames.size,
    nextInMs: roundRunning ? null : Math.max(0, roundEveryMs - (Date.now() - roundFinishedAt)) };
}
async function runRound() {
  if (roundRunning) return;
  roundRunning = true; roundNo++; roundStartedAt = Date.now();
  try {
    const { list } = await load();
    for (const d of list) {
      // 藏起来的、以及没填全（地址 + 用户名）的不抓。
      // "落在已关闭分区里"这一维**不在服务端复算**：那份判据长在页面（model.mjs 拿 zones.json 的 off 对着查），
      // 这里再抄一份就是两个真源、早晚走散；多抓一台关掉的分区里的机器只是每轮一次 SSH，
      // 而放出来那一刻它已经有现成的数，不用等下一轮。
      if (d.hidden || !d.host || !d.user) continue;
      let r;
      try { r = await probe({ host: d.host, user: d.user, pass: d.pass, os: d.os }); }
      catch (e) { r = { ok: false, error: "服务内部错误：" + String((e && e.message) || e) }; }
      noteFrame(d.host, r);
      logProbe(d.host, r.ok, r.ok ? framePeek(r.frame) : r.error);
      await new Promise((res) => setTimeout(res, ROUND_GAP_MS));
    }
  } finally {
    roundRunning = false;
    roundFinishedAt = Date.now();
    roundEveryMs = await readEveryMs();
    roundTimer = setTimeout(runRound, roundEveryMs);
  }
}

const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8", ".json": "application/json; charset=utf-8",
  ".css": "text/css; charset=utf-8" };

// 静态出口只放这几类（网页运行要的：页面 / 模块 / 样式 / 图标）。
// ⚠ 必须白名单、不能放 .json/.log：devices.json 里是明文 SSH 口令，probe.log 是抓帧审计，
//   一旦能从静态路径整份读出，前面 HM_ALLOW/HM_OWNER 两扇门和 /api/hosts 的脱敏就全白做了
//   （2026-09-26 评审实证：GET /devices.json 直接返回明文 user/pass）。这三个 json 只走各自的 /api/* 出口。
const STATIC_EXT = new Set([".html", ".mjs", ".js", ".css", ".svg", ".ico"]);

createServer(async (req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  // 第一道门：能不能连这块墙（看）。名单没给 = 放开，连页面带接口一起放行。
  if (!fromAllowed(req)) {
    return send(res, 403, "这块墙不对你开放（serve.mjs 的 HM_ALLOW）", "text/plain; charset=utf-8");
  }
  // 所有 /api/* 都先过同源这道门：它挡的是"别的网站借你打开着的浏览器来打这个端口"，
  // 跟来源 IP 是两回事（同事在自己机器上看墙，IP 过了第一道门，但 Origin 仍然是这台 138 —— 放行是对的）。
  if (url.pathname.startsWith("/api/") && !sameOrigin(req)) {
    return send(res, 403, JSON.stringify({ ok: false, error: "来源不是本机" }));
  }
  // 第二道门：能不能改。下面这一张表就是"改"的全部口径 ——
  // 写三个 json、借这台机器敲别人的 SSH、跑一轮抓取，四种都算改；
  // 而 /api/devices 的 GET 虽然名义上是"读"，读的是那份**含明文口令**的清单，所以它也在这张表里。
  // 观众要读清单走 /api/hosts（剥掉 user/pass 的那份），要读数走 /api/frames。
  const WRITE_API = [["POST", "/api/probe"], ["POST", "/api/round"], ["GET", "/api/devices"],
    ["PUT", "/api/devices"], ["PUT", "/api/zones"], ["PUT", "/api/settings"]];
  if (WRITE_API.some(([m, p]) => m === req.method && p === url.pathname) && !fromOwner(req)) {
    return send(res, 403, JSON.stringify({ ok: false,
      error: "这一项只有看板主人能做（这一台的地址不在 serve.mjs 的 HM_OWNER 里）" }));
  }
  // 我是主人还是观众：页面就问这一格。设置齿轮、编辑、双击补抓、"抓一帧"全凭它摆不摆出来。
  if (url.pathname === "/api/state") {
    return send(res, 200, JSON.stringify({ ok: true, mode: fromOwner(req) ? "owner" : "view",
      view: ALLOW.length ? ALLOW : "谁连得上谁都能看", owner: OWNER }));
  }
  // 给观众的清单：与 /api/devices 同一份文件，只是剥掉 user / pass 两格、补上服务端算好的 live。
  if (url.pathname === "/api/hosts") {
    const { source, list } = await load();
    return send(res, 200, JSON.stringify({ list: scrub(list), source }));
  }
  // 帧缓存：服务端每抓完一台就写这里，页面每 2 秒来取一趟（自己一发 SSH 都不发）。
  // 响应里带上 rounds 那一格，是为了让"这块墙多久抓一轮、上一轮什么时候跑完"在浏览器里可读，
  // 不用去问服务端日志。
  if (url.pathname === "/api/frames") {
    const out = {};
    for (const [host, r] of frames) out[host] = r;
    return send(res, 200, JSON.stringify({ ok: true, rounds: roundInfo(), frames: out }));
  }
  // 手动催一轮（主人的"抓一帧"按钮与自测用）：把排队的那只定时器掐掉、立刻开跑。
  // 只回 roundInfo 不回数据 —— 数还是从 /api/frames 拿，两条路不必各写一份帧。
  if (url.pathname === "/api/round") {
    clearTimeout(roundTimer); roundTimer = 0;
    runRound();   // 不 await：一轮 20~45 秒，HTTP 这一头不该挂着
    return send(res, 200, JSON.stringify({ ok: true, rounds: roundInfo() }));
  }
  if (url.pathname === "/api/probe") {
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
      logProbe(String(body.host || "?"), r.ok, r.ok ? framePeek(r.frame) : r.error);
      // 手动抓的那一帧也进缓存：否则"连通性测试"抓出来的数只活在弹窗里，两秒后页面从 /api/frames
      // 拉回来的还是旧帧，屏幕上看着像"测过了但墙上没动"。
      if (body.host) noteFrame(String(body.host), r);
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
      // withLive 而不是原样吐：让主人那份和观众那份（/api/hosts）字段形状一致，页面只有一条判据
      return send(res, 200, JSON.stringify({ list: withLive(list), source }));
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
  // 静态出口白名单（见 STATIC_EXT 那条注释）：不在名单里的扩展名直接 404，
  // 连 readFile 都不碰 —— 凭据文件连"存不存在"都不对外报。
  const ext = path.extname(abs).toLowerCase();
  if (!STATIC_EXT.has(ext)) return send(res, 404, "not found", "text/plain");
  try {
    const buf = await readFile(abs);
    send(res, 200, buf, TYPES[ext] || "application/octet-stream");
  } catch {
    send(res, 404, "not found", "text/plain");
  }
}).listen(PORT, BIND, async () => {
  console.log(`原型服务已起：http://${LOOPBACK ? "127.0.0.1" : BIND}:${PORT}/monitor-wall.html` +
    (LOOPBACK ? "" : `（也从 http://<本机 IP>:${PORT}/monitor-wall.html 能开）`));
  console.log(`设备清单文件：${FILE}（页面编辑会写回这里${LOOPBACK ? "；只监听 127.0.0.1" : ""}）`);
  console.log(`分区文件：${ZFILE}`);
  console.log(`设置文件：${SFILE}（改它即改看板，页面每 5 秒读一次；页面里改也写回它）`);
  // 两扇门各报一遍：放开"看"之后，光看"来源"那一行会以为谁都能改这块墙
  console.log("看（HM_ALLOW）：" + (ALLOW.length ? `只放 ${ALLOW.join(" / ")}（外加环回）`
    : LOOPBACK ? "只认环回（别的机器连不上）"
    : "⚠ 不限来源 —— 同网段谁能连上谁都能打开这块墙。它读的清单已剥掉用户名与口令（/api/hosts），"
      + "抓帧由本服务端自己转，所以放开「看」的代价是「陌生机器能看见那几台的负载与型号」，不再是「能读走整份清单」"));
  console.log("改（HM_OWNER）：" + (OWNER.length ? `只认 ${OWNER.join(" / ")}（外加环回）`
    : "只有环回 —— 别的机器只能看，改不动；本机要改就在 127.0.0.1 那个地址开页面")
    + (process.env.HM_OWNER === undefined && ALLOW.length ? "（没给 HM_OWNER，暂按 HM_ALLOW 那份名单当主人）" : ""));
  // 有没有私钥直接决定"没填口令的那几台"抓不抓得到，所以启动就得看得见这一格
  console.log("抓机器用的私钥：" + SSH_KEY_NOTE);
  // 第一轮不等定时器：服务一起来就把机器挨个抓一遍，谁先打开墙谁就先有数
  console.log("抓帧：由本服务端自己转（页面只读缓存），每轮歇 " + await readEveryMs() + " ms");
  runRound();
});
