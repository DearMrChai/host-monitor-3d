// 性能看板：一帧真数据（或一份模拟值）→ 右侧那一排卡片。
// 两层同住一个文件是刻意的：RES 那张表里的回调要点 buildSection / paintPanel，拆开就是环形 import。
// 这层不碰 SSH、不碰浮层、不碰分区摆放 —— 那些留在页面，是"这一页"的接线不是"这块板"的逻辑。
import { el, sparkSvg, mini } from "./ui.mjs";
import { clampv, usageColor, tempColor, mean, fmtSpeed, hhmm, gbOfBytes, mbOfBytes, gbOfMb, avgOf, gbTxt, memPct, memFreeGb, diskName, volName, shortName, vendorOf } from "./format.mjs";
import { liveOf, tierOf, MONITOR_SETTINGS, MON_LIMITS, MS_KEY } from "./model.mjs";

const srcTag = (d) => (!liveOf(d) ? "模拟" : d.frame ? "实测" : d.probeErr ? "抓不到" : "待抓");

// 每一节自己标：这节的数从哪儿来。
// 填了地址 = 只用真数据（你 2026-09-24 那句"填了地址就不需要假数据了"）：抓到帧就是"实测 HH:MM"，
// 没抓到就是"抓不到"，这一节里取不到的字段**整行/整节消失**，不会退回模拟值。

function srcOf(key, d) {
  if (!liveOf(d)) return { t: "模拟", c: "sim" };
  if (!d.frame) return { t: d.probeErr ? "抓不到" : "待抓", c: "bad" };
  return { t: "实测 " + hhmm(d.frame.at), c: "real" };
}

// 一帧快照给出的"这台有多忙"（0~100）：
//   Windows 直接给占用率百分比（CIM 的 LoadPercentage）；
//   linux 没有这个数，探针用刚采到的每逻辑核占用率求了平均塞进 cpuPct；
//   实在都没有，才退回"1 分钟负载 ÷ 核数"那条老换算。

const framePct = (f) => {
  if (!f) return null;
  if (typeof f.cpuPct === "number") return clampv(f.cpuPct, 0, 100);
  if (f.cores > 0 && typeof f.load1 === "number") return clampv((f.load1 / f.cores) * 100, 0, 100);
  return null;
};

// 一帧快照能给出什么，"该建哪几节"就按什么算：拿不到的那节**整节不出现**，不拿档位规格去补。
// 填了地址但还没抓到帧（或抓不到）→ 全部数 0 = 一节都不建，面板上只留一句说明。

function hwOf(d) {
  const base = TIER_HW[d.tier] || TIER_HW.matx;
  const f = d.frame;
  if (!f) return liveOf(d) ? { cores: 0, gpus: 0, disks: 0, nics: 0, mem: 0, live: true } : base;
  const cpu = f.cpu || {};
  return {
    // 这一格喂的是"几个核"（RES.cpu.count 那张表），所以报**物理核**：探针给了核映射就数不同的核，
    // 没给就退回逻辑处理器个数（至少比 0 强），再退回探针报的 CORES。
    cores: (cpu.coreMap && new Set(cpu.coreMap).size)
      || (cpu.perCore && cpu.perCore.length) || f.cores || 0,
    gpus: (f.gpus || []).length + (f.gpuNames || []).length,
    disks: (f.disks || []).length || (f.physDisks || []).length,
    nics: nicsOf(f).length,
    mem: f.memTotalMb ? Math.round(f.memTotalMb / 1024) : 0,
    live: true,
  };
}

function pushHist(arr, v) {
  arr.push(v);
  if (arr.length > 60) arr.shift();
}
function hist(n, base, jitter) {
  return Array.from({ length: n }, () => base + Math.random() * jitter);
}

// 硬件规格按档位给（这一张表就是"通用配置项"的入口，改这里等于改整块看板）
// CORES_CAP：核数上限，所有档一起钳在这里（一般机箱用不到几十核，卡片铺太多反而看不清）。
// 要按真机放开，就把这个值改大或删掉这一行钳制。
const CORES_CAP = 6;
// 后三档是"非电脑"的机器：数值按真机规格给（TS-551 = 赛扬 J3355 双核 / 2GB / 5 盘位 / 2 网口）。
// 填 0 的那一项 = 这台没这个概念，看板上整节直接不出现（见 buildPanel），不编数。
// XDR5410 的内存规格页没给数字，所以留 0；交换机把 8 个口当 8 张"网卡"看。
const TIER_HW = {
  laptop: { cores: 12, gpus: 1, disks: 1, nics: 1, mem: 16 },
  itx: { cores: 6, gpus: 1, disks: 1, nics: 1, mem: 32 },
  matx: { cores: 16, gpus: 1, disks: 2, nics: 1, mem: 32 },
  atx: { cores: 16, gpus: 2, disks: 3, nics: 2, mem: 64 },
  eatx: { cores: 24, gpus: 2, disks: 3, nics: 2, mem: 128 },
  nas: { cores: 2, gpus: 0, disks: 5, nics: 2, mem: 2 },
  switch: { cores: 0, gpus: 0, disks: 0, nics: 8, mem: 0 },
  router: { cores: 1, gpus: 0, disks: 0, nics: 4, mem: 0 },
};
const pCountOf = (n) => Math.max(1, Math.round(n / 3));
const GPU_NAMES = ["NVIDIA GeForce RTX 4090", "NVIDIA GeForce RTX 4080", "AMD Radeon RX 7900 XTX"];
const DISK_NAMES = [
  { name: "Samsung 990 PRO 2TB", type: "NVMe", total: 2000, maxRead: 7450, maxWrite: 6900 },
  { name: "WD Black SN850X 4TB", type: "NVMe", total: 4000, maxRead: 7300, maxWrite: 6600 },
  { name: "Crucial MX500 1TB", type: "SSD", total: 1000, maxRead: 560, maxWrite: 510 },
  { name: "Seagate Exos 16TB", type: "HDD", total: 16000, maxRead: 270, maxWrite: 260 },
];
const NIC_NAMES = [
  { name: "以太网", type: "Ethernet", link: 2500 },
  { name: "Wi-Fi 6E", type: "Wireless", link: 1200 },
];

