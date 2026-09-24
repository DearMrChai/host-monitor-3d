// 陈列层（fleet）：把 devices 那张列表变成场景里的一排机器、每个区的角铁、每台头顶的标注。
//
// 为什么单独一层：它上头要读状态（model 的清单/分区/分级/档位表），下头要动场景图与 DOM 标注，
// 而地面那层（脉冲 / 涟漪 / 雨）只读它摆出来的 holders —— 依赖方向只能是
// 页面 → 地面 → fleet → model，反过来就成环（fleet 用不到涟漪，涟漪离不开 holders）。
//
// scene / fitOverview / touch 三格由入口装配时 inject 进来（见 monitor-wall.html 的 initFleet）：
// 渲染器与相机是"这一块屏"的组装产物，不该被下层反向 import；全景距离跟重画配置文件这两件事
// 属于页面接线，fleet 只在重建末尾叫它们一下。
import { THREE } from "./three.mjs";
import { devices, ZONES, STATES, tierOf, zoneKeyOf, ZONE_FIELD, CLUSTER_SPACING, CLUSTER_ROW_GAP,
  CLUSTER_PER_ROW, holders, zoneMarks, loads, zoneOffOf, levelOf } from "./model.mjs";
import { fmt } from "./format.mjs";
import { refreshPerfHead } from "./dashboard.mjs";

let scene, fitOverview, touch;
export function initFleet(ctx) { scene = ctx.scene; fitOverview = ctx.fitOverview; touch = ctx.touch; }

// ---------- 区的角铁：八个角，"木箱角铁" ----------
// 参考那份是按"区域 50×50×15"的米制场景写的，两条比例照搬、绝对值换算到 mm（本项目 1 单位 = 1 mm）：
//   臂长 = 区宽 × 5%   → 4400 × 5% = 220 mm（参考里 bracketLen = width * 0.05）
//   截面 = 区宽 × 0.3% → 4400 × 0.3% ≈ 13 mm（参考里 bracketWid = 0.15，占 50 的 0.3%）
// 不直接抄 0.15：那是米制场景的数，搬到 mm 世界里是 0.15 mm，屏幕上不存在。
// 参考里 bracketThk = 0.08 声明了却没进几何体（三根臂全用的 bracketWid），这里不替它发挥，三根臂同截面。
const BRACKET = { lenK: 0.05, widK: 0.003 };

// 一个区 = 八个角（四角 × 上下两层），每个角三根臂（X / Y / Z 各一根）= 24 件。
// 三根臂的落位全部写成"占哪一段"（X、Y、Z 各给一段区间），不写"中心 ± 半个长"——对齐能从数上直接读：
//   立柱：横截面 = 角点 ± w/2，Y 从端面（贴地 / 贴盒顶面）往内量 len
//   两根水平臂：截面与立柱同宽、Y 与立柱同层，内端顶在立柱的外侧面上（臂尖离角点仍是 len）
// 参考那份三根臂都从角点起算、在角上互相插穿 —— 插穿会让两个同向的面同时存在，同一片像素叠两层色，
// 角上会浮出一块比别处亮的补丁（本项目判据里的"同侧重合"）。这里只改这一件事：三件互不重叠、
// 贴合面朝里（max 对 min，属良性）；臂长仍按"从角点量 len"算，看着跟参考一样长。
// 返回的 Group 由调用方摆到区中心；材质挂在 userData.bracketMat 上，供换色与呼吸。
function createCornerBrackets(width, depth, height, colorHex) {
  const g = new THREE.Group();
  const len = Math.max(60, width * BRACKET.lenK);
  const w = Math.max(4, Math.round(width * BRACKET.widK));
  const mat = new THREE.MeshStandardMaterial({
    color: colorHex, emissive: colorHex, emissiveIntensity: 0.06,
    transparent: true, opacity: 0.22, roughness: 0.6, metalness: 0.8,
    depthWrite: false,   // 半透明件互相遮挡时写深度会花，不写反而稳
  });
  // 一根臂 = X / Y / Z 上各占一段；尺寸与中点都从这六个数推出来
  const seg = (name, x0, x1, y0, y1, z0, z1) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(x1 - x0, y1 - y0, z1 - z0), mat);
    m.name = name;
    m.position.set((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
    g.add(m);
  };
  const lo = (a, b) => Math.min(a, b), hi = (a, b) => Math.max(a, b);
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    const cx = (sx * width) / 2, cz = (sz * depth) / 2;     // 角点 = 盒子的角
    const ix = cx - sx * (w / 2), iz = cz - sz * (w / 2);   // 立柱内侧面（水平臂顶在这里）
    for (const top of [false, true]) {
      const vy0 = top ? height - len : 0, vy1 = top ? height : len;   // 立柱那一段：贴地或贴顶
      const hy0 = top ? height - w : 0, hy1 = top ? height : w;       // 水平臂那一段：跟立柱同层
      seg('zone-bracket-v', cx - w / 2, cx + w / 2, vy0, vy1, cz - w / 2, cz + w / 2);
      seg('zone-bracket-x', lo(ix, cx - sx * len), hi(ix, cx - sx * len), hy0, hy1, cz - w / 2, cz + w / 2);
      seg('zone-bracket-z', cx - w / 2, cx + w / 2, hy0, hy1, lo(iz, cz - sz * len), hi(iz, cz - sz * len));
    }
  }
  g.userData.bracketMat = mat;
  return g;
}

