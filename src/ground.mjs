// 地面层：脚下脉冲（水平环 + 向上数据流）、点阵涟漪地形、二进制雨，再加"每台这一拍什么档位"。
// 2026-09-24 T5 刀6 从 monitor-wall.html 整块搬出，正文一字未改（对账：
//   DST=src/ground.mjs node 00-暂存/hm3d-t54-verify.mjs monitor-wall.html <名字...>）。
// 单位口径同页面：1 世界单位 = 1 mm；参考代码是米口径，换算只在 GROUND_S / RAIN_S 两处各写一遍。
// 依赖是单向的：地面 ← 陈列层（holderOf / paintLabel 要问"这台在屏幕上有没有位置"），
// 反过来谁都不认页面 —— scene / clock / 写文件那三样由 initGround 递进来（同 fleet 那一刀）。
import { THREE } from "./three.mjs";
import { devices, holders, loads, PULSE_SETTINGS, PULSE_LIMITS, PS_KEY,
  stateOf, levelOf, zoneOffOf, liveOf } from "./model.mjs";
import { clampv } from "./format.mjs";
import { framePct } from "./dashboard.mjs";
import { holderOf, paintLabel } from "./fleet.mjs";

let scene = null;                 // 粒子与点阵都挂在这张图上：建场景的是页面，这里只接
let clock = null;                 // 自检钩子的时间基准，跟 tick 用的是同一个 THREE.Clock
let touchSettings = () => {};     // 值改完要落 settings.json：这一层不认识文件，由页面递进来

// ---------- 脚下脉冲：水平脉冲环 + 向上数据流 ----------
// 照用户给的"种子版"参考复刻，只取脉冲这一件事（参考里开机的屏幕闪烁没带）。
// 换算是这么做的：参考是米口径（机箱 6 单位高、相机 48 单位），这里 1 单位 = 1 mm，
// 所以"距离和粒径"按设备 footprint 放大重定，"时间量"（寿命 2.5s、间隔 3.0/2.0/1.2s、
// 爆发节奏 0 / 0.2 / 0.35s）是秒，原样照抄不动。
// 参考另外挂了 UnrealBloomPass 做辉光：派单禁止 three 的 examples/，这里不引 ——
// 光晕只剩贴图自身的柔光衰减 + 叠加混合，整体比参考暗一档是预期，不是掉效果。
// 可调值本身（PULSE_SETTINGS / PULSE_LIMITS / PS_KEY）在 src/model.mjs；
// 恢复跟着这一层搬进来了：它要走的夹取就是下面的 setPulseSetting，而 touchSettings 由页面注入，
// 所以既不留一份在页面、也不搬进 model（model ↔ 页面 的环形 import 才是当初不搬的理由）。
try {
  const saved = JSON.parse(localStorage.getItem(PS_KEY) || "{}");
  // enabled 是布尔，不在 PULSE_LIMITS 里（那张表只管"数值 + 上下限 + 步进"），单独恢复
  if (typeof saved.enabled === "boolean") PULSE_SETTINGS.enabled = saved.enabled;
  if (typeof saved.rippleEnabled === "boolean") PULSE_SETTINGS.rippleEnabled = saved.rippleEnabled;
  if (typeof saved.rainEnabled === "boolean") PULSE_SETTINGS.rainEnabled = saved.rainEnabled;
  for (const k in PULSE_LIMITS) if (Number.isFinite(saved[k])) setPulseSetting(k, saved[k], true);
} catch (e) { /* 读不到就用默认值 */ }
export function setPulseSetting(key, value, quiet) {
  const lim = PULSE_LIMITS[key];
  if (!lim) return;
  const v = Number(value);
  if (!Number.isFinite(v)) return;
  PULSE_SETTINGS[key] = clampv(v, lim[0], lim[1]);
  if (quiet) return;   // 启动时恢复存档：逐个写 localStorage 没必要，也不该反过来覆盖
  try { localStorage.setItem(PS_KEY, JSON.stringify(PULSE_SETTINGS)); } catch (e) { /* 同上 */ }
  touchSettings();
}
// 关的时候不等在飞的自己散完：拨开关要的是"这一帧屏幕上就没了"，慢收尾看着像开关没生效。
// 函数体引用的 livePulses / liveUp / disposePoints 在下面才声明 —— 只在点击时调用，不在求值期跑。
export function setPulseEnabled(on, quiet) {
  PULSE_SETTINGS.enabled = !!on;
  try { localStorage.setItem(PS_KEY, JSON.stringify(PULSE_SETTINGS)); } catch (e) { /* 同上 */ }
  if (!quiet) touchSettings();
  if (PULSE_SETTINGS.enabled) return;
  for (const rt of pulseRt.values()) { rt.queue.length = 0; rt.nextBurst = null; }
  for (let i = livePulses.length - 1; i >= 0; i--) disposePoints(livePulses, i);
  for (let i = liveUp.length - 1; i >= 0; i--) disposePoints(liveUp, i);
}


// 粒子贴图是运行时画在 canvas 上的，不是外部素材文件（派单禁的是素材，不是这个）。
// 一律画白色：颜色由 material.color 按分级染，三档共用同两张图。
function softDotTexture() {
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const x = c.getContext("2d");
  const g = x.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, "rgba(255, 255, 255, 1)");
  g.addColorStop(0.3, "rgba(255, 255, 255, .7)");
  g.addColorStop(0.7, "rgba(255, 255, 255, .2)");
  g.addColorStop(1, "rgba(255, 255, 255, 0)");
  x.fillStyle = g;
  x.fillRect(0, 0, 64, 64);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
