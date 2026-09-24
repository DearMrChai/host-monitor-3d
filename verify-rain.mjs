// #39 二进制雨"2 + 1"的闸（2026-09-24 他挑的：2 = 字会在落下时换，1 = 更亮更密）。
// 两件事的形状不一样，所以闸也不是一种：
//   ① 换字那步的表达式是从 ground.mjs 里**截原文**跑的（同 verify-grade 的纪律）——
//      "换字要真的换一个"这件事自造一份测试版就成了测我自己，截原文才测得到屏上那一份。
//   ② 图集 / 着色器补丁 / drawRange / 落盘键位这些是"接错就整片不亮"的结构性断言，只能钉文本。
// 观感（够不够亮、密到什么程度算糊）不在这张闸里 —— 那是他的眼睛，这里只保证数对得上。
import { readFileSync } from 'node:fs';

let fails = 0;
const ok = (n, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  const pass = g === w;
  if (!pass) fails++;
  console.log((pass ? '  ✓ ' : '  ✗ ') + n + '  ⇒ ' + g + (pass ? '' : '（要 ' + w + '）'));
};
const has = (n, src, s) => ok(n, src.includes(s), true);
const missing = (n, src, s) => ok(n, src.includes(s), false);
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

const G = 'src/ground.mjs';
const M = 'src/model.mjs';
const U = 'src/settings-ui.mjs';
const g = readFileSync(G, 'utf8');

// ---------- ① 换字那一步：截原文跑 ----------
const RAIN_CONST = between(G, 'const RAIN_GLYPHS = ', 'const rainFlipWait = () => RAIN_FLIP_MIN + Math.random() * (RAIN_FLIP_MAX - RAIN_FLIP_MIN);',
  'RAIN_* 那四颗常量 + rainFlipWait', 8);
const NS = new Function(RAIN_CONST + '\n;return ({ RAIN_GLYPHS, RAIN_CAP, RAIN_FLIP_MIN, RAIN_FLIP_MAX, rainFlipWait });')();
ok('字符集 = 参考烤进纹理的那两个（没自造新字符）', NS.RAIN_GLYPHS, '01');
ok('图集格数跟着字符串走', NS.RAIN_GLYPHS.length, 2);

const waitMin = [], w = [];
for (let i = 0; i < 4000; i++) w.push(NS.rainFlipWait());
ok('换字等待全落在声明的区间内', w.every((v) => v >= NS.RAIN_FLIP_MIN && v <= NS.RAIN_FLIP_MAX), true);
// 正对照：全都相等 = 忘了随机（整场会同帧一起翻脸），这里读实测的极值
ok('确实是散的（4000 次的实测极值不等于两个端点常量）',
  [Math.min.apply(null, w) > NS.RAIN_FLIP_MIN, Math.max.apply(null, w) < NS.RAIN_FLIP_MAX], [true, true]);

// 换字表达式：从 update 里原样截出来（构造期还有一行"首帧先掷一次"，它含的不是 this.glyph[i] + ...，
// 所以正则按"右边仍以 this.glyph[i] 开头"取 —— 取错行就是把初掷当成翻转在测，测出来照样全绿）
const tg = [...g.matchAll(/this\.glyph\[i\] = ([^;]+);/g)].find((m) => m[1].includes('this.glyph[i]'));
if (!tg) { console.log('✗ 截不到换字那一句（写法变了？那"必定换出一个别的"就没权威面了）'); process.exit(1); }
console.log('  截出换字表达式：' + tg[1]);
has('正对照：构造期每颗先掷一次初值（否则整场从第 0 格起步）', g, 'this.glyph[i] = (Math.random() * RAIN_GLYPHS.length) | 0;');
const step = new Function('gn', 'i', 'this.glyph[i] = ' + tg[1] + ';');
function alwaysChanges(gn) {
  let same = 0;
  for (let start = 0; start < gn; start++) {
    let cur = start;
    for (let k = 0; k < 500; k++) {
      const before = cur;
      const box = { glyph: [cur] };
      step.call(box, gn, 0);
      cur = box.glyph[0];
      if (cur === before) same++;
      if (!(Number.isInteger(cur) && cur >= 0 && cur < gn)) return '跑出图集范围：' + cur;
    }
  }
  return same === 0 ? '' : '有 ' + same + '/1000 次"换"完还是同一个字';
}
ok('两个字符时每一次都真翻转（照参考那句掷硬币会有一半时间白换）', alwaysChanges(2), '');
ok('扩到三个字符仍成立（换出的必是别的字、且不越图集）', alwaysChanges(3), '');