// ---------- 实测项（2026-09-24）：填了地址的设备只用真数据 ----------
// 规则只有一条，全在这几个访问器里落实：**取不到就返回 null**。
// 然后：
//   · bars / foot 里 pct 与 text 都变 null 的 → 这一行整行不建（buildCard 里筛掉）
//   · items 为空 → 这一节整节不建（buildPanel 里就跳过了）
//   · stats 里 v 为 null 的 → 那一格显示 —（格数固定，不能一帧一个样）
// 模拟项永远返回数/串，所以这条规则对它们是无操作 —— 没填地址的那条路一个字都没改。
// CPU：一张卡 = 一个**物理核**。探针报了核映射（coreMap，逐逻辑处理器）就把同核的逻辑处理器并成一张：
// 数取该核里最忙的那个逻辑处理器（一个核忙到 100% 就是 100%，取平均会把"有一根线程跑满"洗掉），
// 两根线程各自的数挂在卡片的详情里（threads），点开卡才看得见。
// 没有映射（老探针、或两路长度不等被 serve.mjs 判废）就退回一逻辑处理器一张 —— 退回时**明说**是逻辑的，
// 不再把"线程 0/1/2…"当成核来摆（他 2026-09-24 那条"点开之后还是显示线程，不是核心"）。
// 温度一次快照给不了，一律 null。
const liveCpu = (f) => {
  const c = f.cpu || {};
  const us = c.perCore || [];
  const len = (a) => (a && a.length === us.length ? a : null);
  const map = len(c.coreMap), cls = len(c.pcls), mhz = len(c.perMhz);
  if (!map) {
    return us.map((u, i) => ({ id: i, live: true, core: false, kind: cls ? (cls[i] || null) : null,
      usage: u,
      freq: mhz && mhz[i] != null ? mhz[i] / 1000 : null, temp: null, threads: [], history: [] }));
  }
  const groups = new Map();
  us.forEach((u, i) => {
    let g = groups.get(map[i]);
    if (!g) {
      g = { id: groups.size, coreId: map[i], live: true, core: true, kind: null, usage: null,
        freq: null, threads: [], history: [] };
      groups.set(map[i], g);
    }
    if (cls) g.kind = g.kind === "P" || cls[i] === "P" ? "P" : "E";
    if (mhz && mhz[i] != null && g.freq == null) g.freq = mhz[i] / 1000;
    g.usage = g.usage == null ? u : Math.max(g.usage, u);
    g.threads.push({ id: i, usage: u });
  });
  return [...groups.values()];
};
const liveMem = (f) => {
  if (!f.memTotalMb) return [];
  const m = f.mem || {};
  const total = gbOfMb(f.memTotalMb), used = gbOfMb(f.memUsedMb);
  return [{
    id: 0, live: true, total, used,
    cache: gbOfMb(m.cacheMb),
    swapTotal: gbOfMb(m.swapTotalMb), swapUsed: gbOfMb(m.swapUsedMb),
    type: m.type || null, speed: m.speedMhz || null, modules: m.modules || null,
    history: [],
  }];
};
// 显卡：nvidia-smi 有的那几张带全套指标；只有型号的（lspci / WMI 报的名字）指标全 null，
// 卡片就只剩"型号"这一件事 —— 不编利用率。
const liveGpu = (f) => {
  const out = (f.gpus || []).map((g, i) => ({
    id: i, live: true, name: g.name || null, short: shortName(g.name) || ("GPU " + i),
    vendor: vendorOf(g.name), usage: g.util,
    memTotal: gbOfMb(g.memTotalMb), memUsed: gbOfMb(g.memUsedMb),
    temp: g.tempC, power: g.powerW, powerLimit: g.powerLimitW,
    fan: g.fanPct, coreClock: g.clockMhz, driver: g.driver || null, history: [],
  }));
  for (const n of (f.gpuNames || [])) {
    out.push({ id: out.length, live: true, name: n, short: shortName(n) || n, vendor: vendorOf(n),
      usage: null, memTotal: null, memUsed: null, temp: null, power: null, powerLimit: null,
      fan: null, coreClock: null, driver: null, history: [] });
  }
  return out;
};
// 磁盘：优先按"卷"（有容量 + 读写速率），没有卷才退回整块物理盘（只有容量）。
// 一次快照没有 IO 忙率 / 温度 / 延迟，全 null；大数字改用**容量占用率**（这是真数）。
const liveDisk = (f) => {
  if ((f.disks || []).length) return f.disks.map((v, i) => ({
    id: i, live: true, name: v.model || null, vol: volName(v), part: String(v.id || "") || null,
    type: v.media || v.fs || null, fs: v.fs || null, label: v.label || null,
    bus: v.bus || null, media: v.media || null,
    total: gbOfBytes(v.sizeBytes), free: gbOfBytes(v.freeBytes),
    used: v.sizeBytes > 0 ? gbOfBytes(v.sizeBytes - v.freeBytes) : null,
    readSpeed: mbOfBytes(v.readBps), writeSpeed: mbOfBytes(v.writeBps),
    busy: v.sizeBytes > 0 ? ((v.sizeBytes - v.freeBytes) / v.sizeBytes) * 100 : null,
    temp: null, latency: null, history: [],
  }));
  return (f.physDisks || []).map((p, i) => ({
    id: i, live: true, name: p.name, vol: null, part: null, type: p.media || null,
    fs: null, label: null, bus: p.bus || null, media: p.media || null,
    total: gbOfBytes(p.sizeBytes), free: null,
    used: null, readSpeed: null, writeSpeed: null, busy: null, temp: null, latency: null, history: [],
  }));
};
// 容器/虚拟桥的接口名：vethXXXX、docker0、br-XXXX、virbr0、tap0 —— 这些是别人家的管子，
// 一台机上能冒出十几条，全摆到墙上就把真网卡淹了。物理口一律留，隧道口（zt/tun/wg/tailscale）留，
// 只滤掉这一串前缀。规则写在这儿，hwOf 和 liveNet 共用，免得"几张卡"和"摆几张卡"对不上。
const nicsOf = (f) => ((f && f.nics) || []).filter((n) => !/^(veth|docker|br-|virbr|tap|dummy)/i.test(String(n.name || "")));
const liveNet = (f) => nicsOf(f).map((n, i) => ({
  id: i, live: true, name: n.name, type: n.virtual ? "虚拟" : "物理",
  link: n.linkMbps || 0, up: n.up, ip: n.ip || null, mac: n.mac || null,
  virtual: n.virtual, desc: n.desc || null,
  downSpeed: mbOfBytes(n.rxBps), upSpeed: mbOfBytes(n.txBps),
  history: [], downHistory: [], upHistory: [],
}));

// 这五条就是"一帧真数据 → 面板项"的翻译层。buildPanel 只认这张表：
// 填了地址又抓到帧的设备，每一节都由它生成；没填地址的、还没抓到帧的，才走原来那套 count+make。
const LIVE = { cpu: liveCpu, mem: liveMem, gpu: liveGpu, disk: liveDisk, net: liveNet };

