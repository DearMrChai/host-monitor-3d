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

**监控墙这一页要经 `npm start` 打开**：它的代码是真 import 本地 `.mjs` 的，多数浏览器不许从 `file://`
import 本地模块 —— 那种情况双击是一片空白，状态条会直接写出这句话和该跑的命令。
⚠ 但"空白"不是 `file://` 的唯一结局：2026-09-25 在内置浏览器实测，本地模块被放行、墙跑起来了，
屏上是八台**内置道具**在荡。所以那一格现在两处都说：顶栏挂红字"内置道具名册：file:// 没连本地服务"，
状态条也明写"屏上这几台是道具、编辑不落盘"（同一口径见下节"名册来源"）。
另一页 `silhouette-shelf.html`（剪影架）仍然可以双击：它嵌的是内联副本，代价是那一份得靠 `npm run check` 重灌。

**部署成一块看板**（就一台机器自己看的那屏）：把整个目录拷过去（`monitor-wall.html`、`serve.mjs`、`probe/`、
`src/`、两份 `*-geometry.mjs`、`devices.json`、`settings.json`、`node_modules/`），在那台上 `node serve.mjs`，用它的浏览器开
`http://127.0.0.1:8123/monitor-wall.html`。少带 `probe/` 那一格，`serve.mjs` 会在 import 期就起不来（它俩是硬 import）。
默认只监听 127.0.0.1（要放开给别的机器看，用下面那两扇门 `HM_BIND` / `HM_ALLOW` / `HM_OWNER`，138 那块墙就是这么摆的）。
之后调参数不用去碰那台的浏览器，直接改它目录里的
`settings.json`，墙上 5 秒内自己跟上。
`devices.json` 含明文口令，是拷过去的那一份里唯一敏感的东西 —— 别转发、别截图。

**名册来源（2026-09-25 清账2）：屏上那几台是"看板抓的真机器"还是"内置道具"，必须挂在墙上**
这块墙存在的理由是"这些数是真抓的"，所以八台 demo 道具（负载是本地随机游走）不许静默冒充真机器。
现在四条路全部上报，判据只在 `src/model.mjs` 的 `rosterBadge` / `rosterIsProps` 两处纯函数里（屏与闸共用）：

| 情况 | `ROSTER.source` | 墙上顶栏 `#roster` |
|---|---|---|
| 开机还没问过服务端 | `unknown` | 不挂（不闪一下假警报） |
| 读到 `devices.json`（`source: "file"`） | `server-devices` / `server-hosts` | 不挂 |
| 服务端读不到文件、回内置名册 | `builtin` | **红字**："内置道具名册：服务端没读到 devices.json，回的是内置名册（source=seeded）（屏上这几台不是真机器）" |
| 那一枪失败（403 / 断连 / `file://`） | `builtin` | **红字**，带上是哪扇门与原始错误 |

配套改动：`serve.mjs` 的 `load()` 在没有 `devices.json` 时**只回道具、不再把它写成文件**（原先先 `save` 再生成，
于是道具身份只在文件消失后的第一次请求里露一次脸，第二次刷新起 `source` 就成了 `file` —— 对一块长期挂着的墙，
那种一次性提示等于没提示）。观众开不了设置弹窗，所以这一格一定在**墙上**，不是只在弹窗里。
问仪器：`__hm().roster()`。钉它的闸：`node verify-access.mjs`（名册那一段，含"四条路径一个都不能少"的调用点计数）。

**数据文件名 2026-09-24 起是英文的**（`设备清单.json`→`devices.json`、`分区.json`→`zones.json`、
`设置.json`→`settings.json`、`探测记录.log`→`probe.log`）。138 那台**两边都已经是英文名**（当天就地改完并验过），
所以 `00-暂存/hm3d-138-push.mjs` 里的 `RENAME` 那一步现在每次都是空转（留着不动：新拷一份旧档名目录去部署时它仍然管用）。
改名这一步不能省：新 `serve.mjs` 找不到 `devices.json` 就回内置道具（见上一节，它不再自作主张写文件），
他那几台真机的配置就当众消失 —— 区别只是现在屏上会挂红字告诉你消失了。