// 区的颜色 = 这堆机器里最严重的那一档（谁都不亮时按空闲绿）：
// 盒子跟着状态呼吸才有意义，否则它只是个装饰框。
const ZONE_SEVERITY = { IDLE: 0, ACTIVE: 1, ALERT: 2 };
function zoneLevel(mine) {
  let best = null;
  for (const h of mine) {
    const k = (loads.get(h.id) || {}).key;
    if (!k) continue;
    if (!best || ZONE_SEVERITY[k] > ZONE_SEVERITY[best]) best = k;
  }
  return best || 'IDLE';
}

// 机身件走受光材质；屏幕 / 屏幕内容 / 电源灯走不受光材质，这样"亮"看起来是自己发光。
const PART_COLORS = {
  "case-shell": 0x39424e, "front-panel": 0x2b333d, "front-grille": 0x5b6672, "front-rib": 0x5b6672,
  "top-vent": 0x232a32, "top-vent-rear": 0x232a32, "side-window": 0x6fb3d9, "io-panel": 0x8b95a1,
  "case-foot": 0x1c222a,
  "laptop-base": 0x2f363d, "laptop-lid": 0x3b434b, "laptop-hinge": 0x1c222a,
  "keyboard-deck": 0x2b3138, "trackpad": 0x4a535c,
  "monitor-bezel": 0x2a3038, "monitor-neck": 0x3b434b, "monitor-base": 0x2a3038,
  "keycap-row": 0x525c66, "mouse-body": 0x39424e, "mouse-wheel": 0x77838f, "mouse-seam": 0x1c222a,
  "nas-shell": 0x2f3742, "nas-tray": 0x3d4753, "nas-rear-plate": 0x232a32,
  "nas-port": 0x11151a, "nas-port-2": 0x11151a, "nas-fan": 0x1a2028, "nas-dc": 0x11151a,
  "switch-shell": 0x5a6572, "switch-port": 0x14181e, "switch-dc": 0x11151a,
  "router-body": 0x272d35, "router-top-vent": 0x1c222a, "router-front": 0x39424e,
  "router-ports": 0x14181e, "router-antenna": 0x1c222a,
};
// 状态灯一律不受光：它们跟电源走（关机就灭），不是被照亮的小塑料片。
// 名字不同是因为各档几何各写各的，收集时都塞进 parts.leds。
const LED_NAMES = ["power-led", "nas-led", "nas-power", "switch-led", "switch-led-pwr", "router-led"];
const BASIC_COLORS = {
  "screen-win-bar": 0x2f8ae0, "screen-win-a": 0xdfe9f5, "screen-win-b": 0xc6d9ef,
  "screen-linux-bar": 0x33413a, "screen-linux-line": 0x57e08a, "screen-linux-cursor": 0xb6ffcf,
};
const SCREEN_LIT = { win: 0x1668c8, linux: 0x0e1c14 };
const SCREEN_OFF = 0x0a0d11;
const LED_ON = 0x7ee2a8;
const LED_OFF = 0x232a31;

function paint(group) {
  group.traverse((o) => {
    if (!o.isMesh) return;
    if (BASIC_COLORS[o.name] !== undefined) {
      o.material = new THREE.MeshBasicMaterial({ color: BASIC_COLORS[o.name] });
    } else if (LED_NAMES.indexOf(o.name) >= 0) {
      o.material = new THREE.MeshBasicMaterial({ color: LED_ON });
    } else if (o.name === "monitor-screen" || o.name === "laptop-screen") {
      o.material = new THREE.MeshBasicMaterial({ color: SCREEN_LIT.win });
    } else {
      o.material = new THREE.MeshStandardMaterial({
        color: PART_COLORS[o.name] !== undefined ? PART_COLORS[o.name] : 0x4a545f,
        roughness: 0.62, metalness: 0.08,
      });
    }
  });
  return group;
}

