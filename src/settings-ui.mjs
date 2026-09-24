// 设置层：齿轮开的那个弹窗（设备清单 / 分区 / 监控 / 脉冲 / 地面五块面板），加上三份 JSON 的读写与防抖。
// 2026-09-24 T5 刀7 从 monitor-wall.html 整块搬出，正文一字未改（对账：
//   DST=src/settings-ui.mjs node 00-暂存/hm3d-t54-verify.mjs monitor-wall.html <名字...>）。
// 为什么这层单独存在：三份文件（devices / zones / settings）在部署后是**权威**——页面启动读它、每 5 秒再读一次，
// 屏上任何一格改了都要防抖着写回去。这套"读→夹取→应用→防抖写盘"的规矩只这一处，别的地方别再写第二份。
// 依赖方向：设置层认得陈列层与地面层（rebuild / setPulseSetting 那一批都是它的下游），
// 但探针、心跳、相机这三样是页面的动作 —— 反向 import 页面就成了环形引用（模块求值顺序会咬人），
// 所以由 initSettings 注入，同 fleet 与 ground 那两刀一个办法。
import { THREE } from "./three.mjs";
import { TIERS, tierOf, mkDev, seq, devices, setDevices, ZONES, ZONE_FIELD, ZONE_AISLE, ZONE_PITCH,
  ZONE_KEY_RE, ZONE_MAX, zoneKeyOf, zoneOf, OS_LABEL, MONITOR_SETTINGS, MON_LIMITS, MS_KEY,
  PULSE_SETTINGS, PULSE_LIMITS, PS_KEY, liveOf, ACCESS, zoneOffOf,
  STATES, GRADE_KEYS, gradeBounds, setGrade, gradeValues } from "./model.mjs";
import { fmt, clampv, pctFmt, mmFmt } from "./format.mjs";
import { el, mini, fieldRow, textField, sliderRow, bindOnOff } from "./ui.mjs";
import { perfDev, hidePerf, refreshPerfHead } from "./dashboard.mjs";
import { rebuild, applyState, holderOf } from "./fleet.mjs";
import { setPulseSetting, setPulseEnabled, setRippleEnabled, setRainEnabled, setGradeSetting } from "./ground.mjs";

// 页面递进来的三样动作：探针（抓一帧 + 把结果写在浮层里）、节拍 setter（改了任何一格节拍都要重排它的定时器）、
// 相机（点设备行那个"位置"链接要聚焦、开弹窗要先收掉钉住的牌）。声明成 let 是因为它们只在点击时被调，
// 不在模块求值期跑 —— 装配那一行（initSettings）晚于这里就行。
let probeDevice = null, tipResult = null, setMonitorSetting = null;
let focusStation = null, pinLabel = null, moveTo = null;
export function initSettings(ctx) {
  probeDevice = ctx.probeDevice;
  tipResult = ctx.tipResult;
  setMonitorSetting = ctx.setMonitorSetting;
  focusStation = ctx.focusStation;
  pinLabel = ctx.pinLabel;
  moveTo = ctx.moveTo;
}

const gear = document.getElementById("gear");
const mask = document.getElementById("mask");
const rowsBox = document.getElementById("rows");
const countEl = document.getElementById("dcount");

// ---------- 这一台是主人还是观众（2026-09-24 需求 #2 那一刀：组内都能看，只有配在程序里的能改）----------
// 页面只在开机问一次 /api/state，拿到 mode 就照着摆：观众那一份连设置齿轮都不给。
// 认不出来的那一档（读不到 / file://）按主人处理 —— 这不是"放行"：真正的门在 serve.mjs，
// 观众那边就算硬把弹窗打开，四个写接口与 /api/probe 也会各自回 403。这里只管要不要给他那个入口。
const ACCESS_API = "/api/state";
// 那一格住在 model.mjs 的 ACCESS 里（看板那侧也要读它来挑文案）；这里只是设置层的入口
export const isViewer = () => ACCESS.viewer;
export async function loadAccess() {
  if (location.protocol === "file:") return;
  try {
    const r = await fetch(ACCESS_API, { cache: "no-store" });
    if (!r.ok) return;
    const j = await r.json();
    ACCESS.viewer = j.mode === "view";
    // setDialog(false) 无条件走一遍：它是幂等的（就是"关上"），比先读 mask.hidden 再决定省事，
    // 而且那个属性在别的元素上恰恰不可信（#mask 靠补的那行 CSS 才压得住，见页面 CSS）。
    if (ACCESS.viewer) { gear.hidden = true; setDialog(false); }
  } catch { /* 读不到就维持主人态，写接口自己会挡 */ }
}



// 列表：一台一个折叠。折起来只看身份（名字 / 档位 / 电源 / 地址填没填），
// 展开才给编辑：名称、档位、电源、系统、连接地址、用户名、密码。同一时刻只展开一台。
let openId = null;


