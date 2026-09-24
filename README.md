# host-monitor-3d

Host Monitor 的 **3D 陈列架 / 监控墙原型**：程序化设备几何（机箱、笔记本、NAS、交换机、路由器、外设）
+ 两页 HTML（剪影架可双击直接开，监控墙要走本地服务，见下）+ 一个能真连机器的本地采集服务。

**它还不是插件的一部分。** 目标是把 `chassis-geometry.mjs` / `desk-geometry.mjs` 这两个纯几何模块
移植进 `dsh-plugin-host-monitor`，页面与 `serve.mjs` 是造它们、量它们、试它们的车间。
移植的接缝与约束见 [docs/移植指引.md](docs/移植指引.md)。

```
1 世界单位 = 1 毫米 · 零外部素材 · three 钉 0.170.0（CDN importmap，禁 examples/）
```

## 三条命令跑起来

```
npm i                  # three（校验用）+ ssh2（探测用），只装在本目录
npm run check          # 语法（含 HTML 里那段模块体）→ 灌剪影架的内联副本 → 六节几何校验
npm start              # http://127.0.0.1:8123/monitor-wall.html
```

**监控墙这一页必须经 `npm start` 打开**：它的代码是真 import 本地 `.mjs` 的，而浏览器不许从 `file://`
import 本地模块，所以双击打不开 —— 双击的话状态条上会直接写出这句话和该跑的命令。
另一页 `silhouette-shelf.html`（剪影架）仍然可以双击：它嵌的是内联副本，代价是那一份得靠 `npm run check` 重灌。

**部署成一块看板**（就一台机器自己看的那屏）：把整个目录拷过去（`monitor-wall.html`、`serve.mjs`、
`src/`、两份 `*-geometry.mjs`、`设备清单.json`、`设置.json`、`node_modules/`），在那台上 `node serve.mjs`，用它的浏览器开
`http://127.0.0.1:8123/monitor-wall.html`。服务只监听 127.0.0.1，所以看板只能在那台机器本机打开 ——
这正好：一块墙上的屏不该被别人从别的机器上看。之后调参数不用去碰那台的浏览器，直接改它目录里的
`设置.json`，墙上 5 秒内自己跟上。
`设备清单.json` 含明文口令，是拷过去的那一份里唯一敏感的东西 —— 别转发、别截图。

Windows 上当看板那台要注意一件事：**在 SSH 会话里直接起 `node serve.mjs`，会话一断进程就跟着被收走**
（现象是浏览器里 `ERR_CONNECTION_REFUSED`，日志停在启动那几行）。要让它活下来得让 WMI 去建进程，或者
干脆交给计划任务（见下）。另开一个会话查 `netstat -ano | findstr 8123` 能看到 LISTENING 才算真起来了。

**那台机器自己没屏幕 / 要从别的机器看**：带两个环境变量起，`HM_BIND=0.0.0.0`（不再只绑环回）＋
`HM_ALLOW=<你那台的 IP>`（只认这几个来源，环回永远放行）。**这两个要一起给**：服务不做鉴权，
能连上的人就能读走整份 `设备清单.json`（含明文口令），也能借 `/api/probe` 往任意主机打 SSH。
**别指望防火墙替你挡**——比如 138 那台的 Windows 防火墙三个 profile 全是关的（实测 `Enabled=False`），
规则加上去也拦不住谁，所以来源这道门只能服务自己认。不给 `HM_ALLOW` 时启动日志里会写一行"来源：不限制"的空心警告。

```powershell
# 开机自启：计划任务跑一个"起看板.ps1"，脚本里先收掉旧实例（按命令行带 serve.mjs 找）再起新的。
# 动作里头用 cmd 的 set "VAR=值"（写成 set VAR=值 && … 会把 && 前的空格算进值里，node 会报
# getaddrinfo ENOTFOUND 0.0.0.0）；起进程走 WMI，否则任务一结束进程就被收走。
$act = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument '-NoProfile -ExecutionPolicy Bypass -File "C:\Users\User\hm3d\起看板.ps1"'
$trg = New-ScheduledTaskTrigger -AtStartup; $trg.Delay = 'PT30S'
$set = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
  -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero)
Register-ScheduledTask -TaskName 'hm3d-monitor-wall' -Action $act -Trigger $trg -Settings $set `
  -Principal (New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest) -Force
