// 状态层：设备清单、分区、三档分级、可调参数表在整页只有一份，就是这里。
//
// 为什么 devices 要配一个 setDevices()：ESM 的 live binding 只对"导出方自己的赋值"生效。
// 别的模块写 PULSE_SETTINGS.enabled = false 这类属性改得动、也看得见；
// 但 devices = 新数组 这种整体换绑，在导入方那一侧只会抛 TypeError（导入的绑定只读）。
// 所以清单整份替换必须走 setDevices()；ZONES 反过来刻意长驻同一个数组
// （loadZones 用 length = 0 再 push），不换绑，也就不需要 setter。
//
// 档位表要拿模型函数，所以几何在这里 import 进来（页面自己不再直接吃这两份）。
import { deskLaptop, deskITX, deskMATX, deskATX, deskEATX } from '../desk-geometry.mjs';
import { nasQNAP, switch8, routerAX } from '../chassis-geometry.mjs';

// 档位表：一档 = 一个现成的桌面组合函数。设备只存"我叫什么 + 我是哪档 + 开机没 + 什么系统"，
// 场景里的那一排和设置列表都从这里派生，所以两边不会走散。
const TIERS = [
  { key: "laptop", chip: "笔记本", label: "笔记本（开盖 + 鼠标作比例参照）", make: deskLaptop },
  { key: "itx", chip: "ITX", label: "ITX 机箱 + 显示器 + 键鼠", make: deskITX },
  { key: "matx", chip: "mATX", label: "mATX 机箱 + 显示器 + 键鼠", make: deskMATX },
  { key: "atx", chip: "ATX", label: "ATX 机箱 + 显示器 + 键鼠", make: deskATX },
  { key: "eatx", chip: "E-ATX", label: "E-ATX 机箱 + 显示器 + 键鼠", make: deskEATX },
  // 后三档没有屏幕，所以 applyState 那几件（screens / win / linux）自然是空数组，不用特判。
  // 示例型号照用户给的"威联通551"口径，另外两台挑了同量级的真型号（尺寸出处见 docs/尺寸与实测.md 第五节）。
  { key: "nas", chip: "NAS", label: "NAS（威联通 TS-551 示例）", make: nasQNAP },
  { key: "switch", chip: "交换机", label: "8 口交换机（TP-LINK SG1008D 示例）", make: switch8 },
  { key: "router", chip: "路由器", label: "无线路由器（TP-LINK XDR5410 示例）", make: routerAX },
];
const tierOf = (k) => TIERS.find((t) => t.key === k);

let seq = 0;
// zone 空串 = 按档位自动落区；填了就是手动指定（下拉里那格）
const mkDev = (short, tier) => ({ id: ++seq, short, tier, zone: "", power: true, hidden: false, os: "win", host: "", user: "", pass: "" });
// 连不上 /api/devices 时（清单为空、服务没起、读回坏 JSON）用的内置默认，和 serve.mjs 首次生成的 设备清单.json 一致
let devices = [
  mkDev("笔记本", "laptop"), mkDev("ITX", "itx"), mkDev("mATX", "matx"),
  mkDev("ATX", "atx"), mkDev("E-ATX", "eatx"),
  mkDev("NAS", "nas"), mkDev("交换机", "switch"), mkDev("路由器", "router"),
];

// 间距：地面格子 250 mm 一格（GridHelper 24000/96）。
// 2140 让 mATX↔ATX 这一对的净空正好 5 格（原来 2400 = 6 格，你量到的那个）。
// 分区之后这个数只在"区里没有对应布局"时兜底用，实际摆位见页面里的 layoutClusters()。
// ⚠ 搬家时清点出来的惰常量：分区落地后整页已经没有一处读它了（T5-2 对账时确认，09-24）。
// 先留着不删——它是"排距从 2400 改到 2140"这段口径的唯一记录，删了就没人知道那 5 格是谁定的。
// 要恢复兜底，把它接回 layoutClusters 的无对应布局分支即可。
const SPACING = 2140;

