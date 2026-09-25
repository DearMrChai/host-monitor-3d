// 口径 B 的闸（2026-09-24 他裁）：综合负载 = max(CPU 占用, GPU 利用率)，内存只越线抬一档。
// 为什么截原文而不是另抄一份：这三段（framePct / frameGpuPct+frameMemPct+realLoadOf / STATES+stateOf+gradeOf）
// 分家住在三个文件里，抄一份进测试就等于测了个假件 —— 截的是仓库里那些字节本身。
// 断言的形状：每条都写"旧口径（只看 CPU）会给什么"，因为这条改动的全部意义就是那几台 GPU 打满、CPU 空闲的机器。
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// 从 startMark 起截到 fromMark 之后第一个 "\n};"（含）：三处箭头函数都是块体、闭合都在行首，所以够用。
// 一段里塞了三个函数时（ground 那刀），fromMark 指到**最后一个**函数的开头，不然会截在半路。
function slice(file, startMark, label, minLines, fromMark = startMark) {
  const src = readFileSync(file, 'utf8');
  const i = src.indexOf(startMark);
  if (i < 0) { console.log('✗ 截不到 ' + label + '（' + file + ' 里找不到 ' + startMark + '）'); process.exit(1); }
  const k = src.indexOf(fromMark, i);
  const j = k < 0 ? -1 : src.indexOf('\n};', k);
  if (j < 0) { console.log('✗ ' + label + ' 找不到结尾的 "\\n};"'); process.exit(1); }
  const body = src.slice(i, j + 3);
  const n = body.split('\n').length;
  // 正对照：截出来的行数必须像个函数。0~2 行 = 起点写错了却"成功"，那是假绿
  if (n < minLines) { console.log('✗ ' + label + ' 只截到 ' + n + ' 行（应 ≥ ' + minLines + '）＝起点/终点错了'); process.exit(1); }
  console.log('  截出 ' + label + '：' + n + ' 行 / ' + body.length + ' 字节');
  return body;
}

// clampv 也截原文：自己另写一份"看起来等价"的，等于给 framePct 换了个被测件
function sliceLine(file, startMark, label) {
  const src = readFileSync(file, 'utf8');
  const i = src.indexOf(startMark);
  if (i < 0) { console.log('✗ 截不到 ' + label); process.exit(1); }
  const line = src.slice(i, src.indexOf('\n', i));
  console.log('  截出 ' + label + '：' + line.length + ' 字节');
  return line;
}

const S_DASH = 'src/dashboard.mjs', S_GROUND = 'src/ground.mjs', S_MODEL = 'src/model.mjs';
const parts = [
  sliceLine('src/format.mjs', 'const clampv =', 'clampv（外部件）'),
  slice(S_DASH, 'const framePct = (f) => {', 'framePct（CPU 那一维）', 5),
  slice(S_GROUND, 'const frameGpuPct = (f) => {', 'frameGpuPct + frameMemPct + realLoadOf（GPU 那一维与合成）', 18,
    'const realLoadOf = (d) => {'),
  slice(S_MODEL, 'const STATES = [', 'STATES + stateOf + MEM_BOOST_PCT + gradeOf（定档）', 10,
    'const gradeOf = (pct, memPct) => {'),
];
const run = vm.runInNewContext(
  parts.join('\n')
  + '\n;({ realLoadOf, frameGpuPct, frameMemPct, gradeOf, stateOf, STATES })'
);

// 一帧的最小形状：只有这三个数参与，别的字段一概不给，免得测试偷偷依赖上没在口径里的东西
const mk = ({ cpu, gpu, gpus, memUsedMb, memTotalMb }) => ({
  cpuPct: cpu == null ? undefined : cpu,
  gpu: gpu == null ? null : { util: gpu },
  gpus: gpus || [],
  memUsedMb, memTotalMb,
});

