// 「一物理核一张卡」这条的自检（2026-09-24，用户那条"点开之后还是显示线程，不是核心"的账）。
// 为什么单独有这一个文件：混合架构（P/E）那台机器不是随时在线，而"并卡"错了在屏上看不出来
// —— 空闲机器 12 张卡跟 6 张卡看起来都对。所以把它做成不联网、不开浏览器就能核的一条断言。
// 为什么是**截原文**而不是 import：dashboard.mjs 顶层就取 DOM（document.getElementById），
//   node 里 import 直接崩。截 liveCpu 那一段 = 测的是仓库里那 25 行字节，不是另抄的一份。
// 正对照（R-6 口径：凡是"0 个/没找到"的读数必须先证明仪器在跑）：
//   截图本身会打印行数与字节数；下面的用例期望值全部来自本机 i9-12900H 用同一段 PowerShell 直跑量到的真数。
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const src = readFileSync('src/dashboard.mjs', 'utf8');
const i = src.indexOf('const liveCpu = (f) => {');
const j = src.indexOf('\n};', i);
if (i < 0 || j < 0) { console.log('✗ verify-cpu：截不到 liveCpu（i=' + i + ' j=' + j + '），源码里那个声明改名了'); process.exit(1); }
const body = src.slice(i, j + 3);
const lines = body.split('\n').length;
if (lines < 10) { console.log('✗ verify-cpu：只截到 ' + lines + ' 行，肯定不是整段'); process.exit(1); }
console.log('✓ verify-cpu：截出 liveCpu ' + lines + ' 行 / ' + body.length + ' 字节（正对照）');
const liveCpu = vm.runInNewContext(body + '; liveCpu');

// 本机 12900H 实测：20 个逻辑处理器 / 14 个物理核（6 个 P 各 2 线程 + 8 个 E 各 1 线程）
const P20 = [5, 95, 12, 30, 0, 7, 3, 2, 1, 0, 4, 6, 40, 20, 10, 5, 3, 2, 1, 0];
const CORE14 = [0, 0, 2, 2, 4, 4, 6, 6, 8, 8, 10, 10, 12, 13, 14, 15, 16, 17, 18, 19];
const CASES = [
  { 名: '本机 12900H（混合架构：6P+8E）', f: { cpu: { perCore: P20, coreMap: CORE14,
      pcls: [...Array(12).fill('P'), ...Array(8).fill('E')] } },
    卡: 14, 核: true, P: 6, E: 8, 线程: 20, 首卡占用: 95 },
  { 名: '142 那台 linux（Ryzen5 5600：6 核 12 线程，无 PCLS）', f: { cpu: { perCore: [1, 2, 3, 4, 5, 6, 70, 8, 9, 10, 11, 12],
      coreMap: [0, 1, 2, 3, 4, 5, 0, 1, 2, 3, 4, 5] } }, 卡: 6, 核: true, P: 0, E: 0, 线程: 12, 首卡占用: 70 },
  { 名: '没有核映射（老探针）→ 退回一逻辑处理器一张卡', f: { cpu: { perCore: [10, 20, 30, 40] } },
    卡: 4, 核: false, P: 0, E: 0, 线程: 0, 首卡占用: 10 },
  { 名: '映射长度不等（必须整段不认，不按下标猜）', f: { cpu: { perCore: [10, 20, 30, 40], coreMap: [0, 0, 1] } },
    卡: 4, 核: false, P: 0, E: 0, 线程: 0, 首卡占用: 10 },
];

let bad = 0;
for (const c of CASES) {
  const cards = liveCpu(c.f);
  const got = { 卡: cards.length, 核: cards.every((x) => !!x.core),
    P: cards.filter((x) => x.kind === 'P').length, E: cards.filter((x) => x.kind === 'E').length,
    线程: cards.reduce((a, x) => a + x.threads.length, 0), 首卡占用: cards[0] && cards[0].usage };
  const 差 = Object.keys(got).filter((k) => String(got[k]) !== String(c[k]));
  if (差.length) { bad++; console.log('✗', c.名, '差在：' + 差.map((k) => k + '=' + got[k] + '(应 ' + c[k] + ')').join(' ')); }
  else console.log('✓', c.名, '→', got.卡, '张卡 /', got.线程, '线程 / P', got.P, 'E', got.E);
}
console.log(bad ? '\n✗ verify-cpu：' + bad + ' 个用例不对' : '\n✓ verify-cpu 全过');
process.exit(bad ? 1 : 0);