const RES = {
  cpu: {
    title: "CPU", unit: "核", dense: true, heat: true, summary: true,
    count: (hw) => Math.min(CORES_CAP, hw.cores),
    // 型号是他点名要加的（"6 核 后面建议 +cpu 型号"）。实测那台拼在核数后面；
    // P/E 那半只有混合架构报得出来，报不出来就只写核数，不去按比例猜。
    sub: (its, d) => {
      const c = d && d.frame && d.frame.cpu ? d.frame.cpu : null;
      // 没抓到帧的（模拟那几台）照旧按"每三个核里两个 E"分摊 —— 模拟卡的 kind 是按**整机核数**分的，
      // 而墙上只摆前 6 张，直接数 kind 会得出 "6P + 0E" 这种一看就不对的串。
      if (!c) return pCountOf(its.length) + "P + " + (its.length - pCountOf(its.length)) + "E · " + its.length + " 核";
      // 主频这一格要回来（09-24 他问"原来显示核心数量和主频的地方变成线程了"）：
      // 换成一逻辑处理器一张卡之后，抬头只剩核数/线程/型号，那一格没人管了 —— 数还在帧里（maxMhz / curMhz），
      // 只是没人念。两个数含义不同，所以分开写：curMhz 是 linux 侧 /proc/cpuinfo 的**此刻**跑多少，
      // maxMhz 是 Windows 侧 WMI 的**标称**主频（不是睿频上限，别写成"最高"）。两个都拿不到就整段不显示。
      const ghz = (v) => (v >= 1000 ? (v / 1000).toFixed(2) + " GHz" : v + " MHz");
      const hz = c.curMhz ? " · 实时 " + ghz(c.curMhz) : c.maxMhz ? " · 主频 " + ghz(c.maxMhz) : "";
      const model = shortName(c.model);
      // 线程总数按卡里那些逻辑处理器数出来（有核映射时 = 各卡 threads 之和；没有映射时卡片本身就是逻辑处理器）
      const logi = c.logical || its.reduce((a, x) => a + ((x.threads && x.threads.length) || 1), 0);
      // 抬头数的就是**屏上那些卡**，所以拿 its 自己算，不去念探针另报的那两个数（对不上就是打脸）
      const p = its.filter((x) => x.kind === "P").length;
      const e = its.filter((x) => x.kind === "E").length;
      const pe = p + e ? p + "P + " + e + "E · " : "";
      if (its[0] && its[0].core) {
        // 一核一张卡：核数 = 卡数，线程数另外报出来，免得"14"被读成 14 个线程
        return pe + its.length + " 核 · " + logi + " 线程" + hz + (model ? " · " + model : "");
      }
      // 没有核映射（老探针 / 两路长度不等）：卡是一逻辑处理器一张，抬头只能说线程，
      // 并明说映射没取到 —— 他 09-24 报的"还是显示线程不是核心"，退回这一路时必须让他看见原因
      return logi + " 线程 · 核映射未取到" + hz + (model ? " · " + model : "");
    },
    make: (i, hw) => {
      const isP = i < pCountOf(hw.cores);
      const base = 8 + Math.random() * 20;
      return {
        id: i, kind: isP ? "P" : "E", usage: base, freq: isP ? 2.6 : 2.0, temp: 42 + Math.random() * 8,
        threads: Array.from({ length: isP ? 2 : 1 }, (_, t) => ({ id: t, usage: base + (Math.random() - 0.5) * 20 })),
        history: hist(60, base, 10),
      };
    },
    label: (c) => (c.core ? "核 " + c.id : c.live ? "逻辑处理器 " + c.id : "Core " + c.id),
    tag: (c) => c.kind || "",
    tagCls: (c) => (c.kind === "P" ? "p" : c.kind === "E" ? "e" : ""),
    pct: (c) => c.usage,
    big: (c) => (c.usage == null ? null : [c.usage.toFixed(0), "%", usageColor(c.usage)]),
    bars: [
      { k: "使用率", pct: (c) => c.usage, text: (c) => (c.usage == null ? null : c.usage.toFixed(0) + "%"), color: (c) => (c.usage == null ? null : usageColor(c.usage)) },
      { k: "频率", pct: (c) => (c.freq == null ? null : (c.freq / 5.2) * 100), text: (c) => (c.freq == null ? null : c.freq.toFixed(2) + " GHz"), color: () => "#58a6ff" },
    ],
    foot: [
      { k: "温度", text: (c) => (c.temp == null ? null : c.temp.toFixed(0) + "°C"), color: (c) => (c.temp == null ? null : tempColor(c.temp)) },
      { k: "线程", text: (c) => (c.threads && c.threads.length ? c.threads.length + "T" : null) },
    ],
    // 每格固定 4 个：格数不能一帧一个样，不然 buildSection 存下的 ref 会跟当前结果错位。
    // 取不到的那格 v 给 null，paintPanel 会把它显示成 —。
    stats: (its, d) => {
      const us = its.map((c) => c.usage).filter((v) => Number.isFinite(v));
      const fs = its.map((c) => c.freq).filter((v) => Number.isFinite(v));
      const ts = its.map((c) => c.temp).filter((v) => Number.isFinite(v));
      const pkg = d && d.frame && d.frame.cpu ? d.frame.cpu.tempC : null;   // linux 的整包温度（sensors）
      const t = ts.length ? Math.max(...ts) : pkg;
      const avg = avgOf(us);
      const hotId = us.length ? us.indexOf(Math.max(...us)) : -1;
      // 第四格念的是"哪一张卡最忙"，所以称呼必须跟着卡的口径走（核 / 逻辑处理器），不能写死
      const c0 = its[0] || {};
      const byCore = !c0.live || c0.core;
      const busyPre = byCore ? (c0.live ? "核 " : "Core ") : "逻辑处理器 ";
      return [
        { k: "总使用率", v: avg == null ? null : avg.toFixed(1), u: "%", color: avg == null ? null : usageColor(avg) },
        { k: "平均频率", v: fs.length ? mean(fs).toFixed(2) : null, u: "GHz" },
        { k: "最高温度", v: t == null ? null : t.toFixed(0), u: "°C", color: t == null ? null : tempColor(t) },
        { k: byCore ? "最忙核心" : "最忙逻辑处理器", v: hotId >= 0 ? busyPre + its[hotId].id + " · " + us[hotId].toFixed(0) + "%" : null, sm: true },
      ];
    },
    // 抓到的那一帧只覆盖总使用率（win 用占用率、linux 用负载均值÷核数）；各核分布仍是分摊出来的
    real: (st, d) => {
      const pct = framePct(d.frame);
      if (pct == null) return;
      st[0].v = pct.toFixed(1);
      st[0].color = usageColor(pct);
    },
    detail: (c) => [
      { k: "类型", v: c.kind ? c.kind + "-Core" : null },
      { k: "频率", v: c.freq == null ? null : c.freq.toFixed(2) + " GHz" },
      { k: "温度", v: c.temp == null ? null : c.temp.toFixed(1) + " °C", color: c.temp == null ? null : tempColor(c.temp) },
    ],
    threads: (c) => (c.threads || []).map((t) => ({ k: "线程 " + t.id, pct: t.usage, text: t.usage.toFixed(0) + "%", color: usageColor(t.usage) })),
    step: (c, t, i) => {
      const wave = (Math.sin(t * 0.7) + 1) / 2;
      const per = (Math.sin(t * 1.1 + i * 0.9) + 1) / 2;
      const spike = Math.random() < 0.05 ? 30 : 0;
      c.usage = clampv(c.usage + (clampv(6 + wave * 45 + per * 30 + spike + Math.random() * 8, 0, 100) - c.usage) * 0.32, 0.5, 100);
      const base = c.kind === "P" ? 2.0 : 1.6;
      const boost = c.kind === "P" ? 2.6 : 1.8;
      c.freq += (base + (c.usage / 100) * boost - c.freq) * 0.25;
      c.temp += (36 + c.usage * 0.45 + (c.kind === "P" ? 4 : 0) - c.temp) * 0.10;
      c.threads.forEach((th) => {
        th.usage = clampv(th.usage + (clampv(c.usage + (Math.random() - 0.5) * 26, 0, 100) - th.usage) * 0.35, 0, 100);
      });
      pushHist(c.history, c.usage);
    },
    history: (c) => c.history,
    histColor: (c) => usageColor(c.usage),
  },

  mem: {
    title: "内存", unit: "条", count: (hw) => (hw.mem > 0 ? 1 : 0),
    // 用户第 4 条要的就是 "DDR5 · 6000 MHz" 这种规格串。实测那台按 类型 · 频率 · 条数 拼，
    // 哪一段取不到就少哪一段 —— 他机器里没有 DDR5，那就照实写 DDR4，不拿 DDR5 顶上去。
    sub: (its) => {
      const m = its[0];
      if (!m.live) return m.type + " · " + m.speed + " MHz";
      return [m.type, m.speed == null ? null : m.speed + " MHz", m.modules == null ? null : m.modules + " 条"]
        .filter(Boolean).join(" · ") || "规格未知";
    },
    make: (i, hw) => ({
      id: i, total: hw.mem, used: hw.mem * 0.44, cache: hw.mem * 0.18, swapTotal: 8, swapUsed: 0.9,
      type: "DDR5", speed: 6000, channels: 2, history: hist(60, 45, 15),
    }),
    label: () => "物理内存",
    tag: (m) => m.type || "",
    pct: (m) => memPct(m),
    big: (m) => { const p = memPct(m); return p == null ? null : [p.toFixed(1), "%", usageColor(p)]; },
    bars: [
      { k: "已用", pct: (m) => memPct(m), text: (m) => (m.used == null ? null : gbTxt(m.used) + " GB"), color: (m) => { const p = memPct(m); return p == null ? null : usageColor(p); } },
      { k: "缓存", pct: (m) => (m.cache == null || !m.total ? null : (m.cache / m.total) * 100), text: (m) => (m.cache == null ? null : gbTxt(m.cache) + " GB"), color: () => "#bc8cff" },
      { k: "Swap", pct: (m) => (m.swapUsed == null || !m.swapTotal ? null : (m.swapUsed / m.swapTotal) * 100), text: (m) => (m.swapUsed == null || m.swapTotal == null ? null : gbTxt(m.swapUsed) + " / " + gbTxt(m.swapTotal) + " GB"), color: () => "#d29922" },
    ],
    // 通道数一次快照取不到，那是"内存控制器怎么接的"；能取到的是**条数**，所以实测那台给条数、不给通道。
    foot: [
      { k: "可用", text: (m) => { const v = memFreeGb(m); return v == null ? null : gbTxt(v) + " GB"; } },
      { k: "通道", text: (m) => (m.live ? null : m.channels === 2 ? "双通道" : m.channels + " 通道") },
      { k: "条数", text: (m) => (m.live && m.modules != null ? m.modules + " 条" : null) },
    ],
    stats: (its) => {
      const m = its[0];
      const p = memPct(m);
      const uc = m.used == null ? null : m.used + (m.cache || 0);
      return [
        { k: "使用率", v: p == null ? null : p.toFixed(1), u: "%", color: p == null ? null : usageColor(p) },
        { k: "已用+缓存", v: uc == null ? null : gbTxt(uc), u: "GB" },
        { k: "Swap", v: m.swapUsed == null || !m.swapTotal ? null : ((m.swapUsed / m.swapTotal) * 100).toFixed(0), u: "%" },
        { k: "总计", v: m.total == null ? null : gbTxt(m.total, 0) + " GB", sm: true },
      ];
    },
    real: (st, d) => {
      const f = d.frame;
      if (!f || !f.memTotalMb) return;
      const pct = (f.memUsedMb / f.memTotalMb) * 100;
      st[0].v = pct.toFixed(1);
      st[0].color = usageColor(pct);
      st[3].v = Math.round(f.memTotalMb / 1024) + " GB";
    },
    detail: (m) => [
      { k: "规格", v: m.type ? m.type + (m.speed == null ? "" : " · " + m.speed + " MHz") : null },
      { k: "容量", v: m.used == null || m.total == null ? null : gbTxt(m.used) + " / " + gbTxt(m.total) + " GB" },
      { k: "Swap", v: m.swapUsed == null || m.swapTotal == null ? null : gbTxt(m.swapUsed) + " / " + gbTxt(m.swapTotal) + " GB" },
    ],
    step: (m, t) => {
      m.used = clampv(m.used + (clampv(m.total * (0.42 + Math.sin(t / 6) * 0.18 + Math.random() * 0.06), m.total * 0.15, m.total * 0.92) - m.used) * 0.08, 1, m.total - 2);
      m.cache += (clampv(m.total * (0.16 + Math.sin(t / 9) * 0.06), 0.5, m.total * 0.35) - m.cache) * 0.06;
      m.swapUsed = clampv(m.swapUsed + (Math.random() - 0.5) * 0.06, 0, m.swapTotal);
      pushHist(m.history, (m.used / m.total) * 100);
    },
    history: (m) => m.history,
    histColor: (m) => { const p = memPct(m); return p == null ? "#58a6ff" : usageColor(p); },
  },

  gpu: {
    title: "显卡", unit: "张", count: (hw) => hw.gpus,
    make: (i) => {
      const name = GPU_NAMES[i % GPU_NAMES.length];
      const memTotal = name.indexOf("4080") >= 0 ? 16 : 24;
      const base = 15 + Math.random() * 25;
      return {
        id: i, name, vendor: name.split(" ")[0], memTotal, memUsed: memTotal * 0.3, usage: base,
        temp: 42 + Math.random() * 8, power: 120, powerLimit: 450, fan: 40,
        coreClock: 2150, history: hist(60, base, 15),
      };
    },
    // 实测那台的卡片抬头直接写型号（用户第 5 条："显卡 一张 需要型号"）；
    // 只从 WMI/lspci 拿到名字、没有 nvidia-smi 指标的那几张，指标位留空 —— 型号是真的，利用率不编。
    label: (g) => (g.live && g.short ? g.short : "GPU " + g.id),
    tag: (g) => g.vendor || "",
    tagCls: (g) => (g.vendor === "NVIDIA" ? "p" : g.vendor === "Intel" ? "e" : ""),
    pct: (g) => g.usage,
    big: (g) => (g.usage == null ? null : [g.usage.toFixed(0), "%", usageColor(g.usage)]),
    bars: [
      { k: "核心", pct: (g) => g.usage, text: (g) => (g.usage == null ? null : g.usage.toFixed(0) + "%"), color: (g) => (g.usage == null ? null : usageColor(g.usage)) },
      { k: "显存", pct: (g) => (g.memUsed == null || !g.memTotal ? null : (g.memUsed / g.memTotal) * 100), text: (g) => (g.memUsed == null || g.memTotal == null ? null : gbTxt(g.memUsed) + " / " + gbTxt(g.memTotal) + " GB"), color: () => "#58a6ff" },
      { k: "功耗", pct: (g) => (g.power == null || !g.powerLimit ? null : (g.power / g.powerLimit) * 100), text: (g) => (g.power == null ? null : g.power.toFixed(0) + " W"), color: () => "#d29922" },
    ],
    foot: [
      { k: "温度", text: (g) => (g.temp == null ? null : g.temp.toFixed(0) + "°C"), color: (g) => (g.temp == null ? null : tempColor(g.temp)) },
      { k: "风扇", text: (g) => (g.fan == null ? null : g.fan.toFixed(0) + "%") },
      { k: "核心频率", text: (g) => (g.coreClock == null ? null : g.coreClock.toFixed(0) + " MHz") },
      { k: "驱动", text: (g) => (g.live && g.driver ? g.driver : null) },
    ],
    stats: (its) => {
      const us = its.map((g) => g.usage).filter((v) => Number.isFinite(v));
      const ts = its.map((g) => g.temp).filter((v) => Number.isFinite(v));
      const ps = its.map((g) => g.power).filter((v) => Number.isFinite(v));
      const mt = its.reduce((a, g) => a + (g.memUsed != null ? g.memUsed : 0), 0);
      const mc = its.some((g) => g.memUsed != null && g.memTotal != null);
      const avg = avgOf(us);
      return [
        { k: "平均使用率", v: avg == null ? null : avg.toFixed(1), u: "%", color: avg == null ? null : usageColor(avg) },
        { k: "最高温度", v: ts.length ? Math.max(...ts).toFixed(0) : null, u: "°C", color: ts.length ? tempColor(Math.max(...ts)) : null },
        { k: "总功耗", v: ps.length ? ps.reduce((a, b) => a + b, 0).toFixed(0) : null, u: "W" },
        { k: "显存", v: mc ? gbTxt(mt) + " / " + gbTxt(its.reduce((a, g) => a + (g.memTotal != null ? g.memTotal : 0), 0)) : null, u: "GB", sm: true },
      ];
    },
    detail: (g) => [
      { k: "型号", v: g.name || null },
      { k: "显存", v: g.memUsed == null || g.memTotal == null ? null : gbTxt(g.memUsed) + " / " + gbTxt(g.memTotal) + " GB" },
      { k: "功耗墙", v: g.powerLimit == null ? null : g.powerLimit + " W" },
      { k: "驱动", v: g.driver || null },
    ],
    step: (g, t, i) => {
      const w = (Math.sin(t * 0.55 + i * 1.7) + 1) / 2;
      const spike = Math.random() < 0.04 ? 25 : 0;
      g.usage = clampv(g.usage + (clampv(15 + w * 55 + spike + Math.random() * 12, 0, 100) - g.usage) * 0.25, 0, 100);
      g.memUsed += (clampv(g.memTotal * (0.25 + (g.usage / 100) * 0.5 + Math.random() * 0.08), 0.5, g.memTotal) - g.memUsed) * 0.15;
      g.temp += (38 + g.usage * 0.42 - g.temp) * 0.08;
      g.power += (70 + (g.usage / 100) * (g.powerLimit - 70) - g.power) * 0.15;
      g.fan += ((g.usage > 60 ? 76 : 41) - g.fan) * 0.08;
      g.coreClock += (1800 + (g.usage / 100) * 700 + Math.random() * 50 - g.coreClock) * 0.1;
      pushHist(g.history, g.usage);
    },
    history: (g) => g.history,
    histColor: (g) => (g.usage == null ? "#58a6ff" : usageColor(g.usage)),
  },

  disk: {
    title: "磁盘 I/O", unit: "块", count: (hw) => hw.disks,
    // 实测那台摆的是**卷**（一个挂载点一张卡），抬头就不能再写 "2 块" 了 —— 抬头是给"摆了几张"计数的，
    // 摆的是卷就说卷、退回物理盘就说盘；模拟那台照旧走 items.length + unit。
    sub: (its) => (its.length && its[0].live
      ? (its[0].vol != null ? its.length + " 个卷" : its.length + " 块物理盘")
      : its.length + " 块"),
    make: (i) => {
      const d = DISK_NAMES[i % DISK_NAMES.length];
      return Object.assign({ id: i }, d, {
        used: d.total * (0.25 + Math.random() * 0.45), readSpeed: 8, writeSpeed: 5,
        busy: 5, temp: 40, latency: 0.1, history: hist(60, 8, 15),
      });
    },
    // 用户第 7 条："磁盘信息也不对"。实测那台显示的是**卷**（D:\、/ 这种挂载点 + 容量 + 类型），
    // 型号 WMI/df 给得出就写，给不出就写挂载点；没有卷的机器退回整块物理盘。
    label: (d) => diskName(d),
    tag: (d) => d.type || "",
    tagCls: (d) => (d.type === "NVMe" ? "p" : d.type === "HDD" ? "" : "e"),
    pct: (d) => d.busy,
    big: (d) => (d.busy == null ? null : [d.busy.toFixed(0), "%", usageColor(d.busy)]),
    // 读/写这两条只给模拟那台：实测只有字节/秒这一个真数，没有标称速率可当分母，
    // 拿一个假分母去画进度条就是编。实测那台把读/写挪到下面的 foot 里，只报数、不画比例。
    bars: [
      { k: "读", pct: (d) => (d.live || !d.maxRead ? null : (d.readSpeed / d.maxRead) * 100), text: (d) => (d.live || d.readSpeed == null ? null : fmtSpeed(d.readSpeed).join(" ")), color: () => "#4f8cff" },
      { k: "写", pct: (d) => (d.live || !d.maxWrite ? null : (d.writeSpeed / d.maxWrite) * 100), text: (d) => (d.live || d.writeSpeed == null ? null : fmtSpeed(d.writeSpeed).join(" ")), color: () => "#6fd39a" },
      { k: "容量", pct: (d) => (d.used == null || !d.total ? null : (d.used / d.total) * 100), text: (d) => (d.used == null || d.total == null ? null : gbTxt(d.used, 0) + " / " + gbTxt(d.total, 0) + " GB"), color: (d) => { const p = d.used != null && d.total ? (d.used / d.total) * 100 : null; return p == null ? null : usageColor(p); } },
    ],
    foot: [
      { k: "读", text: (d) => (d.live && d.readSpeed != null ? fmtSpeed(d.readSpeed).join(" ") : null) },
      { k: "写", text: (d) => (d.live && d.writeSpeed != null ? fmtSpeed(d.writeSpeed).join(" ") : null) },
      { k: "剩余", text: (d) => (d.live && d.free != null ? gbTxt(d.free, 0) + " GB" : null) },
      { k: "温度", text: (d) => (d.temp == null ? null : d.temp.toFixed(0) + "°C"), color: (d) => (d.temp == null ? null : tempColor(d.temp)) },
      { k: "延迟", text: (d) => (d.latency == null ? null : d.latency.toFixed(2) + " ms") },
      { k: "使用率", text: (d) => (!d.live && d.busy != null ? d.busy.toFixed(0) + "%" : null) },
    ],
    stats: (its) => {
      const rd = its.map((d) => d.readSpeed).filter((v) => Number.isFinite(v));
      const wr = its.map((d) => d.writeSpeed).filter((v) => Number.isFinite(v));
      const bu = its.map((d) => d.busy).filter((v) => Number.isFinite(v));
      const ts = its.map((d) => d.temp).filter((v) => Number.isFinite(v));
      const hot = bu.length ? its[its.map((d) => d.busy).indexOf(Math.max(...bu))] : null;
      const total = rd.length || wr.length ? fmtSpeed(rd.reduce((a, b) => a + b, 0)) : null;
      const totalW = rd.length || wr.length ? fmtSpeed(wr.reduce((a, b) => a + b, 0)) : null;
      // 实测那台的 busy 其实是**容量占用率**（一次快照给不出 IO 忙率），叫"最忙盘"就是挂错牌子了
      const live = !!(its[0] && its[0].live);
      return [
        { k: "总读", v: total ? total[0] : null, u: total ? total[1] : "" },
        { k: "总写", v: totalW ? totalW[0] : null, u: totalW ? totalW[1] : "" },
        { k: live ? "占用最高" : "最忙盘", v: hot ? diskName(hot) + " · " + hot.busy.toFixed(0) + "%" : null, sm: true },
        { k: "最热盘", v: ts.length ? Math.max(...ts).toFixed(0) : null, u: "°C", color: ts.length ? tempColor(Math.max(...ts)) : null },
      ];
    },
    detail: (d) => [
      { k: "型号", v: d.name || null },
      { k: "容量", v: d.used == null || d.total == null ? null : gbTxt(d.used, 0) + " / " + gbTxt(d.total, 0) + " GB" },
      { k: "剩余", v: d.free == null ? null : gbTxt(d.free, 0) + " GB" },
      { k: "挂载", v: d.live && d.vol ? d.vol : null },
      { k: "设备", v: d.live && d.part && d.part !== d.vol ? d.part : null },
      { k: "文件系统", v: d.live && d.fs ? d.fs : null },
      { k: "总线", v: d.live && d.bus ? d.bus : null },
      { k: "标称", v: !d.live && d.maxRead ? "读 " + d.maxRead + " · 写 " + d.maxWrite + " MB/s" : null },
    ],
    step: (d, t, i) => {
      const w = (Math.sin(t * 0.8 + i * 1.3) + 1) / 2;
      const burst = Math.random() < 0.06 ? 0.5 + Math.random() * 0.5 : 0;
      d.readSpeed += (clampv(d.maxRead * (0.02 + w * 0.15 + burst * 0.6 + Math.random() * 0.08), 0, d.maxRead) - d.readSpeed) * 0.4;
      d.writeSpeed += (clampv(d.maxWrite * (0.02 + (1 - w) * 0.12 + burst * 0.5 + Math.random() * 0.06), 0, d.maxWrite) - d.writeSpeed) * 0.4;
      d.busy += (clampv((d.readSpeed / d.maxRead) * 60 + (d.writeSpeed / d.maxWrite) * 60 + 2, 0.5, 100) - d.busy) * 0.3;
      d.latency += (0.03 + (d.busy / 100) * 0.6 + Math.random() * 0.05 - d.latency) * 0.15;
      d.temp += (35 + (d.busy / 100) * 28 + Math.random() * 2 - d.temp) * 0.06;
      pushHist(d.history, d.busy);
    },
    history: (d) => d.history,
    histColor: (d) => (d.busy == null ? "#58a6ff" : usageColor(d.busy)),
  },

  net: {
    title: "网络", unit: "张网卡", count: (hw) => hw.nics,
    make: (i) => Object.assign({ id: i }, NIC_NAMES[i % NIC_NAMES.length], {
      up: true, downSpeed: 4, upSpeed: 1.2, totalRx: 400, totalTx: 120,
      dropped: 0, errors: 0, latency: 3,
      downHistory: hist(60, 4, 6), upHistory: hist(60, 1.5, 3),
    }),
    label: (n) => n.name || null,
    tag: (n) => n.type || "",
    pct: (n) => (n.downSpeed == null || !n.link ? null : (n.downSpeed / (n.link / 8)) * 100),
    big: (n) => (n.downSpeed == null ? null : fmtSpeed(n.downSpeed).concat("#4f8cff")),
    bars: [
      { k: "↓ 下行", pct: (n) => (n.downSpeed == null || !n.link ? null : (n.downSpeed / (n.link / 8)) * 100), text: (n) => (n.downSpeed == null ? null : fmtSpeed(n.downSpeed).join(" ")), color: () => "#4f8cff" },
      { k: "↑ 上行", pct: (n) => (n.upSpeed == null || !n.link ? null : (n.upSpeed / (n.link / 8)) * 100), text: (n) => (n.upSpeed == null ? null : fmtSpeed(n.upSpeed).join(" ")), color: () => "#6fd39a" },
    ],
    // 实测那台的"累计流量 / 丢包 / 延迟"一次快照拿不到（要 /proc/net/snmp 或计数器差），
    // 换成真的量得到的三样：链路速率、IP/MAC、当前上下行速率。
    foot: [
      { k: "累计", text: (n) => (n.live ? null : (n.totalRx + n.totalTx).toFixed(1) + " GB") },
      { k: "丢包", text: (n) => (n.live ? null : String(n.dropped + n.errors)) },
      { k: "延迟", text: (n) => (n.live ? null : n.latency.toFixed(1) + " ms") },
      { k: "链路", text: (n) => (!n.live || !n.link ? null : (n.link / 1000).toFixed(1) + " Gbps") },
      { k: "地址", text: (n) => (n.live && n.ip ? n.ip : null) },
      { k: "MAC", text: (n) => (n.live && n.mac ? n.mac : null) },
    ],
    spark: (n) => [[n.downHistory, "#4f8cff"], [n.upHistory, "#6fd39a"]],
    stats: (its) => {
      const live = !!(its[0] && its[0].live);
      const ds = its.map((n) => n.downSpeed).filter((v) => Number.isFinite(v));
      const us = its.map((n) => n.upSpeed).filter((v) => Number.isFinite(v));
      const fd = ds.length ? fmtSpeed(ds.reduce((a, b) => a + b, 0)) : null;
      const fu = us.length ? fmtSpeed(us.reduce((a, b) => a + b, 0)) : null;
      const up = its.filter((n) => n.up).length;
      const lat = its.map((n) => n.latency).filter((v) => Number.isFinite(v));
      return [
        { k: "总下行", v: fd ? fd[0] : null, u: fd ? fd[1] : "", color: "#4f8cff" },
        { k: "总上行", v: fu ? fu[0] : null, u: fu ? fu[1] : "", color: "#6fd39a" },
        { k: "在线", v: up + " / " + its.length, sm: true },
        live
          ? { k: "链路合计", v: (its.reduce((a, n) => a + (n.link || 0), 0) / 1000).toFixed(1), u: "Gbps" }
          : { k: "最高延迟", v: lat.length ? Math.max(...lat).toFixed(1) : null, u: "ms" },
      ];
    },
    detail: (n) => [
      { k: "链路", v: n.link ? (n.link / 1000).toFixed(1) + " Gbps" : null },
      { k: "累计", v: n.live ? null : "↓ " + n.totalRx.toFixed(1) + " · ↑ " + n.totalTx.toFixed(1) + " GB" },
      { k: "错包", v: n.live ? null : "丢 " + n.dropped + " · 错 " + n.errors },
      { k: "地址", v: n.live && n.ip ? n.ip : null },
      { k: "MAC", v: n.live && n.mac ? n.mac : null },
      { k: "驱动", v: n.live && n.desc ? n.desc : null },
    ],
    step: (n, t, i) => {
      const w = (Math.sin(t * 0.6 + i * 2.1) + 1) / 2;
      const burst = Math.random() < 0.05 ? 3 + Math.random() * 8 : 0;
      n.downSpeed += (clampv(0.5 + w * 12 + burst + Math.random() * 2, 0, 125) - n.downSpeed) * 0.35;
      n.upSpeed += (clampv(0.2 + w * 4 + burst * 0.3 + Math.random(), 0, 60) - n.upSpeed) * 0.35;
      n.totalRx += (n.downSpeed / 1024) * 0.8;
      n.totalTx += (n.upSpeed / 1024) * 0.8;
      n.latency += (1 + Math.random() * 8 - n.latency) * 0.05;
      if (Math.random() < 0.01) n.dropped += 1;
      pushHist(n.downHistory, n.downSpeed);
      pushHist(n.upHistory, n.upSpeed);
    },
    history: (n) => n.downHistory,
    histColor: () => "#4f8cff",
  },
};
const PANEL_ORDER = ["cpu", "mem", "gpu", "disk", "net"];

