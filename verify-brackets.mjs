// 角铁自检（跑法：node verify-brackets.mjs）。
// 把 monitor-wall.html 里的 BRACKET + createCornerBrackets 抠出来，用假 THREE 跑一遍，逐件量"占哪一段"，
// 再两两查三件事：体积重叠、同侧重合（本项目判据里会叠色/闪烁的那种）、面对面贴合（良性）。
// 顺带把整个 <script type="module"> 落盘过一遍 node --check —— 页面里改出语法错要当场知道，别等开浏览器。
import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

const HERE = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(HERE, "monitor-wall.html"), "utf8");

// ---------- 1. 语法：整个 <script type="module"> 落盘过 node --check ----------
const mStart = src.indexOf('<script type="module">');
const mEnd = src.indexOf("</script>", mStart);
const mod = src.slice(mStart + '<script type="module">'.length, mEnd);
const tmp = join(tmpdir(), "_hm3d-module.tmp.mjs");
writeFileSync(tmp, mod);
try {
  execFileSync(process.execPath, ["--check", tmp], { stdio: "pipe" });
  console.log("语法 node --check ................ 通过");
} catch (e) {
  console.log("语法 node --check ................ 失败\n" + (e.stderr || e.stdout || e).toString());
  process.exit(1);
}

// ---------- 2. 抠出角铁那一段（从 BRACKET 常量到下一个区块注释） ----------
const b0 = src.indexOf("const BRACKET =");
const b1 = src.indexOf("// 区的颜色 =");
const code = src.slice(b0, b1) + "\nreturn { BRACKET, createCornerBrackets };";

class BoxGeo { constructor(w, h, d) { this.w = w; this.h = h; this.d = d; } }
class Vec3 {
  constructor() { this.x = 0; this.y = 0; this.z = 0; }
  set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; }
}
class Mesh {
  constructor(geo, mat) { this.geometry = geo; this.material = mat; this.name = ""; this.position = new Vec3(); this.isMesh = true; }
}
class Group {
  constructor() { this.children = []; this.userData = {}; }
  add(o) { this.children.push(o); }
}
const THREE = {
  Group, Mesh,
  MeshStandardMaterial: class { constructor(p) { Object.assign(this, p); } },
  BoxGeometry: BoxGeo,
};
const { BRACKET, createCornerBrackets } = new Function("THREE", code)(THREE);

const r3 = (v) => Math.round(v * 1000) / 1000;
const lo = (a, b) => Math.min(a, b), hi = (a, b) => Math.max(a, b);
const ov = (a, b) => Math.min(a[1], b[1]) - Math.max(a[0], b[0]);   // 重叠量，负数=没挨上
const span = (m) => ({
  name: m.name,
  x: [m.position.x - m.geometry.w / 2, m.position.x + m.geometry.w / 2],
  y: [m.position.y - m.geometry.h / 2, m.position.y + m.geometry.h / 2],
  z: [m.position.z - m.geometry.d / 2, m.position.z + m.geometry.d / 2],
});

// 逐件量：体积重叠 / 同侧重合 / 面对面
function audit(parts) {
  let vol = 0, same = 0, face = 0;
  const detail = [];
  for (let i = 0; i < parts.length; i++) for (let j = i + 1; j < parts.length; j++) {
    const A = parts[i], B = parts[j];
    if (ov(A.x, B.x) > 1e-9 && ov(A.y, B.y) > 1e-9 && ov(A.z, B.z) > 1e-9) {
      vol++; detail.push("体积重叠 " + A.name + " / " + B.name);
      continue;
    }
    for (const k of ["x", "y", "z"]) {
      const o = ["x", "y", "z"].filter((t) => t !== k);
      // 注意：两个负的重叠量相乘会变正 —— 必须两轴都为正才算"投影有正面积"
      if (!(ov(A[o[0]], B[o[0]]) > 1e-9 && ov(A[o[1]], B[o[1]]) > 1e-9)) continue;
      if (Math.abs(A[k][1] - B[k][1]) < 1e-9 || Math.abs(A[k][0] - B[k][0]) < 1e-9) {
        same++; detail.push("同侧重合 " + A.name + " / " + B.name + " @" + k);
      } else if (Math.abs(A[k][0] - B[k][1]) < 1e-9 || Math.abs(A[k][1] - B[k][0]) < 1e-9) {
        face++;
      }
    }
  }
  return { vol, same, face, detail };
}

// ---------- 3. 按 4400×3200×1150 跑，并把每件的跨度跟"从角点算出来的那组数"逐个对 ----------
const W = 4400, D = 3200, H = 1150;
const parts = createCornerBrackets(W, D, H, 0x00ff41).children.map(span);
const w = Math.max(4, Math.round(W * BRACKET.widK));
const len = Math.max(60, W * BRACKET.lenK);

