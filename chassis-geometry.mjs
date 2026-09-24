// 设备几何 · 机箱与网络设备（剪影架那页用）· 可移植层
//
// 单位：1 世界单位 = 1 毫米。若你的场景是米，调用方自己乘 0.001。
// 姿态约定：一律按"立着"建 —— 底面落在局部 y=0，x/z 居中，正面朝 +z。
//           躺/站/转由调用方的 rotation 决定，几何里不写死。
// 尺寸约定：每个导出函数的包围盒严格等于 docs/尺寸与实测.md 里的真实毫米值。
//           唯一的例外是 routerAX：厂商那个 56 只是机身高，天线竖起来后实测包围盒更高，
//           两个数都记在尺寸表里（见该函数上方的注释）。
//           盒子极值由特征件单独定义（宽=侧板、高=顶窗、深=电源灯端面），
//           外壳在每个贴合面各退 1~2mm —— 两个朝外的面重合就是深度缓冲里的同一个深度，会闪。
// 颜色约定：这里不给材质（Mesh 用 three 默认材质），移植时按 mesh.name 换 palette 键。
//
// 本模块顶层不碰 document / window / renderer，node 可直接 import。
// 导出 = 9 个模型函数（laptopClosed / laptopOpen / chassisITX / chassisMATX / chassisATX / chassisEATX
//        + nasQNAP / switch8 / routerAX）+ 1 个 helper（screenContent，屏幕内容层，要传屏幕宽高，不是模型）。

import { THREE } from './src/three.mjs';

// 真实尺寸（毫米），出处见 docs/尺寸与实测.md
const MATX = { w: 205, h: 440, d: 347.5 }; // 乔思伯 D31
const ATX = { w: 212, h: 409, d: 453 }; // Fractal Design Meshify C
const EATX = { w: 240, h: 503, d: 509 }; // Fractal Design North XL
const ITX = { w: 185, h: 376, d: 292 }; // 酷冷至尊 NR200（Mini-ITX，厂商按平写给 376×185×292，这里竖着建）
const LAPTOP = { w: 317.7, closedH: 17.9, d: 226.9 }; // ThinkPad T14（14" 16:10）

const LID_THICK = 5.9; // 合盖 17.9 = 底座 12 + 屏盖 5.9（拆分是估算，总厚是真数）
const BASE_THICK = LAPTOP.closedH - LID_THICK;
const SCREEN_14 = { w: 301.6, h: 188.5 }; // 14" 16:10 可视区，由对角线 355.6 算出
const LID_TILT_DEG = 75; // 屏盖相对竖直方向后仰 75°，即开合角 105°

function box(name, w, h, d, x, y, z) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d));
  m.name = name;
  m.position.set(x, y, z);
  return m;
}

function footRing(group, w, d, r, h) {
  const inset = 14;
  const gx = w / 2 - r - inset;
  const gz = d / 2 - r - inset;
  const embed = 2; // 脚顶上端埋进外壳 2mm：底面照旧落在 y=0，但不会跟外壳底面共面
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r * 1.15, h + embed, 12));
      m.name = 'case-foot';
      m.position.set(sx * gx, (h + embed) / 2, sz * gz);
      group.add(m);
    }
  }
}

// 电源指示灯。轴朝 +z（正面），端面正好落在规格极值上（见 towerShell 的层位说明）。
function powerLed(group, x, y, z, r, len) {
  const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r, len, 10));
  m.name = 'power-led';
  m.rotation.x = Math.PI / 2;
  m.position.set(x, y, z + len / 2);
  group.add(m);
}