// ---------- 分区：地图上各自聚一堆 ----------
// 区不新增档位，也不改几何：档位决定"用哪套模型"，区只决定"摆在地图哪一块"。
// 默认按档位落区（ZONE_OF_TIER），设备行里那一格下拉可以逐台改写（d.zone 非空 = 手动指定）。
// 分区不再是写死的四个（2026-09-23）：名字和 X/Z 在设置里的"分区设置"改，增删也在那儿，
// 改动存进同目录的 分区.json。数组本身是长驻的同一个对象（ZONES.length = 0 再 push），
// 别把它换成新数组 —— 下面一堆闭包和读点都抓着它。
// 四个区**同一个尺寸**：角铁要八对称，盒子必须全等，否则"分了区"会读成"四堆随机摆放"。
// 这个数不是凑整数好看，是按最挤的一堆现量的：算力集群 4 台 = 3 列 × 1400 + 最宽的 E-ATX 桌面 999
// → 3278 宽，两侧留余量到 4400；两行 × 行距 1800 + 最深桌面 787 → 2587 深，收到 3200。
// 机器真实尺寸一个没动，动的只是"格子画多大"。
const ZONE_FIELD = { w: 4400, d: 3200, h: 1150 };
const ZONE_AISLE = 900;   // 两个盒子之间的过道
const ZONE_PITCH = ZONE_FIELD.d + ZONE_AISLE;   // 一排到下一排：挪一个数，整张图的推导跟着走
const ZC = [(ZONE_FIELD.w + ZONE_AISLE) / 2, (ZONE_FIELD.d + ZONE_AISLE) / 2];
// 默认摆位（2026-09-23 第二次重排：以网络设备区为地图中心）：网络落在原点 (0,0)，
// 其余三区整体后移一个 ZC[1]（= 半个 Z 间距）—— 相对方位与上一版完全一样，只是把整张图
// 平移到"网络区在正中"。于是算力/储存在后排（z = −ZONE_PITCH）左右分开，终端在前排正前方。
// 全是"默认值"不是"定案值"——分区设置里改一个数就能挪，改完存 分区.json。
const ZONES = [
  { key: "compute", cn: "算力集群",   at: [-ZC[0], -ZONE_PITCH] },
  { key: "storage", cn: "储存设备区", at: [ ZC[0], -ZONE_PITCH] },
  { key: "net",     cn: "网络设备区", at: [ 0,      0] },
  { key: "edge",    cn: "终端设备区", at: [ 0, ZONE_PITCH] },
];
const ZONE_KEY_RE = /^[a-z0-9_-]{1,24}$/;
const ZONE_MAX = 9;   // 地皮是 3 列 × 5 行候选位，9 个到顶：再多就不是"分区"是"撒豆子"了
const ZONE_OF_TIER = {
  itx: "compute", matx: "compute", atx: "compute", eatx: "compute",
  laptop: "edge", nas: "storage", switch: "net", router: "net",
};
// 档位 → 区 的自动映射要能扛住"那个区被删了"：映射目标不在了就退到第一个区，
// 不能让设备因为一个分区没了就从屏幕上消失。
const zoneKeyOf = (d) => {
  if (ZONES.some((z) => z.key === d.zone)) return d.zone;
  const auto = ZONE_OF_TIER[d.tier];
  return ZONES.some((z) => z.key === auto) ? auto : ZONES[0].key;
};
const zoneOf = (d) => ZONES.find((z) => z.key === zoneKeyOf(d)) || ZONES[0];
// 区内排布：一行最多 3 台、间隔 1400 mm（5.6 格），满了换行。
// 为什么不是原来那一排的 2140：四台算力按 2140 排就是一堆 6.4 m 宽，四堆摆一起地图要 14 m，
// 全景退到那个量级机器又变灰点了。要更疏/回到 2140，只改这两个常量。
const CLUSTER_SPACING = 1400;
const CLUSTER_ROW_GAP = 1800;
const CLUSTER_PER_ROW = 3;

