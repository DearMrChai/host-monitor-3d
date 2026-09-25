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
has('逐格画字（不再是整张贴图只画一个字）', g, 'x.fillText(RAIN_GLYPHS[i], 64 + i * 128, 64);');
missing('参考那一次性的掷硬币不再留在纹理里（"从头到尾同一个字"的病根）', g, 'x.fillText(Math.random() > 0.5');
has('每颗带一个图集索引的属性', g, 'geo.setAttribute("aGlyph", new THREE.BufferAttribute(this.glyph, 1));');
has('着色器加的是属性 + varying（不是新写一个材质）', g, 'sh.vertexShader = "attribute float aGlyph;\\nvarying float vGlyph;\\n"');
has('片元只替换那一次采样：按索引挪到属于它的那一格', g, '#include <map_particle_fragment>');
has('采样坐标 = (格号 + gl_PointCoord.x) / 格数', g, 'vec2 pcoord = vec2( ( floor( vGlyph ) + gl_PointCoord.x ) / ');
has('仍走 three 的 uvTransform（不重造粒径 / 亮度 / pixelRatio 那套管子）', g, 'vec2 uv = ( uvTransform * vec3( pcoord, 1 ) ).xy;');
has('给 program 缓存键：不给就会跟地面点阵那颗 PointsMaterial 撞成同一份程序', g, 'this.rainMat.customProgramCacheKey = () => "hm-rain-atlas";');
has('颗数只挪 drawRange（容量一次配满，换档不重建 buffer）', g, 'this.rain.geometry.setDrawRange(0, n);');
has('下落与换字按列遍历（整列一起落 = "成柱"的循环形状，不再是一颗一颗各自走）', g, 'for (let c = 0; c * RAIN_ROWS < this.n; c++) {');
has('列内逐行落位（一行一个 y，行距由 rowGap 给）', g, 'pos[o + 1] = this.head[c] + j * gap;');
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
  s, 'rainBrightness: "num", rainCount: "num", rainDotMm: "num",');
const u = readFileSync(U, 'utf8');
has('页面写文件时带上 rainCount', u, 'rainCount: PULSE_SETTINGS.rainCount,');
has('读文件时认得 rainCount（会被钳进量程）', u, '"rainBrightness", "rainCount"');
// ⚠ 这三条 needle 一律带后面的逗号：不带就是**前缀匹配**，把键名手滑写成 rainDotMmX 也算"滑杆在那儿"（变异实验抓出来的）。
has('弹窗里有那一格滑杆', u, 'limits: PULSE_LIMITS.rainCount,');

// ---------- ⑤ 仪器：加强过的三件事都得有非眼睛读数 ----------
has('颗数进读数（在画的，不是容量）', g, '雨滴: n, 雨滴容量: p.length / 3');
has('GPU 被告知画几颗也进读数（滑杆 → drawRange 那一段的取证）', g, "画到第几颗: binaryRain.rain.geometry.drawRange.count");
has('字形分布进读数（只有一格有数 = 图集没被逐颗用上）', g, '字形分布: dist');
has('累计换字次数进读数（隔一秒读两次的差 = "字在换"的取证）', g, '换字累计: binaryRain.flips');
const wl = readFileSync('monitor-wall.html', 'utf8');
has('调试钩子里有"上一帧交了多少个点"（关掉雨开关的差值 = 那颗 Points 真在渲染清单里）',
  wl, '点数: renderer.info.render.points');

// ---------- ⑥ 2026-09-25 那一轮：他报"都是 0"之后补的读数与探针 ----------
has('字色还是参考那一句纯白平涂（渐变那一刀量下来只买回 0.003 的光比差，已撤回；别再往这里找"都是 0"的解）',
  g, 'x.fillStyle = "#ffffff";');
missing('径向渐变没被偷偷加回来（加法混合下"更亮"改的是颜色，alpha 一个数都不动 ⇒ 只看 alpha 会以为改了）',
  g, 'x.createRadialGradient(cx, 64, 6, cx, 64, 78)');
