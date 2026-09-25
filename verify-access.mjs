// 访问分权的对账（2026-09-24 需求 #2：组内谁都能看这块墙，只有配在 HM_OWNER 里的那几台能改）。
// 这里量的是 serve.mjs 里那两扇门的**判据本体**（整段截进 vm 跑，不 import 服务、不占端口、不碰文件），
// 真链路的读数的确另开隔离端口跑（见 docs），但"哪一格该被剥掉、哪道门该挡谁"这类先在这儿钉住。
// ⚠ 每条截取的区间都印出"截到几行几字节"当正对照：切片没匹配上就是 0 行，
//   而 0 行的断言会全绿 —— 那是最坏的一种绿（R-6，这一族已经栽过四次）。
import { readFileSync } from "node:fs";
import vm from "node:vm";

const src = readFileSync("serve.mjs", "utf8");
let fails = 0;
const n = (v) => JSON.stringify(v);
function ok(label, got, want) {
  const g = n(got), w = n(want);
  const good = g === w;
  if (!good) fails++;
  console.log((good ? '  ✓ ' : '  ✗ ') + label + '  ⇒ ' + g + (good ? '' : '（要 ' + w + '）'));
}
// 按下标切成 [i, j)：起点必须撞上、终点也要撞上，撞不上就当场抛出去（别拿着空串去 vm 里"通过"）
function slice(fromMark, toMark, name) {
  const i = src.indexOf(fromMark), j = src.indexOf(toMark, i + fromMark.length);
  if (i < 0 || j < 0) throw new Error('截不到 ' + name + '（起点 ' + (i < 0 ? '没撞上' : 'ok') + '、终点 ' + (j < 0 ? '没撞上' : 'ok') + '）');
  const code = src.slice(i, j);
  console.log('  截出 ' + name + '：' + code.split('\n').length + ' 行 / ' + code.length + ' 字节');
  return code;
}

// ---------- 门 1+2：ALLOW / OWNER / fromAllowed / fromOwner ----------
// 区间从 const ALLOW 起、到 const MAX_BYTES 前停：中间还夹着 SSH_KEY 那几行，
// 但 HM_SSH_KEY 不给时那两句根本不执行（readFileSync 在 if 里面），所以能整段截。
const doors = slice('const ALLOW = (process.env.HM_ALLOW', 'const MAX_BYTES', '两扇门的判据本体（ALLOW / OWNER / fromAllowed / fromOwner）');
// 三套环境各起一个 vm：这一格是唯一会出现"谁能看却没人能改"的地方（HM_OWNER 忘了给），所以逐套点清。
function mk(env) {
  const ctx = vm.createContext({ process: { env }, console });
  vm.runInContext(doors + '\nthis.X = { ALLOW, OWNER, fromAllowed, fromOwner, peerOf, loopOf };', ctx);
  return ctx.X;
}
const req = (ip) => ({ socket: { remoteAddress: ip } });
{
  const A = mk({});   // 两个都没给：开发机跑法（只监听环回，谁都不知道谁是主人）
  ok('HM_OWNER / HM_ALLOW 都没给 ⇒ 看：不限来源；改：只剩环回', [A.ALLOW.length, A.OWNER.length], [0, 0]);
  ok('  陌生 IP 能看', A.fromAllowed(req('10.226.127.99')), true);
  ok('  陌生 IP 不能改', A.fromOwner(req('10.226.127.99')), false);
  ok('  环回永远能改（本机 node serve.mjs 不留后路）', A.fromOwner(req('::1')), true);
}
{
  const B = mk({ HM_BIND: '0.0.0.0', HM_ALLOW: '10.226.127.14,10.226.127.52' });
  ok('只给 HM_ALLOW（老写法）⇒ OWNER 退回吃它，不会出现"能看不能改"', B.OWNER, ['10.226.127.14', '10.226.127.52']);
  const C = mk({ HM_BIND: '0.0.0.0', HM_ALLOW: '10.226.127.14,10.226.127.52', HM_OWNER: '10.226.127.14' });
  ok('两扇都给 ⇒ 组内两台能看，只有 .14 能改',
    [C.fromAllowed(req('10.226.127.52')), C.fromOwner(req('10.226.127.52')), C.fromOwner(req('10.226.127.14'))],
    [true, false, true]);
  ok('HM_OWNER 给空串 ⇒ 谁都不能改（只剩环回），但看是放开的', mk({ HM_OWNER: '' }).OWNER, []);
  const D = mk({ HM_BIND: '0.0.0.0', HM_OWNER: '10.226.127.14' });
  ok('只给 HM_OWNER ⇒ 看对全网放行、改只认那一台（这就是他裁的"乙"）',
    [D.fromAllowed(req('10.30.241.9')), D.fromOwner(req('10.30.241.9')), D.fromAllowed(req('10.226.127.14'))],
    [true, false, true]);
  // IPv4-mapped 那一层必须剥：node 在双栈下报的是 ::ffff:10.226.127.14，不剥的话名单永远对不上，
  // 症状是"我明明配了 HM_OWNER 却谁都改不了"。
  ok('IPv4-mapped 前缀剥得掉（带 ::ffff: 也能进名单）',
    [D.fromOwner(req('::ffff:10.226.127.14')), D.peerOf(req('::ffff:10.226.127.14'))], [true, '10.226.127.14']);
}

