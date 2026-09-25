// 涟漪"自然路径"的取证闸（2026-09-25 清账1）。
// 为什么单独一个闸：三档波速 8/16/30 此前只在**手动撒环**那个钩子（rippleKick）上读到过，
// 而屏上真正在荡的那一圈走的是 ground.mjs 的 stepRipples —— 那是另一个调用点。
// 他 09-25 的原话："70 已经跑到过了 昨晚到现在，已经跑到过很多次了"，也就是说"等高负载那档自己出现"
// 不是缺数，是我没去读。所以这一闸把真实那段代码截进 vm 跑，档位由**真 142 那几帧的数**判出来。
// 2026-09-25 深夜补一句：真页那一档现在由 ground.mjs 的 noteRipple 自己攒（每档第一次起圈记一条，
// 问 `__hm().rippleEvidence()`），本闸管的是确定性那一半 —— 同一批真帧，随时可重跑，不依赖哪台机器此刻忙不忙。
//
// 链路分工（别让一个闸假装覆盖了全部）：
//   帧 → 一个百分比、百分比 → 档位   = verify-load.mjs（口径 B，12 例，已进门）
//   档位 → 这一圈用什么值            = 本闸（stepRipples 原文 + noteRipple 原文）
// 两半接起来才是"138 屏上那圈黄环荡得快，是因为那台真跑进了 35~70"这句话。
//
// 只假造三个依赖：holderOf（落位坐标，本闸要测的不是它）、rippleTerrain（记录用的桩）、
// localStorage（⑦ 那一路要的就是"盘"，给一份内存 Map 版的，跑完就丢）。
// 真给的是：devices / holders / mkDev / loads / levelOf / gradeOf / STATES / PULSE_SETTINGS / setGrade
// —— 全部 import 自 src/model.mjs，也就是页面用的同一份真源，不是往测试里抄一份数字。
// ⚠ 少给一个依赖在这儿是**静默**的：evidenceRestore 外面那圈 try/catch 把"STATES 没进上下文"的
// ReferenceError 当成"盘上没有存档"，⑦ 那两条当场红给我看才露馅（这一版新加的桩漏的，不是老账）。
//  ⇒ 凡是"被 try/catch 包住的读档"，闸里必须有一条**只可能靠读档成功才绿**的断言（这里就是"刷新后仍有 ALERT:30"）。
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { devices, holders, mkDev, loads, levelOf, gradeOf, STATES, PULSE_SETTINGS, setGrade, GRADE_KEYS } from './src/model.mjs';

const src = readFileSync('src/ground.mjs', 'utf8');
const from = src.indexOf('function stepRipples(t) {');
const to = src.indexOf('// 雨壳的数值正对照');
if (from < 0 || to < 0 || to < from) {
  console.log('✗ 没截到 stepRipples 原文（marker 漂了：from=' + from + ' to=' + to + '）');
  console.log('  这是**闸自己**坏了：ground.mjs 里那个函数名、或后面那句注释改了名 ⇒ 本闸空转，全绿也不算验过。');
  process.exit(1);
}
// vm 的 Script 不认 ESM：这一段里有 `export function rippleEvidence()` 与 `export const RIPPLE_EVIDENCE_KEY`，
// 原样喂进去就是 SyntaxError（第一次跑撞上的）。只剥行首那一个关键字，函数体一个字不改；
// 还有第二处 export 就停下来要人看。
const segSrc = src.slice(from, to).replace(/^export /gm, '');
if (segSrc.includes('export ')) {
  console.log('✗ 这一段里还有别处的 export，剥法不再安全 —— 本闸要改写而不是硬跑');
  process.exit(1);
}
const hasCall = /rippleTerrain\.addRipple\(h\.x, h\.z, st\.color, st\.amplitude, st\.speed\)/.test(segSrc);
const hasNote = /noteRipple\(d, st, t\)/.test(segSrc);
console.log((hasCall && hasNote ? '✓ ' : '✗ ') + '截到 stepRipples + noteRipple 原文（'
  + segSrc.split('\n').length + ' 行）：撒环那一行与取证那一行都在里面');
if (!hasCall || !hasNote) {
  console.log('✗ 缺 ' + (hasCall ? '' : 'addRipple 调用 ') + (hasNote ? '' : 'noteRipple 调用') + ' ⇒ 空转，不算验过');
  process.exit(1);
}
let bad = 0;

// 2026-09-25 实测到的真帧（不是编的）：142 CPU 79.1 / GPU 29.5 ⇒ max 79.1 = ALERT；
// 笔记本跑推理时 38 % 上下 = ACTIVE；家悦 1~7 % = IDLE。内存那一维照口径 B 只用来抬档。
const REAL = [
  { short: '推理机142', pct: 79.1, memPct: 61.0, wantKey: 'ALERT', wantSpeed: 30, wantAmp: 1.2 },
  { short: '笔记本', pct: 38.0, memPct: 85.4, wantKey: 'ACTIVE', wantSpeed: 16, wantAmp: 0.85 },
  { short: '家悦', pct: 7.0, memPct: 40.0, wantKey: 'IDLE', wantSpeed: 8, wantAmp: 0.6 },
];