has('两格的墨量差变成一个读数（"1 天生比 0 淡"这句话不许只靠嘴说）', g, '图集墨量: binaryRain.atlasBalance()');
has('墨量算法按格切（格宽 128，跟图集那一句同一个口径）', g, 'const cell = (px / 128) | 0;');
has('钉格探针在（CPU 侧"字形分布"证明不了着色器取了对应的格，这一对才是正对照）',
  g, 'export function rainPinGlyph(v)');
has('页面挂了钉格探针', wl, 'rainPinGlyph,');
has('页面挂了程序侧取证（cacheKey / aGlyph / 片元里真有我那段）', wl, 'rainProgram: () => {');

// ---------- ⑦ 字径那一格（2026-09-25 从写死抬成滑杆）：四处点名 + 默认值没跑偏 ----------
// 为什么单挑这一颗：他报的"都是 0"最后量出来不是亮度的事（1 的有效光 = 0 的 76.5 %，改字色只买到 76.8 %），
// 是"一颗字在墙上约 10 px 高、1 那根竖笔不到一个像素"的事 ⇒ 能救的维度只有"多大"。
// 多大这颗旋钮的默认值必须正好是参考原来那颗 1.8 单位，不然"抬成滑杆"这件事本身就把画面改了。
ok('字径量程', LIM.rainDotMm, [360, 2880, 20]);
ok('默认字径 = 参考的 1.8 单位 × RAIN_S(400) mm', /rainDotMm:\s*(\d+)/.exec(MS)[1], String(1.8 * 400));
has('建材质时读的是那一格', g, 'size: PULSE_SETTINGS.rainDotMm');
missing('粒径那一句里不再留写死的 1.8 * RAIN_S（留着就是两处真值，滑杆只管一半）', g, 'size: 1.8 * RAIN_S');
has('每帧把那一格落到材质上（拖完就变，不重建材质）', g, 'this.syncSize();');
has('落到材质前钳进量程', g, 'const lim = PULSE_LIMITS.rainDotMm;');
has('serve.mjs 的 SET_SHAPE.ground 认得 rainDotMm', s, 'rainDotMm: "num"');
has('页面写文件时带上 rainDotMm', u, 'rainDotMm: PULSE_SETTINGS.rainDotMm,');
has('读文件时认得 rainDotMm（会被钳进量程）', u, '"rainCount", "rainDotMm"');
has('弹窗里有字径那一格滑杆', u, 'limits: PULSE_LIMITS.rainDotMm,');
has('字径进读数（屏上那一颗到底是几毫米，不靠眼睛猜）', g, '字径mm: binaryRain.rainMat.size');

// ---------- ⑧ #3（2026-09-25 他"开 3/4"）：成柱 + 拖尾 ----------
// ⚠ 这一节测的是**他自己点的两件事**，参考里没有：DigitalRainBackground 是 800 颗各自随机布点各自落，
// 既没柱也没尾。所以"照参考"这条判据在这里用不上，只能把柱子的算术钉住 ——
// 常量这一段仍是截原文跑（跟 ① 同一纪律），结构那一段钉文本。
const COL = between(G, 'const RAIN_ROWS = ', 'const loadK = (r, v) => r[0] + (r[1] - r[0]) * v;',
  '#3/#4 的柱子与联动常量', 12);
const NC = new Function(RAIN_CONST + '\n' + COL + '\n;return ({ RAIN_ROWS, RAIN_COLS, RAIN_TRAIL_MIN, RAIN_ROW_GAP_K, RAIN_FADE, RAIN_LOAD_SPEED, RAIN_LOAD_BRIGHT, loadK });')();
// 起点故意截在 `const RAIN_ROWS = ` 这一句的**前半**（不带值）：带着 "20" 当锚点的话，
// 把 20 改成 21 这个变异会让整段截不到 ⇒ 闸直接退出，看着像"抓到了"，其实是后面几十条一条没跑。
ok('列数 × 每列几行 = 容量（不整除就会有一截 buffer 永远画不到，滑杆拉满也只画那么多）',
  NC.RAIN_COLS * NC.RAIN_ROWS, NS.RAIN_CAP);