// ---------- 通用渲染 ----------

const perfEl = document.getElementById("perf");
const perfName = document.getElementById("perfName");
const perfSub = document.getElementById("perfSub");
const perfBody = document.getElementById("perfBody");
const perfGrip = document.getElementById("perfGrip");
const perfPause = document.getElementById("perfPause");
const OFF = "—";
let perfDev = null;
let perfPaused = false;
const views = {};
const picked = {};


function isHeat(key) { return views[key] === "heat"; }
function pickedItem(key) { return picked[key] ? picked[key].item : null; }

function buildCard(key, rs, item) {
  const card = el("div", "core" + (rs.dense ? "" : " wide"));
  const tg = el("span", "ctag" + (rs.tagCls && rs.tagCls(item) ? " " + rs.tagCls(item) : ""), rs.tag ? rs.tag(item) || "" : "");
  const head = el("div", "chead");
  head.append(el("span", "cname", rs.label(item)), tg);
  const bigT = document.createTextNode("—");
  const bigU = el("span", "u");
  const bigB = el("b");
  bigB.append(bigT);
  const bigRow = el("div", "bigno");
  bigRow.append(bigB, bigU);
  // 实测项里"取不到"的那一行（pct 和文字都是 null）整行不建 —— 空进度条比没有更难懂。
  // 建完就把筛出来的定义留在 item._ 上，paintCard 按同一份定义画，两边不会错位。
  const barDefs = rs.bars.filter((bd) => bd.pct(item) != null || bd.text(item) != null);
  const bars = barDefs.map((bd) => {
    const i = el("i");
    const bar = el("div", "bar");
    bar.append(i);
    const v = el("span", "v");
    const row = el("div", "io");
    row.append(el("span", "k", typeof bd.k === "function" ? bd.k(item) : bd.k), bar, v);
    card.append(row);
    return { i, bar, v };
  });
  const footDefs = rs.foot.filter((fd) => fd.text(item) != null);
  const foot = el("div", "sub2");
  const footRefs = footDefs.map((fd) => {
    const b = el("b");
    const s = el("span", null, fd.k + " ");
    s.append(b);
    foot.append(s);
    return b;
  });
  // 实测那台没有历史（一次快照给不出曲线），spark 会返回空数组 —— 那就别建那个空盒子占位
  let sp = null;
  if (rs.spark && rs.spark(item).some(([vals]) => vals && vals.length > 1)) { sp = el("div", "miniSpark"); card.append(sp); }
  card.append(foot);
  card.prepend(head, bigRow);
  card.addEventListener("click", () => { pickCard(key, item); });
  item._ = { card, bigT, bigU, bars, barDefs, footRefs, footDefs, sp, tg };
  return card;
}

