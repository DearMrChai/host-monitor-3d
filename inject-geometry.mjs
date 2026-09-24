// 临时工具：把 chassis-geometry.mjs 内联进 silhouette-shelf.html（那一页要能 file:// 双击打开，
// 而浏览器不许从 file:// import 本地模块，所以它只能吃拼进去的副本）。
// 监控墙那页 2026-09-24 起改真 import 了，不再进这里 —— 见 docs/移植指引.md。
import { readFileSync, writeFileSync } from "node:fs";

const G2_NAMES = ['laptopClosed', 'laptopOpen', 'chassisITX', 'chassisMATX', 'chassisATX', 'chassisEATX', 'nasQNAP', 'switch8', 'routerAX', 'screenContent'];
const MARKER = '// ---------- 以下只属于这一页（原型外壳，不移植进插件） ----------';

function wrap(src, names, header) {
  let body = src
    .replace(/^import \* as THREE from 'three';\s*$/m, '')
    .replace(/^import \{ THREE \} from '\.\/src\/three\.mjs';\s*$/m, '')
    .replace(/^import \{[^}]*\} from '\.\/chassis-geometry\.mjs';\s*$/m, '')
    .replace(/^export function /gm, 'function ')
    .trimEnd();
  return `${header}\n${body}\n\nreturn { ${names.join(', ')} };\n})();\nconst { ${names.join(', ')} } = ${header.match(/const (\w+)/)[1]};\n`;
}

function inject(html, block) {
  const start = html.indexOf('const G2 = (() => {');
  const end = html.indexOf(MARKER);
  if (start < 0 || end < 0 || end < start) throw new Error(`${html.slice(0, 40)}… 找不到内联区`);
  return html.slice(0, start) + block + '\n' + html.slice(end);
}

const f = 'silhouette-shelf.html';
writeFileSync(f, inject(readFileSync(f, 'utf8'), wrap(readFileSync('chassis-geometry.mjs', 'utf8'), G2_NAMES, 'const G2 = (() => {')));

{
  const s = readFileSync(f, 'utf8');
  console.log(f,
    '| 占位符残留', /export function|^import /m.test(s),
    '| 对数深度', s.includes('logarithmicDepthBuffer: true'),
    '| 内联区行数', s.slice(s.indexOf('const G2'), s.indexOf(MARKER)).split('\n').length);
}