// 上面那条单独会漏：6400 / 21 = 304.76，再乘回去还是 6400 ⇒ 只比乘积看不出行数不整除。
// 所以必须再钉"列数本身是整数"这一条（这一格才是 20 → 21 那次变异的落点）。
ok('列数本身是整数（304.76 根柱子是不存在的对象，屏幕上会直接少画一行的宽度）',
  Number.isInteger(NC.RAIN_COLS), true);
ok('拖尾最短那一档不超过一列的行数（配反了就是"每列只亮 6 行"还随机不到）',
  NC.RAIN_TRAIL_MIN <= NC.RAIN_ROWS, true);
// 正对照：量程滑到两端时"整列切"这件事还成立吗 —— 半根柱子在屏上是断头，一眼就是坏样
const cut = (want) => want - (want % NC.RAIN_ROWS);
ok('滑杆两端与中间都落在整列上（800 / 1600 / 3200 / 6400 四档一个都不剩半列）',
  [800, 1600, 3200, 6400].map(cut), [800, 1600, 3200, 6400]);
ok('最左那一档也画得出整列（40 根，不是"半根柱子"）', cut(800) / NC.RAIN_ROWS, 40);
ok('任意一颗颗数被钳进整列（拿 6399 试：余 19 颗必须抹掉）', cut(6399), 6380);
ok('尾梢确实淡到近看不见（最短尾 0.8^5 vs 最长尾 0.8^19）',
  [+Math.pow(NC.RAIN_FADE, NC.RAIN_TRAIL_MIN - 1).toFixed(3), +Math.pow(NC.RAIN_FADE, NC.RAIN_ROWS - 1).toFixed(4)],
  [0.328, 0.0144]);
ok('行距 = 字径 × 系数（默认那颗字 720 mm ⇒ 柱子上行距 828 mm）', Math.round(720 * NC.RAIN_ROW_GAP_K), 828);
has('颗数往下取整到整列那一句在', g, 'const n = want - (want % RAIN_ROWS);');
has('拖尾之外的行亮度写 0（加法混合下"颜色 × 0"就是不发光：长短柱共用一套材质、一份 buffer）', g, 'const v = j < L ? b : 0;');
has('逐行乘衰减（不是每行重新掷一个随机亮度 —— 那样就没有"尾"了）', g, 'b *= RAIN_FADE;');
has('拖尾走 three 自己的顶点色，不新写 ShaderMaterial', g, 'vertexColors: true });');
has('顶点色 buffer 挂了', g, 'geo.setAttribute("color", new THREE.BufferAttribute(this.tint, 3));');
has('每帧把亮度上传 GPU（只在重生时上传的话，柱子会停在第一帧的尾长上）', g, 'this.rain.geometry.attributes.color.needsUpdate = true;');
missing('没有自造的第二套粒子材质（柱子只挪状态，不挪管线）', g, 'new THREE.ShaderMaterial');
has('整列共用一个角度与半径（"各行站在同一条竖线上"的写法根源）', g, 'this.cAng[c] = (c + Math.random()) * Math.PI * 2 / RAIN_COLS;');
has('行距跟着字径走（他把字调大，柱子整体变长而不是上下叠字）', g, 'rowGap() { return this.rainMat.size * RAIN_ROW_GAP_K; }');
has('字径变了要重排每一列的顶点', g, 'for (let c = 0; c < RAIN_COLS; c++) this._layout(c);');
has('领头那颗落到底不算完，要等尾巴也离开可见带（否则半条柱子凭空消失）', g, 'if (this.head[c] + (L - 1) * gap < RAIN_BOTTOM) this._respawnCol(c, false);');
has('重生时把整条尾巴一起抬出柱顶（不然屏幕上会凭空冒出一截尾梢）', g, 'RAIN_TOP + tail + Math.random() * 20 * RAIN_S');
// 柱子的三格非眼睛读数（列内 XZ 偏离 / 行距偏差 / 尾梢亮度比）：没有它们，"成柱了没有"就只能问他眼睛
has('列内 XZ 偏离进读数', g, '列内XZ偏离mm: +colXZOff.toFixed(3)');
has('行距偏差进读数', g, '行距偏差mm: +gapJitter.toFixed(3)');
has('在画列数与亮着的行进读数', g, '在画列数: n / RAIN_ROWS, 每列几行: RAIN_ROWS, 亮着的行: lit');
has('尾梢亮度比进读数', g, '尾梢亮度比: n ? +Math.pow(RAIN_FADE, tMax - 1).toFixed(3) : null');