Windows 上当看板那台要注意一件事：**在 SSH 会话里直接起 `node serve.mjs`，会话一断进程就跟着被收走**
（现象是浏览器里 `ERR_CONNECTION_REFUSED`，日志停在启动那几行）。要让它活下来得让 WMI 去建进程，或者
干脆交给计划任务（见下）。另开一个会话查 `netstat -ano | findstr 8123` 能看到 LISTENING 才算真起来了。

**那台机器自己没屏幕 / 要从别的机器看**：`HM_BIND=0.0.0.0`（不再只绑环回）**必给**，另加两扇门的名单 ——
两个都只认 TCP 那一端报来的**来源地址**（不是 `Origin`），**环回永远是主人**（ToDesk 上去照看那条路一直留着）：

| 环境变量 | 管什么 | 不给时 |
|---|---|---|
| `HM_ALLOW` | **看**：名单外的来源连页面都打不开（整页 403） | 放开：谁能连上谁都能看这块墙 |
| `HM_OWNER` | **改**：写那三个 json、开设置、催一轮抓取、借这台机器 SSH 别人 | 回退成 `HM_ALLOW`（老写法一字不改也照样能改） |

**别指望防火墙替你挡**——比如 138 那台的 Windows 防火墙三个 profile 全是关的（实测 `Enabled=False`），
规则加上去也拦不住谁，所以这两道门只能服务自己认。只给 `HM_ALLOW`、`HM_OWNER` 空着 = 只有环回能改，
启动日志会明写 `改（HM_OWNER）：只认 127.0.0.1（外加环回）` 那样的话；一句都不给则是"看：不限 / 改：只剩环回"，
日志那两行各带一句 ⚠ 说明代价。

放开"看"的代价说清楚：同网段谁能连上谁就看得见那几台的型号、负载与档位。他读不到凭据——
观众那份清单是新接口 `/api/hosts`，`user` / `pass` **整键不出现**（不是置空串），页面开页先问一次
`/api/state` 知道自己是不是观众，是观众就连设置齿轮都不给他。抓帧由服务端自己转轮次，
所以**所有页面都关掉也照抓**（这一条是"看板"跟"调试页"的分界：以前页面一关数值就停）。

**清单里"没填口令"的那几台抓不到数**：服务只认口令这一条认证路，账号无密码、sshd 又关着
`PasswordAuthentication` 的机器（14 就是）只会回 `All configured authentication methods failed`。
再给一个环境变量 `HM_SSH_KEY=<私钥文件路径>` 即可：服务启动时读一次，之后每台机器都先试这把公钥、
再试清单里的口令（两行互不干扰，有口令的照旧）。公钥要装进**那台目标机**的授权档 —— Windows 上如果
账号在 Administrators 组里，sshd 只认 `C:\ProgramData\ssh\administrators_authorized_keys`
（`sshd_config` 的 `Match Group administrators` 段决定的，不是用户自己目录里那份）。
配没配上，启动日志第一屏就写着：`抓机器用的私钥：已载入私钥 …` / `⚠ … 读不到` / `没配 HM_SSH_KEY`。

```powershell
# 目标机侧（管理员 PowerShell）：追加公钥，绝不覆盖已有行；ACL 收紧到 OpenSSH 认的样子
$k = 'C:\ProgramData\ssh\administrators_authorized_keys'
$pub = 'ssh-ed25519 AAAA... 你在那台生成的注释'
$lines = @(); if (Test-Path $k) { $lines = @(Get-Content $k | Where-Object { $_.Trim() }) }
if ($lines -notcontains $pub) { $lines += $pub }
Set-Content -Path $k -Value $lines -Encoding ascii
icacls $k /inheritance:r /grant '*S-1-5-18:F' /grant '*S-1-5-32-544:F'
```

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
`settings.json` / `probe.log` 会被拒：`icacls C:\Users\User\hm3d /grant "user:(OI)(CI)F" /T`。

## 两页各管什么