function renderList() {
  rowsBox.textContent = "";
  // 只画当前分区；i 始终是 devices 里的全局下标（删除 / 换位都按它算，不再翻译一次）
  const mine = devices.map((d, i) => ({ d, i })).filter((o) => zoneKeyOf(o.d) === curZone);
  if (!mine.length) {
    rowsBox.append(el("div", "netnote", "这个分区里还没有设备 —— 右上角「＋ 添加设备」加的就是当前选中的这个分区。"));
  }
  mine.forEach((o, k) => {
    const d = o.d, i = o.i;
    const det = el("details", "dev" + (d.hidden ? " hid" : ""));
    det.open = openId === d.id;

    const sum = el("summary");
    const sumName = el("span", "sumName", d.short);
    const tierChip = el("span", "chip", tierOf(d.tier).chip);
    const pwChip = el("span", "chip" + (d.power ? " set" : ""), d.power ? "● 开机" : "○ 关机");
    d.pwChip = pwChip;
    const addrChip = el("span", "chip" + (d.host ? " set" : ""), d.host || "未填地址");
    const zoneChip = el("span", "chip", zoneOf(d).cn);   // 折叠行上直接看得见落在哪个区
    const ops = el("div", "ops");
    const loc = mini("◎", "在屏幕上定位这台并打开它的性能看板（交换机/路由器只有几十毫米高，"
      + "一排八台的画面里用鼠标点 3D 基本点不中，所以列表里给一个直达的）");
    const up = mini("↑", "上移（左移一位）");
    const dn = mini("↓", "下移（右移一位）");
    // 整个分区的开关：关掉 = 这一区不摆，设备留在清单里、随时放回来（和"删除"是两回事）
    const hideBtn = mini(d.hidden ? "放回" : "收起", d.hidden
      ? "放回屏幕上（收起只是不摆，清单里一直留着）"
      : "从屏幕上收起来：3D 里不摆、列表里不占格、也不再去抓它的帧。清单里留着，随时放回", d.hidden ? "on2" : "");
    const del = mini("删除", "把这台的 3D 移掉", "del");
    // 收起来的这台不参与排序（屏幕上看不见，换位看不出来），按钮就按不可用来摆
    up.disabled = k === 0 || d.hidden;
    dn.disabled = k === mine.length - 1 || d.hidden;
    // summary 里的按钮要拦住默认行为，否则点一下反而把这台展开了
    loc.addEventListener("click", (e) => { e.preventDefault(); const h = holderOf(d); if (h) focusStation(h); });
    up.addEventListener("click", (e) => { e.preventDefault(); moveInZone(i, -1); });
    dn.addEventListener("click", (e) => { e.preventDefault(); moveInZone(i, 1); });
    hideBtn.addEventListener("click", (e) => { e.preventDefault(); d.hidden = !d.hidden; sync(); touch(); });
    del.addEventListener("click", (e) => {
      e.preventDefault();
      if (openId === d.id) openId = null;
      devices.splice(i, 1);
      sync();
      touch();
    });
    ops.append(loc, up, dn, hideBtn, del);
    sum.append(el("span", "caret"), sumName, tierChip, zoneChip, pwChip, addrChip);
    if (d.hidden) sum.append(el("span", "chip", "已收起"));
    sum.append(el("span", "grow"), ops);

    const body = el("div", "dbody");
    const nm = textField("text", d.short, "设备名", (v) => {
      d.short = v.trim() || "(未命名)";
      sumName.textContent = d.short;
      applyState(d);
    });
    nm.maxLength = 24;
    nm.title = "设备名（改屏幕上那行标注）";

    const tier = el("select", "tier");
    tier.title = "档位（决定这台用哪套几何）";
    for (const t of TIERS) {
      const o = document.createElement("option");
      o.value = t.key;
      o.textContent = t.label;
      tier.add(o);
    }
    tier.value = d.tier;
    tier.addEventListener("change", () => { d.tier = tier.value; sync(); });

    const zone = el("select", "tier");
    zone.title = "这台落在哪个区（默认跟着档位走，改了就手动钉住）";
    for (const z of [{ key: "", cn: "自动（按档位）" }].concat(ZONES)) {
      const o = document.createElement("option");
      o.value = z.key; o.textContent = z.cn; zone.add(o);
    }
    zone.value = d.zone || "";
    zone.addEventListener("change", () => { d.zone = zone.value; sync(); });

    const line = el("div", "line");
    const pw = el("button", "pw");
    pw.type = "button";
    d.pwBtn = pw;
    pw.addEventListener("click", () => { d.power = !d.power; applyState(d); });
    const os = el("select", "os");
    os.title = "系统（决定屏幕画什么）";
    for (const k of ["win", "linux"]) {
      const o = document.createElement("option");
      o.value = k;
      o.textContent = OS_LABEL[k];
      os.add(o);
    }
    os.value = d.os;
    os.addEventListener("change", () => { d.os = os.value; applyState(d); });
    line.append(pw, os);

    const host = textField("text", d.host, "留空：接采集时才填", (v) => {
      d.host = v.trim();
      addrChip.textContent = d.host || "未填地址";
      addrChip.classList.toggle("set", !!d.host);
      touch();
    });
    host.title = "连接地址（主机名或 IP）；会写进配置文件，密码不写";
    const user = textField("text", d.user, "留空", (v) => { d.user = v.trim(); touch(); });
    const pass = textField("password", d.pass, "明文存进配置文件", (v) => { d.pass = v; touch(); });

    const sshLine = el("div", "line");
    const testBtn = el("button", "mini test", "连通性测试");
    testBtn.type = "button";
    const sshSt = el("span", "cname", liveOf(d) ? (d.frame ? "已取到一帧" : "凭据已填，未测") : "未填凭据 · 走模拟");
    testBtn.addEventListener("click", async () => {
      if (!liveOf(d)) { tipResult(d, { ok: false, error: "地址 / 用户名 没填 —— 这台继续走模拟数据" }); return; }
      testBtn.disabled = true;
      testBtn.textContent = "测试中…";
      const res = await probeDevice(d);
      testBtn.disabled = false;
      testBtn.textContent = "连通性测试";
      sshSt.textContent = res.ok ? "已取到一帧" : "失败：" + res.error;
      tipResult(d, res);
      sync();
    });
    sshLine.append(testBtn, sshSt);

    body.append(
      fieldRow("名称", nm),
      fieldRow("档位", tier),
      fieldRow("分区", zone),
      fieldRow("状态", line),
      fieldRow("连接地址", host),
      fieldRow("用户名", user),
      fieldRow("密码", pass),
      fieldRow("SSH", sshLine),
      el("div", "netnote", "名称 / 档位 / 电源 / 系统 / 连接地址 / 用户名 → 写进同目录的 devices.json（跑 serve.mjs 时）。"
        + "密码按你说的明文存进这个文件（它因此是敏感文件，见 serve.mjs 顶上那句提醒）。"
        + "地址 + 用户名 填了 = 这台走 SSH 抓一帧（密码可以是空的：Windows 那几台本来就不设密码）；"
        + "地址或用户名空着 = 模拟数据。“系统”那一格不只是画屏幕用的 —— 抓帧也按它分流，"
        + "Windows 走 PowerShell、Linux 走 sh。")
    );

    det.append(sum, body);
    // 互斥在 click 上做（toggle 事件是异步派发的，靠它会慢半拍）：
    // 这台要展开，就先把别的关掉。
    sum.addEventListener("click", () => {
      if (det.open) return;
      for (const other of rowsBox.querySelectorAll("details.dev[open]")) if (other !== det) other.open = false;
    });
    det.addEventListener("toggle", () => {
      if (det.open) openId = d.id;
      else if (openId === d.id) openId = null;
    });
    rowsBox.append(det);
  });
  for (const d of devices) applyState(d);
  const zcur = ZONES.find((z) => z.key === curZone) || ZONES[0];
  const shown = zcur.off ? 0 : mine.filter((o) => !o.d.hidden).length;
  const tail = zcur.off ? "（这一区已关，整区不摆）"
    : mine.length > shown ? "（收起 " + (mine.length - shown) + " 台）" : "";
  countEl.textContent = zcur.cn + " " + shown + " 台" + tail + " · 全部 " + devices.length + " 台";
}

