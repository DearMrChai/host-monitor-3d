// 三档波速/节拍那六根关联滑杆的闸（2026-09-24 他裁的乙：「应该是三根关联进度条，避免黄色调的比绿色还慢」）。
// 这条断言的形状是"顺序"，不是"某个数对不对" —— 所以每个用例跑完都要把三条不变式再查一遍：
// speed 非降、interval 非升、没有一个值掉出自己的量程。少查这一遍，就等于测了个"这一次恰好没破"。
// 跟 verify-load 同一个套路：截仓库里的原文进 vm 跑，不自造件（自造一份 setGrade 就是测了个假的）。
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// 显式起止标记的对截法：这一段里有好几个 "\n};"，按行首找终点会截在半路，所以终点也写死。
function between(file, startMark, endMark, label, minLines) {
  const src = readFileSync(file, 'utf8');
  const i = src.indexOf(startMark);
  if (i < 0) { console.log('✗ 截不到 ' + label + '（找不到 ' + startMark + '）'); process.exit(1); }
  const j = src.indexOf(endMark, i);
  if (j < 0) { console.log('✗ ' + label + ' 找不到终点 ' + endMark); process.exit(1); }
  const body = src.slice(i, j + endMark.length);
  const n = body.split('\n').length;
  // 正对照：截太少 = 起点或终点写错了却"成功"，那是假绿
  if (n < minLines) { console.log('✗ ' + label + ' 只截到 ' + n + ' 行（应 ≥ ' + minLines + '）＝起点/终点错了'); process.exit(1); }
  console.log('  截出 ' + label + '：' + n + ' 行 / ' + body.length + ' 字节');
  return body;
}

const S_MODEL = 'src/model.mjs';
const parts = [
  between(S_MODEL, 'const STATES = [', '\n];', 'STATES（三档的表，值就住在这里）', 3),
  between(S_MODEL, 'const GRADE_LIMITS = {', '  return n;\n}', 'GRADE_LIMITS + gradeBounds + setGrade + GRADE_KEYS + gradeValues + applyGradeValues（六根关联滑杆的后端）', 40),
];
const S = vm.runInNewContext(parts.join('\n')
  + '\n;({ STATES, gradeBounds, setGrade, GRADE_KEYS, gradeValues, applyGradeValues })');

// 默认值抄一份下来当复位点：每个用例都从同一张表出发，否则前一个用例把顺序拖坏了，后面全在测脏状态
const DEF = JSON.parse(JSON.stringify(S.STATES));
const reset = () => { for (let i = 0; i < DEF.length; i++) Object.assign(S.STATES[i], DEF[i]); };
const sp = () => S.STATES.map((x) => x.speed);
const iv = () => S.STATES.map((x) => x.interval);
const nonDecreasing = (a) => a.every((v, i) => i === 0 || v >= a[i - 1]);
const nonIncreasing = (a) => a.every((v, i) => i === 0 || v <= a[i - 1]);
// 三条不变式：每个用例结尾都跑一遍（"这一条断言过了"不等于"顺序还在"）
function invariants(tag) {
  const a = sp(), b = iv();
  const bad = [];
  if (!nonDecreasing(a)) bad.push('波速反序 ' + a.join('/'));
  if (!nonIncreasing(b)) bad.push('节拍反序 ' + b.join('/'));
  if (a.some((v) => v < 5 || v > 50)) bad.push('波速出量程 ' + a.join('/'));
  if (b.some((v) => v < 0.3 || v > 10)) bad.push('节拍出量程 ' + b.join('/'));
  return bad.length ? tag + '：' + bad.join('；') : '';
}

// 一个用例 = 一次写入 + 期望的生效值（"被夹到多少"就是要断言那个数，不是"没报错"）
const cases = [
  { n: '默认三档（正对照：读出来就得是 8/16/30 与 3.0/2.0/1.2）', w: [], want: { s: [8, 16, 30], i: [3, 2, 1.2] } },
  { n: '绿波速往死里拖到 50 → 被黄顶回 16，黄红一字未动', w: [['speed', 0, 50]], want: { s: [16, 16, 30], i: [3, 2, 1.2] } },
  { n: '红波速往死里拖到 5 → 被黄顶到 16（5~50 的量程先进、再被相邻档夹住）', w: [['speed', 2, 5]], want: { s: [8, 16, 16], i: [3, 2, 1.2] } },
  { n: '黄波速拖到绿之下（7）→ 停在 8：允许等于绿，不允许比绿慢', w: [['speed', 1, 7]], want: { s: [8, 8, 30], i: [3, 2, 1.2] } },
  { n: '先绿拖到 20（生效 16）再把黄拖到 30 → 红跟着被顶到 30，仍不反序', w: [['speed', 0, 20], ['speed', 1, 30]], want: { s: [16, 30, 30], i: [3, 2, 1.2] } },
  { n: '红节拍拖到 10（比黄还长）→ 夹回黄的 2.0：越忙起圈不能更稀', w: [['interval', 2, 10]], want: { s: [8, 16, 30], i: [3, 2, 2] } },
  { n: '绿节拍拖到 0.5（比黄还短）→ 夹回黄的 2.0', w: [['interval', 0, 0.5]], want: { s: [8, 16, 30], i: [2, 2, 1.2] } },
  { n: '步进：红波速 25.4 → 25（step 1）', w: [['speed', 2, 25.4]], want: { s: [8, 16, 25], i: [3, 2, 1.2] } },
  { n: '步进：绿节拍 2.27 → 2.3（step 0.1，且不留浮点残渣）', w: [['interval', 0, 2.27]], want: { s: [8, 16, 30], i: [2.3, 2, 1.2] } },
  { n: '写进 NaN → 整格不动（文件里一个 null 不该把三档打乱）', w: [['speed', 1, 'abc']], want: { s: [8, 16, 30], i: [3, 2, 1.2] } },
  { n: '量程外的 500 → 先进 50 再被相邻档夹（黄还是 16）', w: [['speed', 0, 500]], want: { s: [16, 16, 30], i: [3, 2, 1.2] } },
];

