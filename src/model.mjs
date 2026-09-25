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
// 连不上 /api/devices 时（清单为空、服务没起、读回坏 JSON）用的内置默认，和 serve.mjs 首次生成的 devices.json 一致
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
// 改动存进同目录的 zones.json。数组本身是长驻的同一个对象（ZONES.length = 0 再 push），
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
// 全是"默认值"不是"定案值"——分区设置里改一个数就能挪，改完存 zones.json。
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

// 采集节拍的两格真值；定时器本身（beat / 抓帧轮询）都在页面里，这里只放数。
//   intervalMs    = 看板与地面"这一拍"的节拍（重画面板、重算档位，纯本地，不碰网络）
//   probeEveryMs  = 每隔多久把"填了地址"的机器各抓一帧（从上一轮抓完开始计时）。
// 上限放到 60 s：他要过"10 秒一轮"，原来那格 5 s 封顶根本调不到（2026-09-24）。
// probeEveryMs 默认 15 s = 一轮（并行抓 ≈ 最慢那台 ~11s）之后再歇 15 s。下限 1 s（2026-09-26 放开）。
const MONITOR_SETTINGS = { intervalMs: 3000, probeEveryMs: 15000 };
const MON_LIMITS = { intervalMs: [200, 60000, 100], probeEveryMs: [1000, 600000, 1000] };
const MS_KEY = "hm.mon.v1";

// 脚下脉冲 + 地面点阵 + 二进制雨的全部可调值：真源只有这一份，滑杆、settings.json、
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
  // ---- 地面涟漪 + 二进制雨（2026-09-23 融合，参考在 docs/参考-涟漪地面/ 与 docs/参考-数字雨/）----
  // 两颗开关互相独立、也独立于上面的 enabled：脉冲关了脚下安静，地面和雨照旧。
  rippleEnabled: true,
  rippleHeight: 0.5,           // 涟漪高度（参考单位）：0 = 只亮不起伏
  // 「环每秒荡多远」和「多久起一圈」不在这一格里：2026-09-24 他裁的三档关联那六根，
  // 值就住在下面 STATES 的 speed / interval 两个字段上（滑杆读写的是它，见 setGrade）。
  rippleThickness: 1.0,        // 环厚度：0.3 一圈激光环、4 一片水波
  rippleBrightness: 0.25,      // 点阵被点亮的程度（参考推荐"克制"档）
  // 点阵密度 = 地面每边的段数：顶点 (n+1)²，点距 = 24000/n mm。它只换采样分辨率，
  // 不动涟漪/底波的任何系数（那些公式在参考单位里）——见 RippleTerrain.syncDots 的注释。
  dotSeg: 320,                 // 2026-09-24：以前写死 180（点距 133 mm），用户自己拉到点距 75 mm 那档后裁为默认
  dotSizeMm: 56,               // 单个点的直径（世界毫米）：56 = 参考的 0.7 单位 × GROUND_S，即以前写死的那个值
                               // 这颗管"每一粒画多大"，上面那颗管"一粒一粒摆多密"——两颗分开才配得出"密而不糊"
  rainEnabled: true,
  rainBrightness: 0.8,         // 数字雨不透明度。上限 2026-09-24 从 0.8 抬到 1.2（他挑的"更亮"那一刀）：
                               // 0.8 以下照参考，往上是拿"加法混合糊成一片白"换"显眼"，归他拧。
  rainCount: 1600,             // 屏上画多少颗字。800 = 参考原样那一档（滑杆最左），默认给两倍是"更密"那一刀。
                               // 容量在 ground 的 RAIN_CAP 一次配满，这一格只挪 drawRange。
  rainDotMm: 720,              // 一颗字画多大（世界毫米）：720 = 参考的 1.8 单位 × RAIN_S，就是以前写死的那个值。
                               // 2026-09-25 从写死抬成滑杆，起因是他报"都是 0"——量下来 1 的有效光有 0 的 76.5 %
                               // （改字色只买到 76.8 %，白改），真正的问题是那字在墙上只有约 10 px 高，
                               // 1 的一根竖笔不到一个像素 ⇒ 能救的维度是"多大"，而多大归他拧。
  rainFollowLoad: true,        // #4（2026-09-25）：雨跟着机群忙闲变 —— 忙时柱子落得快、也亮到那一格的顶，
                               // 闲时慢下来、退到八成。它只**乘**在 rainBrightness 下面（乘数封顶 1.0），
                               // 所以他手里那格永远是天花板，联动只能往下让。关掉就是原样（1.0 / 1.0）。
};
const PULSE_LIMITS = {
  pulseStartBrightness: [0.05, 1, 0.01],
  pulseEndBrightness: [0.02, 0.8, 0.01],
  upParticleBrightness: [0.02, 1, 0.01],
  travelK: [2, 24, 0.5],
  // 范围照参考参数表的"建议范围"：height 0~8 / thickness 0.3~4 / brightness 0~2 / rain 0~0.8
  // （原来那格 speed 5~50 挪到下面的 GRADE_LIMITS.speed —— 它现在是三档共用的量程，不是一根滑杆）
  rippleHeight: [0, 8, 0.1],
  rippleThickness: [0.3, 4, 0.1],
  rippleBrightness: [0, 2, 0.05],
  // 密度档：60 段 = 400 mm 点距（疏得能看见一格一格），360 段 = 66.7 mm 点距 = 13 万顶点。
  // 上限没有再往上给：点径是 0.7 参考单位 = 56 mm，再密点就互相压着连成一片光，那不是"更密的点阵"是"一块地皮"。
  dotSeg: [60, 360, 20],
  // 点径：8 mm ≈ 看不见（一像素都不到），56 = 参考原值，112 一档已经比默认档的点距(75)还大——点是加法混合的，
  // 直径一大相邻点就糊成一整片，"点阵"就读不出来了。上限给到 112 是留给他"故意要糊"的试法。
  dotSizeMm: [8, 112, 2],
  rainBrightness: [0, 1.2, 0.01],
  // 颗数：800 = 参考那一份的原样（滑杆拉到最左就是素材本来的密度），6400 = ground 的 RAIN_CAP。
  // 上限原来是 3200，2026-09-25 他拉满后报"还可以再升，没糊"⇒ 跟着抬一倍（默认仍是 1600，不动他拧的值）。
  // 留一个"封顶"在这里是有意义的：字是加法混合的满屏 Sprite，真糊成一整面蓝墙时这一格就是回得去的边界。
  // 这一格与 RAIN_CAP 是同一个数的两处写法，verify-rain.mjs 里钉着对账（走散了就是"屏上画不满滑杆那一格"）。
  rainCount: [800, 6400, 100],
  // 字径：360 = 参考的一半（字基本糊成噪点，留给"只要氛围"的调法），720 = 参考原值，
  // 2880 = 四倍（约 40 px 高，1 的那根竖笔终于占得下一个像素，代价是满屏蓝块开始互相压）。
  // 上限故意给到"会糊"那一段：颗数那格管"多少粒"，这一格管"一粒多大"，糊不糊由他两格配。
  rainDotMm: [360, 2880, 20],
};
const PS_KEY = "hm.pulse.v1";