// ---------- ⑨ #4：雨跟着机群忙闲变 ----------
// ⚠ 这一节不许只看文本：#4 的全部风险都在"取谁的数"这一步，而它在真页面上只有四台机那一格能验，
// 本机道具舞台永远读不到（没帧 ⇒ 回落 1，正是下面那条 null 分支）。所以这里把**屏上那一份函数原文**截出来，
// 灌一台真数 / 两台游走 / 一台收起 / 一台关机 / 一台没帧，逐条断言谁投票谁不投票（同 ① 的纪律：截原文，不自造测试版）。
const FL = between(G, 'function fleetLoad01() {', '\n  return n ? { load01: clampv(sum / n / 100, 0, 1), 台数: n } : null;\n}',
  'fleetLoad01 本体', 10);
const flRun = new Function('devices', 'loads', 'zoneOffOf', 'clampv', FL + '\n;return fleetLoad01();');
const mk = (id, o) => Object.assign({ id, short: id, hidden: false, zone: '', power: true, frame: null }, o);
const L = (pct) => new Map(pct.map(([k, v]) => [k, { pct: v }]));
const zz = (d) => d.zone === 'off';
const cl = (v) => Math.max(0, Math.min(1, v));
const one = flRun([mk('a', { frame: {}, power: true })], L([['a', 90]]), zz, cl);
ok('一台有帧的：取它的数，load01 = 0.9、台数 = 1', one, { load01: 0.9, 台数: 1 });
ok('两真有帧 + 一台道具(无帧) + 一台收起 + 一台关机 ⇒ 只有前两票',
  flRun([mk('a', { frame: {} }), mk('b', { frame: {} }), mk('c', { frame: null }),
    mk('d', { frame: {}, hidden: true }), mk('e', { frame: {}, power: false })],
    L([['a', 100], ['b', 0], ['c', 77], ['d', 100], ['e', 100]]), zz, cl).台数, 2);
ok('那两票是 100 与 0 ⇒ 平均 0.5（道具/收起/关机那三票没混进来）',
  flRun([mk('a', { frame: {} }), mk('b', { frame: {} }), mk('c', { frame: null }),
    mk('d', { frame: {}, hidden: true }), mk('e', { frame: {}, power: false })],
    L([['a', 100], ['b', 0], ['c', 77], ['d', 100], ['e', 100]]), zz, cl).load01, 0.5);
ok('整区关闭的那台也不投票（跟脚下涟漪同一句 zoneOffOf 条件）',
  flRun([mk('a', { frame: {}, zone: 'off' })], L([['a', 100]]), zz, cl), null);
ok('有帧但没算出 pct 的（null）不投票 ⇒ 全场没数就是 null，不是 0',
  flRun([mk('a', { frame: {} })], L([['a', null]]), zz, cl), null);
ok('一台都没帧 ⇒ null（屏上倍率因此回落 1.0，不是"空载"）',
  flRun([mk('a', { frame: null })], L([]), zz, cl), null);
// 正对照：0.5 那一档两维各是多少 —— 这两个数就是"他眼睛该看到什么"的换算表
ok('load01 = 0.5 ⇒ 速度 1.125 倍、亮度 0.9 倍',
  [NC.loadK(NC.RAIN_LOAD_SPEED, 0.5), NC.loadK(NC.RAIN_LOAD_BRIGHT, 0.5)], [1.125, 0.9]);