function pickCard(key, item) {
  const same = picked[key] && picked[key].item === item;
  picked[key] = same ? null : { item };
  paintPanel(false);
}

function buildItems(key) {
  const rs = RES[key];
  const grid = rs.ui.grid;
  grid.textContent = "";
  for (const it of rs.items) {
    if (isHeat(key)) {
      const cell = el("div", "hc", it.id != null ? String(it.id) : "");
      cell.title = rs.label(it);
      cell.addEventListener("click", () => pickCard(key, it));
      it._ = { cell };
      grid.append(cell);
    } else {
      grid.append(buildCard(key, rs, it));
    }
  }
}

function buildSection(key, d) {
  const rs = RES[key];
  if (!views[key]) views[key] = "card";
  picked[key] = null;
  const sect = el("div", "sect");
  const cnt = el("span", "cname");
  const src = el("span", "chip sim", "模拟");
  const head = el("div", "shead");
  head.append(el("span", "sname", rs.title), cnt, src);
  if (rs.heat) {
    const bCard = el("button", "vbtn mini" + (views[key] === "card" ? " on" : ""), "卡片");
    const bHeat = el("button", "vbtn mini" + (views[key] === "heat" ? " on" : ""), "热力图");
    bCard.type = bHeat.type = "button";
    bCard.addEventListener("click", () => { views[key] = "card"; bCard.classList.add("on"); bHeat.classList.remove("on"); buildItems(key); paintPanel(false); });
    bHeat.addEventListener("click", () => { views[key] = "heat"; bHeat.classList.add("on"); bCard.classList.remove("on"); buildItems(key); paintPanel(false); });
    head.append(el("span", "grow"), bCard, bHeat);
  }
  const stats = el("div", "cstat");
  const statRefs = rs.stats ? rs.stats(rs.items, d).map((s) => {
    const t = document.createTextNode(OFF);
    const v = el("div", "v" + (s.sm ? " sm" : ""));
    v.append(t, el("span", "u", ""));
    const box = el("div");
    box.append(el("div", "k", s.k), v);
    stats.append(box);
    return { t, v, u: v.lastChild };
  }) : [];
  const grid = el("div", "grid" + (rs.dense ? " dense" : " solo"));
  const sum = rs.summary ? el("div", "sumbar") : null;
  const detail = el("div", "drk");
  detail.hidden = true;
  sect.append(head, stats, grid);
  if (sum) sect.append(sum);
  sect.append(detail);
  rs.ui = { cnt, src, statRefs, grid, sum, detail, sumRefs: null };
  if (sum) rs.ui.sumRefs = bindSum(rs);
  buildItems(key);
  return sect;
}