// 三级分级：结构照参考保留（颜色 / 间隔 / 单次爆发几连），max = 这一档的负载上限（%）。
// amplitude 是地面涟漪的强度（参考值：空闲 0.6 / 活跃 0.85 / 警报 1.2）。2026-09-24 起它只被
// 涟漪自己的节拍 stepRipples 读，脚下脉冲不再带着它 —— 三档的"颜色/间隔"两边仍同源，所以读法没散。
// speed 是这一档的环每秒荡多远（2026-09-24 他裁："绿色应该是偶尔一个波浪、红色应该高于绿色"）：
// 环在**生成那一刻**取走它，之后不跟着滑杆回改，所以正在荡的半圈不会突然加速。
// 阈值是我先定的，要聊就改这三格，别的都不用动。
const STATES = [
  { key: "IDLE", cn: "空闲", color: 0x00ff41, interval: 3.0, burst: 1, max: 35, amplitude: 0.6, speed: 8 },
  { key: "ACTIVE", cn: "活跃", color: 0xffcc00, interval: 2.0, burst: 2, max: 70, amplitude: 0.85, speed: 16 },
  { key: "ALERT", cn: "高负载", color: 0xff0033, interval: 1.2, burst: 3, max: 100, amplitude: 1.2, speed: 30 },
];
const stateOf = (load) => STATES.find((s) => load <= s.max) || STATES[STATES.length - 1];
// 综合档位（2026-09-24 他裁的口径 B）。传进来的 pct 已经是"这一帧有多忙"的那一个数
// （CPU 占用与 GPU 利用率取 max，算在 ground 的 realLoadOf 里），这一格只管两件事：
//   ① 按上面那张阈值表定档；
//   ② 内存越过高线时，把"空闲"抬到"活跃"——只抬这一档，永远抬不到"高负载"。
// 内存为什么不并进 pct 一起 max：常驻高内存是常态不是事件，16 G 的笔记本日常就挂 85 %，
// 并进去会把那台钉成永久黄/红，墙反而看不出"变化"了 —— 而变化检测就是这个看板存在的理由。
// memPct 拿不到（道具、老探针）就是 null：null 一律不参与，不拿 0 顶位。
const MEM_BOOST_PCT = 92;
const gradeOf = (pct, memPct) => {
  if (pct == null) return null;
  const s = stateOf(pct);
  return s.key === "IDLE" && typeof memPct === "number" && memPct >= MEM_BOOST_PCT ? STATES[1] : s;
};