```

任务以 SYSTEM 跑，它建出来的文件属主是 SYSTEM；给那个账号补一次目录权限，否则以后从外网 SFTP 覆盖
`设置.json` / `探测记录.log` 会被拒：`icacls C:\Users\User\hm3d /grant "user:(OI)(CI)F" /T`。

## 两页各管什么

| 文件 | 是什么 | 看什么 |
|---|---|---|
| `monitor-wall.html` | **监控墙**：设备按四个区各自聚集（算力集群 / 终端设备区 / 储存设备区 / 网络设备区，默认以网络设备区为地图中心）+ 右侧性能看板 + 设置弹窗（设备 / 分区 / 脉冲效果 / 地面与雨 / 采集频率 五格） | 分级脉冲（脉冲效果格里有总开关）、点阵涟漪地面与二进制雨（地面与雨格里各有独立开关）、看板五节按档位增减、双击或列表里 ◎ 聚焦、SSH 实测与模拟分流（**打开页面时清单里填了地址的机器各自动抓一帧**）、每台落在哪个区、分区的名字和位置可改（存 `分区.json`）、设置那几格存 `设置.json`（改文件即改看板，页面每 5 秒读一次） |
| `silhouette-shelf.html` | **剪影架**：九台设备裸摆，无状态、无看板、屏幕内容层藏掉 | 只验两件事：包围盒等于规格真数、正面不闪 |

## 目录

```
chassis-geometry.mjs   机箱与网络设备几何（9 个模型函数 + screenContent helper），可移植层
desk-geometry.mjs      外设与桌面组合（复用上面那份，没有第二份几何），可移植层
src/three.mjs          全场景唯一的 THREE 来源（双 CDN 兜底在这里，两页与两份几何都 import 它）
src/model.mjs          状态层：档位表 / 设备清单 / 分区 / 三档分级 / 可调参数表，整页只有一份（T5-2 从页面里搬出来的）
src/format.mjs         读数换算层：数 → 屏上那行字（fmt / 色阶 / GB / 型号短名 / 厂商…），零依赖，三处共用（T5-4 刀1）
src/ui.mjs             DOM 积木层：造节点 / 造一行滑杆 / 造一个开关按钮，只认参数不认状态（T5-4 刀2）
src/dashboard.mjs      性能看板：一帧数据 → 右侧那排卡片（取数 + 渲染两层同住一个文件，见口径 7）（T5-4 刀3）
monitor-wall.html      监控墙原型（几何、three、状态都是真 import，所以必须经 serve.mjs 打开）
silhouette-shelf.html  剪影架原型（嵌内联副本，可 file:// 双击）
serve.mjs              本地服务：清单 / 分区 / 设置 三个文件的读写 + SSH 探一帧（Windows 走 PowerShell，Linux 走 sh）
check.mjs              一条命令的自检：语法（HTML 里那段模块体 + 根目录与 src/ 全部 .mjs）→ 注入 → 几何校验
inject-geometry.mjs    把 chassis-geometry.mjs 灌进剪影架那一页（只有它还吃内联副本）
verify-geometry.mjs    六节校验：① 监控墙 import 齐 + 状态层 node 侧可跑（8 台 / 4 区 / 8 档）+ 剪影架可跑 / ② 内联 vs 源逐件比对 / 规格包围盒 / 同侧重合 / 正面射线 / 局部系复核
docs/                  尺寸与实测、移植指引、本地服务与数据源、立项前派单（留档）
```

**改完 `.mjs` 必须 `npm run check`**：③ 那一节按 `docs/尺寸与实测.md` 的表逐件量包围盒，17 个模型全 OK 才算过；
剪影架那一页嵌的是内联副本，不重灌就会跟源走散，② 就是抓这件事的（逐件世界 AABB 比对，9 个单机件必须全 0 差异）；
① 那一节现在还会在 node 里把 `src/model.mjs` 真 import 一遍，设备/分区/档位数不对就当场报错。

## 七条不能破的口径

1. **几何是纯函数**：顶层不碰 `document` / `window` / renderer，node 能直接 import；
   姿态由调用方的 `rotation` 决定，不写死在几何里。
2. **零外部素材**：不许 `.glb` / 贴图图片 / 外部字体 / three `examples/` 里的模型与控制器。
   运行时用 canvas 画的粒子贴图不算素材。
3. **尺寸给真数**：每个模型的包围盒严格等于 `docs/尺寸与实测.md` 里带出处的那个数，
   不许为了"几档看着分得开"凑比例。唯一例外是路由器（含天线 144.2 ≠ 机身 56），文档里写明。
4. **几何里一个颜色字面量都没有**：材质由调用方按 `mesh.name` 换 palette 键，
   页面上那些 hex 全是原型外壳，移植时重写。
5. **状态只有一份，且在 `src/model.mjs`**：设备清单、分区、三档分级、可调参数表都从那里 import。
   整份换绑（`devices = 新数组`）必须走导出的 `setDevices()`——导入方那侧的绑定是只读的，
   直接写会在运行时抛 TypeError；改对象属性（`PULSE_SETTINGS.dotSeg = 320`）不用，照常写。
   `ZONES` 刻意长驻同一个数组（`length = 0` 再 push），就是为了让各层抓着的引用不散。
6. **数 → 字只有一份口径，且在 `src/format.mjs`**：性能看板、提示浮层、设置列表三处读到的都是这一层。
   这层零依赖（不碰 DOM / THREE / 状态），所以在 node 里能直接 import 来量；页面里另写一份 `toFixed`
   就是"同一个数在两处显示成两个样"的开始。
7. **看板的取数与渲染不许拆成两个模块**：`RES` 那张表里每节的回调直接点另一层的 `buildSection` /
   `paintPanel`，拆开了就是环形 import（求值顺序会咬人，页面里那段 `<script type="module">` 不是模块、
   谁都 import 不到它，没有"经由页面绕回去"这条路）。公共积木早一步沉到 `src/ui.mjs` 与
   `src/format.mjs`，所以同层兄弟模块之间一条 import 都没有。

## ⚠ 敏感文件，永远不进 git

`设备清单.json` 里有**明文 SSH 口令**（2026-09-23 用户明确许可落盘），`探测记录.log` 记着连过哪些机器。
两者都已在 `.gitignore` 里。仓库里只放 `设备清单.example.json`（凭据全空）。
**不要**把它们拷进任何分享包、截图或转发；新机器上跑 `serve.mjs` 会按 example 那套默认值生成一份干净的。

`分区.json` 与 `设置.json` 也在 `.gitignore` 里，但理由不同 —— 它们**不含凭据**：默认值写在
`src/model.mjs` 里，这两份是"本机改过"的版本；跟进仓库的话，本地拖一次滑块、挪一次分区就把工作区弄脏了。
部署时要调参数，直接改部署目录里的 `设置.json`。

## 现状与未验收项

已用仪器核对过的：17 个模型包围盒与件数、正面 40×40 射线首击图、同侧重合清点全 0、
脉冲稳态（八台 1.4~1.7 万粒、CPU 提交 1.2~6.2 ms/帧，跨场次不可比、只当量级看；环半径 ÷ footprint 半径 = `travelK` 可核对）、
涟漪地面（点阵默认 `dotSeg=320` → 321² = 103041 点铺满 24000 mm、点距 75 mm，`dotSizeMm=56` 一粒画多大；
活环封顶 32 个时 CPU 1.2~4.2 ms/帧（180 段时测的），
密度滑杆 60~360 段实测 0.5~13.2 ms/帧近似线性于顶点数、点径 8~112 mm 实测 CPU 2.3~2.5 ms/帧不动（它只吃 GPU 填充，本机量不到）、
**与脉冲已脱钩**：关脉冲推 10 s 仍自起 15 圈、关涟漪当帧抹平且连底波一起静止 `起伏mm [0,0]`、
雨壳半径 40000~54000 整个套在相机 30000 的最远拉距外面）、
设置文件双向（页面点开关/按方向键 → 400 ms 后文件里那一格变；外部改文件 → 5 秒内滑杆位置与数值一并跟上，
不用刷新；写越界值 → 钳回并把文件改写成生效值；手改的 `_说明` 不被抹掉；文件删掉/改坏 → 重新生成一份）、
四台一起抓：三台真机各回一帧、第四台如实报"认证失败"（它的密钥还没生成完），`探测记录.log` 里逐行可查、
每条只记时间与主机名；Windows 抓帧分支（桌面机 2.7 s / 1.8 s 各一帧，系统名不乱码、带回了 `nvidia-smi` 那路 GPU；
同批 Linux 那台 0.3 s 一帧）、
四台一起抓时页面控制台干净（"抓不到"回 200 而不是 502 就是为了这个）。

**仍然欠人眼验收的**：
- 3D 画面整体好不好看 —— 我是截图看的，不是你眼睛看的；
- 涟漪与二进制雨的观感：参考页那层 `UnrealBloom` 没带过来（口径 2 禁 `examples/`），
  只靠贴图柔光＋叠加混合，比参考暗一档是预期，要不要提亮度是你的取舍；
- 帧率（GPU 侧填充/合成开销没法在后台标签页量，量了必出假数）；
- 分级阈值 `35% / 70%` 是我先定的，等你聊（要改只动 `STATES` 里那三个 `max`）；
- 八台一排在全景里机器很小 —— 要不要改两排 / 收间距是你的取舍，我没动。

立项前的工作单留在 [docs/派单-机箱剪影-2026-09.md](docs/派单-机箱剪影-2026-09.md)，
其中两条约束已被后续决定改写，文件顶部逐条注明。