function bindSum(rs) {
  const s = rs.ui.sum;
  const refs = {};
  s.append(el("span", "t", "整体"));
  for (const [k, label, unit] of [["avg", "平均", "%"], ["max", "最高", "%"], ["min", "最低", "%"], ["balance", "负载均衡度", ""]]) {
    const wrap = el("span", null, label + " ");
    const b = el("b", null, OFF);
    refs[k] = b;
    wrap.append(b);
    if (k === "max") { const i2 = el("i"); refs.maxCore = i2; wrap.append(document.createTextNode(unit), i2); }
    else wrap.append(document.createTextNode(unit));
    s.append(wrap);
  }
  return refs;
}

function paintCard(key, rs, it, on) {
  const u = it._;
  if (!u) return;
  const sel = !!(pickedItem(key) === it);
  if (u.cell) {
    const p = rs.pct(it);
    u.cell.style.background = on && p != null ? usageColor(p) : "#21262d";
    u.cell.style.opacity = on && p != null ? (0.4 + (p / 100) * 0.6).toFixed(2) : "0.5";
    u.cell.classList.toggle("sel", sel);
    return;
  }
  u.card.classList.toggle("sel", sel);
  u.card.style.opacity = on ? "1" : ".5";
  const raw = on ? rs.big(it) : null;
  const big = raw || [OFF, ""];
  u.bigT.textContent = big[0];
  u.bigU.textContent = big[1];
  u.bigT.parentNode.style.color = on && big[2] ? big[2] : "";
  u.barDefs.forEach((bd, i) => {
    const r = u.bars[i];
    const p = on ? bd.pct(it) : null;
    if (p == null) { r.i.style.width = "0%"; r.i.style.background = "transparent"; }
    else { r.i.style.width = clampv(p, 0, 100).toFixed(1) + "%"; r.i.style.background = (bd.color && bd.color(it)) || "#58a6ff"; }
    const tx = on ? bd.text(it) : null;
    r.v.textContent = tx == null ? OFF : tx;
  });
  u.footDefs.forEach((fd, i) => {
    const t = u.footRefs[i];
    const tx = on ? fd.text(it) : null;
    t.textContent = tx == null ? OFF : tx;
    t.style.color = on && tx != null && fd.color ? (fd.color(it) || "") : "";
  });
  if (u.tg && rs.tagCls) u.tg.className = "ctag" + (rs.tagCls(it) ? " " + rs.tagCls(it) : "");
  if (u.sp && rs.spark) u.sp.innerHTML = on ? rs.spark(it).map(([v, c]) => sparkSvg(v, c, 26)).join("") : "";
}