// ---------- 三档的波速与节拍：六根关联滑杆的后端（2026-09-24 他裁的乙）----------
// 值不另存一份：滑杆、settings.json、涟漪与脉冲读写的都是上面 STATES 里的 speed / interval 本身。
// 两处共用是有意的 —— 参考那份表里 interval 就同时管"地面起圈"和"脚下起爆"（stepRipples / triggerBurst
// 都读它），拆成两份就会出现"脚下黄、地上绿"那种读法冲突。
// 量程：波速照参考的 5~50（10 像水面、22 有节奏、50 像冲击波）；节拍给 0.3~10 s
// （0.3 = 一秒三圈已经糊成一片，10 = 半天看不见一圈，两端都是故意留给"难看得很明显"的档）。
const GRADE_LIMITS = { speed: [5, 50, 1], interval: [0.3, 10, 0.1] };
// speed 要 绿 ≤ 黄 ≤ 红（越忙荡得越快）；interval 要 绿 ≥ 黄 ≥ 红（越忙起圈越勤）。
const GRADE_ASC = { speed: true, interval: false };
// 这一档能活动的闭区间：一边被"比它闲的档"顶住、另一边被"比它忙的档"顶住。
// 滑杆每次重画都现取，所以三根条的长短是随彼此实时变的 —— 拖不出反序，不弹错也不报错。
// 第三个位置回填**步进**：滑杆要的是 [min, max, step] 一整份，只回两个数它会把 step 写成 "undefined"，
// 节拍那三根就退化成整秒一档（1.2 / 2.3 这种默认值再也拖不出来）—— 2026-09-24 在真 DOM 里读到的。
function gradeBounds(field, idx) {
  const [lo, hi, step] = GRADE_LIMITS[field];
  const asc = GRADE_ASC[field];
  let min = lo, max = hi;
  for (let j = 0; j < STATES.length; j++) {
    if (j === idx) continue;
    const v = STATES[j][field];
    const raisesFloor = asc ? j < idx : j > idx;
    if (raisesFloor) { if (v > min) min = v; } else if (v < max) max = v;
  }
  return [min, max, step];
}
// 写一个数：先进总量程 → 按步进取整 → 最后被相邻档夹住。返回**实际生效值**（滑杆按它回显，
// 文件里越界的值也走这一条），跟其他设置格同一个规矩：settings.json 躺的永远是生效值。
function setGrade(field, idx, v) {
  const [lo, hi, step] = GRADE_LIMITS[field];
  const n0 = Number(v);
  if (!Number.isFinite(n0)) return STATES[idx][field];
  const b = gradeBounds(field, idx);
  let n = Math.round(Math.min(hi, Math.max(lo, n0)) / step) * step;
  n = Math.min(b[1], Math.max(b[0], n));
  STATES[idx][field] = Math.round(n * 100) / 100;
  return STATES[idx][field];
}
// settings.json 里那六个键 ↔ (字段, 档位)：读写两边都从这一张表走，键名只在这一处出现。
const GRADE_KEYS = [
  ["rippleSpeedIdle", "speed", 0], ["rippleSpeedActive", "speed", 1], ["rippleSpeedAlert", "speed", 2],
  ["rippleIntervalIdle", "interval", 0], ["rippleIntervalActive", "interval", 1], ["rippleIntervalAlert", "interval", 2],
];
// 这六格的当前值 → 一个能 JSON 化的对象：写 settings.json、写浏览器兜底存档都取这一份。
function gradeValues() {
  const o = {};
  for (const [k, field, i] of GRADE_KEYS) o[k] = STATES[i][field];
  return o;
}
// 反向：从一份设置对象里恢复（缺键就跳过 —— 老 settings.json 里没这六格，走默认值是正常路径）。
// 返回认得几格，让调用方能拿它当"读数不能为 0"的正对照。
function applyGradeValues(o) {
  let n = 0;
  for (const [k, field, i] of GRADE_KEYS) {
    if (o && Number.isFinite(Number(o[k]))) { setGrade(field, i, o[k]); n++; }
  }
  return n;
}
// localStorage 那一整份：PULSE_SETTINGS + 六档值合在一起写，所以 file:// 场景也不会有第二套真源。
function pulseStore() { return JSON.stringify(Object.assign({}, PULSE_SETTINGS, gradeValues())); }