// 三档共用的空壳：外壳 + 脚 + 前面板底 + 电源指示灯。特征件由各档自己写死。
//
// 正面是三个不同深度的平面，不是齐平的一片：**外壳 d/2-2、前面板 d/2-1、电源灯 d/2**。
// 齐平（两个朝外的面重合在同一平面）在深度缓冲里就是同一个深度，整块面积会闪；
// 差 1mm 就分得开。外壳在正面/顶面退 1~2mm，宽度那 1mm 退在**没有侧板的那一侧**（侧板在 −x，
// 所以外壳 x 从 −w/2+1 到 +w/2），让外面那些特征件去定义规格极值，
// 所以包围盒仍然严格等于 docs/尺寸与实测.md 的真数（宽由侧板定、高由顶窗定、深由电源灯定）。
function towerShell(w, h, d, footH, footR) {
  const g = new THREE.Group();
  const bodyH = h - footH;
  g.add(box('case-shell', w - 1, bodyH - 1, d - 2, 0.5, footH + (bodyH - 1) / 2, -1));
  footRing(g, w, d, footR, footH);
  g.add(box('front-panel', w - 8, bodyH - 6, 4, 0, footH + bodyH / 2, d / 2 - 3));
  powerLed(g, w / 2 - 26, h - 30, d / 2 - 1, 3.5, 1);
  return g;
}

// ITX：矮一圈的方盒子，正面上下两段大网孔（NR200 正面几乎全是进风网）
export function chassisITX() {
  const { w, h, d } = ITX;
  const g = towerShell(w, h, d, 10, 9);
  const bodyH = h - 10;
  g.add(box('front-grille', w - 34, bodyH * 0.3, 3, 0, 10 + bodyH * 0.26, d / 2 - 4.5));
  g.add(box('front-grille', w - 34, bodyH * 0.3, 3, 0, 10 + bodyH * 0.68, d / 2 - 4.5));
  g.add(box('top-vent', 130, 3, 170, 0, h - 1.5, -10));
  g.add(box('side-window', 4, 210, 200, -w / 2 + 2, 10 + bodyH * 0.52, -10));
  g.add(box('io-panel', 62, 12, 3, 0, 10 + bodyH - 26, d / 2 - 4.5));
  return g;
}

// mATX：竖条格栅 + 顶面一块散热窗（D31 的正面是大面积网孔）
export function chassisMATX() {
  const { w, h, d } = MATX;
  const g = towerShell(w, h, d, 12, 11);
  const bodyH = h - 12;
  const slats = 9;
  for (let i = 0; i < slats; i++) {
    const y = 12 + bodyH * 0.12 + (i * bodyH * 0.72) / (slats - 1);
    g.add(box('front-grille', 150, 9, 3, 0, y, d / 2 - 4.5));
  }
  g.add(box('top-vent', 150, 3, 190, 0, h - 1.5, -20));
  g.add(box('side-window', 4, 260, 230, -w / 2 + 2, 12 + bodyH * 0.52, -20));
  g.add(box('io-panel', 70, 14, 3, 0, h - 30, d / 2 - 4.5));
  return g;
}

// ATX：横条格栅 + 前后两段顶面散热（Meshify C 的正面是斜切网孔）
export function chassisATX() {
  const { w, h, d } = ATX;
  const g = towerShell(w, h, d, 14, 12);
  const bodyH = h - 14;
  const slats = 12;
  for (let i = 0; i < slats; i++) {
    const y = 14 + bodyH * 0.1 + (i * bodyH * 0.76) / (slats - 1);
    g.add(box('front-grille', 168, 6, 3, 0, y, d / 2 - 4.5));
  }
  g.add(box('top-vent', 170, 3, 150, 0, h - 1.5, d / 2 - 110));
  g.add(box('top-vent-rear', 170, 3, 130, 0, h - 1.5, -d / 2 + 90));
  g.add(box('side-window', 4, 300, 340, -w / 2 + 2, 14 + bodyH * 0.5, -20));
  g.add(box('io-panel', 90, 12, 3, 0, h - 26, d / 2 - 4.5));
  return g;
}