// ---------- 观众那份清单：user / pass 必须整格消失 ----------
const scrubbed = slice('const withLive =', 'async function load()', 'withLive / SCRUB / scrub（脱敏那一步）');
const ctx2 = vm.createContext({ console });
vm.runInContext(scrubbed + '\nthis.scrub = scrub; this.withLive = withLive; this.SCRUB = SCRUB;', ctx2);
const LEAKY = [
  { name: '推理机', tier: 'atx', zone: 'rack', power: true, hidden: false, os: 'linux',
    host: '192.168.31.142', user: 'user01', pass: 'hunter2-not-for-wrong-hands' },
  { name: 'NAS', tier: 'nas', zone: '', power: true, hidden: false, os: 'linux', host: '', user: '', pass: '' },
];
// 正对照：不脱敏的那一份里 pass 必须在（否则"剥掉了"这条断言是在跟空气比）
ok('正对照：withLive 之后明文口令还在 ⇒ 测试数据真的含口令',
  ctx2.withLive(LEAKY)[0].pass, 'hunter2-not-for-wrong-hands');
const out = ctx2.scrub(LEAKY);
ok('脱敏后键集合固定为这九格（多一格就得进这里说清楚）', Object.keys(out[0]).sort(),
  ['hidden', 'host', 'live', 'name', 'os', 'power', 'tier', 'zone']);
ok('两格凭据都不在（键本身消失，不是空串）', ['user', 'pass'].filter((k) => k in out[0]), []);
ok('观众那份里搜不到口令原文（含"整格没删、改塞进别的键"那种漏法）',
  JSON.stringify(out).includes('hunter2'), false);
ok('live 由服务端算：填了地址+用户名 = true，NAS 那台 = false', out.map((d) => d.live), [true, false]);
ok('原清单没被改写（脱敏是复制一份，不是就地删）', LEAKY[0].pass, 'hunter2-not-for-wrong-hands');
// 这一条是给"以后往 normalize 里加字段"留的闸：新加的那一格只要名字像凭据，就得在这里点名，
// 不然它会顺着 scrub 的"整份复制"漏到观众手上。
ok('名字长得就像凭据的键，一个都不许出现在观众那份里',
  Object.keys(out[0]).filter((k) => /pass|user|secret|token|key|pwd/i.test(k)), []);

// ---------- 写接口那张表：漏一行就等于把那扇门开给全组 ----------
const m = src.match(/const WRITE_API = (\[[\s\S]*?\]);/);
if (!m) throw new Error('截不到 WRITE_API 那张表（改名字了？那这道闸就白装了）');
console.log('  截出 WRITE_API：' + m[1].split('\n').length + ' 行 / ' + m[1].length + ' 字节');
const table = (new Function('return ' + m[1]))();
const has = (method, path) => table.some(([a, b]) => a === method && b === path);
for (const [method, path] of [['POST', '/api/probe'], ['POST', '/api/round'], ['GET', '/api/devices'],
  ['PUT', '/api/devices'], ['PUT', '/api/zones'], ['PUT', '/api/settings']]) {
  ok('表里必须有 ' + method + ' ' + path + '（少了它 = 观众能' + (method === 'GET' ? '读走明文口令' : '改这一份') + '）',
    has(method, path), true);
}
for (const [method, path] of [['GET', '/api/hosts'], ['GET', '/api/frames'], ['GET', '/api/state'],
  ['GET', '/api/settings'], ['GET', '/api/zones']]) {
  ok('表里不许有 ' + method + ' ' + path + '（那是观众开页要用的，挡了就是一整片"—"的墙）', has(method, path), false);
}
ok('两道门的 403 话术各说各的（他一眼分得清"没连上"还是"没权限"）',
  [src.includes('这块墙不对你开放'), src.includes('只有看板主人能做')], [true, true]);
ok('页面问身份的那一格用的是同一个判据（不是另写一遍名单）',
  src.includes('mode: fromOwner(req) ? "owner" : "view"'), true);