// ↑↓ 只跟"同一个区里的邻居"换位：区各摆各的，跨区换位在屏幕上一点变化都看不出来，
// 那会被读成"按钮坏了"。换成对调而不是搬移，设备的 id 不动（性能看板盯着的那台不会掉线）。
function moveInZone(i, dir) {
  const zk = zoneKeyOf(devices[i]);
  for (let j = i + dir; j >= 0 && j < devices.length; j += dir) {
    if (zoneKeyOf(devices[j]) !== zk) continue;
    if (devices[j].hidden) continue;   // 收起来的那台屏幕上看不见，跟它换位等于按钮没反应
    const t = devices[i]; devices[i] = devices[j]; devices[j] = t;
    sync();
    return;
  }
}

// 列表动一处，场景重造一遍：改档 / 加台 / 删台 / 换区 / 排序都会走到这里
export function sync() {
  // 收起来的、整个分区关掉的，看板不该继续挂在上面（场景里已经没有它了）
  if (perfDev && (!devices.includes(perfDev) || perfDev.hidden || zoneOffOf(perfDev))) hidePerf();
  rebuild();
  renderTabs();
  renderList();
  for (const d of devices) applyState(d);
  if (perfDev) refreshPerfHead();
}

function setDialog(open) {
  mask.hidden = !open;
  gear.classList.toggle("on", open);
  gear.setAttribute("aria-expanded", String(open));
  if (open) {
    const first = rowsBox.querySelector("summary");
    if (first) first.focus();
  }
}
gear.addEventListener("click", () => setDialog(mask.hidden));
document.getElementById("dlgx").addEventListener("click", () => setDialog(false));
mask.addEventListener("pointerdown", (e) => { if (e.target === mask) setDialog(false); });
window.addEventListener("keydown", (e) => { if (e.key === "Escape" && !mask.hidden) setDialog(false); });
document.getElementById("dadd").addEventListener("click", () => {
  const d = mkDev("设备 " + (seq + 1), "matx");
  d.zone = curZone;   // 加在"当前选项卡"这个分区里，不是加完还得去别的区找
  devices.push(d);
  sync();
  touch();
});

// ---------- 设置弹窗：左侧分类导轨 + 右侧四块面板 ----------
// 导轨只切 display，不重建 DOM：滑杆的值由 PULSE_SETTINGS / MONITOR_SETTINGS 单一来源渲染，
// 切来切去不会把用户刚拖到的位置忘掉。
const catBtns = Array.from(document.querySelectorAll("#dlg .rail .cat"));
function showCat(key) {
  for (const b of catBtns) b.classList.toggle("on", b.dataset.cat === key);
  for (const p of document.querySelectorAll("#dlg .pane")) p.classList.toggle("on", p.id === "cat-" + key);
}
for (const b of catBtns) b.addEventListener("click", () => showCat(b.dataset.cat));


// 能被"外部改设置"刷新的控件都把自己那次 paint 登记进来：settings.json 被改了 → applySettings 落到内存 →
// 一声令下把这些控件重画一遍，滑杆位置与开关文案立刻跟上（否则文件里改了值，屏上滑杆还停在旧位置）。
const uiPaints = [];
function paintSettingsUI() { for (const f of uiPaints) f(); }
for (const o of [
  { key: "pulseStartBrightness", limits: PULSE_LIMITS.pulseStartBrightness, title: "脉冲起始亮度",
    hint: "刚发射那一刻的亮度。调大更扎眼，调小变成\"暗流涌动\"。", fmt: pctFmt },
  { key: "pulseEndBrightness", limits: PULSE_LIMITS.pulseEndBrightness, title: "脉冲收尾亮度",
    hint: "飞到最远端还剩多少。调小收得干净，调大远端会留一片残光。", fmt: pctFmt },
  { key: "upParticleBrightness", limits: PULSE_LIMITS.upParticleBrightness, title: "向上粒子亮度",
    hint: "那缕往上飘的数据流。独立一格，免得跟脉冲亮度互相抢。", fmt: pctFmt },
  { key: "travelK", limits: PULSE_LIMITS.travelK, title: "脉冲范围",
    hint: "扩散半径 = 机器本体（不含显示器/键鼠）底面半径 × 这个倍数。默认 18 ≈ 一环 6 m 直径（2026-09-24 定的\"至少 3 倍\"），会越过脚下铺到邻机那一片。", fmt: mmFmt },
]) {
  uiPaints.push(sliderRow(document.getElementById("pulseRows"), {
    title: o.title, hint: o.hint, limits: o.limits, fmt: o.fmt,
    get: () => PULSE_SETTINGS[o.key],
    set: (v) => setPulseSetting(o.key, v),
  }));
}
uiPaints.push(sliderRow(document.getElementById("monRows"), {
  title: "重画节拍", hint: "多少毫秒走一拍：重画右侧看板、重算每台的档位（脚下什么色）。纯本地，不碰网络。",
  limits: MON_LIMITS.intervalMs,
  // 只报"每 xx ms 1 次"：原来那格还算了个 1000/v，出来的"1.2 次/秒 / 1.3 次/秒"是小数，读着像故障
  fmt: (v) => "每 " + v.toFixed(0) + " ms 1 次",
  get: () => MONITOR_SETTINGS.intervalMs,
  set: (v) => setMonitorSetting("intervalMs", v),
}));
// 抓帧间隔 = 那几台真机"多久被敲一次"。这一格才是"看板上的数会不会自己动"的开关：
// 重画节拍再快，帧不更新也只是把同一份数重念一遍（他 2026-09-24 报的"数值纹丝不动"就是这个）。
uiPaints.push(sliderRow(document.getElementById("monRows"), {
  title: "抓帧间隔", hint: "隔多久把填了地址的机器各抓一帧（从上一轮抓完开始计时）。2026-09-24 起这一轮由跑服务的那台机器自己转，所有页面都关掉也照抓；改这一格从下一轮起生效。一轮实测 20~35 s，别调到 3 s 那档连轴转。",
  limits: MON_LIMITS.probeEveryMs,
  fmt: (v) => "每 " + (v / 1000).toFixed(0) + " 秒 1 轮",
  get: () => MONITOR_SETTINGS.probeEveryMs,
  set: (v) => setMonitorSetting("probeEveryMs", v),
}));