// E-ATX：整幅竖肋前面板 + 两段顶面散热 + 大侧板（North XL 的正面是竖向肋条）
export function chassisEATX() {
  const { w, h, d } = EATX;
  const g = towerShell(w, h, d, 16, 13);
  const bodyH = h - 16;
  const ribs = 7;
  for (let i = 0; i < ribs; i++) {
    const x = -w / 2 + 28 + (i * (w - 56)) / (ribs - 1);
    g.add(box('front-rib', 12, bodyH * 0.82, 3, x, 16 + bodyH / 2, d / 2 - 4.5));
  }
  g.add(box('top-vent', 190, 3, 200, 0, h - 1.5, d / 2 - 140));
  g.add(box('top-vent-rear', 190, 3, 200, 0, h - 1.5, -d / 2 + 140));
  g.add(box('side-window', 4, 380, 420, -w / 2 + 2, 16 + bodyH * 0.48, -10));
  // io-panel 比竖肋再退 1mm：这一档的竖肋够高，顶到 io-panel 的高度区间里，
  // 同一平面上就是共面（共面会闪）。错开 1mm 变成互相穿插，穿插不闪。
  g.add(box('io-panel', 110, 14, 3, 0, 16 + bodyH - 40, d / 2 - 5.5));
  return g;
}

// ===== 三台"不是机箱"的机器：NAS / 交换机 / 路由器 =====
// 规格出处、以及"厂商给的两个数到底哪个是深哪个是高"的判断，都记在 docs/尺寸与实测.md 第五节。
// 极值分配沿用 towerShell 的思路：没有突出件的轴由外壳自己顶到极值，被特征件占掉的那一面
// 外壳退位 —— 每个朝外的面只属于一件，共面（同一轴向、同一坐标、面积还重叠）就会闪。
const NAS551 = { w: 148, h: 220, d: 182 }; // 威联通 TS-551：官方"尺寸（高×宽×深）220×148×182 mm"
const SW8 = { w: 158, h: 25, d: 100 }; // TP-LINK TL-SG1008D：官方"158×100×25 mm"，8 个千兆口
const RT5410 = { w: 270, h: 56, d: 245, ant: 4 }; // TP-LINK TL-XDR5410：官方"270×56×245 mm"，4 根外置天线

// NAS：立式 5 盘位（3×3.5" + 2×2.5"）。正面 5 块盘位面板 + 每块一颗状态灯，
// 背面一块内凹 I/O 底板，底板前面再放两个网口、风扇和电源孔。
export function nasQNAP() {
  const { w, h, d } = NAS551;
  const g = new THREE.Group();
  // 外壳：宽/高就是规格极值（这两轴没有突出件），前后各退位让给盘位面板和背板
  g.add(box('nas-shell', w, h, d - 8, 0, h / 2, -1)); // z ∈ [-88, 86]
  for (let i = 0; i < 5; i++) {
    const y = 38 + i * 36;
    g.add(box('nas-tray', w - 16, 34, 3, 0, y, d / 2 - 3.5)); // 前面 89：比外壳前面（86）进 3mm，比状态灯退 2mm
    g.add(box('nas-led', 4, 4, 2, -w / 2 + 14, y, d / 2 - 1)); // 端面正好落在 d/2 = 91，深的极值由它定
  }
  g.add(box('nas-power', 14, 14, 2, w / 2 - 18, 16, d / 2 - 1));
  g.add(box('nas-copy-btn', 8, 8, 2, w / 2 - 18, 200, d / 2 - 1));
  // 背面：底板退在极值内 1mm，网口 / 风扇 / 电源孔各占一块不重叠的面积去定义 -d/2
  g.add(box('nas-rear-plate', w - 24, h - 46, 2, 0, h / 2 - 3, -d / 2 + 2)); // z ∈ [-90, -88]
  g.add(box('nas-port', 15, 13, 1.5, -22, 44, -d / 2 + 0.75));
  g.add(box('nas-port-2', 15, 13, 1.5, 2, 44, -d / 2 + 0.75));
  g.add(box('nas-fan', 70, 70, 1.5, 0, 130, -d / 2 + 0.75));
  g.add(box('nas-dc', 16, 10, 1.5, 0, 196, -d / 2 + 0.75));
  return g;
}