// 配置文件里的每一行 → 场景里的设备对象：档位不认识退到 mATX，分区名不在表里就按档位自动落区。
// 原来这段写在 loadDevices 里，整份换绑走不了导入方，所以搬进来。
// 这台填没填地址 = 取不取真数。fleet 摆它、看板读它、探针问它，三处同一个口径，所以放状态这层。
// 判据现在是"服务端算好的那一格"（下面 setDevices 里落）：放开"看"那扇门之后，观众拿到的清单里
// 根本没有 user 这一格（/api/hosts 把它剥了），页面再自己 host && user 就会把每台真机都判成模拟机 ——
// 症状是朋友打开墙，四台全是一片"—"。所以 live 由 serve.mjs 算，页面只读结果。
export const liveOf = (d) => d.live === true;

// 这一台是主人还是观众：真源在 serve.mjs（看来源地址在不在 HM_OWNER 里），页面开机问一次 /api/state。
// 放状态层而不是设置层：看板那一侧的提示文案也要跟着身份变（观众双击不会去抓机器，
// 而"你这一下已经当场去抓了"那句话对他说就是假的），而 dashboard 不能 import settings-ui（那是环形）。
// ⚠ 只能就地改 ACCESS.viewer，不许整份换绑（见下面那三条"活"状态的规矩）。
export const ACCESS = { viewer: false };

// 名册来源（2026-09-25 清账2）：墙上那几台是从哪儿来的。
// 内置那一份是**道具**（demo 用的假机器，负载是本地随机游走）：没连服务直接开页面时它就够使，
// 但"服务端清单没读到、于是屏上站着八台看着真的一排假机器"是另一回事 —— 那块墙的定位是变化检测器，
// 把道具当真机器摆出去就是它最不能犯的一种错。所以这一格现在要分得开四种：
// 'unknown' 还没问过（开机那一瞬，不该闪警报）· 'server-hosts'/'server-devices' 真名册 · 'builtin' 道具上墙。
// 道具那一支有三条来路（`file://` / 服务端回内置名册 / 那一枪整个失败），差别只在 error 那句话。
export const ROSTER = { source: 'unknown', error: '' };
export const ROSTER_SOURCES = ['unknown', 'builtin', 'server-hosts', 'server-devices'];
export function setRosterSource(source, error = '') {
  ROSTER.source = source; ROSTER.error = String(error || '');
}
// 顶栏那一格到底挂不挂、挂什么：写成纯函数而不是埋在 DOM 里，好让闸门能直接跑它
// （DOM 那一头只有一个 rosterEl.textContent = 这里给的 text —— 判据只这一处，屏上与闸共用）。
export function rosterBadge(source = ROSTER.source, error = ROSTER.error) {
  if (source === 'unknown' || source === 'server-hosts' || source === 'server-devices') return { hidden: true, text: '' };
  return { hidden: false, text: error ? '内置道具名册：' + error + '（屏上这几台不是真机器）'
    : '内置道具名册：没连服务，屏上这几台不是真机器' };
}
// 服务端回的那一份清单是不是"真从 devices.json 读出来的"。
// 为什么不能拿 HTTP 200 当判据：serve.mjs 的 load() 在读不到文件时**照样回 200**，
// 只是 list 换成内置那八台道具、source 换成 seeded / invalid-fallback / unreadable-fallback。
// 只认 'file'、其余一律算道具（认死形状而不是认名单：以后再加一种 fallback 也不会漏成"静默真名册"）。
export const SERVER_ROSTER_FILE = 'file';
export const SERVER_ROSTER_PROPS = ['seeded', 'invalid-fallback', 'unreadable-fallback'];
export function rosterIsProps(source) { return source !== SERVER_ROSTER_FILE; }
export function rosterPropsNote(source, file = 'devices.json') {
  return '服务端没读到 ' + file + '，回的是内置名册（source=' + (source || '未知') + '）';
}

