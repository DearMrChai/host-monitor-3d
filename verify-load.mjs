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
console.log('\n' + (bad ? '✗ 综合负载 ' + bad + '/' + cases.length + ' 条不符（上面是差在哪）'
  : '✓ 综合负载 ' + cases.length + '/' + cases.length + ' 条全按口径 B'));
if (bad) process.exitCode = 1;