| 文件 | 是什么 | 看什么 |
|---|---|---|
| `monitor-wall.html` | **监控墙**：设备按四个区各自聚集（算力集群 / 终端设备区 / 储存设备区 / 网络设备区，默认以网络设备区为地图中心）+ 右侧性能看板 + 设置弹窗（设备 / 分区 / 脉冲效果 / 地面与雨 / 采集频率 五格） | 分级脉冲（脉冲效果格里有总开关）、点阵涟漪地面与二进制雨（地面与雨格里各有独立开关）、看板五节按档位增减、双击或列表里 ◎ 聚焦、SSH 实测与模拟分流（**填了地址的机器每 15 秒自动抓一轮，开机就先抓一轮；双击一台还没帧的会当场补抓**）、每台落在哪个区、分区的名字和位置可改（存 `zones.json`）、设置那几格存 `settings.json`（改文件即改看板，页面每 5 秒读一次） |
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
src/fleet.mjs          陈列层：一台设备从"硬件档"到"桌上有东西 + 头顶有牌"的整条建造与染色（T5 刀5）
src/ground.mjs         地面层：脚下脉冲 + 点阵涟漪地形 + 二进制雨 + 每拍负载档位（含它自己的自检钩子，T5 刀6）
src/settings-ui.mjs    设置层：齿轮弹窗五块面板 + 三份 JSON 的读写与防抖（读→夹取→应用→写盘只这一处；页面的探针/心跳/相机三个动作由 initSettings 注入，T5 刀7）
monitor-wall.html      监控墙原型（几何、three、状态都是真 import，所以必须经 serve.mjs 打开）
silhouette-shelf.html  剪影架原型（嵌内联副本，可 file:// 双击）
serve.mjs              本地服务：清单 / 分区 / 设置 三个文件的读写 + SSH 探一帧（两段探针正文在 probe/，契约与解析还在这儿）
probe/probe-linux.mjs  抓一帧 · linux 那套 sh 脚本正文（整段走 stdin，给远端 shell 看的，与 serve.mjs 零共用符号，T5 step5）
probe/probe-win.mjs    抓一帧 · Windows 那套 PowerShell 脚本正文（必须是单行，理由写在这两个文件的头上，T5 step5）
check.mjs              一条命令的自检：语法（HTML 里那段模块体 + 根目录、src/ 与 probe/ 全部 .mjs）→ 注入 → 几何校验
inject-geometry.mjs    把 chassis-geometry.mjs 灌进剪影架那一页（只有它还吃内联副本）
verify-geometry.mjs    六节校验：① 监控墙 import 齐 + 状态层 node 侧可跑（8 台 / 4 区 / 8 档）+ 剪影架可跑 / ② 内联 vs 源逐件比对 / 规格包围盒 / 同侧重合 / 正面射线 / 局部系复核
verify-brackets.mjs    角铁自检（现进 check.mjs）：从 **src/fleet.mjs** 截 BRACKET + createCornerBrackets 原文，用假 THREE 量 24 件臂长 / 体积重叠 / 同侧重合 / 换尺寸复跑；屏上对应 `__hm().cornerView(key)`
verify-cpu.mjs         多卡并卡口径（混合架构 P/E 映射；映射长度不等整段不认）
verify-load.mjs        综合负载口径 B（CPU∥GPU 取 max、内存只抬档，12 例）+ 服务端 framePeek 原始数（6 例）+ 两处接线
verify-grade.mjs       三档关联滑杆：波速/节拍拖不出反序、量程守得住（19 条）
verify-ripples.mjs     自然路径（真 stepRipples + noteRipple 截进 vm）三档环速、滑杆驱动、无档不撒圈、取证活过刷新（15 条）
verify-access.mjs      访问分权两扇门 + 脱敏 + 名册来源四态不静默
verify-rain.mjs        二进制雨：换字截原文、图集与 drawRange、柱子整列切、忙闲倍率、新键四处点名
docs/                  尺寸与实测、移植指引、本地服务与数据源（口径权威）、**阶段总结-20260925.md（新会话入场档）**、派单-机箱剪影-2026-09.md（立项前留档）
docs/参考-数字雨/       用户给的参考代码＝规格，一律只读不改：数字雨与波浪地面整页（二进制雨的出处）
docs/参考-涟漪地面/     同上：点阵涟漪地形那三份（js×2 + 需求 txt）
docs/参考-角铁/         同上：角铁那两份（deepseek 那段 + `调用.js` 的接法）
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

`devices.json` 里有**明文 SSH 口令**（2026-09-23 用户明确许可落盘），`probe.log` 记着连过哪些机器。
两者都已在 `.gitignore` 里。仓库里只放 `devices.example.json`（凭据全空）。
**不要**把它们拷进任何分享包、截图或转发；新机器上跑 `serve.mjs` 会按 example 那套默认值生成一份干净的。

