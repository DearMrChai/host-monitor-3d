// 设备几何 · 外设与桌面组合（监控墙那页用）· 可移植层
//
// 单位 / 姿态 / 颜色约定同 chassis-geometry.mjs：
//   1 世界单位 = 1 毫米；单机件一律"立着"建（底面 y=0、x/z 居中、正面朝 +z）；
//   不给材质，移植时按 mesh.name 换 palette 键。
//
// 这一组 = 机箱与网络设备（复用 chassis-geometry.mjs）+ 显示器 / 键盘 / 鼠标 + 桌面组合。
// 组合是 Group，只含子件几何与本地变换，不写死任何全局姿态。
// 本模块顶层不碰 document / window / renderer，node 可直接 import。

import { THREE } from './src/three.mjs';
import { laptopOpen, chassisITX, chassisMATX, chassisATX, chassisEATX, screenContent } from './chassis-geometry.mjs';

// 真实尺寸（毫米），出处见 docs/尺寸与实测.md
const MONITOR = { w: 537.6, h: 430, d: 179.6, panelH: 307, panelD: 48, screen: { w: 527.0, h: 296.4 } };
const KEYBOARD = { w: 440, h: 35, d: 130 };
const MOUSE = { w: 63.5, h: 40, d: 125 };

function box(name, w, h, d, x, y, z) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d));
  m.name = name;
  m.position.set(x, y, z);
  return m;
}

function roundedRectShape(w, l, r) {
  const s = new THREE.Shape();
  const x = -w / 2;
  const y = -l / 2;
  s.moveTo(x + r, y);
  s.lineTo(x + w - r, y);
  s.quadraticCurveTo(x + w, y, x + w, y + r);
  s.lineTo(x + w, y + l - r);
  s.quadraticCurveTo(x + w, y + l, x + w - r, y + l);
  s.lineTo(x + r, y + l);
  s.quadraticCurveTo(x, y + l, x, y + l - r);
  s.lineTo(x, y + r);
  s.quadraticCurveTo(x, y, x + r, y);
  return s;
}

// 23.8" 16:9 显示器，含底座。官方给的整机高是 364~496（升降），这里取中间值 430。
export function monitor24() {
  const { w, h, d, panelH, panelD, screen } = MONITOR;
  const g = new THREE.Group();
  const panelY = h - panelH / 2;
  const panelZ = -d / 2 + panelD / 2 + 4; // 面板靠后，底座朝前（+z 是朝向用户那一侧）

  g.add(box('monitor-base', 240, 12, d, 0, 6, 0));
  g.add(box('monitor-neck', 60, panelY - panelH / 2 - 12, 30, 0, 12 + (panelY - panelH / 2 - 12) / 2, panelZ));
  g.add(box('monitor-bezel', w, panelH, panelD, 0, panelY, panelZ));
  const screenZ = panelZ + panelD / 2;
  // 面框前表面在 screenZ。玻璃外凸 2、内容层再从玻璃外 4 起：层层之间留真间隙。
  // 间隙不是讲究，是深度缓冲的分辨率要（贴合或只差零点几毫米，远处会整块闪）。
  g.add(box('monitor-screen', screen.w, screen.h, 1, 0, panelY, screenZ + 1.5));
  const content = screenContent(screen.w, screen.h, 0.6, 'monitor');
  content.position.set(0, panelY, screenZ + 6);
  g.add(content);
  return g;
}

// 全尺寸键盘。键帽按 19.05mm 键距标准做成 6 排整条，不是一颗一颗键。
export function keyboardFull() {
  const { w, h, d } = KEYBOARD;
  const g = new THREE.Group();
  const deckH = h - 9;
  g.add(box('keyboard-deck', w, deckH, d, 0, deckH / 2, 0));
  for (let i = 0; i < 6; i++) {
    g.add(box('keycap-row', w - 20, 9, 14, 0, deckH + 4.5, -50 + i * 20));
  }
  return g;
}

// 鼠标。体块由 ExtrudeGeometry 出，斜切倒角当背部弧度；包围盒严格等于 63.5 × 40 × 125。
export function mouse() {
  const { w, h, d } = MOUSE;
  const bevel = 6;
  const g = new THREE.Group();
  const shape = roundedRectShape(w - bevel * 2, d - bevel * 2, 22);
  const geo = new THREE.ExtrudeGeometry(shape, {
    depth: h - bevel * 2,
    bevelEnabled: true,
    bevelThickness: bevel,
    bevelSize: bevel,
    bevelSegments: 4,
    curveSegments: 14,
  });
  geo.rotateX(-Math.PI / 2);
  geo.translate(0, bevel, 0);
  const body = new THREE.Mesh(geo);
  body.name = 'mouse-body';
  g.add(body);

  const wheel = new THREE.Mesh(new THREE.CylinderGeometry(4, 4, 3, 12));
  wheel.name = 'mouse-wheel';
  wheel.rotation.z = Math.PI / 2;
  wheel.position.set(0, h - 6, d / 2 - 34);
  g.add(wheel);
  g.add(box('mouse-seam', 1.6, 1, 62, 0, h - 1.5, d / 2 - 33));
  return g;
}

function place(node, name, x, z) {
  node.name = name;
  node.position.set(x, 0, z);
  return node;
}

// 四个桌面组合。机箱摆在右后方，显示器居中偏后，键鼠在最前（+z 朝用户）。
// 全部落在 y=0 同一平面上，没有桌面板 —— 高度读数才干净。
export function deskLaptop() {
  const g = new THREE.Group();
  g.add(place(laptopOpen(), 'laptop', 0, 0));
  g.add(place(mouse(), 'mouse', 300, 120)); // 只作比例参照，不要就删这一行
  return g;
}

export function deskITX() {
  const g = new THREE.Group();
  g.add(place(chassisITX(), 'chassis', 320, -270));
  g.add(place(monitor24(), 'monitor', -160, -310));
  g.add(place(keyboardFull(), 'keyboard', -160, 60));
  g.add(place(mouse(), 'mouse', 110, 90));
  return g;
}

export function deskMATX() {
  const g = new THREE.Group();
  g.add(place(chassisMATX(), 'chassis', 330, -300));
  g.add(place(monitor24(), 'monitor', -160, -330));
  g.add(place(keyboardFull(), 'keyboard', -160, 60));
  g.add(place(mouse(), 'mouse', 110, 90));
  return g;
}

export function deskATX() {
  const g = new THREE.Group();
  g.add(place(chassisATX(), 'chassis', 380, -330));
  g.add(place(monitor24(), 'monitor', -160, -360));
  g.add(place(keyboardFull(), 'keyboard', -160, 60));
  g.add(place(mouse(), 'mouse', 110, 90));
  return g;
}

export function deskEATX() {
  const g = new THREE.Group();
  g.add(place(chassisEATX(), 'chassis', 450, -380));
  g.add(place(monitor24(), 'monitor', -160, -400));
  g.add(place(keyboardFull(), 'keyboard', -160, 60));
  g.add(place(mouse(), 'mouse', 110, 90));
  return g;
}