const cases = [
  // 142 跑推理的实际形状：两张卡吃满、CPU 只有个位数
  { n: '双卡 97/93 + CPU 4（142 推理时）', f: mk({ cpu: 4, gpus: [{ util: 97 }, { util: 93 }] }),
    want: { pct: 97, key: 'ALERT' }, old: 'IDLE' },
  { n: '单卡 util 55 + CPU 20（Windows 老字段那条）', f: mk({ cpu: 20, gpu: 55 }),
    want: { pct: 55, key: 'ACTIVE' }, old: 'IDLE' },
  // 缺的那一维必须整条退出，不能当 0 —— 138 / 195 就是这种（核显，没有 nvidia-smi）
  { n: '只有 CPU 12、一帧都没有 GPU（无 nvidia-smi）', f: mk({ cpu: 12 }),
    want: { pct: 12, key: 'IDLE' }, old: 'IDLE' },
  { n: '只有 GPU 88、CPU 拿不到（linux 探针没回 cpuPct）', f: mk({ cpu: null, gpus: [{ util: 88 }] }),
    want: { pct: 88, key: 'ALERT' }, old: 'null（不判档）' },
  { n: 'GPU 只有型号没指标（util 缺）→ 不算 0', f: mk({ cpu: 6, gpus: [{ util: undefined }] }),
    want: { pct: 6, key: 'IDLE' }, old: 'IDLE' },
  // 内存只抬"空闲→活跃"这一档，抬不到高负载
  { n: 'CPU 4 + 内存 95 % → 抬成活跃', f: mk({ cpu: 4, memUsedMb: 15200, memTotalMb: 16000 }),
    want: { pct: 4, key: 'ACTIVE' }, old: 'IDLE' },
  { n: 'CPU 4 + 内存 91.9 % → 不抬（门槛之下）', f: mk({ cpu: 4, memUsedMb: 91.9, memTotalMb: 100 }),
    want: { pct: 4, key: 'IDLE' }, old: 'IDLE' },
  { n: 'CPU 4 + 内存 92.0 % → 抬（门槛含等号）', f: mk({ cpu: 4, memUsedMb: 92, memTotalMb: 100 }),
    want: { pct: 4, key: 'ACTIVE' }, old: 'IDLE' },
  { n: 'CPU 50 + 内存 95 % → 本来就活跃，不双抬', f: mk({ cpu: 50, memUsedMb: 95, memTotalMb: 100 }),
    want: { pct: 50, key: 'ACTIVE' }, old: 'ACTIVE' },
  { n: 'CPU 80 + 内存 99 % → 高负载（内存不再往上顶，本来就封顶）', f: mk({ cpu: 80, memUsedMb: 99, memTotalMb: 100 }),
    want: { pct: 80, key: 'ALERT' }, old: 'ALERT' },
  { n: '内存字段缺（老探针）→ 那一维不参与', f: mk({ cpu: 4 }),
    want: { pct: 4, key: 'IDLE' }, old: 'IDLE' },
  // 没有帧 = 没有数，不编档位（今晚刚立的纪律，这条改动的口径不能把它冲掉）
  { n: '没有帧 → pct null、不判档', f: undefined, want: { pct: null, key: null }, old: 'null（不判档）' },
];