// 按 name 把可动的件挑出来，状态只改这几件
function collectParts(model) {
  const p = { screens: [], win: [], linux: [], leds: [] };
  model.traverse((o) => {
    if (!o.isMesh) return;
    if (o.name === "monitor-screen" || o.name === "laptop-screen") p.screens.push(o);
    else if (LED_NAMES.indexOf(o.name) >= 0) p.leds.push(o);
    else if (o.name.indexOf("screen-win") === 0) p.win.push(o);
    else if (o.name.indexOf("screen-linux") === 0) p.linux.push(o);
  });
  return p;
}

function dropStation(h) {
  scene.remove(h.holder);
  h.model.traverse((o) => {
    if (!o.isMesh) return;
    o.geometry.dispose();
    o.material.dispose();
  });
  h.div.remove();
}

// 按 devices 重造这张地图：台数 / 次序 / 档位 / 落区全部跟着列表走，不存在第二份名单
export function rebuild() {
  for (const h of holders) dropStation(h);
  clearZoneMarks();
  const built = devices.filter((d) => !d.hidden && !zoneOffOf(d)).map((d) => {
    const model = paint(tierOf(d.tier).make());
    const holder = new THREE.Group();
    holder.add(model);
    scene.add(holder);

    const bb = new THREE.Box3().setFromObject(model);
    const size = bb.getSize(new THREE.Vector3());
    // 脉冲的"地盘"按机器本体算，不按整套桌面：桌面组合里显示器 + 键鼠摊到 860mm 宽，
    // 拿它当半径的话一圈能罩到邻居家脚下。机器本体在组合里的 name 是 chassis / laptop
    // （约定见 desk-geometry.mjs 的 place），NAS / 交换机 / 路由器这档整个模型就是本体。
    const machine = model.getObjectByName("chassis") || model.getObjectByName("laptop") || model;
    const msz = new THREE.Box3().setFromObject(machine).getSize(new THREE.Vector3());
    let meshes = 0;
    model.traverse((o) => { if (o.isMesh) meshes++; });

    const div = document.createElement("div");
    div.className = "lbl";
    const b = document.createElement("b");
    const span = document.createElement("span");
    span.textContent = "整套 宽 " + fmt(size.x) + " × 高 " + fmt(size.y) + " × 深 " + fmt(size.z)
      + " mm · " + meshes + " 件";
    const stateLine = document.createElement("i");
    div.append(b, stateLine, span);
    div.title = d.short + " · " + span.textContent;
    document.body.appendChild(div);

    return { id: d.id, holder, model, div, b, stateLine, parts: collectParts(model), upH: size.y,
      stag: 0, zone: zoneKeyOf(d), hw: size.x / 2, hd: size.z / 2, x: 0, z: 0,
      footR: Math.max(msz.x, msz.z) * 0.5 };
  });
  layoutClusters(built);
  for (const h of built) h.holder.position.set(h.x, 0, h.z);
  // holders 长驻同一个数组（只能就地改，理由见 src/model.mjs 那一段）：换绑的话导入方看着的还是旧的空数组
  holders.length = 0;
  holders.push(...built);
  drawZoneMarks(built);
  for (const d of devices) applyState(d);
  fitOverview();
}

// 区内聚成一堆：一行最多 CLUSTER_PER_ROW 台、满了换行，每行各自居中到区中心。
// 标注错行仍然按列表序奇偶来（同一行里两台机器的名字不能叠在一起）。
function layoutClusters(built) {
  for (const z of ZONES) {
    const mine = built.filter((h) => h.zone === z.key);
    const rows = Math.max(1, Math.ceil(mine.length / CLUSTER_PER_ROW));
    mine.forEach((h, i) => {
      const row = Math.floor(i / CLUSTER_PER_ROW);
      const col = i % CLUSTER_PER_ROW;
      const inRow = Math.min(CLUSTER_PER_ROW, mine.length - row * CLUSTER_PER_ROW);
      h.x = z.at[0] + (col - (inRow - 1) / 2) * CLUSTER_SPACING;
      h.z = z.at[1] + (row - (rows - 1) / 2) * CLUSTER_ROW_GAP;
    });
  }
  built.forEach((h, i) => { h.stag = (i % 2) * -50; });
}