ok('倍率不会越出声明线段（load01 被钳在 0~1，两端各试一次）',
  [NC.loadK(NC.RAIN_LOAD_SPEED, cl(-3)), NC.loadK(NC.RAIN_LOAD_BRIGHT, cl(9))], [0.75, 1]);
// 契约层旁边的东西（它读真机的数），所以这一节的重点不是"好不好看"，是三件事：
// 乘数量程对、没数时不瞎乘、以及那颗开关在四个地方都点名（少一个就是 #38 那类静默丢值）。
ok('loadK 两端就是声明的线段（截原文跑，不是看注释）',
  [NC.loadK(NC.RAIN_LOAD_SPEED, 0), NC.loadK(NC.RAIN_LOAD_SPEED, 1)], [0.75, 1.5]);
ok('亮度倍率封顶 1.0 ⇒ 他拧的 rainBrightness 仍是天花板（联动只往下让）', NC.loadK(NC.RAIN_LOAD_BRIGHT, 1), 1);
ok('空载时亮度退到八成、速度退到 0.75 倍', [NC.loadK(NC.RAIN_LOAD_BRIGHT, 0), NC.loadK(NC.RAIN_LOAD_SPEED, 0)], [0.8, 0.75]);
ok('满载 1.5 倍速 / 空载 0.75 倍 = 相差 2 倍（"忙闲看得出差"的那个数）',
  +(NC.RAIN_LOAD_SPEED[1] / NC.RAIN_LOAD_SPEED[0]).toFixed(2), 2);
has('取不到数就整格不乘（倍率回落 1，不是回落 0 = "空载"）', g, 'const ls = ld ? loadK(RAIN_LOAD_SPEED, ld.load01) : 1;');
has('没帧的机子不投票：返回 null 而不是 0', g, 'return n ? { load01: clampv(sum / n / 100, 0, 1), 台数: n } : null;');
has('排除条件与脚下涟漪同源（收起 / 整区关闭 / 关机 / 没帧的都不算证据）', g, 'if (d.hidden || zoneOffOf(d) || !d.power || !d.frame) continue;');
has('速度那一维真接在下落上（不是只改了个没人读的变量）', g, 'this.head[c] -= this.cSpeed[c] * ls * delta;');
has('亮度那一维接在材质上（乘在他那格下面）', g, 'this.rainMat.opacity = gb * this.brightK;');
has('光斑跟着一起退（只暗一半会读成"这块坏了"）', g, 'this.bokehMat.opacity = gb * 0.8 * this.brightK;');
has('联动三格本帧值有初值（第一帧之前读到的是 1 而不是 undefined）', g, 'this.speedK = 1; this.brightK = 1; this.loadN = 0; this.load01 = null;');
has('默认开', /rainFollowLoad:\s*(true|false)/.exec(MS)[1], 'true');
// 那颗键的四处点名 —— 少一处就是"每次 PUT 丢掉那一格"（#38 的缺陷类）
has('① serve.mjs 的形状表认得它', s, 'rainDotMm: "num", rainFollowLoad: "bool",');
has('② 页面写文件的载荷里有它', u, 'rainFollowLoad: PULSE_SETTINGS.rainFollowLoad,');
has('③ 读文件那一侧认得它（跟 rainEnabled 一样走布尔，不进 PULSE_LIMITS）', u, 'typeof g.rainFollowLoad === "boolean"');
has('④ localStorage 恢复那一侧也认得它', g, 'typeof saved.rainFollowLoad === "boolean"');
has('弹窗里有那颗开关', u, 'bindOnOff("rainLoadOn", "跟忙闲"');
has('页面上有那颗按钮', wl, 'id="rainLoadOn"');
has('倍率进读数（屏上此刻乘了多少，不靠眼睛反推）', g, '速度倍: +binaryRain.speedK.toFixed(3), 亮度倍: +binaryRain.brightK.toFixed(3)');

console.log(fails ? '\n✗ 二进制雨 ' + fails + ' 条没过'
  : '\n✓ 二进制雨：换字截原文跑过、图集与 drawRange 接上、柱子按整列切、忙闲倍率两头对、新键四处都点名');
process.exit(fails ? 1 : 0);