// 每一例都重建一份上下文：取证数组与节拍计时都是模块内的活状态，复用会把上一例的记录带过来。
// 唯一例外是下面⑦：那一例故意把同一份"盘"（ls）交给第二个上下文，模拟的就是"刷新之后"。
function makeStore(seed) {
  const m = new Map();
  if (seed !== undefined) m.set('hm3d.rippleEvidence.v1', seed);
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, String(v)); },
    dump: () => (m.has('hm3d.rippleEvidence.v1') ? m.get('hm3d.rippleEvidence.v1') : null) };
}
function run(list, ls = makeStore()) {
  const spawn = [];
  const ctx = vm.createContext({
    devices, holders, rippleRt: new Map(), PULSE_SETTINGS, levelOf, STATES, localStorage: ls,
    holderOf: (d) => ({ x: 1000 + d.seq * 900, z: -400 }),
    rippleTerrain: { addRipple: (x, z, color, amplitude, speed) => spawn.push({ x, z, color, amplitude, speed }) },
    Math,
  });
  devices.length = 0;
  holders.length = 0;
  for (const d of list) { devices.push(d); holders.push({ id: d.id }); }   // 一台一个 Holder：spread 才是真值
  vm.runInContext(segSrc + '\nthis.__go = stepRipples; this.__ev = rippleEvidence; this.__key = RIPPLE_EVIDENCE_KEY;', ctx,
    { filename: 'ground-stepRipples-seg.mjs' });
  for (let k = 0; k <= 400; k++) ctx.__go(k * 0.05);   // 20 秒合成时刻：三档节拍（3.0/2.0/1.2）都够起好几圈
  return { spawn, evidence: ctx.__ev(), key: ctx.__key, ls };
}

const mk = (short, pct, memPct, power = true) => {
  const d = mkDev(short, 'atx');
  d.power = power;
  // 走真判据：pct → gradeOf（口径 B 那张阈值表）→ loads 里那一格，与 ground 的 stepLoads 落的是同一个形状
  loads.set(d.id, { pct, memPct, key: gradeOf(pct, memPct).key });
  return d;
};

console.log('\n── ① 三档各跑一次自然路径：addRipple 收到的值必须是那一档的值');
for (const t of REAL) {
  const r = run([mk(t.short, t.pct, t.memPct)]);
  const got = r.spawn[0];
  const e = r.evidence[0];
  const ok = !!got && got.speed === t.wantSpeed && got.amplitude === t.wantAmp
    && r.evidence.length === 1 && !!e && e.key === t.wantKey && e.speed === t.wantSpeed && e.dev === t.short;
  if (!ok) bad++;
  console.log((ok ? '  ✓ ' : '  ✗ ') + t.short + ' 真帧 ' + t.pct + ' % ⇒ 那一档 ' + t.wantKey
    + ' ⇒ 自然路径这一圈 speed=' + (got ? got.speed : '没撒') + ' amplitude=' + (got ? got.amplitude : '-')
    + '｜取证 ' + r.evidence.length + ' 条' + (e ? '：' + e.key + ' speed=' + e.speed + ' dev=' + e.dev : ''));
}

console.log('\n── ② 正对照：三台同跑，撒出的环必须是三种不同的值（并成一档的话上面会三条全绿）');
{
  const r = run(REAL.map((t) => mk(t.short, t.pct, t.memPct)));
  const speeds = [...new Set(r.spawn.map((s) => s.speed))].sort((a, b) => a - b);
  const ok = speeds.length === 3 && speeds.join(',') === '8,16,30';
  if (!ok) bad++;
  console.log((ok ? '  ✓ ' : '  ✗ ') + '三档同跑一次 ⇒ 波速出现 ' + speeds.length + ' 种 [' + speeds.join(',') + ']');
  const keys = r.evidence.map((e) => e.key).sort().join(',');
  const ok2 = r.evidence.length === 3 && keys === 'ACTIVE,ALERT,IDLE';
  if (!ok2) bad++;
  console.log((ok2 ? '  ✓ ' : '  ✗ ') + '取证每档只留第一圈、三档齐：'
    + r.evidence.map((e) => e.key + ':' + e.speed + '/' + e.dev).join(' '));
}

console.log('\n── ③ 那根"波速"滑杆真驱动自然路径（六根关联滑杆接没接上的判据）');
{
  const idx = STATES.findIndex((s) => s.key === 'ALERT');
  setGrade('speed', idx, 42);
  const r = run([mk('推理机142', 79.1, 61.0)]);
  const ok = !!r.spawn[0] && r.spawn[0].speed === 42;
  if (!ok) bad++;
  console.log((ok ? '  ✓ ' : '  ✗ ') + '把红档波速推到 42 ⇒ 自然路径这一圈 speed='
    + (r.spawn[0] ? r.spawn[0].speed : '没撒') + '（滑杆改的就是这一行，不是只喂手动撒环那个钩子）');
  setGrade('speed', idx, 30);   // 复原：STATES 是全模块共用真源，不还原会污染下面的用例
  const back = run([mk('推理机142', 79.1, 61.0)]);
  const ok2 = !!back.spawn[0] && back.spawn[0].speed === 30;
  if (!ok2) bad++;
  console.log((ok2 ? '  ✓ ' : '  ✗ ') + '复原后仍读到 30（正对照：改得动也改得回，量的确实是同一个源）');
}

