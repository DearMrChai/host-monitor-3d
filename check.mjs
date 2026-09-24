// 一条命令的自检：语法（含 HTML 里那段模块体）→ 几何注入 → 几何对账 → CPU 并卡口径 → 综合负载口径 → 三档关联（波速/节拍拖不出反序）→ 访问分权（两扇门与脱敏）。
// 为什么不引 linter：这一仓库的纪律是零构建，`node --check` 就是唯一门槛（见 README「怎么跑」）。
// HTML 那段必须单独提出来量：它占整页 3200 多行，而 node 不认 .html。
import { readFileSync, writeFileSync, unlinkSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

function check(label, code, file) {
  writeFileSync(file, code);
  const r = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  unlinkSync(file);
  if (r.status !== 0) {
    console.log('✗', label, '\n' + (r.stderr || '').trim().split('\n').slice(0, 6).join('\n'));
    process.exitCode = 1;
    return false;
  }
  const n = code.split('\n').length;
  console.log('✓', label, n, '行');
  return true;
}

// HTML 里 <script type="module"> 的那一体（含 file:// 兜底那段经典脚本之外的全部）
const html = readFileSync('monitor-wall.html', 'utf8');
const a = html.indexOf('<script type="module">');
const body = html.slice(a + '<script type="module">'.length, html.indexOf('</script>', a));
check('monitor-wall.html 模块体', body, '_check_wall.mjs');

// 根目录 + src/ + probe/ 下的 .mjs 全过一遍：拆出去的每一刀都自动进门，不用改这里
// （目录在加，扫描的清单也得跟着加 —— 2026-09-24 step5 把两段抓机器的脚本搬进 probe/ 时才撞见这条）
const modFiles = [
  ...readdirSync('.').filter((x) => x.endsWith('.mjs')),
  ...readdirSync('src').filter((x) => x.endsWith('.mjs')).map((x) => 'src/' + x),
  ...readdirSync('probe').filter((x) => x.endsWith('.mjs')).map((x) => 'probe/' + x),
];
for (const f of modFiles) {
  if (f === 'check.mjs' || f.startsWith('_check_')) continue;
  check(f, readFileSync(f, 'utf8'), '_check_one.mjs');
}

for (const step of ['inject-geometry.mjs', 'verify-geometry.mjs', 'verify-cpu.mjs', 'verify-load.mjs', 'verify-grade.mjs', 'verify-access.mjs']) {
  const r = spawnSync(process.execPath, [step], { encoding: 'utf8' });
  process.stdout.write(r.stdout || '');
  if (r.status !== 0) {
    console.log('✗', step, '\n' + (r.stderr || '').trim());
    process.exitCode = 1;
    break;
  }
}
console.log(process.exitCode ? '\n自检未过（上面是差在哪一行）' : '\n自检全过');