export function setDevices(list) {
  devices = (list || []).map((it) => Object.assign(
    mkDev(String(it.name || "(未命名)"), TIERS.some((t) => t.key === it.tier) ? it.tier : "matx"),
    { power: it.power !== false, hidden: it.hidden === true, os: it.os === "linux" ? "linux" : "win",
      host: typeof it.host === "string" ? it.host : "", user: typeof it.user === "string" ? it.user : "",
      pass: typeof it.pass === "string" ? it.pass : "",
      // 老规矩兜底：万一哪条路（file:// 手编、未来别的入口）给的是不带 live 的裸清单，
      // 页面自己按 host && user 现算 —— 那正是搬去服务端之前的判据，结果一样。
      live: typeof it.live === "boolean" ? it.live : !!(it.host && it.user),
      zone: ZONES.some((z) => z.key === it.zone) ? it.zone : "" }
  ));
}

// ---------- 场景里那三份"活"的状态 + 两个共用判据（T5 刀5 从页面搬进来）----------
// 为什么不留在页面、也不塞进 fleet：holders / zoneMarks 由 fleet 整份重建，但视角层（双击拾取、聚焦取景、
// 全景距离）和地面层（脉冲落点、涟漪节拍、标注那行字）都要读它；loads 由地面层的模拟器写、fleet 的分级读。
// 放在状态层，三边都朝下 import，谁都不是别人的上层。
// ⚠ 三个都只能"就地改"（length = 0 再 push），不许整份换绑：ESM 的 live binding 只对导出方自己的赋值生效，
// 换绑之后导入方仍然看着旧数组 —— 那正是上面 setDevices 要走函数的同一条理由。
export const holders = [];      // 每台工作站：{ id, holder, model, div, b, stateLine, parts, 落位 x/z, hw/hd, footR }
export const zoneMarks = [];    // 每个开放分区一组角铁 + 一块区名
// 每台的负载（0~100 或 null）：填了地址+用户名且抓到过帧 → 那一帧的真数；
// 填了地址但还没抓到帧 → null（没有数就是没有数，不拿随机游走补一个档位出来）；
// 没填地址的道具 → 本地随机游走。
// 这一格同时是分级判定的输入，所以"看板上是什么数"和"脚下是什么颜色"是同一个来源。
export const loads = new Map();   // device.id -> { pct, memPct, key }  pct=CPU∥GPU 的 max，memPct=内存占用率（只用来抬档）

// 不进来的有两种：① d.hidden（这台单独藏了）② 落在"已关闭分区"里的（z.off）。
// 两种都只是不摆出来，那一行还留在 devices.json 里，分区和归属也一个字没动 —— 放出来就原样回来。
// ① 在 fleet 的 rebuild 里判，这一格只管 ②（它要对着 ZONES 查，属于状态层的事）。
const zoneOffOf = (d) => { const z = ZONES.find((q) => q.key === zoneKeyOf(d)); return !!(z && z.off); };
// 这台现在算哪一档（关机就没有档）：标注那行字、脚下脉冲、涟漪节拍三处读同一个判据，所以放状态层。
const levelOf = (d) => (d.power ? STATES.find((s) => s.key === (loads.get(d.id) || {}).key) : null);

export { TIERS, tierOf, mkDev, seq, devices, SPACING, ZONES, ZONE_FIELD, ZONE_AISLE, ZONE_PITCH,
  GRADE_LIMITS, GRADE_KEYS, gradeBounds, setGrade, gradeValues, applyGradeValues, pulseStore,
  ZC, ZONE_KEY_RE, ZONE_MAX, ZONE_OF_TIER, zoneKeyOf, zoneOf, CLUSTER_SPACING, CLUSTER_ROW_GAP,
  CLUSTER_PER_ROW, OS_LABEL, MONITOR_SETTINGS, MON_LIMITS, MS_KEY, PULSE_SETTINGS, PULSE_LIMITS,
  PS_KEY, STATES, stateOf, gradeOf, MEM_BOOST_PCT, zoneOffOf, levelOf };