console.log('\n── ④⑤ 没有档就不能有圈（关机 / 有地址但还没抓到帧）');
{
  const r = run([mk('关机机', 90.0, 70.0, false)]);
  const ok = r.spawn.length === 0 && r.evidence.length === 0;
  if (!ok) bad++;
  console.log((ok ? '  ✓ ' : '  ✗ ') + 'power=false 的那台：撒环 ' + r.spawn.length + ' 圈、取证 '
    + r.evidence.length + ' 条（关机就没有档，不拿 90 % 去荡一圈）');
  const d = mkDev('待抓机', 'atx');
  loads.set(d.id, { pct: null, memPct: null, key: null });
  const r2 = run([d]);
  const ok2 = r2.spawn.length === 0;
  if (!ok2) bad++;
  console.log((ok2 ? '  ✓ ' : '  ✗ ') + '没帧的那台：撒环 ' + r2.spawn.length + ' 圈（没有数就不编档位去荡）');
}

console.log('\n── ⑥ 对账：三档初值没漂、关联滑杆仍是六格');
{
  const speeds = STATES.map((s) => s.speed).join('/');
  const ok = speeds === '8/16/30' && GRADE_KEYS.length === 6;
  if (!ok) bad++;
  console.log((ok ? '  ✓ ' : '  ✗ ') + '三档波速初值 ' + speeds + ' 未漂、关联滑杆 ' + GRADE_KEYS.length
    + ' 格（' + GRADE_KEYS.map((x) => x[0]).join(' ') + '）');
  const iv = STATES.map((s) => s.interval).join('/');
  const ok2 = iv === '3/2/1.2';
  if (!ok2) bad++;
  console.log((ok2 ? '  ✓ ' : '  ✗ ') + '三档节拍初值 ' + iv + ' 未漂（起圈间隔与波速同一张表）');
}

console.log('\n── ⑦ 这份取证要活过刷新（09-25 深夜补：他报"142 刚到过 98"，可我手里那份只剩 ACTIVE/IDLE）');
{
  const r1 = run([mk('推理机142', 79.1, 61.0)]);   // 第一趟：只有红档路过过一次
  const okKey = r1.key === 'hm3d.rippleEvidence.v1';
  if (!okKey) bad++;
  console.log((okKey ? '  ✓ ' : '  ✗ ') + '盘上那格只有一个键名（' + r1.key + '），不是页面里另抄一份');
  const written = r1.ls.dump();
  const okW = !!written && JSON.parse(written).length === 1 && JSON.parse(written)[0].key === 'ALERT';
  if (!okW) bad++;
  console.log((okW ? '  ✓ ' : '  ✗ ') + '撒下那一圈的同时就落了盘：' + (written || '没写'));
  const r2 = run([mk('家悦', 7.0, 40.0)], r1.ls);   // 第二趟 = 刷新后重开页：同一份盘、只有绿档
  const backKeys = r2.evidence.map((e) => e.key + ':' + e.speed).sort().join(' ');
  const okR = backKeys === 'ALERT:30 IDLE:8';
  if (!okR) bad++;
  console.log((okR ? '  ✓ ' : '  ✗ ') + '刷新后重开页 ⇒ 取证里仍是 ' + backKeys
    + '（红档那一圈是上一趟路过时记的，本机现在只有 7 %）');
  const r3 = run([mk('家悦', 7.0, 40.0)], makeStore('{这不是 JSON'));   // 脏盘不许把开页弄崩
  const okC = r3.evidence.length === 1 && r3.evidence[0].key === 'IDLE';
  if (!okC) bad++;
  console.log((okC ? '  ✓ ' : '  ✗ ') + '盘上是脏东西时：开页不抛、当没有存档（读到 '
    + r3.evidence.length + ' 条，全是本次真跑出来的）');
  const r4 = run([mk('推理机142', 79.1, 61.0)], makeStore(JSON.stringify(
    [{ key: 'NOPE', speed: 1 }, { key: 'ALERT', speed: 30, dev: '旧', amplitude: 1.2, intervalS: 3, at: 9 }])));
  const okF = r4.evidence.length === 1 && r4.evidence[0].key === 'ALERT' && r4.evidence[0].dev === '旧';
  if (!okF) bad++;
  console.log((okF ? '  ✓ ' : '  ✗ ') + '盘上有脏条目时只收 STATES 认得的键（NOPE 丢掉、ALERT 留下）：'
    + r4.evidence.map((e) => e.key + '/' + e.dev).join(' ') + '｜"每档只留第一次"这条语义跨刷新照旧成立');
}

console.log('\n' + (bad ? '✗ 自然路径 ' + bad + ' 条不符（上面是差在哪）'
  : '✓ 自然路径 15 条：黄/红两档的环速在真实调用点取到值，滑杆驱动得到、无档不撒圈、取证活过刷新'));
if (bad) process.exitCode = 1;