console.log("件数 .............................", parts.length, "(期望 24 = 4 角 × 2 层 × 3 臂)");
console.log("臂长 / 截面 ......................", r3(len), "mm /", w + "×" + w, "mm（角铁的臂从角点量起 len，截面与立柱同）");

const expect = [];
for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
  const cx = (sx * W) / 2, cz = (sz * D) / 2;
  const ix = cx - sx * (w / 2), iz = cz - sz * (w / 2);
  for (const top of [false, true]) {
    expect.push(
      { name: "zone-bracket-v", x: [cx - w / 2, cx + w / 2], y: top ? [H - len, H] : [0, len], z: [cz - w / 2, cz + w / 2] },
      { name: "zone-bracket-x", x: [lo(ix, cx - sx * len), hi(ix, cx - sx * len)], y: top ? [H - w, H] : [0, w], z: [cz - w / 2, cz + w / 2] },
      { name: "zone-bracket-z", x: [cx - w / 2, cx + w / 2], y: top ? [H - w, H] : [0, w], z: [lo(iz, cz - sz * len), hi(iz, cz - sz * len)] },
    );
  }
}
let miss = 0;
for (const e of expect) {
  const hit = parts.find((p) => p.name === e.name
    && ["x", "y", "z"].every((k) => Math.abs(p[k][0] - e[k][0]) < 1e-9 && Math.abs(p[k][1] - e[k][1]) < 1e-9));
  if (!hit) { miss++; console.log("  跨度对不上：", e.name, JSON.stringify(e)); }
}
console.log("跨度逐件对数（从角点算）...........", miss ? "不符 " + miss + " 件" : "24/24 全对");

const a = audit(parts);
console.log("体积重叠 .........................", a.vol, "(期望 0)");
console.log("同侧重合（会叠色/闪烁）............", a.same, "(期望 0)");
console.log("面对面贴合（良性）.................", a.face, "(每角 2 处 × 8 = 16)");
if (a.detail.length) console.log("  " + a.detail.join("\n  "));

const bb = {
  x: [Math.min(...parts.map((p) => p.x[0])), Math.max(...parts.map((p) => p.x[1]))],
  y: [Math.min(...parts.map((p) => p.y[0])), Math.max(...parts.map((p) => p.y[1]))],
  z: [Math.min(...parts.map((p) => p.z[0])), Math.max(...parts.map((p) => p.z[1]))],
};
console.log("整组包围盒 .......................", "x " + r3(bb.x[0]) + "~" + r3(bb.x[1]),
  "y " + r3(bb.y[0]) + "~" + r3(bb.y[1]), "z " + r3(bb.z[0]) + "~" + r3(bb.z[1]));
console.log("  = " + r3(bb.x[1] - bb.x[0]) + " × " + r3(bb.y[1] - bb.y[0]) + " × " + r3(bb.z[1] - bb.z[0]),
  "（盒子 " + W + "×" + H + "×" + D + "，立柱在角上各外扩 " + w / 2 + "）");
console.log("底贴地 / 顶贴盒顶面 ...............",
  bb.y[0] === 0 && bb.y[1] === H ? "是（y " + bb.y[0] + " ~ " + bb.y[1] + "）" : "否：y " + bb.y[0] + " ~ " + bb.y[1]);
console.log("八个角都在盒子角上（±w/2, ±d/2）....",
  [[-1, -1], [-1, 1], [1, -1], [1, 1]].every(([sx, sz]) =>
    parts.some((p) => p.name === "zone-bracket-v"
      && Math.abs((p.x[0] + p.x[1]) / 2 - (sx * W) / 2) < 1e-9
      && Math.abs((p.z[0] + p.z[1]) / 2 - (sz * D) / 2) < 1e-9)) ? "是" : "否");

// ---------- 4. 换两组尺寸再跑（函数不是只会算 4400 这一个数） ----------
for (const [w2, d2, h2] of [[2000, 1500, 800], [6000, 4000, 2000]]) {
  const p2 = createCornerBrackets(w2, d2, h2, 0xff0000).children.map(span);
  const b2 = audit(p2);
  const yTop = Math.max(...p2.map((p) => p.y[1])), yBot = Math.min(...p2.map((p) => p.y[0]));
  console.log("换尺寸 " + w2 + "×" + d2 + "×" + h2 + " ..........", "件数 " + p2.length,
    "· 重叠 " + b2.vol + " · 同侧 " + b2.same + " · y " + yBot + " ~ " + yTop);
}