// ---------- 服务端那一轮的节拍来源：SET_SHAPE 少列一格 = 每次 PUT 都把那格丢掉 ----------
// 这一条是 09-24 舞台上抓到的真缺陷：把 settings.json 的 monitor 写成 {intervalMs:3000, probeEveryMs:3000}，
// 页面 PUT 一趟回来文件里只剩 intervalMs —— 因为 normalizeSettings 只认 SET_SHAPE 里列过的键。
// 搬进服务端之前 probeEveryMs 只活在浏览器内存里（页面自己排下一轮），掉了也没人看得见；
// 现在它是服务端唯一的节拍来源，掉一格 = 那根滑杆从此不灵，而它屏上还会动。
const sm = src.match(/const SET_SHAPE = (\{[\s\S]*?\n\});/);
if (!sm) throw new Error('截不到 SET_SHAPE（改名字了？那"哪一格能落盘"就没有权威面了）');
console.log('  截出 SET_SHAPE：' + sm[1].split('\n').length + ' 行 / ' + sm[1].length + ' 字节');
const SHAPE = (new Function('return ' + sm[1]))();
ok('monitor 组两格都认（intervalMs 重画节拍 / probeEveryMs 抓帧间隔）',
  Object.keys(SHAPE.monitor).sort(), ['intervalMs', 'probeEveryMs']);
ok('服务端读的就是这一格（不是另起一个键名）', src.includes('settings.monitor.probeEveryMs'), true);
ok('服务端那一轮跳过的判据 = 藏起来的 / 没填地址 / 没填用户名（跟搬之前页面那条一致）',
  src.includes('if (d.hidden || !d.host || !d.user) continue;'), true);
ok('节拍有地板：手改文件写 10 ms 不会把这台机器变成 SSH 轰炸机',
  [src.includes('const EVERY_FLOOR = 3000'), src.includes('EVERY_CEIL = 600000')], [true, true]);

// ---------- 页面这一侧：身份只有一格，两句文案各说各的实话 ----------
// 为什么也要钉：这一刀的"观众不给齿轮、清单换 /api/hosts、双击不去抓"三件事全凭同一个布尔值。
// 它要是被抄成两份（比如看板那侧另存一个 let），改一处漏一处就是"朋友那台看到假话"——
// 09-24 就是这样差点出去的：面板那句"双击这一下已经当场去抓了"对观众是假的（他点了什么都不发）。
const PAGE = { model: readFileSync("src/model.mjs", "utf8"),
  set: readFileSync("src/settings-ui.mjs", "utf8"),
  dash: readFileSync("src/dashboard.mjs", "utf8"),
  wall: readFileSync("monitor-wall.html", "utf8") };
console.log('  页面四件：' + Object.entries(PAGE).map(([k, v]) => k + ' ' + v.split('\n').length + ' 行').join(' / '));
ok('身份那一格住在状态层（model 里 export 的 ACCESS.viewer），不是设置层的私有变量',
  /export const ACCESS = \{ viewer: false \};/.test(PAGE.model), true);
ok('设置层与看板层都从 model import 它（谁都没有第二份真源）',
  [/ACCESS[^}]*\}[^;]*from "\.\/model\.mjs"/.test(PAGE.set.split('\n').slice(0, 25).join('\n')),
    PAGE.dash.includes('MS_KEY, ACCESS } from "./model.mjs"')], [true, true]);
ok('全仓库不许再出现第二份本地身份变量（let viewOnly 一出现就是抄了第二份）',
  [PAGE.set, PAGE.dash, PAGE.wall, PAGE.model].some((s) => /let viewOnly/.test(s)), false);
ok('观众的清单 URL：认这一格挑 /api/hosts 还是 /api/devices',
  PAGE.set.includes('fetch(ACCESS.viewer ? HOSTS_API : CFG_API'), true);
ok('观众那条"别反写 devices.json"的闸还在（拿脱敏清单回写会把凭据整格清空）',
  PAGE.set.includes('if (ACCESS.viewer) return;'), true);
// 文案闸：这一条是"对观众说假话"的唯一防线，正对照 = 主人那一支确实写着这句话
ok('面板那句话说实话：主人那支才提"双击去抓"（正对照）',
  /双击这一下已经当场去抓了/.test(PAGE.dash), true);
// 观众那一支的那句话：从 ACCESS.viewer 起、到下一支（行首那个 `:`）为止。
// 不能拿固定字数当窗口——主人那一支就紧跟在后面，窗口一宽就把假话算进观众那一支。
const lines = PAGE.dash.split("\n");
const from = lines.findIndex((l) => l.includes(": ACCESS.viewer"));
const vLines = from < 0 ? [] : lines.slice(from + 1, from + 1 + Math.max(0,
  lines.slice(from + 1).findIndex((l) => /^\s*: /.test(l)))).join("\n");
