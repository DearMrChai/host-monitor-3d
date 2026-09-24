// 读数换算层：一个数怎么变成屏上那行字，全页只有这一份口径。
// 这层刻意零依赖 —— 不碰 DOM、不碰 THREE、不碰状态，所以 node 里也能直接 import 来量。
// 从页面里搬出来的（T5-4 刀1，2026-09-24），函数体一字未改。
function fmt(v) { const r = Math.round(v * 10) / 10; return Number.isInteger(r) ? String(r) : r.toFixed(1); }

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

const clampv = (v, a, b) => Math.min(b, Math.max(a, v));
const usageColor = (p) => "hsl(" + Math.round(145 - (p / 100) * 145) + " 72% 50%)";
const tempColor = (t) => "hsl(" + Math.round(195 - clampv((t - 40) / 50, 0, 1) * 195) + " 80% 55%)";
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
// MB/s 进，带单位出（参考里的 fmtSpeed）
function fmtSpeed(mbps) {
  if (mbps < 0.01) return ["0", "B/s"];
  if (mbps < 1) return [(mbps * 1024).toFixed(0), "KB/s"];
  if (mbps < 1024) return [mbps.toFixed(1), "MB/s"];
  return [(mbps / 1024).toFixed(2), "GB/s"];
}

const hhmm = (iso) => {
  const t = new Date(iso);
  return isNaN(t) ? "" : String(t.getHours()).padStart(2, "0") + ":" + String(t.getMinutes()).padStart(2, "0");
};
const gbOfBytes = (b) => (typeof b === "number" && b > 0 ? b / 1073741824 : null);
const mbOfBytes = (b) => (typeof b === "number" && b >= 0 ? b / 1048576 : null);
const gbOfMb = (mb) => (typeof mb === "number" && mb > 0 ? mb / 1024 : null);
const avgOf = (a) => (a && a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
// 整数照样写成整数：模拟那几台的内存总量是 32 这种整数，别被 toFixed(1) 变成 "32.0"
const gbTxt = (v, d) => (v == null ? null : Number.isInteger(v) ? String(v) : v.toFixed(d == null ? 1 : d));
const memPct = (m) => (m.used != null && m.total ? (m.used / m.total) * 100 : null);
// 实测那台的 used 本身已经是不含可回收缓存的口径（linux 用 MemAvailable、win 用 FreePhysicalMemory 反推），
// 再减一次 cache 就减重了；所以只有模拟那台（used/cache 是两笔独立假数）才减 cache。
const memFreeGb = (m) => (m.total != null && m.used != null ? Math.max(0, m.total - m.used - (m.live ? 0 : (m.cache || 0))) : null);
// 实测那种"一个挂载点一张卡"的抬头就是挂载点（C:\ / /），模拟那台还是 DISK 0/1/2…
const diskName = (d) => (d.live ? d.vol || d.name || "DISK " + d.id : "DISK " + d.id);
// 卷的抬头取哪个字段，两条脚本给的东西不一样：
//   · windows 的 id 就是盘符（"C:"）—— 盘符本身就是最认得出的名字，直接用，别拿卷标（卷标常为空）顶
//   · linux 的 id 是分区名（"nvme0n1p2"），label 才是挂载点（"/"）—— 挂载点才是他要认的那个名字
const volName = (v) => {
  const id = String((v && v.id) || "");
  if (/^[A-Za-z]:$/.test(id)) return id;
  return String((v && v.label) || "").trim() || id;
};
// 型号串要能整头摆下：'NVIDIA GeForce RTX 2080 Ti' 26 字符，卡面放得下，别在中间切。
// 只砍三种没有信息量的尾巴：奔着 intel/amd 那套产品名后缀（"CPU @ 2.60GHz"）、
// "6-Core Processor" 里的核数（核数已经有单独一格了）、还有光秃秃的 "Processor"。
const shortName = (n) => {
  if (!n) return null;
  const m = String(n)
    .replace(/\((R|TM)\)/gi, "")
    .replace(/CPU @.*$/i, "")
    .replace(/\s+\d+\s*-\s*(Core|Thread)s?\s+Processor\s*$/i, "")
    .replace(/\s+Processor\s*$/i, "")
    .trim();
  return m.length > 30 ? m.slice(0, 29) + "…" : m;
};
const vendorOf = (n) => {
  const s = String(n || "").toLowerCase();
  if (!s) return null;
  if (/nvidia|geforce|quadro|rtx|gtx|tesla/.test(s)) return "NVIDIA";
  if (/amd|radeon|\bati\b/.test(s)) return "AMD";
  if (/intel|iris|uhd graphics|hd graphics/.test(s)) return "Intel";
  if (/apple|\bm[0-9] (pro|max|ultra)\b/.test(s)) return "Apple";
  return String(n).split(/\s+/)[0];
};

// 百分比 / 倍数两种写法：滑杆右上角那一格用，全页只这一份。
const pctFmt = (v) => Math.round(v * 100) + "%";
const mmFmt = (v) => "×" + v.toFixed(1);

export { fmt, esc, clampv, usageColor, tempColor, mean, fmtSpeed,
  hhmm, gbOfBytes, mbOfBytes, gbOfMb, avgOf, gbTxt, memPct, memFreeGb, diskName, volName,
  shortName, vendorOf, pctFmt, mmFmt };
