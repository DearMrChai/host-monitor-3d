// DOM 积木层：造一个节点 / 一行滑杆 / 一个按钮，只认参数、不认页面上的任何状态。
// 为什么单独一层：设备列表、设置各分类、性能看板三处都在造同样的行；再往下拆 dashboard 与 settings-ui
// 时两边都要用，谁 import 谁都会留下环形引用（模块求值顺序会咬人），所以把公共的那半沉到第三层。
// 唯一的依赖是 sparkSvg 折线要夹高度 —— 那个口径属于读数层，不在这儿另写一份 toFixed/clamp。
import { clampv } from './format.mjs';

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

function sparkSvg(vals, color, h) {
  const hh = h || 42;
  const w = 320;
  if (!vals || vals.length < 2) return "";
  const top = Math.max(1, ...vals);
  const step = w / (vals.length - 1);
  const pts = vals.map((v, i) => (i * step).toFixed(1) + "," + (hh - clampv(v / top, 0, 1) * hh).toFixed(1)).join(" ");
  return '<svg viewBox="0 0 ' + w + " " + hh + '" preserveAspectRatio="none">'
    + '<polygon points="0,' + hh + " " + pts + " " + w + "," + hh + '" fill="' + color + '" opacity="0.16"></polygon>'
    + '<polyline points="' + pts + '" fill="none" stroke="' + color + '" stroke-width="1.6" '
    + 'vector-effect="non-scaling-stroke" stroke-linejoin="round" stroke-linecap="round"></polyline></svg>';
}

function mini(label, title, cls) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "mini" + (cls ? " " + cls : "");
  b.textContent = label;
  b.title = title;
  return b;
}

function fieldRow(label, node) {
  const row = el("div", "fld");
  row.append(el("span", null, label), node);
  return row;
}

function textField(kind, value, placeholder, onInput) {
  const i = el("input", "tx");
  i.type = kind;
  i.value = value;
  i.placeholder = placeholder;
  i.autocomplete = "off";
  i.spellcheck = false;
  i.addEventListener("input", () => onInput(i.value));
  return i;
}

// 一行滑杆：标题 + 当前值 + 滑杆 + 一句说明；onInput 负责写回配置并（按需）落盘。
// o.limits 可以是 [min,max,step]，也可以是每次重画现取这个数组的函数 —— 六根关联滑杆要用后者：
// 三档互相夹着，活动区间随另外两根当前位置变，写死一次就等于把"拖不出反序"这条保证丢掉。
function sliderRow(mount, o) {
  const bounds = () => (typeof o.limits === "function" ? o.limits() : o.limits);
  const [b0, b1, b2] = bounds();
  const wrap = el("div", "sld");
  const lab = el("div", "lab");
  lab.append(el("span", null, o.title));
  const val = el("b");
  lab.append(val);
  const input = document.createElement("input");
  input.type = "range";
  input.min = b0; input.max = b1; input.step = b2;
  input.setAttribute("aria-label", o.title);
  wrap.append(lab, input, el("div", "hint", o.hint));
  const paint = () => {
    const [min, max, step] = bounds();
    input.min = min; input.max = max; input.step = step;
    const v = o.get();
    input.value = v;
    val.textContent = o.fmt(v);
  };
  input.addEventListener("input", () => { o.set(input.value); paint(); });
  paint();
  mount.append(wrap);
  return paint;
}

function bindOnOff(id, label, get, set) {
  const b = document.getElementById(id);
  const paint = () => {
    const on = get();
    b.classList.toggle("on", on);
    b.textContent = label + (on ? " 开" : " 关");
    b.setAttribute("aria-pressed", String(on));
  };
  b.addEventListener("click", () => { set(!get()); paint(); });
  paint();
  return paint;
}

export { el, sparkSvg, mini, fieldRow, textField, sliderRow, bindOnOff };