ok('观众那一支不承诺双击会去抓，改说"看板那台自己排一轮"',
  [vLines.includes("还没抓到这台的帧"), vLines.includes("自己抓一轮"), vLines.includes("双击这一下")],
  [true, true, false]);
ok('双击补抓第一行就把观众挡掉（不等服务端 403 才告诉他）',
  PAGE.wall.includes('if (isViewer() || !liveOf(d) || d.frame) return;'), true);
ok('页面读的是服务端那一轮的缓存，不再是页面自己排定时器',
  [PAGE.wall.includes('fetch("/api/frames"'), PAGE.wall.includes('fetch("/api/round"'),
    /function probeRound\(/.test(PAGE.wall)], [true, true, false]);

// ---------- 清账2（2026-09-25）：名册来源不许静默 ----------
// 登记过的那条失败模式：观众那一台若 /api/hosts 读失败，页面会静默退回**内置道具名册** ——
// 屏上是一片看着全真的一排假机器，而那块墙存在的理由就是"这些数是真抓的"。
// 他 09-25 逐字："第二项要清账" ⇒ 原先"新缺陷只登记不追改"对这一条作废。
// 判据两层：① rosterBadge 这一格纯函数（挂/不挂、挂什么，屏上与闸共用同一处）
//           ② 三条读名册的路径（file:// / 读失败 / 读到）必须都报到这一格里，少一条就是又静默了
const M = await import("./src/model.mjs");
ok('名册初始是"还没问过"（开机那一瞬不闪红字，但也不许是"已读到"）',
  M.ROSTER.source, 'unknown');
ok('道具上墙 ⇒ 顶栏必须挂出来（这是这一刀的全部目的）',
  M.rosterBadge('builtin', '/api/hosts 读失败：HTTP 500'),
  { hidden: false, text: '内置道具名册：/api/hosts 读失败：HTTP 500（屏上这几台不是真机器）' });
ok('观众与主人两种真名册 ⇒ 都不挂（不常驻一行红字，只有异常才出现）',
  [M.rosterBadge('server-hosts').hidden, M.rosterBadge('server-devices').hidden], [true, true]);
ok('file:// 那一支也报（"本来就该是道具"不是静默的借口，文案另给一句）',
  M.rosterBadge('builtin', 'file:// 没连本地服务').text,
  '内置道具名册：file:// 没连本地服务（屏上这几台不是真机器）');
ok('unknown（还没问过）不挂红字', M.rosterBadge('unknown').hidden, true);
// 三条路径接线：只验"源码里确实调了"不够，还要钉"没有一条路径绕过它"——
// 所以这一格统计的是调用点数量：setRosterSource 在 loadDevices 里必须正好出现三次
// （file:// 一支、成功一支、失败一支），多一处少一处都停下来要人看。
const rosterCalls = (PAGE.set.match(/setRosterSource\(/g) || []).length;
ok('loadDevices 三条路径全部上报来源（file:// / 读到 / 读失败）', rosterCalls, 3);
ok('读失败那一支带上端点与原文（屏上那句要能指出是哪扇门没开）',
  /setRosterSource\("builtin", \(ACCESS\.viewer \? HOSTS_API : CFG_API\) \+ " 读失败：" \+ e\.message\)/.test(PAGE.set), true);
ok('成功那一支在 setDevices 之后才报（换绑之前报会把来源与屏上内容错开）',
  PAGE.set.indexOf('setDevices(j.list)') < PAGE.set.indexOf('setRosterSource(ACCESS.viewer ? "server-hosts"'), true);
ok('顶栏那一格在墙上（不是只在观众开不了的设置弹窗里）',
  [PAGE.wall.includes('<span id="roster" hidden></span>'), PAGE.wall.includes('rosterBadge')], [true, false]);
ok('DOM 那一处只写 text/hidden，判据全在 rosterBadge（不许两处各写一套文案）',
  (PAGE.set.match(/内置道具名册：\s*'\s*\+/g) || []).length, 0);
ok('仪器问得到：__hm().roster() 走的是同一格 ROSTER',
  PAGE.wall.includes('roster: () => rosterState()'), true);

console.log(fails ? '\n✗ 访问分权 ' + fails + ' 条没过' : '\n✓ 访问分权：两扇门的名单/回退/脱敏/写接口表都对，名册来源不静默');
process.exit(fails ? 1 : 0);