function paintDetail(key, rs, on) {
  const d = rs.ui.detail;
  const sel = pickedItem(key);
  if (!sel || !on) { d.hidden = true; d.textContent = ""; return; }
  // 取不到的字段不摆一行"—"：那一行直接不出现，留下的都是这一台真报上来的
  const rows = (rs.detail ? rs.detail(sel) : []).filter((r) => r.v != null);
  const ths = rs.threads ? rs.threads(sel) : [];
  const wave = sparkSvg(rs.history(sel) || [], rs.histColor(sel), 42);
  if (!wave && !rows.length && !ths.length) { d.hidden = true; d.textContent = ""; return; }
  d.hidden = false;
  d.innerHTML = wave
    + rows.map((r) => '<div class="drow"><span>' + r.k + "</span><b" + (r.color ? ' style="color:' + r.color + '"' : "") + ">" + r.v + "</b></div>").join("")
    + ths.map((t) => '<div class="thr"><span>' + t.k + '</span><div class="bar"><i style="width:'
      + clampv(t.pct, 0, 100).toFixed(1) + "%;background:" + t.color + '"></i></div><span class="tv">' + t.text + "</span></div>").join("");
}

function paintPanel(advance) {
  if (!perfDev) return;
  const on = perfDev.power;
  const t = Date.now() / 1000;
  perfSub.textContent = tierOf(perfDev.tier).label + " · " + (on ? (perfPaused ? "已暂停" : "采集中") : "已关机");
  for (const key of PANEL_ORDER) {
    const rs = RES[key];
    if (!rs.items.length) continue;   // 这台没这个概念（交换机没有 CPU/内存/磁盘）→ 这节压根没建
    // 实测那台的数来自探针那一帧，不是本地游走：its 上带 live 的就别 step，否则真数会被假数盖掉。
    if (advance && on && !perfPaused) rs.items.forEach((it, i) => { if (!it.live) rs.step(it, t, i); });
    rs.ui.cnt.textContent = rs.sub ? rs.sub(rs.items, perfDev) : rs.items.length + " " + rs.unit;
    const tag2 = srcOf(key, perfDev);
    rs.ui.src.textContent = tag2.t;
    rs.ui.src.className = "chip " + tag2.c;
    if (rs.stats) {
      const st = on ? rs.stats(rs.items, perfDev) : [];
      if (on && rs.real) rs.real(st, perfDev);
      rs.ui.statRefs.forEach((ref, i) => {
        const s = st[i];
        const has = !!(s && s.v != null && s.v !== "");
        ref.t.textContent = has ? s.v : OFF;
        ref.u.textContent = has ? s.u || "" : "";
        ref.v.style.color = has && s.color ? s.color : "";
      });
    }
    for (const it of rs.items) paintCard(key, rs, it, on);
    if (rs.summary) {
      const r = rs.ui.sumRefs;
      const us = rs.items.map((it) => rs.pct(it)).filter((v) => Number.isFinite(v));
      if (!on || !us.length) { for (const k in r) r[k].textContent = k === "maxCore" ? "" : OFF; }
      else {
        const avg = mean(us), max = Math.max(...us), min = Math.min(...us);
        const hot = rs.items[rs.items.findIndex((it) => rs.pct(it) === max)];
        const sd = Math.sqrt(mean(us.map((v) => (v - avg) ** 2)));
        r.avg.textContent = avg.toFixed(1);
        r.max.textContent = max.toFixed(0);
        r.maxCore.textContent = " (" + rs.label(hot) + ")";
        r.min.textContent = min.toFixed(0);
        r.balance.textContent = (clampv(1 - sd / Math.max(avg, 1), 0, 1) * 100).toFixed(0) + "%";
      }
    }
    paintDetail(key, rs, on);
  }
}