// 交换机：158×100 的金属扁盒，25 高。8 口一排开在正面，指示灯排在顶面靠前一列。
export function switch8() {
  const { w, h, d } = SW8;
  const g = new THREE.Group();
  g.add(box('switch-shell', w, h - 1, d - 6, 0, (h - 1) / 2, -1)); // y ∈ [0,24]，z ∈ [-48,46]
  for (let i = 0; i < 8; i++) {
    const x = -63 + i * 18;
    g.add(box('switch-port', 14, 12, 4, x, 11, d / 2 - 2)); // 前面 50 = d/2，深的极值由端口定义
    // 顶面那一颗：从 24 顶到 25，高的极值由灯定义（灯底跟外壳顶面对面贴合，不闪）
    g.add(box('switch-led', 6, 1, 4, x, h - 0.5, d / 2 - 10));
  }
  // 电源灯挪到最左：跟第一颗端口灯在同一高度平面上，投影再重叠就会闪（差 1mm 间距不够，直接挪开）
  g.add(box('switch-led-pwr', 8, 1, 4, -w / 2 + 8, h - 0.5, d / 2 - 10));
  g.add(box('switch-dc', 12, 9, 4, w / 2 - 16, 11, -d / 2 + 2)); // 背面 -50 = -d/2
  return g;
}

// 路由器：270×245 的卧式机身，56 高，后面 4 根外置天线竖起。
// 注意：包围盒的高度是"含天线"的实测值，厂商那个 56 只是机身 —— 移植时按机身数对齐。
export function routerAX() {
  const { w, h, d } = RT5410;
  const g = new THREE.Group();
  g.add(box('router-body', w, h - 1, d - 4, 0, (h - 1) / 2, 0)); // y ∈ [0,55]，z ∈ [-120.5,120.5]
  g.add(box('router-top-vent', w - 60, 1, 90, 0, h - 0.5, -20)); // 顶面那条散热脊，y ∈ [55,56]：机身高的极值由它定
  g.add(box('router-front', 150, 10, 3, 0, 20, d / 2 - 2.5)); // 前面 121.5，比极值退 1mm
  g.add(box('router-led', 8, 3, 3, 0, 20, d / 2 - 1.5)); // 端面 122.5 = d/2
  g.add(box('router-ports', 110, 30, 3, 0, 20, -d / 2 + 1.5)); // 背面 -122.5 = -d/2
  for (let i = 0; i < RT5410.ant; i++) {
    const x = -120 + i * 80;
    const a = new THREE.Mesh(new THREE.CylinderGeometry(4, 5, 100, 10));
    a.name = 'router-antenna';
    a.position.set(x, 94, -d / 2 + 18);
    a.rotation.x = THREE.MathUtils.degToRad(-6); // 略微后倾，天线下端埋进机身
    g.add(a);
  }
  return g;
}

// 笔记本 · 合盖（薄板）
export function laptopClosed() {
  const { w, d } = LAPTOP;
  const g = new THREE.Group();
  // 底座前表面退 1mm（d/2-1），让屏盖前沿和电源灯去定义深度极值：
  // 灯端面要是跟底座前表面齐平，那颗灯就会闪。规格深度 226.9 仍由屏盖/灯保证。
  g.add(box('laptop-base', w, BASE_THICK, d - 1, 0, BASE_THICK / 2, -0.5));
  g.add(box('laptop-lid', w, LID_THICK, d, 0, BASE_THICK + LID_THICK / 2, 0));
  powerLed(g, w / 2 - 26, BASE_THICK - 3.5, d / 2 - 1.2, 2.2, 1.2);
  const hinge = new THREE.Mesh(new THREE.CylinderGeometry(2.6, 2.6, w - 40, 10));
  hinge.name = 'laptop-hinge';
  hinge.rotation.z = Math.PI / 2;
  hinge.position.set(0, LAPTOP.closedH - 3.4, -d / 2 + 9);
  g.add(hinge);
  return g;
}