let bad = 0;
for (const c of cases) {
  reset();
  const got = [];
  for (const [field, idx, v] of c.w) got.push(S.setGrade(field, idx, v));
  const a = sp(), b = iv();
  const inv = invariants('不变式破');
  const ok = JSON.stringify(a) === JSON.stringify(c.want.s)
    && JSON.stringify(b) === JSON.stringify(c.want.i) && !inv;
  if (!ok) bad++;
  console.log((ok ? '  ✓ ' : '  ✗ ') + c.n + '  ⇒ 波速 ' + a.join('/') + ' 节拍 ' + b.join('/')
    + '（要 ' + c.want.s.join('/') + ' / ' + c.want.i.join('/') + '）'
    + (got.length ? '  写入返回值 ' + got.join(',') : '') + (inv ? '  ⚠ ' + inv : ''));
}
reset();

// 活动区间本身：三根条各自能动的闭区间 + 步进，滑杆每次重画现取的就是它
// 第三位那个 step 是 2026-09-24 补的：滑杆拿 [min,max] 两元组会把 step 写成字符串 "undefined"，
// 节拍三根退化成整秒一档（默认值 1.2 再也落不回去）。这条只有真 DOM 看得见，所以在这里钉住。
const bounds = [
  { n: '绿波速的区间 = [量程下限 5, 黄 16] + 步进 1', got: S.gradeBounds('speed', 0), want: [5, 16, 1] },
  { n: '黄波速的区间 = [绿 8, 红 30] + 步进 1', got: S.gradeBounds('speed', 1), want: [8, 30, 1] },
  { n: '红波速的区间 = [黄 16, 量程上限 50] + 步进 1', got: S.gradeBounds('speed', 2), want: [16, 50, 1] },
  // interval 是反的：越忙间隔越短，所以下界来自"更忙的那档"、上界来自"更闲的那档"
  { n: '绿节拍的区间 = [黄 2, 量程上限 10] + 步进 0.1', got: S.gradeBounds('interval', 0), want: [2, 10, 0.1] },
  { n: '黄节拍的区间 = [红 1.2, 绿 3] + 步进 0.1', got: S.gradeBounds('interval', 1), want: [1.2, 3, 0.1] },
  { n: '红节拍的区间 = [量程下限 0.3, 黄 2] + 步进 0.1', got: S.gradeBounds('interval', 2), want: [0.3, 2, 0.1] },
];
for (const t of bounds) {
  const ok = JSON.stringify(t.got) === JSON.stringify(t.want);
  if (!ok) bad++;
  console.log((ok ? '  ✓ ' : '  ✗ ') + t.n + '  ⇒ [' + t.got.join(', ') + ']');
}

// 落盘那一头：六个键 ↔ 三档两个字段的对照，读写必须走同一张表（键名只允许出现一次）
const kv = S.gradeValues();
const keysOk = JSON.stringify(Object.keys(kv)) === JSON.stringify(S.GRADE_KEYS.map((x) => x[0]));
console.log((keysOk ? '  ✓ ' : '  ✗ ') + 'gradeValues() 的键 = GRADE_KEYS 那六格：' + Object.keys(kv).join(' '));
if (!keysOk) bad++;

// 手改文件能造出来的最坏情况：三格波速写成完全反序 + 一格越量程。恢复完必须仍是有序的
reset();
const applied = S.applyGradeValues({
  rippleSpeedIdle: 50, rippleSpeedActive: 1, rippleSpeedAlert: 25,
  rippleIntervalIdle: 0.3, rippleIntervalActive: 9, rippleIntervalAlert: 5,
  rippleSpeedUnknown: 77,
});
const inv2 = invariants('反序文件恢复后');
const orderOk = applied === S.GRADE_KEYS.length && !inv2
  && nonDecreasing(sp()) && nonIncreasing(iv());
if (!orderOk) bad++;
console.log((orderOk ? '  ✓ ' : '  ✗ ') + '整份反序的 settings.json 恢复后仍有序 ⇒ 认得 ' + applied + '/'
  + S.GRADE_KEYS.length + ' 格（正对照：少一格就是键名对不上）波速 ' + sp().join('/') + ' 节拍 ' + iv().join('/')
  + (inv2 ? '  ⚠ ' + inv2 : ''));
reset();

console.log('\n' + (bad ? '✗ 三档关联 ' + bad + ' 条不符（上面是差在哪）'
  : '✓ 三档关联 ' + (cases.length + bounds.length + 2) + ' 条：波速/节拍拖不出反序、量程守得住'));
if (bad) process.exitCode = 1;