// ---------- ② 结构：图集 / 着色器补丁 / drawRange ----------
has('图集是横排：一张画布宽 = 一格宽 × 格数', g, 'c.width = 128 * RAIN_GLYPHS.length; c.height = 128;');
has('逐格画字（不再是整张贴图只画一个字）', g, 'for (let i = 0; i < RAIN_GLYPHS.length; i++) x.fillText(RAIN_GLYPHS[i], 64 + i * 128, 64);');
missing('参考那一次性的掷硬币不再留在纹理里（"从头到尾同一个字"的病根）', g, 'x.fillText(Math.random() > 0.5');
has('每颗带一个图集索引的属性', g, 'geo.setAttribute("aGlyph", new THREE.BufferAttribute(this.glyph, 1));');
has('着色器加的是属性 + varying（不是新写一个材质）', g, 'sh.vertexShader = "attribute float aGlyph;\\nvarying float vGlyph;\\n"');
has('片元只替换那一次采样：按索引挪到属于它的那一格', g, '#include <map_particle_fragment>');
has('采样坐标 = (格号 + gl_PointCoord.x) / 格数', g, 'vec2 pcoord = vec2( ( floor( vGlyph ) + gl_PointCoord.x ) / ');
has('仍走 three 的 uvTransform（不重造粒径 / 亮度 / pixelRatio 那套管子）', g, 'vec2 uv = ( uvTransform * vec3( pcoord, 1 ) ).xy;');
has('给 program 缓存键：不给就会跟地面点阵那颗 PointsMaterial 撞成同一份程序', g, 'this.rainMat.customProgramCacheKey = () => "hm-rain-atlas";');
has('颗数只挪 drawRange（容量一次配满，换档不重建 buffer）', g, 'this.rain.geometry.setDrawRange(0, n);');
has('下落与换字都只遍历"在画"的那些颗', g, 'for (let i = 0; i < this.n; i++) {');
has('aGlyph 只在真有颗换字时才上传', g, 'if (glyphDirty) this.rain.geometry.attributes.aGlyph.needsUpdate = true;');
has('关着也同步颗数（重新开雨时画的颗数得跟着那一格，不能是上次关之前的）', g, 'this.syncCount();   // 关着也同步');
has('越界的颗数被容量钳住（手改文件写 99999 不能撑破 buffer）', g, 'Math.min(RAIN_CAP, Math.round(Number(PULSE_SETTINGS.rainCount) || 0))');

// ---------- ③ 两处数值的对账（滑杆上限 ≠ 容量 = 屏上画不满那一格）----------
const ML = between(M, 'const PULSE_LIMITS = {', '\n};', 'PULSE_LIMITS', 15);
const LIM = new Function(ML + '\n;return ({ PULSE_LIMITS });')().PULSE_LIMITS;
console.log('  正对照：RAIN_CAP = ' + NS.RAIN_CAP + '，PULSE_LIMITS.rainCount 上限 = ' + LIM.rainCount[1]);
ok('滑杆上限 = 容量（走散了就是"拖到顶也只画那么多"）', LIM.rainCount[1], NS.RAIN_CAP);
ok('滑杆下限 = 参考原样那 800 颗', LIM.rainCount[0], 800);
ok('亮度上限抬到 1.2（更亮那一刀）', LIM.rainBrightness, [0, 1.2, 0.01]);
const MS = between(M, 'const PULSE_SETTINGS = {', '\n};', 'PULSE_SETTINGS（默认值）', 20);
ok('默认颗数 = 参考的两倍（"更密"预设好，不用他手动拖）', /rainCount:\s*(\d+)/.exec(MS)[1], '1600');

// ---------- ④ 落盘：新键必须过服务端那张形状表 ----------
const s = readFileSync('serve.mjs', 'utf8');
has('serve.mjs 的 SET_SHAPE.ground 认得 rainCount（少这一格 = 每次 PUT 把它丢掉，同 probeEveryMs 那个缺陷）',
  s, 'rainBrightness: "num", rainCount: "num",');
const u = readFileSync(U, 'utf8');
has('页面写文件时带上 rainCount', u, 'rainCount: PULSE_SETTINGS.rainCount,');
has('读文件时认得 rainCount（会被钳进量程）', u, '"rainBrightness", "rainCount"');
has('弹窗里有那一格滑杆', u, 'limits: PULSE_LIMITS.rainCount');

// ---------- ⑤ 仪器：加强过的三件事都得有非眼睛读数 ----------
has('颗数进读数（在画的，不是容量）', g, '雨滴: n, 雨滴容量: p.length / 3');
has('GPU 被告知画几颗也进读数（滑杆 → drawRange 那一段的取证）', g, "画到第几颗: binaryRain.rain.geometry.drawRange.count");
has('字形分布进读数（只有一格有数 = 图集没被逐颗用上）', g, '字形分布: dist');
has('累计换字次数进读数（隔一秒读两次的差 = "字在换"的取证）', g, '换字累计: binaryRain.flips');
const wl = readFileSync('monitor-wall.html', 'utf8');
has('调试钩子里有"上一帧交了多少个点"（关掉雨开关的差值 = 那颗 Points 真在渲染清单里）',
  wl, '点数: renderer.info.render.points');

console.log(fails ? '\n✗ 二进制雨 ' + fails + ' 条没过' : '\n✓ 二进制雨：换字截原文跑过、图集与 drawRange 接上、新键两头都在');
process.exit(fails ? 1 : 0);