const OS_LABEL = { win: "Windows", linux: "Linux" };

// 采集频率那一格的真值；定时器本身（beat / startBeat）还在页面里，只读这个数。
const MONITOR_SETTINGS = { intervalMs: 3000 };
const MON_LIMITS = { intervalMs: [200, 5000, 100] };
const MS_KEY = "hm.mon.v1";

// 脚下脉冲 + 地面点阵 + 二进制雨的全部可调值：真源只有这一份，滑杆、设置.json、
// applySettings 读写的都是它（启动时从 localStorage 恢复那一段仍留在页面里，顺序不变）。
const PULSE_SETTINGS = {
  enabled: false,              // 总开关：关掉 = 立刻停发 + 把还在飞的清干净（不是"停发不停飞"那种慢收尾）
                               // 2026-09-23 按用户要求默认关（部署成看板先安静起步）。
                               // 这一颗只管脚下那一圈粒子环。地面涟漪在 2026-09-24 已经脱钩，
                               // 自己按每台的分级节拍起圈（见 stepRipples），关脉冲地面照荡。
  pulseStartBrightness: 0.95,  // 刚发射时的不透明度
  pulseEndBrightness: 0.03,    // 飞到最远端时的不透明度（越小越"划过去就没"）
  // 参考给的是 0.35，但那是"相机 48 单位看 6 单位的机器"；这里全景相机离地十几米，
  // 一束 60 粒挤在几个像素宽里，叠加混合直接饱和成白柱，颜色全丢。所以默认压到 0.22，
  // 要更亮自己拖那一格（滑杆上限仍是 1）。
  upParticleBrightness: 0.22,  // 向上粒子整体亮度，独立于脉冲，免得两个通道互相盖
  travelK: 18,                 // 扩散范围 = 机器本体 footprint 半径 × 这个系数
                               // 2026-09-24 用户裁定"直径至少是现在的 3 倍"：6 → 18（mATX 那一档半径 ≈ 3 m）。
  // ---- 地面涟漪 + 二进制雨（2026-09-23 融合，参考在 涟漪地面/ 与 docs/参考-数字雨/）----
  // 两颗开关互相独立、也独立于上面的 enabled：脉冲关了脚下安静，地面和雨照旧。
  rippleEnabled: true,
  rippleHeight: 0.5,           // 涟漪高度（参考单位）：0 = 只亮不起伏
  rippleSpeed: 10,             // 环每秒荡多远（参考单位/秒）：10 像水面、40 像冲击波
  rippleThickness: 1.0,        // 环厚度：0.3 一圈激光环、4 一片水波
  rippleBrightness: 0.25,      // 点阵被点亮的程度（参考推荐"克制"档）
  // 点阵密度 = 地面每边的段数：顶点 (n+1)²，点距 = 24000/n mm。它只换采样分辨率，
  // 不动涟漪/底波的任何系数（那些公式在参考单位里）——见 RippleTerrain.syncDots 的注释。
  dotSeg: 320,                 // 2026-09-24：以前写死 180（点距 133 mm），用户自己拉到点距 75 mm 那档后裁为默认
  dotSizeMm: 56,               // 单个点的直径（世界毫米）：56 = 参考的 0.7 单位 × GROUND_S，即以前写死的那个值
                               // 这颗管"每一粒画多大"，上面那颗管"一粒一粒摆多密"——两颗分开才配得出"密而不糊"
  rainEnabled: true,
  rainBrightness: 0.8,         // 数字雨不透明度上限就是 0.8（再高加法混合糊成一片）
};
const PULSE_LIMITS = {
  pulseStartBrightness: [0.05, 1, 0.01],
  pulseEndBrightness: [0.02, 0.8, 0.01],
  upParticleBrightness: [0.02, 1, 0.01],
  travelK: [2, 24, 0.5],
  // 范围照参考参数表的"建议范围"：height 0~8 / speed 5~50 / thickness 0.3~4 / brightness 0~2 / rain 0~0.8
  rippleHeight: [0, 8, 0.1],
  rippleSpeed: [5, 50, 1],
  rippleThickness: [0.3, 4, 0.1],
  rippleBrightness: [0, 2, 0.05],
  // 密度档：60 段 = 400 mm 点距（疏得能看见一格一格），360 段 = 66.7 mm 点距 = 13 万顶点。
  // 上限没有再往上给：点径是 0.7 参考单位 = 56 mm，再密点就互相压着连成一片光，那不是"更密的点阵"是"一块地皮"。
  dotSeg: [60, 360, 20],
  // 点径：8 mm ≈ 看不见（一像素都不到），56 = 参考原值，112 一档已经比默认档的点距(75)还大——点是加法混合的，
  // 直径一大相邻点就糊成一整片，"点阵"就读不出来了。上限给到 112 是留给他"故意要糊"的试法。
  dotSizeMm: [8, 112, 2],
  rainBrightness: [0, 0.8, 0.01],
};
const PS_KEY = "hm.pulse.v1";