let bad = 0;
for (const c of cases) {
  const d = { frame: c.f };
  const pct = run.realLoadOf(d);
  const memPct = run.frameMemPct(c.f);
  const st = pct == null ? null : run.gradeOf(pct, memPct);
  const key = st ? st.key : null;
  const ok = pct === c.want.pct && key === c.want.key;
  if (!ok) bad++;
  console.log(
    (ok ? '  ✓ ' : '  ✗ ') + c.n
    + '  ⇒ pct=' + pct + ' 档=' + (key || '—')
    + '（要 pct=' + c.want.pct + ' 档=' + (c.want.key || '—') + '；旧口径只看 CPU 会给 ' + c.old + '）'
  );
}
// ── ⑦ 服务端日志那一行的原始数（2026-09-25 深夜）───────────────────────────────
// 为什么要在这里测：他报"142 最近应该又一次超过 70 负载 98（我看到了画面）"，可我手里那份取证只剩 ACTIVE/IDLE
// —— 页面那头的记录要"有人开着页 + 帧在跑"才攒得到。服务端每轮都拿到了这一帧，却在日志里只留一个 "OK"，
// 于是"发生过"跟"没证据"长得一模一样。现在 OK 那行带上三个原始数。
// ⚠ 这一闸同时守着一句反面要求：**服务端不许长出第二份判据**（口径 B 只有一个家，在 src/model.mjs）。
{
  const srv = readFileSync('serve.mjs', 'utf8');
  const i = srv.indexOf('function framePeek(frame) {');
  const j = i < 0 ? -1 : srv.indexOf('\n}\n', i);
  if (i < 0 || j < 0) { console.log('✗ 截不到 framePeek（serve.mjs 里那段改了名或改了形状）'); process.exit(1); }
  const peekSrc = srv.slice(i, j + 2);
  console.log('\n── ⑦ 服务端 OK 那行的原始数（framePeek 截原文，' + peekSrc.split('\n').length + ' 行）');
  if (peekSrc.split('\n').length < 5) { console.log('✗ 只截到几行 = 起点/终点错了，本闸空转'); process.exit(1); }
  const ctx = vm.createContext({ Math });
  vm.runInContext(peekSrc + '\nthis.__peek = framePeek;', ctx, { filename: 'serve-framePeek-seg.mjs' });
  const peek = ctx.__peek;
  const peekCases = [
    // 形状照 serve.mjs 归一化那一段抄：逐张在 `gpus`（142 两张 2080 Ti 走这里），老字段 `gpu` 只是 nvidia-smi 第一行。
    // ⚠ 值有真有合成：cpu/mem 两格是 09-25 真帧上的数，那张 98 % 是他口述的那一次（我没能在那一刻抓到帧）⇒
    //   这一例测的是"取 max"这个形状，不是"142 到过 98"的证据（那条账归服务日志，从今天起才留得下）。
    { n: '142 双卡形状（逐张两张 29.5 / 合成 98）⇒ gpu=98（取 max，不是取第一张、不是取平均）',
      f: { cpuPct: 6, memUsedMb: 5786, memTotalMb: 15912, gpu: { util: 29.5 }, gpus: [{ util: 29.5 }, { util: 98 }] },
      want: '  cpu=6 gpu=98 mem=36.4%' },
    { n: '单卡（笔记本真帧：cpu 42 / 显存 374 of 4096 / 卡 25）',
      f: { cpuPct: 42, memUsedMb: 13468, memTotalMb: 16125, gpu: { util: 25 } },
      want: '  cpu=42 gpu=25 mem=83.5%' },
    { n: '取不到卡 ⇒ gpu=-（不是 0，0 是"这一秒真没活"）', f: { cpuPct: 1, memUsedMb: 100, memTotalMb: 1000, gpu: null },
      want: '  cpu=1 gpu=- mem=10.0%' },
    { n: '内存总数字段缺 ⇒ mem=-（不拿 0 % 假装）', f: { cpuPct: 3, gpu: { util: 0 } }, want: '  cpu=3 gpu=0 mem=-' },
    { n: '第一张卡空着、第二张在忙 ⇒ 仍报 98（"这台空着"要看逐张那一栏）',
      f: { cpuPct: 2, memUsedMb: 0, memTotalMb: 1000, gpu: { util: 0 }, gpus: [{ util: 0 }, { util: 98 }] },
      want: '  cpu=2 gpu=98 mem=0.0%' },
    { n: '这一轮压根没帧 ⇒ 空串（老那句 "OK" 一字不变）', f: null, want: '' },
  ];
  for (const c of peekCases) {
    const got = peek(c.f);
    const ok = got === c.want;
    if (!ok) bad++;
    console.log((ok ? '  ✓ ' : '  ✗ ') + c.n + ' ⇒ "' + got + '"' + (ok ? '' : '（要 "' + c.want + '"）'));
  }
  // 两处 logProbe（自动轮 + 页面上"催一轮"那只按钮）都要带，少一处就是那一头的账还是空的
  const wired = (srv.match(/r\.ok \? framePeek\(r\.frame\)/g) || []).length;
  const okWired = wired === 2;
  if (!okWired) bad++;
  console.log((okWired ? '  ✓ ' : '  ✗ ') + '两处 logProbe 都接上了 peek（' + wired + '/2）：自动轮与手动催抓不留两种口径');
  const noJudge = !/gradeOf|levelOf|from "\.\/src\/model\.mjs"/.test(srv);
  if (!noJudge) bad++;
  console.log((noJudge ? '  ✓ ' : '  ✗ ') + '服务端没长出第二份判据（不 import model.mjs、没有 gradeOf/levelOf）'
    + ' ⇒ 档位只有一个家：src/model.mjs 的口径 B');
}

console.log('\n' + (bad ? '✗ 综合负载 / 原始数 ' + bad + ' 条不符（上面是差在哪）'
  : '✓ 综合负载 ' + cases.length + '/' + cases.length + ' 条全按口径 B，另有 framePeek 6 条 + 接线 2 条'));
if (bad) process.exitCode = 1;