// 脉冲总开关那一颗按钮：文案与配色跟状态同源，不另存一份
const pulseOnBtn = document.getElementById("pulseOn");
function paintPulseOn() {
  const on = PULSE_SETTINGS.enabled;
  pulseOnBtn.classList.toggle("on", on);
  pulseOnBtn.textContent = on ? "脉冲 开" : "脉冲 关";
  pulseOnBtn.setAttribute("aria-pressed", String(on));
}
pulseOnBtn.addEventListener("click", () => { setPulseEnabled(!PULSE_SETTINGS.enabled); paintPulseOn(); });
paintPulseOn();
uiPaints.push(paintPulseOn);

// 地面与雨：涟漪五格（高度/环宽/亮度 + 点阵两颗旋钮）+ 一格雨亮度，跟脉冲滑杆同一条 sliderRow / 同一份 PULSE_SETTINGS
// mount 分两摊：荡得怎么样的三格留在地面那一节，"点阵本身长什么样"那两格单独一节（2026-09-24 他说参数太多要分组）。
for (const o of [
  { key: "rippleHeight", mount: "rippleRows", title: "涟漪高度", fmt: (v) => v.toFixed(1),
    hint: "0 = 环只亮不起伏（水面静谧感）；0.5 轻触、2.5 投石、8 山丘。参考推荐 0.5 / 2.5。地面那层自己走的底波也吃这一格。" },
  { key: "rippleThickness", mount: "rippleRows", title: "涟漪环厚度", fmt: (v) => v.toFixed(1),
    hint: "0.3 一圈激光环、1.0 精细、4 一片水波。过大环会糊在一起失去\"环\"形。" },
  { key: "rippleBrightness", mount: "rippleRows", title: "涟漪亮度", fmt: pctFmt,
    hint: "点阵被点亮的程度。0 只剩起伏看不见环；2 过曝发白。参考推荐 0.25 克制档。" },
  { key: "dotSeg", mount: "dotRows", title: "点阵密度", fmt: (v) => (24000 / v).toFixed(0) + " mm",
    hint: "两个点之间隔多少毫米（默认 75 = 2026-09-24 定下来的档）。往左疏、往右密：60 段 = 400 mm 一格一格，"
      + "360 段 = 67 mm（13 万个点，比默认档再多三成，机器差就往回拉）。"
      + "只改采样密度，涟漪的高度/环宽/波长一个数都没跟着变。密了以后整张地会更亮——点是加法混合叠的，"
      + "要么把上面那格涟漪亮度往回拉，要么把下面那格点径往回拉。" },
  { key: "dotSizeMm", mount: "dotRows", title: "点径", fmt: (v) => v.toFixed(0) + " mm",
    hint: "一粒点画多大（世界毫米），默认 56 = 参考里那个 0.7 单位。跟密度是两回事：上面那格管"
      + "\"摆多密\"，这一格管\"多大一粒\"。拉小 = 点更分明、整片更暗（加法混合叠的面积小了），"
      + "拉大 = 糊成地皮。想看清\"一粒一粒\"就把它压到点距的一半以下。" },
]) {
  uiPaints.push(sliderRow(document.getElementById(o.mount), {
    title: o.title, hint: o.hint, limits: PULSE_LIMITS[o.key], fmt: o.fmt,
    get: () => PULSE_SETTINGS[o.key],
    set: (v) => setPulseSetting(o.key, v),
  }));
}
// 三档波速 + 三档节拍：六根**关联**滑杆（2026-09-24 他裁的乙，"避免黄色调的比绿色还慢"）。
// 每根的活动区间每次重画现取（gradeBounds），所以拖到挨着邻居就拖不动了 —— 不弹错、不用记规矩。
// 值不在 PULSE_SETTINGS 里：它们就是 STATES 那三行的 speed / interval，滑杆、settings.json、地面共用一份。
// 落盘后必须整窗重画一次：这一根动过，另外两根的区间也跟着动，不重画就会留下一个能拖进禁区间的旧滑杆。
const GRADE_ROWS = [
  { field: "speed", idx: 0, title: "波速 · 空闲（绿）",
    hint: "绿的环每秒荡多远。默认 8 = 慢慢漾开，读起来是「这台活着」而不是「这里有事」。" },
  { field: "speed", idx: 1, title: "波速 · 活跃（黄）",
    hint: "夹在绿与红之间，拖不出反序。默认 16 ≈ 以前那根全局 10 往上一档。" },
  { field: "speed", idx: 2, title: "波速 · 高负载（红）",
    hint: "30 像被踩了一脚的水面，往上到 50 就是冲击波扫过去。只能往绿与黄之上拖。" },
  { field: "interval", idx: 0, title: "节拍 · 空闲（绿）",
    hint: "隔多久起一圈。默认 3.0 s = 「偶尔一个波浪」。这一根同时也管脚下脉冲几连发的节奏（参考那张表就是一个数）。" },
  { field: "interval", idx: 1, title: "节拍 · 活跃（黄）", hint: "绿 ≥ 黄 ≥ 红：越忙起圈越勤，反了就是设置没生效。" },
  { field: "interval", idx: 2, title: "节拍 · 高负载（红）",
    hint: "默认 1.2 s。往 0.3 拖是「一圈叠一圈」，八台一起那么响就很吵了 —— 眼睛说了算。" },
];
for (const o of GRADE_ROWS) {
  uiPaints.push(sliderRow(document.getElementById("gradeRows"), {
    title: o.title, hint: o.hint,
    limits: () => gradeBounds(o.field, o.idx),
    fmt: (v) => (o.field === "speed" ? v.toFixed(0) : v.toFixed(1) + " s"),
    get: () => STATES[o.idx][o.field],
    set: (v) => { setGradeSetting(o.field, o.idx, v); paintSettingsUI(); },
  }));
}
uiPaints.push(sliderRow(document.getElementById("rainRows"), {
  title: "雨亮度", hint: "0 隐藏、0.3 远景氛围、0.8 雨成主角。上限就是 0.8，再高加法混合糊成一片。",
  limits: PULSE_LIMITS.rainBrightness, fmt: (v) => v.toFixed(2),
  get: () => PULSE_SETTINGS.rainBrightness,
  set: (v) => setPulseSetting("rainBrightness", v),
}));
// 涟漪 / 雨两颗独立开关：跟脉冲开关同一种按钮长相，但各管各的
uiPaints.push(bindOnOff("rippleOn", "涟漪", () => PULSE_SETTINGS.rippleEnabled, setRippleEnabled));
uiPaints.push(bindOnOff("rainOn", "雨", () => PULSE_SETTINGS.rainEnabled, setRainEnabled));

