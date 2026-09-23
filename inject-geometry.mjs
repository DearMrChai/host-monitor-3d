// 临时工具：把 *.mjs 几何内联进两个 HTML（file:// 下浏览器不能 import 本地 ESM）。
import { readFileSync, writeFileSync } from 'node:fs';

const G2_NAMES = ['laptopClosed', 'laptopOpen', 'chassisITX', 'chassisMATX', 'chassisATX', 'chassisEATX', 'nasQNAP', 'switch8', 'routerAX', 'screenContent'];
const G1_NAMES = ['monitor24', 'keyboardFull', 'mouse', 'deskLaptop', 'deskITX', 'deskMATX', 'deskATX', 'deskEATX'];
const MARKER = '// ---------- 以下只属于这一页（原型外壳，不移植进插件） ----------';

function wrap(src, names, header) {
  let body = src
    .replace(/^import \* as THREE from 'three';\s*$/m, '')
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

const g2src = readFileSync('chassis-geometry.mjs', 'utf8');
const g1src = readFileSync('desk-geometry.mjs', 'utf8');
const g2block = wrap(g2src, G2_NAMES, 'const G2 = (() => {');
const g1block = wrap(g1src, G1_NAMES, `const G1 = (() => {\nconst { ${G2_NAMES.join(', ')} } = G2;`);

const f2 = 'silhouette-shelf.html';
writeFileSync(f2, inject(readFileSync(f2, 'utf8'), g2block));

const f1 = 'monitor-wall.html';
writeFileSync(f1, inject(readFileSync(f1, 'utf8'), g2block + '\n' + g1block));

for (const f of [f1, f2]) {
  const s = readFileSync(f, 'utf8');
  console.log(f,
    '| 占位符残留', /export function|^import \* as THREE/m.test(s),
    '| 对数深度', s.includes('logarithmicDepthBuffer: true'),
    '| 内联区行数', s.slice(s.indexOf('const G2'), s.indexOf(MARKER)).split('\n').length);
}