function tailTexture() {
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const x = c.getContext("2d");
  const g = x.createLinearGradient(0, 32, 64, 32);
  g.addColorStop(0, "rgba(255, 255, 255, 0)");
  g.addColorStop(0.5, "rgba(255, 255, 255, .3)");
  g.addColorStop(0.9, "rgba(255, 255, 255, 1)");
  g.addColorStop(1, "rgba(255, 255, 255, 1)");
  x.fillStyle = g;
  x.beginPath();
  x.ellipse(32, 32, 32, 6, 0, 0, Math.PI * 2);
  x.fill();
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
const dotTex = softDotTexture();
const tailTex = tailTexture();

// ---------- 地面：点阵涟漪地形（2026-09-23 融合，参考 = docs/参考-涟漪地面/ 那两份）----------
// 参考是"300 单位一张地、相机离地几十单位"的口径；这里 1 单位 = 1 mm、地面要铺满 24000 mm。
// 换算纪律跟脚下脉冲同一条：几何建在**参考单位**里（300×300，每边段数 = PULSE_SETTINGS.dotSeg），整张 mesh 乘 GROUND_S
// 放大到毫米 —— 于是公式里的 0.5 / 0.008 / 100 / 150 / 4.0 一个都不用改，参考那张调参表 1:1 成立，
// 而且密度滑杆拉的只是"同一圈波用多碎的点画"。
// 只有点径这种"材质尺寸"不受 mesh.scale 管（three 的 point size 是世界单位），所以 dotSizeMm 直接就是毫米：
// 默认 56 = 参考那个 0.7 单位 × GROUND_S，换算在定默认值时做一次，运行时代码里没有乘法。
const GROUND_S = 80;   // 1 参考单位 = 80 mm：300 单位 × 80 = 24000 mm，正好替掉原 GridHelper 那张地
const RIPPLE_MAX_AGE = 4.0;   // 参考写死 4 秒（folder 版参数表里没有寿命滑杆，就不造一个）
const RIPPLE_MAX = 32;        // 同时存活的环数上限（8 台全 ALERT 稳态约 27 个，留点余量）
// 每边段数不再有常量：它就是 PULSE_SETTINGS.dotSeg（默认 320 → 321² = 103041 顶点，点距 75 mm），
// 合法范围只写在 PULSE_LIMITS.dotSeg 一处。两颗旋钮都只在 RippleTerrain.syncDots() 一处落地。
// 涟漪自己那层"底波"（2026-09-24 用户裁定：涟漪要自己带波动，默认开着）——
// 整张地按两列正弦慢慢起伏，不需要谁去踢一脚。它跟涟漪共用一颗开关：关涟漪时地面彻底静止（T4 裁的"点阵原地不动"）。
// 振幅/亮度都挂在既有滑杆上（rippleHeight 管高低、rippleBrightness 管亮暗），所以没往 settings.json 里加新键。
// k = 每参考单位的相位（0.055 → 波长 ≈ 114 单位 ≈ 9 m，比区宽还大，看着是"地在呼吸"而不是"水面波纹"）；
// s = 每秒推进多少弧度（0.55 → 一轮约 11 秒）。
const BREATH = { amp: 0.3, glow: 1.6, k1: 0.055, k2: 0.115, s1: 0.55, s2: 0.85 };
class RippleTerrain {
  constructor(sc) {
    this.material = new THREE.PointsMaterial({
      size: PULSE_SETTINGS.dotSizeMm, map: dotTex, vertexColors: true, transparent: true, opacity: 0.85,
      blending: THREE.AdditiveBlending, depthWrite: false, sizeAttenuation: true,
    });
    this.mesh = new THREE.Points(new THREE.BufferGeometry(), this.material);
    this.mesh.scale.setScalar(GROUND_S);
    this.mesh.position.y = -1;   // 原 GridHelper 的高度：机器脚踩在点阵上，不悬空也不陷进去
    sc.add(this.mesh);
    this.geometry = null;
    this.ripples = [];
    this.flat = true;   // 上一个无涟漪帧已经把地面抹平过 → 没涟漪时不必每帧重写三万个顶点
    this.lut = new Float32Array(257);   // 波形查表（见 update 里的注释）
    this.lutThick = NaN;
    this.lutBand = 0;
    this.t = 0;
    this.seg = -1;   // 让第一次 syncDots 一定落进"重建"那条路
    this.syncDots();
  }
  // 点阵的两颗旋钮：dotSizeMm = 一粒画多大（世界毫米），dotSeg = 一粒一粒摆多密（每边段数）。
  // 密这一颗只换**采样分辨率**：涟漪环与底波的公式全在参考单位里（0.5 / 0.008 / 100 / 150 / BREATH 的 k），
  // 一个数都不跟着 seg 走，所以加密前后同一次涟漪的高度、环宽、波长是同一份数学，只是点更碎。
  // "读设置 → 收进合法范围 → 不一样才动"只有这一个地方；三条来路（拖滑杆 / 5 秒读文件 / 启动恢复）都走它。
  syncDots() {
    const limS = PULSE_LIMITS.dotSizeMm, limG = PULSE_LIMITS.dotSeg;
    const vs = Number(PULSE_SETTINGS.dotSizeMm);
    const size = clampv(Number.isFinite(vs) ? vs : limS[0], limS[0], limS[1]);
    if (size !== this.material.size) this.material.size = size;   // 点径只是材质上一个数，不涉几何
    const vg = Number(PULSE_SETTINGS.dotSeg);
    const seg = Math.round(clampv(Number.isFinite(vg) ? vg : limG[0], limG[0], limG[1]));
    if (seg === this.seg) return false;
    PULSE_SETTINGS.dotSeg = seg;   // 文件里手写过 61.5 这种数，落回"实际生效值"，别让标签跟网格两个数
    const n = seg + 1;
    this.seg = seg;
    this.step = 300 / seg;
    const g = new THREE.PlaneGeometry(300, 300, seg, seg);
    g.rotateX(-Math.PI / 2);
    this.count = g.attributes.position.count;
    const colors = new Float32Array(this.count * 3);
    for (let i = 0; i < this.count; i++) {   // 平静时 = 待机电路板那种暗蓝
      colors[i * 3] = 0.02; colors[i * 3 + 1] = 0.06; colors[i * 3 + 2] = 0.15;
    }
    g.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    if (this.geometry) this.geometry.dispose();   // 换档就把上一张显存 buffer 交回去
    this.geometry = g;
    this.mesh.geometry = g;
    this.rowLists = Array.from({ length: n }, () => []);   // 每行落在哪些环带里
    // 底波（涟漪自己带的那层起伏）的行列因子表：可分离成一个"列向量 × 行向量"，
    // 于是每帧只需 4×n 次 sin，几万个顶点里只做乘法和加法。
    this.b1x = new Float32Array(n); this.b1z = new Float32Array(n);
    this.b2x = new Float32Array(n); this.b2z = new Float32Array(n);
    this.flat = true;   // 新建的网格本就全平、底色已铺待机蓝，第一帧不用再抹一遍
  }
  addRipple(x, z, colorHex, amplitude = 1) {
    const c = new THREE.Color(colorHex);
    this.ripples.push({ x: x / GROUND_S, z: z / GROUND_S, colorR: c.r, colorG: c.g, colorB: c.b,
      age: 0, radius: 0, amplitude });
    // 上限兜最坏情况：参考演示只有 3 台设备，我们 8 台全 ALERT 时稳态能到三十几个环，
    // 不设上限的话每帧成本无顶。超了丢最老的（视觉上就是最淡的那圈先没）。
    while (this.ripples.length > RIPPLE_MAX) this.ripples.shift();
  }
  clear() { this.ripples.length = 0; }
  // 底波的行列因子：每帧重算 4×(seg+1) 次 sin，顶点里只做乘法
  breathStep() {
    const t = this.t, seg = this.seg, step = this.step;
    const k1 = BREATH.k1, k2 = BREATH.k2, s1 = BREATH.s1, s2 = BREATH.s2;
    for (let i = 0; i <= seg; i++) {
      const c = -150 + i * step;
      this.b1x[i] = Math.sin(c * k1 + t * s1);
      this.b1z[i] = Math.sin(c * k1 + t * s1 * 0.8);
      this.b2x[i] = Math.sin(c * k2 - t * s2);
      this.b2z[i] = Math.sin(c * k2 + t * s2 * 1.2);
    }
  }
  update(delta) {
    this.syncDots();   // 换档就整张网格重造：下面所有数组都是新几何的，所以这一句必须在取数组之前
    const positions = this.geometry.attributes.position.array;
    const colors = this.geometry.attributes.color.array;
    const height = PULSE_SETTINGS.rippleHeight;
    const speed = PULSE_SETTINGS.rippleSpeed;
    const thickness = PULSE_SETTINGS.rippleThickness;
    const brightness = PULSE_SETTINGS.rippleBrightness;
    const maxAge = RIPPLE_MAX_AGE;
    this.t += delta;
    const breath = PULSE_SETTINGS.rippleEnabled;   // T4：涟漪关了以后地面连底波一起静住
    for (let i = this.ripples.length - 1; i >= 0; i--) {
      const r = this.ripples[i];
      r.age += delta;
      r.radius = r.age * speed;
      if (r.age >= maxAge || r.radius > 150) this.ripples.splice(i, 1);
    }
    if (!this.ripples.length && !breath) {
      if (this.flat) return;
      for (let i = 0; i < this.count; i++) {
        positions[i * 3 + 1] = 0;
        colors[i * 3] = 0.02; colors[i * 3 + 1] = 0.06; colors[i * 3 + 2] = 0.15;
      }
      this.flat = true;
      this.geometry.attributes.position.needsUpdate = true;
      this.geometry.attributes.color.needsUpdate = true;
      return;
    }
    this.flat = false;
    if (breath) this.breathStep();
    // 两刀性能（公式本身一个字没动，改的是"哪些顶点要算"和"exp/sin 算几次"）：
    // ① 波形 sin(d·0.5)·exp(-d²/(t²·100)) 只跟 d 和 thickness 有关 → 厚度没变就查表，
    //    把每顶点两次超越函数换成一次取整下标（256 格，步长约 0.2 参考单位 = 16 mm）。
    // ② 高斯包络在 |d| > 26.3×thickness 时已小于千分之一 → 按行带剔除：整行不在任何环带里
    //    就只抹平不累加；行内再对每个涟漪做平方距离拒绝（连 sqrt 都省）。
    //    不剔除的话 8 台稳态二十几个环 × 32761 顶点 = 每帧近百万次 sqrt/exp/sin，实测 9.6 ms。
    const band = thickness * 26.3;
    if (thickness !== this.lutThick) {
      for (let i = 0; i <= 256; i++) {
        const d = -band + (i / 256) * 2 * band;
        this.lut[i] = Math.sin(d * 0.5) * Math.exp(-(d * d) / (thickness * thickness * 100));
      }
      this.lutThick = thickness;
      this.lutBand = band;
    }
    const lut = this.lut, lutBand = this.lutBand, inv = 256 / (2 * lutBand);
    const seg = this.seg, step = this.step;   // 密度滑杆改的就是这两个：下面所有下标换算都走它们
    const rows = this.rowLists;
    for (let iy = 0; iy <= seg; iy++) rows[iy].length = 0;
    for (let k = 0; k < this.ripples.length; k++) {
      const r = this.ripples[k];
      r.k = (1 - r.age / maxAge) * Math.exp(-r.radius * 0.008) * r.amplitude;
      const outer = r.radius + band;
      r.outer2 = outer * outer;
      const inner = Math.max(0, r.radius - band);
      r.inner2 = inner * inner;
      const row0 = Math.max(0, Math.floor((r.z - outer + 150) / step));
      const row1 = Math.min(seg, Math.ceil((r.z + outer + 150) / step));
      for (let iy = row0; iy <= row1; iy++) rows[iy].push(k);
    }
    for (let iy = 0; iy <= seg; iy++) {
      const list = rows[iy];
      const rowBase = iy * (seg + 1) * 3;
      if (!list.length && !breath) {   // 整行无环：仍要写平（上一帧这里可能正隆着）
        for (let ix = 0; ix <= seg; ix++) {
          const p = rowBase + ix * 3;
          positions[p + 1] = 0;
          colors[p] = 0.02; colors[p + 1] = 0.06; colors[p + 2] = 0.15;
        }
        continue;
      }
      const bz = -150 + iy * step;
      const z1 = breath ? this.b1z[iy] : 0, z2 = breath ? this.b2z[iy] : 0;
      const bh = breath ? height * BREATH.amp : 0;
      for (let ix = 0; ix <= seg; ix++) {
        const bx = -150 + ix * step;
        let y = 0;
        let cr = 0.02, cg = 0.06, cb = 0.15;
        if (breath) {
          // 两列可分离正弦相加再折半：取值范围正好 [-1,1]。亮度只把待机色整体抬起（不引入新色相），
          // 于是"地自己在呼吸"读起来是同一种暗蓝在明暗间走，而不是多了一层别的颜色的波。
          const w = (this.b1x[ix] * z1 + this.b2x[ix] * z2) * 0.5;
          y = w * bh;
          const g = 1 + Math.abs(w) * BREATH.glow * brightness;
          cr *= g; cg *= g; cb *= g;
        }
        for (let q = 0; q < list.length; q++) {
          const r = this.ripples[list[q]];
          const dx = bx - r.x, dz = bz - r.z;
          const d2 = dx * dx + dz * dz;
          if (d2 > r.outer2 || d2 < r.inner2) continue;
          const d = Math.sqrt(d2) - r.radius;
          let li = ((d + lutBand) * inv) | 0;
          if (li < 0) li = 0; else if (li > 256) li = 256;   // 平方拒绝后理论不越界，越界会读出 NaN 且永久脏在颜色里
          const wave = lut[li] * r.k;
          y += wave * height;
          const glow = Math.abs(wave) * brightness;
          cr += r.colorR * glow * 0.9;
          cg += r.colorG * glow * 0.9;
          cb += r.colorB * glow * 0.9;
        }
        const p = rowBase + ix * 3;
        positions[p + 1] = y;
        colors[p] = Math.min(1, cr);
        colors[p + 1] = Math.min(1, cg);
        colors[p + 2] = Math.min(1, cb);
      }
    }
    this.geometry.attributes.position.needsUpdate = true;
    this.geometry.attributes.color.needsUpdate = true;
  }
}
// 构造在 initGround 里（那时才有 scene）；这里只先把名字亮出来，模块内赋值，页面不读它。
let rippleTerrain = null;
const rippleRt = new Map();   // device.id -> { next }  涟漪自己的节拍，跟 pulseRt 无关
export function setRippleEnabled(on, quiet) {
  PULSE_SETTINGS.rippleEnabled = !!on;
  try { localStorage.setItem(PS_KEY, JSON.stringify(PULSE_SETTINGS)); } catch (e) { /* 同上 */ }
  if (!PULSE_SETTINGS.rippleEnabled) {
    rippleTerrain.clear();
    for (const rt of rippleRt.values()) rt.next = null;   // 重新打开时相位重错，不"关五分钟一开全场同拍"
  }
  if (!quiet) touchSettings();
}

// ---------- 背景：二进制雨（参考 = docs/参考-数字雨/ 整页里的 DigitalRainBackground）----------
// 参考把雨布在 −Z 一面幕布上（它的相机不绕）；我们是轨道相机，转过去那面"字墙"就穿帮，
// 所以按对齐结论改成**环绕地图的圆柱壳**：粒子数 / 贴图 / 速度口径全照参考，只换分布。
// 半径 40000~54000：相机最远能拉到 30000（滚轮/双指的硬上限），壳必须整个套在相机外面 ——
// 早先写 16000~22000 是错的：全景就是 16000，等于把雨贴在镜头上，字会有半屏大。
// 换算比例另起一个 RAIN_S，不能借地面的 GROUND_S：地面按"地图多大"换（300 单位→24000 mm），
// 雨是背景层，看着多大／多快只取决于"相机离它多远"。参考相机离雨幕约 140 单位，
// 我们全景时离壳约 56000 mm → 1 参考单位 = 400 mm，正好是 GROUND_S 的 5 倍。
const RAIN_S = 400;
const RAIN_R0 = 40000, RAIN_R1 = 54000;
const RAIN_TOP = 80 * RAIN_S;        // 参考雨柱高 80 单位（再高的看不见：地平线以上就那么一条）
const RAIN_BOTTOM = -5 * RAIN_S;     // 参考落到 y<−5 就重生
function rainGlyphTexture() {
  const c = document.createElement("canvas");
  c.width = c.height = 128;
  const x = c.getContext("2d");
  x.font = 'bold 100px "Courier New", monospace';
  x.textAlign = "center"; x.textBaseline = "middle";
  x.shadowColor = "#00aaff"; x.shadowBlur = 15;
  x.fillStyle = "#ffffff";
  x.fillText(Math.random() > 0.5 ? "0" : "1", 64, 64);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
class BinaryRain {
  constructor(sc) {
    const n = 800;
    const pos = new Float32Array(n * 3);
    this.speeds = new Float32Array(n);
    for (let i = 0; i < n; i++) this._respawn(pos, i, true);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    // fog:false：雨在 40~54 m 外，吃我们那条线性雾（20~46 m）会被吞成灰，背景层就该一直在
    this.rainMat = new THREE.PointsMaterial({ color: 0x0088ff, size: 1.8 * RAIN_S, map: rainGlyphTexture(),
      transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false,
      sizeAttenuation: true, fog: false });
    this.rain = new THREE.Points(geo, this.rainMat);
    sc.add(this.rain);

    const m = 150;
    const bpos = new Float32Array(m * 3);
    this.bAng = new Float32Array(m); this.bRad = new Float32Array(m); this.bY = new Float32Array(m);
    this.bW = new Float32Array(m);   // 每颗的角速度：参考是横向 1.5 单位/秒，换成绕壳转要除以半径
    for (let i = 0; i < m; i++) {
      this.bAng[i] = Math.random() * Math.PI * 2;
      this.bRad[i] = RAIN_R0 + Math.random() * (RAIN_R1 - RAIN_R0);
      this.bW[i] = (1.5 * RAIN_S) / this.bRad[i];
      this.bY[i] = (5 + Math.random() * 40) * RAIN_S;   // 参考 y = 5 + rand*40
      bpos[i * 3] = Math.cos(this.bAng[i]) * this.bRad[i];
      bpos[i * 3 + 1] = this.bY[i];
      bpos[i * 3 + 2] = Math.sin(this.bAng[i]) * this.bRad[i];
    }
    const bgeo = new THREE.BufferGeometry();
    bgeo.setAttribute("position", new THREE.BufferAttribute(bpos, 3));
    // sizeAttenuation:false = 参考原样：光斑是屏幕空间 2.5 px，不随距离缩
    this.bokehMat = new THREE.PointsMaterial({ size: 2.5, map: dotTex, color: 0x00ccff,
      transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false,
      sizeAttenuation: false, fog: false });
    this.bokeh = new THREE.Points(bgeo, this.bokehMat);
    sc.add(this.bokeh);
  }
  _respawn(arr, i, anywhere) {
    const a = Math.random() * Math.PI * 2;
    const r = RAIN_R0 + Math.random() * (RAIN_R1 - RAIN_R0);
    arr[i * 3] = Math.cos(a) * r;
    // anywhere = 首帧铺满整柱；之后只在柱顶以上 20 单位（参考原样）重生，免得眼前凭空冒字
    arr[i * 3 + 1] = anywhere ? Math.random() * RAIN_TOP : RAIN_TOP + Math.random() * 20 * RAIN_S;
    arr[i * 3 + 2] = Math.sin(a) * r;
    this.speeds[i] = (3 + Math.random() * 5) * RAIN_S;   // 参考 3~8 单位/秒 → 毫米/秒
  }
  update(delta) {
    const gb = PULSE_SETTINGS.rainEnabled ? PULSE_SETTINGS.rainBrightness : 0;
    this.rainMat.opacity = gb;
    this.bokehMat.opacity = gb * 0.8;
    if (!PULSE_SETTINGS.rainEnabled) return;   // 关着 = 不透明度 0 且粒子冻住，省掉每帧 950 次写
    const pos = this.rain.geometry.attributes.position.array;
    for (let i = 0; i < this.speeds.length; i++) {
      pos[i * 3 + 1] -= this.speeds[i] * delta;
      if (pos[i * 3 + 1] < RAIN_BOTTOM) this._respawn(pos, i, false);
    }
    this.rain.geometry.attributes.position.needsUpdate = true;
    const bpos = this.bokeh.geometry.attributes.position.array;
    for (let i = 0; i < this.bAng.length; i++) {
      this.bAng[i] += this.bW[i] * delta;
      this.bY[i] += 0.8 * RAIN_S * delta;        // 参考上升 0.8 单位/秒
      if (this.bY[i] > 50 * RAIN_S) this.bY[i] = 0;   // 参考到 y>50 归零
      bpos[i * 3] = Math.cos(this.bAng[i]) * this.bRad[i];
      bpos[i * 3 + 1] = this.bY[i];
      bpos[i * 3 + 2] = Math.sin(this.bAng[i]) * this.bRad[i];
    }
    this.bokeh.geometry.attributes.position.needsUpdate = true;
  }
}
let binaryRain = null;   // 同上
export function setRainEnabled(on, quiet) {
  PULSE_SETTINGS.rainEnabled = !!on;
  try { localStorage.setItem(PS_KEY, JSON.stringify(PULSE_SETTINGS)); } catch (e) { /* 同上 */ }
  if (!quiet) touchSettings();
}
// 地面的数值正对照：截图是黑的（WebGL 抓帧的老毛病），"底波在不在动"只能靠顶点高度取证。
// 起伏取的是 |y| 之和：正余弦一场下来 y 的和本身接近 0（一半隆一半凹），拿代数和会永远读出一个像零的数。
function terrainBounds() {
  const p = rippleTerrain.geometry.attributes.position.array;
  const c = rippleTerrain.geometry.attributes.color.array;
  let y0 = Infinity, y1 = -Infinity, abs = 0, lit = 0;
  for (let i = 0; i < p.length; i += 3) {
    const y = p[i + 1];
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
    abs += Math.abs(y);
    if (Math.abs(y) > 0.02) lit++;   // 单位是参考单位（1 = 80 mm），这一线就是"离地 1.6 mm 以上"
  }
  return { 起伏mm: [Math.round(y0 * GROUND_S), Math.round(y1 * GROUND_S)],
    起伏绝对和mm: Math.round(abs * GROUND_S), 隆起点数: lit };
}
export function updateGround(delta, t) {
  stepRipples(t);
  rippleTerrain.update(delta);
  binaryRain.update(delta);
}
// 涟漪自己的节拍（2026-09-24 脱钩）：以前这圈环是"脉冲爆发时顺手踢一脚"才有的，
// 于是关了脉冲地面就一直是平的 —— 用户裁定两者是独立的两个效果。现在每台按自己负载档位
// 的间隔（空闲 3.0s / 活跃 2.0s / 高负载 1.2s）自己起圈，颜色与强度仍取自同一张 STATES 表，
// 所以"脚下什么色 = 什么档位"这条读法跟脉冲完全一致，只是两套计时器互不牵连。
function stepRipples(t) {
  if (!PULSE_SETTINGS.rippleEnabled) return;
  const spread = Math.max(1, holders.length);
  let i = 0;
  for (const d of devices) {
    const h = holderOf(d);
    if (!h) continue;   // 收起的 / 已关闭分区里的：屏幕上没有它，地面也不替它荡
    i++;
    let rt = rippleRt.get(d.id);
    if (!rt) { rt = { next: null }; rippleRt.set(d.id, rt); }
    const st = levelOf(d);
    if (!st) { rt.next = null; continue; }
    // 首次错开相位：不然几台在同一瞬间一起起圈，地面看着像被人同时拍了一把
    if (rt.next === null) rt.next = t + (i * st.interval) / spread;
    // 落后多少都只补一圈（不追帧）：切到后台再回来那一瞬，不该在原地撒出十几圈
    if (t >= rt.next) {
      rippleTerrain.addRipple(h.x, h.z, st.color, st.amplitude);
      rt.next = t + st.interval;
    }
  }
}
// 雨壳的数值正对照：截图是黑的（WebGL 抓帧的老毛病），"壳围着地图"这件事只能靠半径/高度范围证明
function rainBounds() {
  const p = binaryRain.rain.geometry.attributes.position.array;
  let r0 = Infinity, r1 = -Infinity, y0 = Infinity, y1 = -Infinity, ySum = 0;
  for (let i = 0; i < p.length; i += 3) {
    const rr = Math.hypot(p[i], p[i + 2]);
    if (rr < r0) r0 = rr;
    if (rr > r1) r1 = rr;
    if (p[i + 1] < y0) y0 = p[i + 1];
    if (p[i + 1] > y1) y1 = p[i + 1];
    ySum += p[i + 1];
  }
  return { 雨滴: p.length / 3, 壳半径mm: [RAIN_R0, RAIN_R1], 雨柱高mm: RAIN_TOP,
    字径mm: binaryRain.rainMat.size, 最慢mm每秒: 3 * RAIN_S, 最快mm每秒: 8 * RAIN_S,
    雨半径mm: [Math.round(r0), Math.round(r1)], 雨高度mm: [Math.round(y0), Math.round(y1)],
    雨Y和mm: Math.round(ySum),   // 两次读数不同 = 雨真在下（关掉开关后应当不动）
    光斑: binaryRain.bAng.length };
}

const realLoadOf = (d) => framePct(d.frame);
export function stepLoads(t) {
  for (const d of devices) {
    if (d.hidden || zoneOffOf(d)) continue;   // 屏幕上没有它 → 不用替它算分级
    let w = loads.get(d.id);
    if (!w) {
      w = { pct: liveOf(d) ? null : 10 + Math.random() * 45, k: Math.random() * 6.283, key: null };
      loads.set(d.id, w);
    }
    const real = realLoadOf(d);
    if (real != null) w.pct = real;
    else if (liveOf(d)) w.pct = null;   // 填了地址却还没抓到帧 = 没有数。没有数就不编档位：
                                        // 档位一编出来，脚下的环、涟漪、区的角铁颜色全跟着假数走
                                        //（2026-09-24 他问"初始跳动的依据是否真实"就是这条）
    else {
      const wave = (Math.sin(t * 0.35 + w.k) + 1) / 2;   // 每台的相位不同，不然五台同色同拍
      const target = clampv(8 + wave * 76 + (Math.random() < 0.06 ? 32 : 0) + (Math.random() - 0.5) * 12, 0, 100);
      w.pct += (target - w.pct) * 0.28;
    }
    const key = d.power && w.pct != null ? stateOf(w.pct).key : null;
    if (key !== w.key) {
      w.key = key;
      const h = holderOf(d);
      if (h) paintLabel(h, d);   // 换档那一刻，名字下面那行字跟着变（不看脚下也能核对）
    }
  }
}

const PULSE = { count: 800, upCount: 60, maxAge: 2.5, upMaxAge: 2.0, size: 26, upSize: 22, yOff: 8 };
const livePulses = [];
const liveUp = [];
const pulseRt = new Map();   // device.id -> { nextBurst, queue }
// 自检钩子的时间戳（跨次调用保持单调，见下面 pulseRun 的注释）。原来是两个页面级 let：
// 钩子搬进来之后写它们的是本模块，用对象装是因为 ES module 的 import 绑定对导入方是只读的。
// 脉冲与地面各用一个数（不共用），免得推地面把脉冲的相位也推走。
const probeClock = { t: 0, gt: 0 };

function makePoints(n, color, size, map) {
  const pos = new Float32Array(n * 3);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  const mat = new THREE.PointsMaterial({ color, size, map, transparent: true, opacity: 1,
    blending: THREE.AdditiveBlending, depthWrite: false, sizeAttenuation: true });
  const pts = new THREE.Points(geo, mat);
  scene.add(pts);
  return pts;
}

// 一次"爆发"= 按 burst 次数排进延迟队列，间隔 0 / 0.2 / 0.35s，形成"嘟"、"嘟嘟"、"嘟嘟嘟"的节奏
function triggerBurst(rt, st, t) {
  for (let i = 0; i < st.burst; i++) {
    rt.queue.push({ at: t + (i === 0 ? 0 : i === 1 ? 0.2 : 0.35), color: st.color });
  }
}

function spawnPulse(h, color) {
  const n = PULSE.count;
  const angles = new Float32Array(n);
  const sp = new Float32Array(n);
  const travel = Math.max(400, h.footR * PULSE_SETTINGS.travelK);
  const pts = makePoints(n, color, PULSE.size, tailTex);
  const arr = pts.geometry.attributes.position.array;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    angles[i] = a;
    // 参考里 18~26 的每粒独立速度：快的当"前哨"、慢的拉出"尾巴"，环才不会是一条硬边
    sp[i] = travel * (0.69 + Math.random() * 0.31);
    const r0 = h.footR * (0.07 + Math.random() * 0.4);
    arr[i * 3] = h.x + Math.cos(a) * r0;
    arr[i * 3 + 1] = PULSE.yOff + Math.random() * h.footR * 0.09;
    arr[i * 3 + 2] = h.z + Math.sin(a) * r0;
  }
  livePulses.push({ pts, angles, sp, age: 0, x: h.x, z: h.z, travel, ripple: h.footR * 0.07 });
}

function spawnUpward(h, color) {
  const n = PULSE.upCount;
  const sp = new Float32Array(n);
  const life = new Float32Array(n);
  const pts = makePoints(n, color, PULSE.upSize, dotTex);
  const arr = pts.geometry.attributes.position.array;
  for (let i = 0; i < n; i++) {
    const a = Math.random() * Math.PI * 2;
    const r = h.footR * (0.35 + Math.random() * 1.7);
    arr[i * 3] = h.x + Math.cos(a) * r;
    arr[i * 3 + 1] = PULSE.yOff + Math.random() * 12;
    arr[i * 3 + 2] = h.z + Math.sin(a) * r;
    sp[i] = 120 + Math.random() * 200;        // 上升速度 mm/s（参考 1.5~4 单位/s）
    life[i] = 0.5 + Math.random() * 0.5;      // 生命周期系数：让这一把错落消失而不是同时没了
  }
  liveUp.push({ pts, sp, life, age: 0, x: h.x, z: h.z });
}

function disposePoints(list, i) {
  const p = list[i];
  scene.remove(p.pts);
  p.pts.geometry.dispose();
  p.pts.material.dispose();
  list.splice(i, 1);
}

export function updatePulses(dt, t) {
  // 总开关关着：一个都不发。nextBurst 留 null，重新打开时相位会重新错开，
  // 不会出现"关掉五分钟、一打开全场同时炸一轮"。
  if (!PULSE_SETTINGS.enabled) {
    for (const rt of pulseRt.values()) { rt.queue.length = 0; rt.nextBurst = null; }
    return;
  }
  // 遍历的是 devices 而不是 holders：收起了某台、关掉了某个分区之后，holders 比 devices 短，
  // 按同一个下标配对会整体错位一格（A 台的地盘上发 B 台的环）。holderOf 才是这两张表的对应关系。
  const spread = Math.max(1, holders.length);
  let i = 0;
  for (const d of devices) {
    const h = holderOf(d);
    if (!h) continue;   // 屏幕上没有它：不发环，也不替它排下一轮
    i++;
    let rt = pulseRt.get(d.id);
    if (!rt) { rt = { nextBurst: null, queue: [] }; pulseRt.set(d.id, rt); }
    const st = levelOf(d);
    if (!st) {
      // 关机 / 设备已删：排队的丢掉，已经在飞的让它跑完寿命自然散（跟参考"停发不停飞"一致）
      rt.queue.length = 0; rt.nextBurst = null;
      continue;
    }
    // 首次给一个错开的相位：不然五台在同一瞬间一起发、然后一起静默半秒
    if (rt.nextBurst === null) rt.nextBurst = t + (i * st.interval) / spread;
    if (t >= rt.nextBurst) {
      triggerBurst(rt, st, t);
      rt.nextBurst = t + st.interval;
    }
    for (let j = rt.queue.length - 1; j >= 0; j--) {
      if (t < rt.queue[j].at) continue;
      const color = rt.queue[j].color;
      rt.queue.splice(j, 1);
      spawnPulse(h, color);
      spawnUpward(h, color);
      // 地面涟漪不再在这里激起：2026-09-24 用户裁定两个效果要各自独立，
      // 环的节拍挪到了下面自己的 stepRipples（关脉冲也照荡）。
    }
  }

  for (let i = livePulses.length - 1; i >= 0; i--) {
    const p = livePulses[i];
    p.age += dt;
    const k = p.age / PULSE.maxAge;
    if (k >= 1) { disposePoints(livePulses, i); continue; }
    // 缓动 pow(k,0.75)：初段快、尾段略慢（参考里就是这一条）
    const ease = Math.pow(k, 0.75);
    const arr = p.pts.geometry.attributes.position.array;
    for (let j = 0; j < p.angles.length; j++) {
      const r = ease * p.sp[j];
      arr[j * 3] = p.x + Math.cos(p.angles[j]) * r;
      arr[j * 3 + 2] = p.z + Math.sin(p.angles[j]) * r;
      arr[j * 3 + 1] = PULSE.yOff + Math.sin(t * 5 + j) * p.ripple * (1 - k);
    }
    p.pts.geometry.attributes.position.needsUpdate = true;
    // 亮度核心：start → end 线性插值，曲线 pow(k,0.8)
    const b = PULSE_SETTINGS.pulseStartBrightness
      + (PULSE_SETTINGS.pulseEndBrightness - PULSE_SETTINGS.pulseStartBrightness) * Math.pow(k, 0.8);
    p.pts.material.opacity = Math.max(0, b);
    p.pts.material.size = PULSE.size * (1 - k * 0.5);
  }

  for (let i = liveUp.length - 1; i >= 0; i--) {
    const u = liveUp[i];
    u.age += dt;
    const k = u.age / PULSE.upMaxAge;
    if (k >= 1) { disposePoints(liveUp, i); continue; }
    const arr = u.pts.geometry.attributes.position.array;
    for (let j = 0; j < u.sp.length; j++) {
      arr[j * 3 + 1] += u.sp[j] * dt * u.life[j];
      arr[j * 3] += (arr[j * 3] - u.x) * dt * 0.3;     // 轻微外飘
      arr[j * 3 + 2] += (arr[j * 3 + 2] - u.z) * dt * 0.3;
    }
    u.pts.geometry.attributes.position.needsUpdate = true;
    u.pts.material.opacity = Math.max(0, PULSE_SETTINGS.upParticleBrightness * (1 - k));
  }
}
// ---------- 自检钩子（原来长在页面的 __hm 里，键名一个没改）----------
// 为什么跟着搬：这些读数要拆的是 rippleTerrain.ripples / binaryRain.rainMat / livePulses[].travel
// 这类**内部字段**，留在页面就得把那六七个对象全部 export 出去。谁是数组的主人，谁就出这份读数。

// 背景标签页 rAF 不跑，脉冲系统没法自己走：这个钩子手推它。时间基准取"真时钟与上次探针里更靠前的那个"
// 往后推，并且跨次调用保持单调 —— 上一版每次从 0 起，把队列里的延迟项甩到了"未来"，读数假 stuck。
export function pulseRun(steps) {
  const base = Math.max(probeClock.t, clock.elapsedTime);
  const t0 = performance.now();
  for (let i = 1; i <= steps; i++) updatePulses(0.05, base + i * 0.05);
  probeClock.t = base + steps * 0.05;
  return { 环: livePulses.length, 上飘: liveUp.length,
    // 环半径取证：travel 就是这一圈能飞到的最远距离，跟脚下 footprint 半径的比就是 travelK。
    // 报"最大那台"是因为八台 footprint 不同，要按台看就读 footRmm 那一串。
    环半径mm: livePulses.length ? Math.round(Math.max(...livePulses.map((p) => p.travel))) : 0,
    footRmm: holders.map((h) => Math.round(h.footR)),
    粒子数: livePulses.reduce((a, p) => a + p.angles.length, 0) + liveUp.reduce((a, p) => a + p.sp.length, 0),
    场景内Points: scene.children.filter((o) => o.type === "Points").length,
    // 只含 updatePulses 的 CPU 提交时间，不含绘制与合成 —— GPU 侧要开人眼/帧率看
    每帧CPU毫秒: +((performance.now() - t0) / steps).toFixed(3),
    时刻: +probeClock.t.toFixed(2), 排队: holders.map((h) => ((pulseRt.get(h.id) || {}).queue || []).length) };
}
export function pulseCount() { return livePulses.length + liveUp.length; }

// 地面与雨的读数：开关、活涟漪数、点阵规模、雨的不透明度（后台标签页 rAF 不跑时用 groundRun 手推）
export function groundStats() {
  return { 涟漪开关: PULSE_SETTINGS.rippleEnabled, 雨开关: PULSE_SETTINGS.rainEnabled,
    活涟漪: rippleTerrain.ripples.length, 顶点: rippleTerrain.count, 地面平: rippleTerrain.flat,
    段数: rippleTerrain.seg, 点距mm: Math.round(24000 / rippleTerrain.seg),
    雨不透明: +binaryRain.rainMat.opacity.toFixed(3), 光斑不透明: +binaryRain.bokehMat.opacity.toFixed(3),
    点径mm: rippleTerrain.material.size, 放大: rippleTerrain.mesh.scale.x,
    地面边长mm: Math.round(300 * GROUND_S), 地面高度mm: rippleTerrain.mesh.position.y, ...rainBounds(), ...terrainBounds() };
}
export function groundRun(steps) {
  // 时间基准跨次调用保持单调（同 pulseRun 那次订正）：否则 stepRipples 的下一拍会一直算在"未来"，
  // 手推多少帧都撒不出一个环，成本读数就成了假的低。
  const base = Math.max(probeClock.gt, clock.elapsedTime);
  const t0 = performance.now();
  for (let i = 0; i < steps; i++) updateGround(0.05, base + (i + 1) * 0.05);
  probeClock.gt = base + steps * 0.05;
  return { 每帧CPU毫秒: +((performance.now() - t0) / steps).toFixed(3), 活涟漪: rippleTerrain.ripples.length,
    底波: PULSE_SETTINGS.rippleEnabled, 时刻: +probeClock.gt.toFixed(2),
    节拍: devices.map((d) => d.short + "→" + (((rippleRt.get(d.id) || {}).next) == null ? "-"
      : (((rippleRt.get(d.id) || {}).next) - probeClock.gt).toFixed(1))) };
}
// 正对照：手动撒 n 个涟漪，量"有环"时的每帧成本（跟 groundRun 空跑对比才知道环带剔除省了多少）
export function rippleKick(n) {
  for (let i = 0; i < n; i++) {
    rippleTerrain.addRipple((Math.random() - 0.5) * 9000, (Math.random() - 0.5) * 9000,
      [0x00ff41, 0xffcc00, 0xff0033][i % 3], 1);
  }
  return rippleTerrain.ripples.length;
}

// ---------- 装配 ----------
// 两张地（点阵 + 雨壳）在拿到 scene 的那一瞬间建，顺序跟原来页面里一致：地面在前、雨壳在后。
// 涟漪与脉冲的粒子数都吃 PULSE_SETTINGS，而那份值在模块求值期已由上面的恢复块夹好，所以这里不必重排。
export function initGround(ctx) {
  scene = ctx.scene;
  clock = ctx.clock;
  touchSettings = ctx.touchSettings;
  rippleTerrain = new RippleTerrain(scene);
  binaryRain = new BinaryRain(scene);
}
