// 几何校验：① 监控墙已撤内联副本 + 剪影架那份可跑 ② 内联 vs .mjs 逐项一致
// ③ 规格包围盒 + 同侧重合清点 ④ 正面相机首击（观众实际看见哪个面）⑤ 定点射线 ⑥ 屏盖局部系实量
import { readFileSync, writeFileSync, unlinkSync, existsSync } from 'node:fs';
import * as THREE from 'three';

const MARKER = '// ---------- 以下只属于这一页（原型外壳，不移植进插件） ----------';
const G2_NAMES = ['laptopClosed', 'laptopOpen', 'chassisITX', 'chassisMATX', 'chassisATX', 'chassisEATX', 'nasQNAP', 'switch8', 'routerAX', 'screenContent'];
const G1_NAMES = ['monitor24', 'keyboardFull', 'mouse', 'deskLaptop', 'deskITX', 'deskMATX', 'deskATX', 'deskEATX'];
const EPS = 0.01;

function extract(htmlFile, names) {
  const s = readFileSync(htmlFile, 'utf8');
  const a = s.indexOf('const G2 = (() => {');
  const b = s.indexOf(MARKER);
  const region = s.slice(a, b);
  // 文件名必须唯一：ESM 按 URL 缓存，两次 import 同一路径会拿到第一次的模块
  const tmp = `_inline_${htmlFile.replace(/[^a-z0-9]/gi, '_')}.mjs`;
  writeFileSync(tmp, `import * as THREE from 'three';\n${region}\nexport { ${names.join(', ')} };\n`);
  TEMPS.push(tmp);
  return import('./' + tmp);
}
const TEMPS = [];

