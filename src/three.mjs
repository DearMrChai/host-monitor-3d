// 全场景唯一的 THREE 来源。别的模块一律 import 这一份，不许各自 import("three")——
// 那样双 CDN 兜底的 try/catch 只覆盖其中一处，断网时表现会不一致。
// 裸 'three' 能解析：浏览器侧靠 HTML 里的 importmap（指 unpkg），node 侧靠 node_modules/three；
// 于是几何那两份在浏览器和 verify 脚本里跟页面共用同一份真源。
// export let 不是状态：只在模块求值期赋值一次，导入方因 top-level await 必然等到它。
export let THREE;
try {
  THREE = await import("three");
} catch (errUnpkg) {
  try {
    THREE = await import("https://cdn.jsdelivr.net/npm/three@0.170.0/build/three.module.js");
  } catch (errJsdelivr) {
    // node 里两个都失败时不该把真错误换成 "document is not defined"
    if (typeof document !== "undefined") {
      const s = document.getElementById("status");
      s.style.display = "grid";
      s.textContent = "three@0.170.0 两个 CDN 都没取到（大概是没网/代理没开）："
        + errUnpkg.message + " || " + errJsdelivr.message;
    }
    throw errUnpkg;
  }
}