// ---------- 设置 ↔ 本地 settings.json（2026-09-23：从"只活在浏览器里"改成"文件是真源"）----------
// 三组：pulse（脉冲）/ ground（地面与雨）/ monitor（采集频率）。键名跟代码里一模一样 —— 不另起一套中文键，
// 多一层映射就多一处会走散的地方；范围那张真表仍是页面里的 PULSE_LIMITS / MON_LIMITS，服务端只校验形状。
// 方向是双向：启动先读文件（文件在就是权威，覆盖浏览器里的旧存档），页面里拖滑块/点开关 400 ms 后写回；
// localStorage 只在 file:// 没服务时兜底。另外每 5 秒读一次 —— 部署成看板后，在服务器上改这个 json、
// 墙上几秒后自己就变，不用去碰那台机器的浏览器。
const SET_API = "/api/settings";
const SET_FILE = "settings.json";
const setLine = document.getElementById("setline");
let setMode = "内存";
let setTimer = 0;
let setSaving = false;
function settingsToFile() {
  return {
    pulse: {
      enabled: PULSE_SETTINGS.enabled,
      pulseStartBrightness: PULSE_SETTINGS.pulseStartBrightness,
      pulseEndBrightness: PULSE_SETTINGS.pulseEndBrightness,
      upParticleBrightness: PULSE_SETTINGS.upParticleBrightness,
      travelK: PULSE_SETTINGS.travelK,
    },
    ground: Object.assign({
      rippleEnabled: PULSE_SETTINGS.rippleEnabled,
      rippleHeight: PULSE_SETTINGS.rippleHeight,
      rippleThickness: PULSE_SETTINGS.rippleThickness,
      rippleBrightness: PULSE_SETTINGS.rippleBrightness,
      dotSeg: PULSE_SETTINGS.dotSeg,
      dotSizeMm: PULSE_SETTINGS.dotSizeMm,
      rainEnabled: PULSE_SETTINGS.rainEnabled,
      rainBrightness: PULSE_SETTINGS.rainBrightness,
    }, gradeValues()),   // 六档波速/节拍：键名与夹好的值都由 model 那张 GRADE_KEYS 表给，这里不重抄
    monitor: { intervalMs: MONITOR_SETTINGS.intervalMs, probeEveryMs: MONITOR_SETTINGS.probeEveryMs },
  };
}
function setSetLine() {
  setLine.textContent = setMode === "文件"
    ? "设置存 " + SET_FILE + "：改文件即生效（每 5 秒读一次），页面里改动也写回它"
    : "设置只在浏览器里（没连上服务？）：刷新不丢，换机器/换浏览器就不同步";
}
// 把文件里的值落到内存。这条路上的两处调用（启动读、5 秒轮询）都传 quiet，
// 免得"读文件"反过来又触发一次"写文件"。
function applySettings(o) {
  if (!o || typeof o !== "object") return false;
  let changed = false;
  const p = o.pulse;
  if (p && typeof p === "object") {
    if (typeof p.enabled === "boolean" && p.enabled !== PULSE_SETTINGS.enabled) { setPulseEnabled(p.enabled, true); changed = true; }
    for (const k of ["pulseStartBrightness", "pulseEndBrightness", "upParticleBrightness", "travelK"]) {
      const lim = PULSE_LIMITS[k], v = Number(p[k]);
      if (!Number.isFinite(v)) continue;
      const nv = clampv(v, lim[0], lim[1]);
      if (nv !== PULSE_SETTINGS[k]) { PULSE_SETTINGS[k] = nv; changed = true; }
    }
  }
  const g = o.ground;
  if (g && typeof g === "object") {
    if (typeof g.rippleEnabled === "boolean" && g.rippleEnabled !== PULSE_SETTINGS.rippleEnabled) { setRippleEnabled(g.rippleEnabled, true); changed = true; }
    if (typeof g.rainEnabled === "boolean" && g.rainEnabled !== PULSE_SETTINGS.rainEnabled) { setRainEnabled(g.rainEnabled, true); changed = true; }
    for (const k of ["rippleHeight", "rippleThickness", "rippleBrightness", "dotSeg", "dotSizeMm", "rainBrightness"]) {
      const lim = PULSE_LIMITS[k], v = Number(g[k]);
      if (!Number.isFinite(v)) continue;
      const nv = clampv(v, lim[0], lim[1]);
      if (nv !== PULSE_SETTINGS[k]) { PULSE_SETTINGS[k] = nv; changed = true; }
    }
    // 六档波速/节拍走 setGrade 本体，不走 setGradeSetting：从文件读值不该反写文件。
    // 但"被相邻档夹过"必须算 changed —— 夹完的生效值要写回去，settings.json 里躺的才是屏上实际那三档。
    for (const [k, field, i] of GRADE_KEYS) {
      const v = Number(g[k]);
      if (!Number.isFinite(v)) continue;
      const before = STATES[i][field];
      if (setGrade(field, i, v) !== before) changed = true;
    }
  }
  const m = o.monitor;
  if (m && typeof m === "object") {
    // 两格节拍都走页面递进来的那个 setter：夹取、重排定时器（本地那一拍 / 抓帧那一轮）、
    // 写 localStorage 兜底，全在 setter 里，这里只判断"值是不是真的变了"（变了才要重绘画布）。
    for (const k of ["intervalMs", "probeEveryMs"]) {
      const lim = MON_LIMITS[k], v = Number(m[k]);
      if (!Number.isFinite(v) || !lim) continue;
      const nv = clampv(Math.round(v / lim[2]) * lim[2], lim[0], lim[1]);
      if (nv !== MONITOR_SETTINGS[k]) { setMonitorSetting(k, v, true); changed = true; }
    }
  }
  if (changed) {
    // 内存变了就把浏览器那份兜底存档同步一下（file:// 场景全靠它）
    try { localStorage.setItem(PS_KEY, JSON.stringify(PULSE_SETTINGS)); localStorage.setItem(MS_KEY, JSON.stringify(MONITOR_SETTINGS)); } catch (e) { /* 写不进就算了 */ }
    paintSettingsUI();
  }
  return changed;
}
async function saveSettings() {
  // "是观众就别写"这一条是必需的：观众的浏览器 GET /api/settings 照样通（设置里不含口令），
  // 所以 setMode 会是"文件"，一旦值被钳过就会走回写 —— 那台机器不该往主人那份 json 上写东西。
  if (ACCESS.viewer || setMode !== "文件") return;
  setSaving = true;
  try {
    const r = await fetch(SET_API, { method: "PUT", headers: { "content-type": "application/json" },
      body: JSON.stringify({ settings: settingsToFile() }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || ("HTTP " + r.status));
  } catch (e) {
    setMode = "内存";
    setLine.textContent = "写入 " + SET_FILE + " 失败：" + e.message + "（设置改动只在浏览器里）";
    setSaving = false;
    return;
  }
  setSaving = false;
  setSetLine();
}
export function touchSettings() {
  // 没接上文件就没得写；这条也顺带挡住启动期（那会儿 setMode 还是"内存"）
  if (ACCESS.viewer || setMode !== "文件") return;
  clearTimeout(setTimer);
  setTimer = setTimeout(() => { setTimer = 0; saveSettings(); }, 400);
}
export async function loadSettings() {
  if (location.protocol === "file:") { setMode = "内存"; setSetLine(); return; }
  try {
    const r = await fetch(SET_API, { cache: "no-store" });
    if (!r.ok) throw new Error("HTTP " + r.status);
    const j = await r.json();
    setMode = "文件";
    if (j.settings) {
      // 手改文件写了越界值 → applySettings 钳回后跟文件不一致 → 回写一次，让文件等于"实际生效值"
      if (applySettings(j.settings) && JSON.stringify(j.settings) !== JSON.stringify(settingsToFile())) saveSettings();
    } else {
      await saveSettings();   // 文件还没生成过：把当前这套默认写下去，"部署后有个能改的东西"才成立
    }
  } catch (e) {
    setMode = "内存";
  }
  setSetLine();
  setInterval(pollSettings, 5000);
}
async function pollSettings() {
  // 本地刚改完还在写盘：这一拍别读，否则读回旧值、屏上会弹回去一下
  if (setMode !== "文件" || setSaving || setTimer) return;
  try {
    const r = await fetch(SET_API, { cache: "no-store" });
    if (!r.ok) return;
    const j = await r.json();
    if (!j.settings || JSON.stringify(j.settings) === JSON.stringify(settingsToFile())) return;   // 一样就别动
    if (applySettings(j.settings)) {
      saveSettings();   // 被钳回过 = "文件 ≠ 生效值"，顺手把文件写成生效值
      setSetLine();
    }
  } catch (e) { /* 一拍读不到不当回事，下一拍再来 */ }
}

// ---------- 设备清单 ↔ 本地配置文件 ----------
// 用 node serve.mjs 起本地服务打开这页时，编辑会写回同目录的 devices.json；
// 直接 file:// 双击打开时浏览器不能写盘，退回内存态并在弹窗里标出来。
// 清单存 name/tier/power/os/host/user/pass —— pass 明文落盘是你 2026-09-23 同意的，
// 代价是这个文件成了敏感文件：别拷进仓库、别进分享包。
const CFG_API = "/api/devices";
const HOSTS_API = "/api/hosts";   // 同一份清单的观众版：没有 user / pass，多一个服务端算好的 live
const CFG_FILE = "devices.json";
const cfgLine = document.getElementById("cfgline");
let cfgMode = "内存";
let cfgLast = "";
let cfgTimer = 0;
let booted = false;

function setCfgLine() {
  cfgLine.textContent = cfgMode === "文件"
    ? "清单已接到本地文件 " + CFG_FILE + " · 编辑即写回" + (cfgLast ? "（最近 " + cfgLast + "）" : "")
    : "没连上本地文件（现在是 file:// 打开？）：编辑只在内存里，刷新即丢。要落盘请跑 node serve.mjs，再开 http://127.0.0.1:8123/（换成这台机子的 IP 也行，跑服务时带 HM_BIND=0.0.0.0）";
}
function toFileList() {
  return devices.map((d) => ({ name: d.short, tier: d.tier, zone: d.zone, power: d.power,
    hidden: d.hidden === true, os: d.os,
    host: d.host, user: d.user, pass: d.pass }));
}
async function saveNow() {
  if (ACCESS.viewer) return;   // 观众的清单来自 /api/hosts（不含 user/pass）；拿它反写 devices.json 会把凭据整格清空
  try {
    const r = await fetch(CFG_API, { method: "PUT", headers: { "content-type": "application/json" },
      body: JSON.stringify({ list: toFileList() }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || ("HTTP " + r.status));
    cfgLast = new Date().toTimeString().slice(0, 8);
  } catch (e) {
    cfgMode = "内存";
    cfgLine.textContent = "写入 " + CFG_FILE + " 失败：" + e.message + "（编辑只在内存里）";
    return;
  }
  setCfgLine();
}
export function touch() {
  if (!booted || cfgMode !== "文件") return;
  clearTimeout(cfgTimer);
  cfgTimer = setTimeout(saveNow, 400);
}
export async function loadDevices() {
  if (location.protocol === "file:") {
    // 不发这一枪：相对地址在 file:// 下会解析成 file:///E:/api/devices，
    // 浏览器必然记一条红色错误，功能上虽然后退回默认，但 console 就不再是干净的
    cfgMode = "内存";
    setCfgLine();
    return;
  }
  try {
    // 观众读的是剥掉 user/pass 的那一份（/api/devices 现在只有主人能读）
    const r = await fetch(ACCESS.viewer ? HOSTS_API : CFG_API, { cache: "no-store" });
    if (!r.ok) throw new Error("HTTP " + r.status);
    const j = await r.json();
    if (!Array.isArray(j.list) || !j.list.length) throw new Error("清单为空");
    setDevices(j.list);   // 整份换绑要走 model 的 setter（理由见 src/model.mjs 头部）
    cfgMode = "文件";
  } catch (e) {
    cfgMode = "内存";
  }
  setCfgLine();
}

// ---------- 分区 ↔ 本地 zones.json ----------
// 为什么单独一个文件：改分区名不该顺手把八台机器的连接信息重写一遍。
// 文件里只认 key / cn / at 三样：key 是内部标识（设备的 d.zone 指的就是它），改名不动 key，
// 所以"改分区名"永远不会把已经钉在这个区里的设备弄丢。
const ZONE_API = "/api/zones";
const ZONE_FILE = "zones.json";
const tabsBox = document.getElementById("ztabs");
const zRowsBox = document.getElementById("zrows");
const zCountEl = document.getElementById("zcount");
const zLine = document.getElementById("zline");
let curZone = ZONES[0].key;   // 设备列表当前选中的分区
let zMode = "内存";
let zTimer = 0;

function setZLine() {
  zLine.textContent = zMode === "文件"
    ? "分区表已接到本地文件 " + ZONE_FILE + "（改一次才生成）· 改名 / 挪位 / 增删即写回"
    : "没连上本地文件（现在是 file:// 打开？）：分区改动只在内存里，刷新即丢。要落盘请跑 node serve.mjs，再开 http://127.0.0.1:8123/（换成这台机子的 IP 也行，跑服务时带 HM_BIND=0.0.0.0）";
}
const zonesToFile = () => ZONES.map((z) => ({ key: z.key, cn: z.cn, at: z.at, off: z.off === true }));
async function saveZones() {
  try {
    const r = await fetch(ZONE_API, { method: "PUT", headers: { "content-type": "application/json" },
      body: JSON.stringify({ list: zonesToFile() }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || ("HTTP " + r.status));
  } catch (e) {
    zMode = "内存";
    zLine.textContent = "写入 " + ZONE_FILE + " 失败：" + e.message + "（分区改动只在内存里）";
    return;
  }
  setZLine();
}
function touchZones() {
  if (!booted || zMode !== "文件") return;
  clearTimeout(zTimer);
  zTimer = setTimeout(saveZones, 400);
}
function zonesFromFile(list) {
  const out = [];
  const seen = new Set();
  for (const it of (Array.isArray(list) ? list : []).slice(0, ZONE_MAX)) {
    if (!it || typeof it !== "object") continue;
    const key = typeof it.key === "string" ? it.key.slice(0, 24) : "";
    const x = Number(it.at && it.at[0]), z = Number(it.at && it.at[1]);
    if (!ZONE_KEY_RE.test(key) || seen.has(key) || !Number.isFinite(x) || !Number.isFinite(z)) continue;
    seen.add(key);
    out.push({ key, cn: String(it.cn || "").slice(0, 12) || ("分区 " + (out.length + 1)),
      at: [Math.round(x), Math.round(z)], off: it.off === true });
  }
  return out.length ? out : null;
}
export async function loadZones() {
  if (location.protocol === "file:") { zMode = "内存"; setZLine(); return; }
  try {
    const r = await fetch(ZONE_API, { cache: "no-store" });
    if (!r.ok) throw new Error("HTTP " + r.status);
    const j = await r.json();
    const list = zonesFromFile(j.list);   // 文件还没生成过就是 null：保持页面内置的那套默认摆位
    if (list) { ZONES.length = 0; for (const z of list) ZONES.push(z); }
    zMode = "文件";
  } catch (e) {
    zMode = "内存";
  }
  setZLine();
}

// 设备列表上面那排选项卡：一格一个分区，数字是这区里的台数（点它只筛列表，不动场景）
function renderTabs() {
  tabsBox.textContent = "";
  if (!ZONES.some((z) => z.key === curZone)) curZone = ZONES[0].key;
  for (const z of ZONES) {
    const all = devices.filter((d) => zoneKeyOf(d) === z.key).length;
    const vis = z.off ? 0 : devices.filter((d) => zoneKeyOf(d) === z.key && !d.hidden).length;
    const b = el("button", "zt" + (z.key === curZone ? " on" : "") + (z.off ? " zoff" : ""));
    b.type = "button";
    b.title = z.cn + " · " + vis + " 台" + (all !== vis ? "（这个区共 " + all + " 台，" + (z.off ? "整区已关" : "藏了 " + (all - vis) + " 台") + "）" : "") + "（只筛列表，不动场景）";
    b.append(el("span", null, z.cn), el("span", "zn", String(vis)));
    b.addEventListener("click", () => {
      curZone = z.key;
      renderTabs();
      renderList();
    });
    tabsBox.append(b);
  }
}

// 分区设置：一行 = 名字 / X / Z / ◎定位 / 删除。结构变了（增删）整块重画，
// 改名和挪位是原地的：输入框不能被自己重画掉，不然打一个字就丢焦点。
export function renderZones() {
  zRowsBox.textContent = "";
  const hd = el("div", "zrow hd");
  hd.append(el("span", null, "分区名"), el("span", null, "X（mm）"), el("span", null, "Z（mm）"),
    el("span", null, "开·关"), el("span"), el("span"));
  zRowsBox.append(hd);
  ZONES.forEach((z, idx) => {
    const row = el("div", "zrow" + (z.off ? " off" : ""));
    const nm = textField("text", z.cn, "分区名", (v) => {
      z.cn = v.trim() || "(未命名)";
      sync();   // 场上的区名标注、列表里的分区下拉、选项卡都跟着改
    });
    nm.maxLength = 12;
    nm.title = "分区名（显示名；设备的归属跟着 key 走，改名不动归属）";
    // 分区可整体关闭：关掉 = 这一区整个不摆（角铁、设备、标注全撤），设备清单一条都不动。
    // 跟"删除"是两件事：删除会把钉在里面的设备打回自动落区，关闭只是先收起这块地。
    const sw = mini(z.off ? "已关" : "开着", "关掉 = 这个区整个不摆（设备仍在清单里）；再点一下放出来", z.off ? "on2" : "");
    sw.addEventListener("click", () => {
      z.off = !z.off;
      renderZones();
      sync();
      touchZones();
    });
    const loc = mini("◎", "把相机拉到这个分区上方（挪完位置想看效果就点它）");
    loc.addEventListener("click", () => {
      pinLabel(null); hidePerf();
      moveTo(new THREE.Vector3(z.at[0], ZONE_FIELD.h / 2, z.at[1]), ZONE_FIELD.w * 1.25);
    });
    const del = mini("删除", ZONES.length > 1
      ? "删掉这个分区；原来钉在这个区的设备回到「按档位自动落区」"
      : "最后一个分区不能删（设备得有地方待）", "del");
    del.disabled = ZONES.length <= 1;
    del.addEventListener("click", () => {
      const gone = z.key;
      ZONES.splice(idx, 1);
      for (const d of devices) if (d.zone === gone) d.zone = "";   // 别让设备跟着分区一起消失
      if (curZone === gone) curZone = ZONES[0].key;
      renderZones();
      sync();
      touch();        // 设备的 zone 被清过，清单也要跟着写一次，别让内存和文件各说各的
      touchZones();
    });
    row.append(nm, numField(z, 0, "分区中心的 X（世界单位 = 毫米，向右为正）"),
      numField(z, 1, "分区中心的 Z（毫米，朝屏幕前方为正）"), sw, loc, del);
    zRowsBox.append(row);
  });
  zCountEl.textContent = ZONES.length + " 个分区";
}
function numField(z, k, title) {
  const i = el("input", "tx");
  i.type = "number";
  i.step = 50;
  i.value = Math.round(z.at[k]);
  i.title = title;
  i.addEventListener("input", () => {
    if (i.value.trim() === "") return;   // 敲到一半的空框当 0 会把分区甩到原点
    const v = Number(i.value);
    if (!Number.isFinite(v)) return;
    z.at[k] = Math.round(v);
    sync();
    touchZones();
  });
  return i;
}
function newZoneKey() {
  for (let n = 1; ; n++) if (!ZONES.some((z) => z.key === "zone" + n)) return "zone" + n;
}
// 新分区落在第一个空着的候选位（3 列 × 5 行，够 ZONE_MAX 个用）。
// 占位判断按"盒子会不会压到"算，不是按中心点差 200mm：默认摆位是半间距错开的（±ZC[0]），
// 只比中心点的话新分区会正好叠在算力集群身上。
function freeSpot() {
  const px = ZONE_FIELD.w + ZONE_AISLE, pz = ZONE_FIELD.d + ZONE_AISLE;
  const clash = (x, z) => ZONES.some((q) => Math.abs(q.at[0] - x) < ZONE_FIELD.w
    && Math.abs(q.at[1] - z) < ZONE_FIELD.d);
  for (const gz of [0, -1, 1, -2, 2]) for (const gx of [0, -1, 1]) {
    const x = gx * px, z = gz * pz;
    if (!clash(x, z)) return [x, z];
  }
  return [0, 3 * ZONE_PITCH];
}
document.getElementById("zadd").addEventListener("click", () => {
  if (ZONES.length >= ZONE_MAX) {
    zLine.textContent = "最多 " + ZONE_MAX + " 个分区（地皮是 3 × 3 格，再多就摆不出不重叠的位置了）";
    return;
  }
  const [x, z] = freeSpot();
  const zz = { key: newZoneKey(), cn: "新分区 " + (ZONES.length + 1), at: [x, z] };
  ZONES.push(zz);
  curZone = zz.key;   // 视线跟着新分区走
  renderZones();
  sync();
  touchZones();
});
// ---------- 给"仪器"用的两格读数 ----------
// 原来这两格直接长在页面的 __hm 里，读的是本模块的私货（setMode / setTimer / mask 的计算样式）。
// 与其把四五个内部状态 export 出去，不如这层自己出读数：__hm 那一边只剩一行委托，键名一字未改。
export function settingsState() { return { 模式: setMode, 文件: SET_FILE, 有待写盘: !!setTimer, 正在写盘: setSaving }; }
export function dialogState() { return getComputedStyle(mask).display; }

// 首屏启动：读三份文件、按文件里的值重建一次、之后才允许写盘（booted 之前任何一次 touch* 都不落盘，
// 免得"刚打开页面"被当成"用户改了设置"把默认值刷进那三份权威档）。
// 顺序是有讲究的。
// 身份（主人 / 观众）先问：它决定下面读清单走哪个端点（/api/devices 带口令、/api/hosts 不带），
// 也决定浏览器这一头的几个写闸门要不要先合上。
// 分区必须先于设备读：设备清单里的 zone 要对着"当前这套分区"验，反过来就全被当成手动钉的又不存在的区。
// 设置要在 sync() 之前读：文件里的值得落在首屏上，不然开局那几秒屏上是 localStorage 的旧值。
// 调用点仍然在页面所有声明之后 —— sync 会走到 fitOverview，
// 那要读 OVERVIEW / HOME，放它们前面就是 TDZ 崩页（这一类错已经踩过 liveOf 一次）。
export async function bootFromFiles() {
  await loadAccess();
  await loadZones();
  await loadDevices();
  await loadSettings();
  sync();
  renderZones();
  booted = true;
}