// 每个区：八角角铁（尺寸全等，所以八对称）+ 一块区名。角铁就是"这里有个格子"的全部证据——
// 参考那份代码里本来也没有盒子面，我不该自己加一层力场。
// 角铁要"若有若无"：opacity 0.22 + 微弱自发光 0.06 呼吸，靠近了才看得出来是金属锚点。
function clearZoneMarks() {
  for (const m of zoneMarks) {
    scene.remove(m.cell);
    m.cell.traverse((o) => { if (o.geometry) o.geometry.dispose(); });
    m.bracketMat.dispose();
    m.div.remove();
  }
  zoneMarks.length = 0;   // 同 holders：长驻一个数组，就地清空
}
function drawZoneMarks(built) {
  for (const z of ZONES) {
    // 关掉的分区（z.off）：地面上不画角铁、不挂区名 —— 落到这个区里的设备在 rebuild 那一步就被筛掉了，
    // 改回来原样回来（key / 名字 / 位置 / 归属一个字没动）。
    if (z.off) continue;
    const mine = built.filter((h) => h.zone === z.key);
    const cell = new THREE.Group();
    cell.position.set(z.at[0], 0, z.at[1]);   // 盒子以区中心为原点，底面落在 y=0
    const colorHex = STATES.find((st) => st.key === (mine.length ? zoneLevel(mine) : 'IDLE')).color;
    const brackets = createCornerBrackets(ZONE_FIELD.w, ZONE_FIELD.d, ZONE_FIELD.h, colorHex);
    cell.add(brackets);
    scene.add(cell);

    // 溢出如实报：机器伸出盒子就是"格子画小了"，别让它悄悄穿帮
    let overflow = 0;
    for (const h of mine) {
      const dx = Math.abs(h.x - z.at[0]), dz = Math.abs(h.z - z.at[1]);
      if (dx + h.hw > ZONE_FIELD.w / 2 || dz + h.hd > ZONE_FIELD.d / 2 || h.upH > ZONE_FIELD.h) overflow++;
    }
    const div = document.createElement("div");
    div.className = "zlbl";
    div.textContent = z.cn + " · " + mine.length + " 台" + (overflow ? " ⚠ 出格 " + overflow : "");
    document.body.appendChild(div);
    zoneMarks.push({ cell, div, bracketMat: brackets.userData.bracketMat,
      at: new THREE.Vector3(z.at[0], ZONE_FIELD.h, z.at[1] + ZONE_FIELD.d / 2 + 320),
      overflow, key: z.key, n: mine.length });
  }
}
// 换档时只改三根材质的颜色，不重建几何
export function paintZoneColors() {
  for (const m of zoneMarks) {
    const mine = holders.filter((h) => h.zone === m.key);
    const hex = STATES.find((st) => st.key === zoneLevel(mine)).color;
    m.bracketMat.color.setHex(hex);
    m.bracketMat.emissive.setHex(hex);
  }
}

export const holderOf = (d) => holders.find((h) => h.id === d.id);

// 名字下面那行字：状态 + 分级 + 当前负载。分级换档时 stepLoads 会单独重画这一行，
// 不走 applyState —— 那条路末尾有 touch()，会为了一个标签去写配置文件。
export function paintLabel(h, d) {
  const on = d.power;
  const st = levelOf(d);
  const pct = on ? Math.round((loads.get(d.id) || {}).pct || 0) : 0;
  h.stateLine.textContent = on ? (st ? "● " + st.cn + " " + pct + "%" : "●") : "○ 关机";
  h.stateLine.className = on ? (st ? "lv-" + st.key : "on") : "";
}

// 一台设备的状态只改这几件：屏幕颜色、两套内容层的可见性、电源灯、标注那行字
export function applyState(d) {
  const h = holderOf(d);
  if (!h) return;
  const on = d.power;
  h.b.textContent = d.short;
  const lit = on ? SCREEN_LIT[d.os] : SCREEN_OFF;
  for (const m of h.parts.screens) m.material.color.setHex(lit);
  for (const m of h.parts.win) m.visible = on && d.os === "win";
  for (const m of h.parts.linux) m.visible = on && d.os === "linux";
  for (const m of h.parts.leds) m.material.color.setHex(on ? LED_ON : LED_OFF);
  paintLabel(h, d);
  if (d.pwBtn) {
    d.pwBtn.textContent = on ? "● 开机" : "○ 关机";
    d.pwBtn.classList.toggle("on", on);
  }
  if (d.pwChip) {
    d.pwChip.textContent = on ? "● 开机" : "○ 关机";
    d.pwChip.classList.toggle("set", on);
  }
  refreshPerfHead();
  touch();
}