function bbox(g) {
  const b = new THREE.Box3().setFromObject(g);
  return [b.max.x - b.min.x, b.max.y - b.min.y, b.max.z - b.min.z, b.min.y];
}
function meshes(g) {
  const out = [];
  g.updateMatrixWorld(true);
  g.traverse((o) => { if (o.isMesh) out.push(o); });
  return out;
}
// 世界 AABB（旋转件会糊，只做初筛；命中后按轴对齐的面配对才算）
function worldBox(m) {
  m.geometry.computeBoundingBox();
  return m.geometry.boundingBox.clone().applyMatrix4(m.matrixWorld);
}
function coincidences(g, tag) {
  const ms = meshes(g);
  const boxes = ms.map(worldBox);
  const hits = [];
  for (let i = 0; i < ms.length; i++) for (let j = i + 1; j < ms.length; j++) {
    const A = boxes[i], B = boxes[j];
    for (const ax of ['x', 'y', 'z']) {
      const u = ax === 'x' ? 'y' : ax === 'y' ? 'z' : 'x';
      const v = ax === 'x' ? 'z' : ax === 'y' ? 'x' : 'y';
      const ovU = Math.min(A.max[u], B.max[u]) - Math.max(A.min[u], B.min[u]);
      const ovV = Math.min(A.max[v], B.max[v]) - Math.max(A.min[v], B.min[v]);
      if (!(ovU > EPS && ovV > EPS)) continue;
      const sameMax = Math.abs(A.max[ax] - B.max[ax]) < EPS;
      const sameMin = Math.abs(A.min[ax] - B.min[ax]) < EPS;
      if (sameMax || sameMin) hits.push(`${ms[i].name}↔${ms[j].name}(${ax}${sameMax ? 'max' : 'min'} ${ovU.toFixed(1)}×${ovV.toFixed(1)})`);
    }
  }
  console.log(`  ${tag} 同侧重合 ${hits.length}${hits.length ? '：' + [...new Set(hits)].join(' ') : ''}`);
  return hits;
}
// 正面相机：把物体正好框满（否则窄高的机箱只占几格，读数没法比），从 +z 往 -z 打 40×40 网格射线
function frontHits(g, tag) {
  const b = new THREE.Box3().setFromObject(g);
  const size = new THREE.Vector3(); b.getSize(size);
  const center = new THREE.Vector3(); b.getCenter(center);
  const fov = 30;
  const aspect = size.x / size.y;
  const dist = (Math.max(size.x / aspect, size.y) / 2) / Math.tan(THREE.MathUtils.degToRad(fov / 2)) * 1.08;
  const cam = new THREE.PerspectiveCamera(fov, aspect, 1, dist * 4);
  cam.position.set(center.x, center.y, b.max.z + dist);
  cam.lookAt(center);
  cam.updateMatrixWorld(true);
  const rc = new THREE.Raycaster();
  rc.near = 1; rc.far = dist * 4;
  const N = 40; const tally = {};
  for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) {
    rc.setFromCamera(new THREE.Vector2((i + 0.5) / N * 2 - 1, (j + 0.5) / N * 2 - 1), cam);
    const hit = rc.intersectObject(g, true)[0];
    const k = hit ? hit.object.name : '·';
    tally[k] = (tally[k] || 0) + 1;
  }
  console.log(`  ${tag} 正面首击 ${N * N} 格：` + Object.entries(tally).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k}:${n}`).join(' '));
  return tally;
}
function diffTally(oldT, newT, tag) {
  const keys = new Set([...Object.keys(oldT), ...Object.keys(newT)]);
  const lines = [];
  let moved = 0;
  for (const k of keys) {
    const a = oldT[k] || 0, c = newT[k] || 0;
    if (a !== c) { lines.push(`${k} ${a}→${c}`); moved += Math.abs(c - a); }
  }
  console.log(`  ${tag} 改前/改后差异：${lines.length ? lines.join('  ') : '无'}（共 ${moved / 2} 格换了归属）`);
}

const SPEC = {
  chassisITX: [185, 376, 292],
  nasQNAP: [148, 220, 182], switch8: [158, 25, 100], // routerAX 故意不进表：它的高度含天线，见下面 ③ 打印
  chassisMATX: [205, 440, 347.5], chassisATX: [212, 409, 453], chassisEATX: [240, 503, 509],
  laptopClosed: [317.7, 17.9, 226.9], laptopOpen: [317.7, 232.7, 279.6],
  monitor24: [537.6, 430, 179.6], keyboardFull: [440, 35, 130], mouse: [63.5, 40, 125],
  deskLaptop: [490.6, 232.7, 348.7], deskMATX: [861.3, 440, 626.3], deskATX: [914.8, 430, 709], deskEATX: [998.8, 503, 787],
};

const src2 = await import('./chassis-geometry.mjs');
const src1 = await import('./desk-geometry.mjs');
const inl2 = await extract('silhouette-shelf.html', G2_NAMES);

// 监控墙那页已经改真 import 了（2026-09-24），所以对它要验的事换了一条：内联副本必须彻底没了、
// 且两条 import 在位。留着这条断言是因为 inject-geometry 以前写的是两个文件——手滑改回去要立刻看见。
{
  const s = readFileSync('monitor-wall.html', 'utf8');
  console.log('① 监控墙：内联副本已撤', !s.includes('const G2 = (() => {'),
    '| chassis import', s.includes('from "./chassis-geometry.mjs"'),
    '| desk import', s.includes('from "./desk-geometry.mjs"'),
    '| THREE 单一来源', s.includes('from "./src/three.mjs"') && !/await import\(["']three["']\)/.test(s),
    '；剪影架：内联副本可跑，chassis', Object.keys(inl2).length, '个导出');
}

console.log('\n② 内联 vs .mjs 逐项比对（包围盒 + 件数 + 每件世界 AABB）· 只剩剪影架这一份内联副本');
for (const [name, mod] of Object.entries(pick(src2, inl2, G2_NAMES))) {
  if (name === 'screenContent') continue;
  const [a, b] = mod;
  const ga = a(), gb = b();
  const ba = bbox(ga), bb = bbox(gb);
  const ma = meshes(ga), mb = meshes(gb);
  let diff = 0;
  for (let i = 0; i < Math.max(ma.length, mb.length); i++) {
    const wa = ma[i] && worldBox(ma[i]), wb = mb[i] && worldBox(mb[i]);
    if (!wa || !wb) { diff++; continue; }
    for (const ax of ['x', 'y', 'z']) if (Math.abs(wa.min[ax] - wb.min[ax]) > EPS || Math.abs(wa.max[ax] - wb.max[ax]) > EPS) diff++;
    if (ma[i].name !== mb[i].name) diff++;
  }
  console.log(`  ${name.padEnd(14)} 包围盒 ${ba.map((n) => n.toFixed(1)).join('×')} vs ${bb.map((n) => n.toFixed(1)).join('×')} | 件数 ${ma.length}/${mb.length} | 逐件差异 ${diff}`);
}
function pick(a, b, names) {
  const o = {};
  for (const n of names) o[n] = [a[n], b[n]];
  return o;
}

console.log('\n③ 规格包围盒（真数）+ 同侧重合清点（.mjs 源）');
for (const name of [...G2_NAMES, ...G1_NAMES]) {
  if (name === 'screenContent') continue;
  const g = (name in src2 ? src2 : src1)[name]();
  const [w, h, d, minY] = bbox(g);
  const s = SPEC[name] || [w, h, d];
  const ok = Math.abs(w - s[0]) < 0.06 && Math.abs(h - s[1]) < 0.06 && Math.abs(d - s[2]) < 0.06 && Math.abs(minY) < 0.06;
  console.log(`  ${name.padEnd(14)} ${w.toFixed(1)} × ${h.toFixed(1)} × ${d.toFixed(1)}  minY ${minY.toFixed(2)}  规格 ${ok ? 'OK' : '不符 ' + s.join('×')}`);
  coincidences(g, '  ');
}

console.log('\n④ 正面相机首击（框满取景；有 _prev.mjs 就顺带出改前/改后差异）');
const prev = existsSync('./_prev.mjs') ? await import('./_prev.mjs') : null;
for (const name of ['chassisMATX', 'chassisATX', 'chassisEATX', 'laptopClosed']) {
  const t = frontHits(src2[name](), name);
  if (prev && prev[name]) diffTally(frontHits(prev[name](), '改前'), t, name);
}
const tOpen = frontHits(src2.laptopOpen(), 'laptopOpen');
if (prev) diffTally(frontHits(prev.laptopOpen(), '改前'), tOpen, 'laptopOpen');
frontHits(src1.monitor24(), 'monitor24');

console.log('\n⑤ 定点射线：正面中心 / 电源灯 两处，看最前面是谁');
for (const name of ['chassisMATX', 'chassisATX', 'chassisEATX']) {
  const g = src2[name]();
  g.updateMatrixWorld(true);
  const b = new THREE.Box3().setFromObject(g);
  const led = meshes(g).find((m) => m.name === 'power-led');
  const probe = (x, y, tag) => {
    const rc = new THREE.Raycaster(new THREE.Vector3(x, y, b.max.z + 5000), new THREE.Vector3(0, 0, -1));
    return `${tag}: ` + rc.intersectObject(g, true).slice(0, 3).map((h) => `${h.object.name}@${h.point.z.toFixed(1)}`).join(' → ');
  };
  console.log(`  ${name.padEnd(13)} ${probe(0, b.max.y * 0.5, '中心')} | ${probe(led.position.x, led.position.y, '电源灯')}`);
  console.log(`               外壳前表面 z=${(b.max.z - 2).toFixed(1)}、前面板 z=${(b.max.z - 1).toFixed(1)}、规格极值 z=${b.max.z.toFixed(1)}`);
}

// ③ 里那条 laptop-screen↔screen-linux-bar 是世界 AABB 被 75° 转轴糊出来的假阳性。
// 斜着的件要回到它自己的局部系量，这里就地复核一遍。
console.log('\n⑥ 屏盖局部系实量（复核 ③ 那条假阳性）');
{
  const g = src2.laptopOpen(); g.updateMatrixWorld(true);
  const pivot = g.getObjectByName('laptop-lid-pivot');
  const strip = new THREE.Matrix4().copy(pivot.matrixWorld).invert();
  const inLid = (o) => {
    o.geometry.computeBoundingBox();
    return o.geometry.boundingBox.clone().applyMatrix4(new THREE.Matrix4().multiplyMatrices(strip, o.matrixWorld));
  };
  const S = inLid(pivot.children.find((o) => o.name === 'laptop-screen'));
  const qs = pivot.children.find((o) => o.name === 'screen-content').children;
  const lo = Math.min(...qs.map((q) => inLid(q).min.y));
  console.log(`  玻璃 y ${S.min.y.toFixed(2)}~${S.max.y.toFixed(2)}，内容层最低 y ${lo.toFixed(2)}，间隙 ${(lo - S.max.y).toFixed(2)} mm`);
  let bad = 0;
  for (let i = 0; i < qs.length; i++) for (let j = i + 1; j < qs.length; j++) {
    const A = inLid(qs[i]), B = inLid(qs[j]);
    for (const ax of ['x', 'y', 'z']) {
      if (!(Math.abs(A.max[ax] - B.max[ax]) < EPS || Math.abs(A.min[ax] - B.min[ax]) < EPS)) continue;
      const u = ax === 'x' ? 'y' : 'z', v = ax === 'x' ? 'z' : 'y';
      if (Math.min(A.max[u], B.max[u]) - Math.max(A.min[u], B.min[u]) > EPS
        && Math.min(A.max[v], B.max[v]) - Math.max(A.min[v], B.min[v]) > EPS) {
        bad++; console.log(`  ⚠ 内容层同面重叠 ${qs[i].name} ${qs[j].name} (${ax})`);
      }
    }
  }
  console.log(`  内容层两两同面重叠 ${bad} 处（0=干净）`);
}

for (const t of TEMPS) unlinkSync(t);