// 三级分级：结构照参考保留（颜色 / 间隔 / 单次爆发几连），max = 这一档的负载上限（%）。
// amplitude 是地面涟漪的强度（参考值：空闲 0.6 / 活跃 0.85 / 警报 1.2）。2026-09-24 起它只被
// 涟漪自己的节拍 stepRipples 读，脚下脉冲不再带着它 —— 三档的"颜色/间隔"两边仍同源，所以读法没散。
// 阈值是我先定的，要聊就改这三格，别的都不用动。
const STATES = [
  { key: "IDLE", cn: "空闲", color: 0x00ff41, interval: 3.0, burst: 1, max: 35, amplitude: 0.6 },
  { key: "ACTIVE", cn: "活跃", color: 0xffcc00, interval: 2.0, burst: 2, max: 70, amplitude: 0.85 },
  { key: "ALERT", cn: "高负载", color: 0xff0033, interval: 1.2, burst: 3, max: 100, amplitude: 1.2 },
];
const stateOf = (load) => STATES.find((s) => load <= s.max) || STATES[STATES.length - 1];

// 配置文件里的每一行 → 场景里的设备对象：档位不认识退到 mATX，分区名不在表里就按档位自动落区。
// 原来这段写在 loadDevices 里，整份换绑走不了导入方，所以搬进来。
// 这台填没填地址 = 取不取真数。fleet 摆它、看板读它、探针问它，三处同一个口径，所以放状态这层。
export const liveOf = (d) => !!(d.host && d.user);

export function setDevices(list) {
  devices = (list || []).map((it) => Object.assign(
    mkDev(String(it.name || "(未命名)"), TIERS.some((t) => t.key === it.tier) ? it.tier : "matx"),
    { power: it.power !== false, hidden: it.hidden === true, os: it.os === "linux" ? "linux" : "win",
      host: typeof it.host === "string" ? it.host : "", user: typeof it.user === "string" ? it.user : "",
      pass: typeof it.pass === "string" ? it.pass : "",
      zone: ZONES.some((z) => z.key === it.zone) ? it.zone : "" }
  ));
}

export { TIERS, tierOf, mkDev, seq, devices, SPACING, ZONES, ZONE_FIELD, ZONE_AISLE, ZONE_PITCH,
  ZC, ZONE_KEY_RE, ZONE_MAX, ZONE_OF_TIER, zoneKeyOf, zoneOf, CLUSTER_SPACING, CLUSTER_ROW_GAP,
  CLUSTER_PER_ROW, OS_LABEL, MONITOR_SETTINGS, MON_LIMITS, MS_KEY, PULSE_SETTINGS, PULSE_LIMITS,
  PS_KEY, STATES, stateOf };