`zones.json` 与 `settings.json` 也在 `.gitignore` 里，但理由不同 —— 它们**不含凭据**：默认值写在
`src/model.mjs` 里，这两份是"本机改过"的版本；跟进仓库的话，本地拖一次滑块、挪一次分区就把工作区弄脏了。
部署时要调参数，直接改部署目录里的 `settings.json`。

## 现状与验收（2026-09-25 深夜收口）

结构、九道闸、部署与逐条验收记录在 **[docs/阶段总结-20260925.md](docs/阶段总结-20260925.md)**（新会话入场档）。
一句概览：四区与角铁陈列、涟漪快慢、雨的 #3/#4 **都过了人眼**（他的原话逐字留在那份第六节），
三档涟漪在自然路径上的屏上读数全齐（含红档 `speed=30`，142 真帧过 70 那次逮到的），清账两项结案。

仍然量不到 / 只登记的（不是待办，别当缺口报）：
- GPU 侧填充与合成的帧率：后台标签页量出来必是假数，本机也没有第二块屏可对——要看只能你眼睛看；
- 参考页那层 `UnrealBloom` 没带过来（口径 2 禁 `examples/`），比参考暗一档是预期，提不提亮度是你的取舍；
- 分级阈值 `35% / 70%` 当初是我先定的，你按"效果可以"整片收过，但没逐字裁过这两个数；要改只动 `STATES` 里那三个 `max`。

已用仪器核对过的（下面那几条"四台/密钥"的记录写在 09-24 之前，现已过时：
14 号机的密钥 09-24 晚接通，`B250M-K(.195)` 09-25 深夜起 `hidden=true`——那台关机摆在他旁边，抓取清单只剩三台）：
17 个模型包围盒与件数、正面 40×40 射线首击图、同侧重合清点全 0、
脉冲稳态（八台 1.4~1.7 万粒、CPU 提交 1.2~6.2 ms/帧，跨场次不可比、只当量级看；环半径 ÷ footprint 半径 = `travelK` 可核对）、
涟漪地面（点阵默认 `dotSeg=320` → 321² = 103041 点铺满 24000 mm、点距 75 mm，`dotSizeMm=56` 一粒画多大；
活环封顶 32 个时 CPU 1.2~4.2 ms/帧（180 段时测的），
密度滑杆 60~360 段实测 0.5~13.2 ms/帧近似线性于顶点数、点径 8~112 mm 实测 CPU 2.3~2.5 ms/帧不动（它只吃 GPU 填充，本机量不到）、
**与脉冲已脱钩**：关脉冲推 10 s 仍自起 15 圈、关涟漪当帧抹平且连底波一起静止 `起伏mm [0,0]`、
雨壳半径 40000~54000 整个套在相机 30000 的最远拉距外面）、
设置文件双向（页面点开关/按方向键 → 400 ms 后文件里那一格变；外部改文件 → 5 秒内滑杆位置与数值一并跟上，
不用刷新；写越界值 → 钳回并把文件改写成生效值；手改的 `_说明` 不被抹掉；文件删掉/改坏 → 重新生成一份）、
四台一起抓：三台真机各回一帧、第四台如实报"认证失败"（它的密钥还没生成完），`probe.log` 里逐行可查、
每条只记时间与主机名；Windows 抓帧分支（桌面机 2.7 s / 1.8 s 各一帧，系统名不乱码、带回了 `nvidia-smi` 那路 GPU；
同批 Linux 那台 0.3 s 一帧）、
四台一起抓时页面控制台干净（"抓不到"回 200 而不是 502 就是为了这个）。

**仍然欠人眼验收的**：见上面那份概览——09-25 深夜这一串已经改写过一次（四区/角铁陈列、涟漪快慢、雨的 #3/#4 都过了人眼，
记录逐字留在 [docs/阶段总结-20260925.md](docs/阶段总结-20260925.md) 第六节）。
八台一排在全景里机器很小这一条仍按"你的取舍，我没动"记着。

立项前的工作单留在 [docs/派单-机箱剪影-2026-09.md](docs/派单-机箱剪影-2026-09.md)，
其中两条约束已被后续决定改写，文件顶部逐条注明。