// 笔记本 · 开盖（105°）。底座 footprint 与合盖一致，高度是开合角的派生值。
export function laptopOpen() {
  const { w, d } = LAPTOP;
  const g = new THREE.Group();
  g.add(box('laptop-base', w, BASE_THICK, d - 1, 0, BASE_THICK / 2, -0.5)); // 前表面退 1mm，理由同 laptopClosed
  g.add(box('keyboard-deck', 280, 1.2, 112, 0, BASE_THICK + 0.6, -18));
  g.add(box('trackpad', 110, 0.8, 68, 0, BASE_THICK + 0.4, 74));
  powerLed(g, w / 2 - 26, BASE_THICK - 3.5, d / 2 - 1.2, 2.2, 1.2);

  const pivot = new THREE.Group();
  pivot.name = 'laptop-lid-pivot';
  pivot.position.set(0, BASE_THICK, -d / 2 + 6);
  pivot.rotation.x = THREE.MathUtils.degToRad(LID_TILT_DEG);

  pivot.add(box('laptop-lid', w, LID_THICK, d, 0, LID_THICK / 2, -d / 2));
  // 屏盖局部 +y 那一面才朝观众（转轴 75° 之后 +y 指向世界 +z 前方），
  // 所以玻璃和内容层都在 +y 侧；装到 -y 侧就是屏盖背面，正面只能看见一块黑。
  // 层层之间留真间隙：贴合或只差零点几毫米，深度缓冲分不开会闪。
  pivot.add(box('laptop-screen', SCREEN_14.w, 1, SCREEN_14.h, 0, LID_THICK + 1.5, -d / 2));
  const content = screenContent(SCREEN_14.w, SCREEN_14.h, 0.5, 'lid');
  content.position.set(0, LID_THICK + 7.4, -d / 2);
  pivot.add(content);

  g.add(pivot);
  return g;
}

// 屏幕内容层：Windows / Linux 两套同时建出来，显示哪套由调用方按 name 前缀切可见性。
// 内容建在自己的"画面坐标系"里、以原点为中心，摆到屏幕上是调用方的事。
//   frame = 'monitor'：画面在 XY 平面，+y 是画面上方，厚度沿 z（朝 +z 出光）。
//   frame = 'lid'    ：画面在 XZ 平面（开盖笔记本屏盖内侧），-z 是画面上方，朝 +y 出光。
// 所有块都按屏幕宽高的比例算，所以 14" 笔记本和 23.8" 显示器共用这一份布局。
// layer = 出光方向上的层号，每层错开 2 倍厚度。**画面里互相重叠的块必须分层**：
// 同层就是共面，共面会闪（Windows 那两块叠着的窗口就是这种情况）。
export function screenContent(sw, sh, t, frame) {
  if (!(sw > 0) || !(sh > 0)) {
    throw new TypeError('screenContent(sw, sh, t, frame)：sw/sh 要传屏幕可视区宽高（毫米）。这是 helper，不是模型。');
  }
  const g = new THREE.Group();
  g.name = 'screen-content';
  const hx = sw / 2;
  const step = t * 2;
  const quad = (name, w, h, u, v, layer) => {
    // u = 画面横向偏移（+ 右），v = 画面纵向偏移（+ 上），o = 出光方向偏移
    const o = (layer || 0) * step;
    g.add(frame === 'lid' ? box(name, w, t, h, u, o, -v) : box(name, w, h, t, u, v, o));
  };

  quad('screen-win-bar', sw, sh * 0.05, 0, -sh / 2 + sh * 0.025, 0);
  quad('screen-win-a', sw * 0.39, sh * 0.35, -sw * 0.16, sh * 0.06, 1);
  quad('screen-win-b', sw * 0.37, sh * 0.32, sw * 0.18, -sh * 0.1, 2);

  quad('screen-linux-bar', sw, sh * 0.04, 0, sh / 2 - sh * 0.02, 0);
  const widths = [0.4, 0.66, 0.3, 0.8, 0.53, 0.2];
  for (let i = 0; i < widths.length; i++) {
    const lw = sw * widths[i];
    quad('screen-linux-line', lw, sh * 0.022, -hx + sw * 0.03 + lw / 2, sh * 0.32 - i * sh * 0.1, 0);
  }
  quad('screen-linux-cursor', sw * 0.03, sh * 0.03, -hx + sw * 0.045, sh * 0.32 - widths.length * sh * 0.1, 0);
  return g;
}