// 一台机器"该建哪几节"由硬件数决定：填 0 的那节不建（交换机没有 CPU / 内存 / 磁盘，
// 路由器没有磁盘 / 显卡，NAS 没有显卡）。用签名比对决定要不要重建，
// 免得每一拍都把整块面板重做一遍 —— 那会把用户点开的卡片选中态冲掉。
function panelKeys(d) {
  const hw = hwOf(d);
  return PANEL_ORDER.filter((k) => RES[k].count(hw) > 0);
}
function panelSig(d) {
  const hw = hwOf(d);
  // 帧的时间戳也算进签名：同一台机器前后两帧里卷/网卡的条数会变，签名变了才会重做面板。
  return panelKeys(d).join(",") + "|" + [hw.cores, hw.gpus, hw.disks, hw.nics, hw.mem].join(",") + "|" + (d.frame ? d.frame.at : "-");
}
let panelSigNow = "";

function buildPanel(d) {
  perfName.textContent = d.short;
  perfBody.textContent = "";
  const hw = hwOf(d);
  const frame = liveOf(d) && d.frame ? d.frame : null;
  panelSigNow = panelSig(d);
  let built = 0;
  for (const key of PANEL_ORDER) {
    const rs = RES[key];
    rs.items = frame ? LIVE[key](frame) : Array.from({ length: rs.count(hw) }, (_, i) => rs.make(i, hw));
    if (!rs.items.length) { rs.ui = null; continue; }   // 这节不建，也别留下一次的旧 DOM 引用
    perfBody.append(buildSection(key, d));
    built++;
  }
  // 一节都没建起来 —— 面板不能是一片空白，得说清楚是"没填地址"还是"还没抓到帧"
  if (!built) {
    perfBody.append(el("div", "pnote", !liveOf(d)
      ? "这台没填地址：只摆位置，不抓数"
      : d.probeErr ? "这台抓不到：" + d.probeErr
        : "还没抓到这台的帧：双击这一下已经当场去抓了，那一帧还没回来。"
          + "之后每 " + Math.round(MONITOR_SETTINGS.probeEveryMs / 1000) + " 秒自动抓一轮（设置 → 采集频率）"));
  }
}

function showPerf(d) {
  perfDev = d;
  buildPanel(d);
  perfEl.hidden = false;
  paintPanel(false);
}
function hidePerf() {
  perfDev = null;
  perfEl.hidden = true;
}
function refreshPerfHead() {
  if (!perfDev) return;
  perfName.textContent = perfDev.short;
  if (panelSig(perfDev) !== panelSigNow) buildPanel(perfDev);
  paintPanel(false);
}
perfPause.type = "button";
perfPause.addEventListener("click", () => {
  perfPaused = !perfPaused;
  perfPause.textContent = perfPaused ? "继续" : "暂停";
  perfPause.classList.toggle("on", perfPaused);
  paintPanel(false);
});

// 面板宽度可拖：按住左缘竖柄左右拖，宽度记进 localStorage，刷新还在
const W_KEY = "hm.perf.width2";
const W_MIN = 288;
const W_MAX = 620;
function clampWidth(w) {
  return Math.round(clampv(w, W_MIN, Math.min(W_MAX, window.innerWidth - 40)));
}
function setWidth(w) {
  const v = clampWidth(w);
  perfEl.style.width = v + "px";
  try { localStorage.setItem(W_KEY, String(v)); } catch (e) { /* 隐私模式忽略 */ }
}
// 默认给到上限；拖过之后才用记住的值。默认值只写样式不落盘，这样以后改上限没拖过的人能跟着变。
// 键名带 2：上一版留下的 288 是自测拖拽留下的，不该盖掉新默认。
let savedW = 0;
try { savedW = Number(localStorage.getItem(W_KEY)) || 0; } catch (e) { /* 同上 */ }
perfEl.style.width = clampWidth(savedW >= W_MIN ? savedW : W_MAX) + "px";
perfGrip.addEventListener("pointerdown", (e) => {
  e.preventDefault();
  perfEl.classList.add("dragging");
  // 拖动手感靠 window 级监听：指针跑得快离开那条 10 px 的柄也不会断，也不用 setPointerCapture
  const move = (ev) => setWidth(window.innerWidth - 12 - ev.clientX);
  const done = () => {
    perfEl.classList.remove("dragging");
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", done);
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", done);
});

// ---------- 采集节拍：设置里"采集频率"那一格改的就是它 ----------
// 一个定时器同时驱动两处：右侧看板的数值游走、每台设备"负载 → 脉冲分级"的判定。
// 放同一个定时器是刻意的 —— 否则会出现面板已经换新、脚下脉冲还挂在旧状态上。
// 真值在 src/model.mjs 的 MONITOR_SETTINGS，这里只负责"启动时从 localStorage 恢复"和"改完通知写盘"。
// 两格一起恢复（probeEveryMs 那格管"多久抓一帧"，定时器长在页面）。
try {
  const saved = JSON.parse(localStorage.getItem(MS_KEY) || "{}");
  for (const k of ["intervalMs", "probeEveryMs"]) {
    if (!Number.isFinite(saved[k])) continue;
    const lim = MON_LIMITS[k];
    MONITOR_SETTINGS[k] = clampv(Math.round(saved[k] / lim[2]) * lim[2], lim[0], lim[1]);
  }
} catch (e) { /* 读不到就用默认值 */ }

// liveCpu 也一并 export：原型自检钩子 __hm().cpuCardsOf(一份合成帧) 要用它核对
// "混合架构那台到底并成了几张卡"，不必守着一台真混合架构机器在线才验得了（正常运行没人调它）。
export { framePct, nicsOf, liveCpu, perfEl, perfName, perfSub, perfBody, perfGrip, perfPause, perfDev, paintPanel, showPerf, hidePerf, refreshPerfHead, W_MIN, W_MAX, clampWidth, savedW };
