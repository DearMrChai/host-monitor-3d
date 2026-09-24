// 原型本地服务：把设备清单存成同目录的 设备清单.json、分区表存成 分区.json、设置存成 设置.json，
// 页面上的编辑实时写回这三个文件。零依赖，node 22 直接跑。
//   node serve.mjs            → http://127.0.0.1:8123/monitor-wall.html
//   HM_BIND=0.0.0.0 HM_ALLOW=10.226.127.14 node serve.mjs
//        → 也从别的机器能开（那台自己没屏幕时用），并且只认 HM_ALLOW 里那几个来源
// 为什么要有它：file:// 下浏览器不能写盘，"编辑同步修改配置文件"必须走一次本地 HTTP。
import { createServer } from "node:http";
import { readFile, writeFile, rename, appendFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const FILE = path.join(DIR, "设备清单.json");
const ZFILE = path.join(DIR, "分区.json");
const SFILE = path.join(DIR, "设置.json");
const PORT = Number(process.env.PORT || 8123);
// 默认只认环回：这块墙看得见设备清单里的明文口令，别顺手把它摊到网段上。
// 要敞开时（比如那台机器自己没屏幕）用 HM_BIND 指定，并且**必须**同时用防火墙把来源收到信得过的
// 那几台机器上 —— 这个服务不做鉴权，能连上的人就等于能读走整份清单、也能借它往任意主机打 SSH。
const BIND = process.env.HM_BIND || "127.0.0.1";
const LOOPBACK = BIND === "127.0.0.1" || BIND === "localhost" || BIND === "::1";
// 允许从哪些机器连（逗号分隔的 IP，环回永远放行；不给＝不限制）。
// 为什么这道检查必须在服务里做、不能只靠防火墙：138 那台的 Windows 防火墙三个 profile 全是关的
// （实测 Enabled=False），规则加上去也不会挡谁。而这个服务不做鉴权 —— 能连上的人就能读走整份
// 设备清单（含明文口令），也能借 /api/probe 往任意主机打 SSH，所以来源得自己认。
const ALLOW = (process.env.HM_ALLOW || "").split(",").map((s) => s.trim()).filter(Boolean);
function fromAllowed(req) {
  if (!ALLOW.length) return true;
  const ip = String(req.socket.remoteAddress || "").replace(/^::ffff:/, "");
  return ip === "127.0.0.1" || ip === "::1" || ALLOW.includes(ip);
}
const MAX_BYTES = 64 * 1024;
const TIERS = new Set(["laptop", "matx", "atx", "eatx", "itx", "nas", "switch", "router"]);
// zone 留空 = 页面按档位自动落区，所以默认清单里全是空串。
// 分区不再是固定那四个（2026-09-23）：设备上这一格只校验"长得像 key"，至于有没有这个区，
// 由页面按 分区.json 自己判。这里写死名单的话，页面里新建的分区一落盘就被服端清成空串。
const ZONE_KEY = /^[a-z0-9_-]{1,24}$/;
const ZONE_MAX = 9;

// 三台网络设备没有屏幕，os 那一格对它们不起作用，填 linux 只是别让下拉显示"Windows"那么别扭
const DEFAULTS = [
  { name: "笔记本", tier: "laptop", zone: "", power: true, hidden: false, os: "win", host: "", user: "", pass: "" },
  { name: "ITX", tier: "itx", zone: "", power: true, hidden: false, os: "win", host: "", user: "", pass: "" },
  { name: "mATX", tier: "matx", zone: "", power: true, hidden: false, os: "win", host: "", user: "", pass: "" },
  { name: "ATX", tier: "atx", zone: "", power: true, hidden: false, os: "win", host: "", user: "", pass: "" },
  { name: "E-ATX", tier: "eatx", zone: "", power: true, hidden: false, os: "win", host: "", user: "", pass: "" },
  { name: "NAS", tier: "nas", zone: "", power: true, hidden: false, os: "linux", host: "", user: "", pass: "" },
  { name: "交换机", tier: "switch", zone: "", power: true, hidden: false, os: "linux", host: "", user: "", pass: "" },
  { name: "路由器", tier: "router", zone: "", power: true, hidden: false, os: "linux", host: "", user: "", pass: "" },
];

// 只认这八个字段，字符串截断、布尔归一，档位不在表里就退回 mATX——配置文件被人手改过也不能把页面搞崩
// ⚠ pass 是明文口令：2026-09-23 你明确说"可以先写进配置文件"，所以这里收 pass 字段。
//    这个文件因此变成敏感文件：不要拷进仓库、不要进分享包、不要截图外传。
function normalize(list) {
  if (!Array.isArray(list)) return null;
  const out = [];
  for (const it of list.slice(0, 32)) {
    if (!it || typeof it !== "object") continue;
    const s = (v, n) => (typeof v === "string" ? v.slice(0, n) : "");
    const zone = s(it.zone, 24);
    out.push({
      name: s(it.name, 24) || "(未命名)",
      tier: TIERS.has(it.tier) ? it.tier : "matx",
      zone: ZONE_KEY.test(zone) ? zone : "",
      power: it.power !== false,
      // 新需求 2（设备可隐藏）：藏起来 = 场景里不摆、列表里不占格、开机不抓帧；文件里留着这一行，
      // 想放出来把 true 改回去就行（页面上那个开关写的就是它）。
      hidden: it.hidden === true,
      os: s(it.os, 8) === "linux" ? "linux" : "win",
      host: s(it.host, 64),
      user: s(it.user, 32),
      pass: s(it.pass, 64),
    });
  }
  return out.length ? out : null;
}

async function load() {
  if (!existsSync(FILE)) {
    await save(FILE, DEFAULTS);
    return { source: "seeded", list: DEFAULTS };
  }
  try {
    const parsed = normalize(JSON.parse(await readFile(FILE, "utf8")));
    if (!parsed) return { source: "invalid-fallback", list: DEFAULTS };
    return { source: "file", list: parsed };
  } catch (e) {
    return { source: "unreadable-fallback", list: DEFAULTS };
  }
}

// 分区表：服务端不预置内容（"默认四个区摆在哪"是页面的事，两处各写一份必然走散）。
// 文件还没生成过就回 { list: null }，页面保持它内置的默认摆位，改一次才生成本文件。
function normalizeZones(list) {
  if (!Array.isArray(list)) return null;
  const out = [];
  const seen = new Set();
  for (const it of list.slice(0, ZONE_MAX)) {
    if (!it || typeof it !== "object") continue;
    const key = typeof it.key === "string" ? it.key.slice(0, 24) : "";
    const cn = typeof it.cn === "string" ? it.cn.slice(0, 12) : "";
    const at = Array.isArray(it.at) ? it.at : [];
    const x = Number(at[0]), z = Number(at[1]);
    if (!ZONE_KEY.test(key) || seen.has(key)) continue;
    if (!Number.isFinite(x) || !Number.isFinite(z)) continue;
    if (Math.abs(x) > 100000 || Math.abs(z) > 100000) continue;   // 手改文件写个天文数字，页面全景会退到看不见
    seen.add(key);
    out.push({ key, cn: cn || ("分区 " + (out.length + 1)), at: [Math.round(x), Math.round(z)],
      // 新需求 1（分区可整体关闭）：关掉 = 地面上不画这块地的边框与区名标注，里面的设备也不摆出来。
      // 跟"删掉分区"是两回事：key / 名字 / 位置 / 归属全留着，改回 false 就原样回来。
      off: it.off === true });
  }
  return out.length ? out : null;
}
async function loadZones() {
  if (!existsSync(ZFILE)) return { source: "none", list: null };
  try {
    const parsed = normalizeZones(JSON.parse(await readFile(ZFILE, "utf8")));
    if (!parsed) return { source: "invalid", list: null };
    return { source: "file", list: parsed };
  } catch (e) {
    return { source: "unreadable", list: null };
  }
}

// 设置文件（设置弹窗里那几项）：三组，键名跟页面代码里用的名字一模一样 —— 不另起一套中文键，
// 多一层映射就多一处会走散的地方。
// 范围（哪一格 0.02~1、哪一格 200~5000）**不在服务端再抄一份**：那张真表是页面的
// PULSE_LIMITS / MON_LIMITS。这里只保"形状对、类型对"，越界值由页面钳回、再把钳过的结果写回来，
// 于是文件里躺的永远是"实际生效值"，人改文件时也能一眼看到自己写的值有没有被收掉。
// 顶层带 "_" 的字符串键（现在只有 _说明）是给人读的：磁盘上有就原样带走，没有就补 SET_NOTE 那一句。
const SET_SHAPE = {
  pulse: { enabled: "bool", pulseStartBrightness: "num", pulseEndBrightness: "num",
    upParticleBrightness: "num", travelK: "num" },
  ground: { rippleEnabled: "bool", rippleHeight: "num", rippleSpeed: "num",
    rippleThickness: "num", rippleBrightness: "num", dotSeg: "num", dotSizeMm: "num", rainEnabled: "bool", rainBrightness: "num" },
  monitor: { intervalMs: "num" },
};
// 文件第一行那句人话。放在服务端而不是页面里：整份删掉重建时也得有人写这一句，
// 否则"删了再打开"生出来的就是一份没有说明的裸 JSON。（页面只管值，不管文件长什么样。）
const SET_NOTE = "看板设置：pulse=脉冲 / ground=地面与雨 / monitor=采集频率。改这个文件即改看板，页面上每 5 秒自己读一次（不用刷新、不用碰那台机器的浏览器）；在页面里拖滑块/点开关也会写回这里。每一格的合法范围由页面把关，写了越界的值会被自动收进范围内、并把这个文件改写成实际生效值。三组少了哪一组就整组保持默认；整份删掉，下次打开页面会按默认值重新生成一份。";
function normalizeSettings(obj) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return null;
  const settings = {};
  let seen = 0;
  for (const g in SET_SHAPE) {
    const src = obj[g] && typeof obj[g] === "object" ? obj[g] : {};
    const out = {};
    for (const k in SET_SHAPE[g]) {
      const v = src[k];
      if (SET_SHAPE[g][k] === "bool") {
        if (typeof v === "boolean") { out[k] = v; seen++; }
      } else if (typeof v === "number" && Number.isFinite(v)) { out[k] = v; seen++; }
    }
    settings[g] = out;
  }
  if (!seen) return null;   // 三组一个认得的键都没有 = 这不是设置文件，别拿它去盖掉磁盘上的
  const extra = {};
  for (const k of Object.keys(obj)) if (k.startsWith("_") && typeof obj[k] === "string") extra[k] = obj[k].slice(0, 500);
  return { settings, extra };
}
// 文件还没生成过就回 { settings: null }，页面拿自己那套默认值写第一份（"部署后有个能改的东西"）。
// 文件存在但内容坏了（被手改残）同样回 null，页面会把生效值写回去 —— 坏文件不该一直坏着。
async function loadSettings() {
  if (!existsSync(SFILE)) return { source: "none", settings: null };
  try {
    const parsed = normalizeSettings(JSON.parse(await readFile(SFILE, "utf8")));
    if (!parsed) return { source: "invalid", settings: null };
    return { source: "file", settings: parsed.settings };
  } catch (e) {
    return { source: "unreadable", settings: null };
  }
}
async function saveSettings(settings, extra) {
  // 磁盘上原有的 _说明 原样带走（人改过那句话就照他改的）；文件不存在或没这句话，就补服务端这一份。
  let head = extra && Object.keys(extra).length ? Object.assign({}, extra) : {};
  if (!Object.keys(head).length) {
    try {
      const cur = JSON.parse(await readFile(SFILE, "utf8"));
      for (const k of Object.keys(cur)) if (k.startsWith("_") && typeof cur[k] === "string") head[k] = cur[k].slice(0, 500);
    } catch { /* 文件还不存在 */ }
  }
  if (!head._说明) head._说明 = SET_NOTE;
  // head 先放进去，_说明 才会排在文件最上面
  await save(SFILE, Object.assign(head, settings));
}

// 先写临时文件再改名：中途崩溃不会留下半个 JSON
async function save(file, list) {
  const tmp = file + ".tmp";
  await writeFile(tmp, JSON.stringify(list, null, 2) + "\n", "utf8");
  await rename(tmp, file);
}

function send(res, code, body, type = "application/json; charset=utf-8") {
  res.writeHead(code, { "content-type": type, "cache-control": "no-store" });
  res.end(body);
}

// ---------- 连通性 / 抓一帧 ----------
// 凭据存在 设备清单.json 里（你 2026-09-23 同意的），本文件不写死任何凭据；
// 每次探测只把页面传来的这几个值用一次：不进日志、不进响应体、不回显给调用方。
// 传输层已装好（npm i ssh2）；没装的话每条请求会明确报"未安装"，方便换机复现。
//
// 两种系统两套抓法（设备清单里的 os 那一格决定走哪条），两边都是"整段脚本走 stdin"：
//   linux → sh -s
//   win   → powershell -NoProfile -ExecutionPolicy Bypass -Command -
// 2026-09-24 为什么从"拼一条命令行 / base64 -EncodedCommand"改成 stdin：
//   ① Windows 的 OpenSSH 远端 shell 是 cmd.exe，命令行总长 8191 字符 —— 字段一多，base64 那一段
//      直接把命令行撑爆，症状是 SSH 层 client-socket（看着像网络不通）。stdin 没有这个长度限制。
//   ② 走 stdin 时 PowerShell 是**一行一行**执行的：多行语句块（if/foreach 跨行）会静默不执行、
//      一个字都不输出。所以 PROBE_PS 必须收成单行（它是单行）。另一条实测：Add-Type 的 C# 源
//      也只能是单行字符串，多行 here-string 同样会静默断掉。
// 两边都输出同一套 KEY=value 行（同一个 KEY 多行 = 一组），再由下面同一段解析变成 frame。
// 记录内的字段顺序在两条脚本里必须完全一致：VOL / PDISK / NIC / DRATE / NETRATE / GPUINFO。
//
// 关于 LOAD 这一格：linux 出的是 /proc/loadavg 的 1 分钟均值（负载，不是占用率）；win 出的是
// "把 CIM 的 LoadPercentage 折成等效负载"（pct × 核数 ÷ 100）。两条都是老口径，页面那条
// 负载 ÷ 核数 × 100 的老公式照样成立；要真占用率看 frame.cpu.pct / frame.cpu.perCore。
// 原文各留一份在 00-暂存\hm3d-p2-sh.sh 与 00-暂存\hm3d-p2-win1.ps1，都已在真机上跑通过。
// 这里的脚本用 String.raw 原样收进来：里面的 \r \n \t \/ 是给 bash / awk / PowerShell 看的转义，
// 不能被 JS 先吃掉（普通模板串会把 \r \n 变成真字符、把 \d 变成 d）。
const PROBE_SH = String.raw`LC_ALL=C; export LC_ALL
echo "HOST=$(hostname 2>/dev/null)"
OS=$(. /etc/os-release 2>/dev/null && echo "$PRETTY_NAME")
[ -n "$OS" ] || OS=$(uname -s)
echo "OS=$OS"
echo "UP=$(cut -d. -f1 /proc/uptime 2>/dev/null)"
# 老键 DISK=（根分区 总量,已用）留着：加新字段之前页面读的就是它，删了 compat 面就断了。
# 新的逐卷明细在下面的 VOL 里，这条只是"老页面不用改也能继续显示根分区那一格"。
echo "DISK=$(df -B1 -P / 2>/dev/null | awk 'NR==2{print $2","$3}')"

# ---------- CPU ----------
CPUMODEL=$(awk -F: '/^model name/{sub(/^ +/,"",$2);print $2;exit}' /proc/cpuinfo)
[ -n "$CPUMODEL" ] || CPUMODEL=$(lscpu 2>/dev/null | awk -F: '/Model name/{sub(/^ +/,"",$2);print $2;exit}')
echo "CPUMODEL=$CPUMODEL"
echo "LOGICAL=$(getconf _NPROCESSORS_ONLN 2>/dev/null || grep -c '^processor' /proc/cpuinfo)"
PHYS=$(lscpu -p=CORE,SOCKET 2>/dev/null | grep -v '^#' | sort -u | wc -l | tr -d ' ')
case "$PHYS" in ''|*[!0-9]*) PHYS=0;; esac
[ "$PHYS" -gt 0 ] 2>/dev/null || PHYS=$(awk -F: '/^cpu cores/{sub(/ /,"",$2);print $2;exit}' /proc/cpuinfo)
echo "CORES=$PHYS"
echo "CPUMAXMHZ=$(lscpu 2>/dev/null | awk -F: '/CPU max MHz/{gsub(/ /,"",$2);printf "%.0f",$2+0}')"
echo "CPUCURMHZ=$(awk -F: '/^cpu MHz/{s+=$2;n++} END{if(n)printf "%.0f",s/n}' /proc/cpuinfo)"
echo "LOAD=$(cut -d' ' -f1 /proc/loadavg)"
FREQ=$(awk -F: '/^cpu MHz/{v=$2;sub(/^ +/,"",v);printf "%s%.0f",(n++?",":""),v+0} END{if(n)printf "\n"}' /proc/cpuinfo)
[ -n "$FREQ" ] && echo "PCFREQ=$FREQ"
# 温度只有 x86 的 lm-sensors 给得出（k10temp / coretemp）；取不到就不报，不编
T=$(sensors 2>/dev/null | awk '/^Tctl:|^Tdie:|^Package id 0:/{v=$2;gsub(/[+°C]/,"",v);print v;exit}')
[ -n "$T" ] && echo "CPUTEMP=$T"

# ---------- 内存 ----------
awk '
  /^MemTotal:/{t=$2}
  /^MemAvailable:/{a=$2}
  /^MemFree:/{f=$2}
  /^Buffers:/{b=$2}
  /^Cached:/{c=$2}
  /^SwapTotal:/{st=$2}
  /^SwapFree:/{sf=$2}
  END{
    if(a=="")a=f+b+c;
    if(t=="")exit;
    printf "MEM=%d,%d\n", t/1024, (t-a)/1024;
    if(c!="")printf "MEMCACHE=%d\n", c/1024;
    if(st!="")printf "SWAP=%d,%d\n", st/1024, (st-sf)/1024;
  }' /proc/meminfo
# 类型 / 频率 / 条数：dmidecode 要 root，能免密提权就取；取不到整段不输出（不编）
SUDO=""
sudo -n true 2>/dev/null && SUDO="sudo -n"
$SUDO dmidecode -t 17 2>/dev/null | awk -F: '
  function t(s){sub(/^ +/,"",s);sub(/ +$/,"",s);return s}
  /^[ \t]*(Size|Type|Speed|Configured Memory Speed):/{
    k=$1; gsub(/[ \t]/,"",k); v=t($2);
    if(k=="Size"){ if(v=="" || v ~ /No Module/) cur=0; else { n++; cur=n } ; next }
    if(!cur) next
    if(k=="Type" && v ~ /DDR/) ty[cur]=v
    else if(k=="Speed" || k=="ConfiguredMemorySpeed") if(v ~ /^[0-9]/){ sub(/ .*/,"",v); sp[cur]=v }
  }
  END{
    if(!n)exit
    printf "MMOD=%d\n", n;
    if(ty[1])printf "MEMTYPE=%s\n", ty[1];
    if(sp[1])printf "MEMSPD=%s\n", sp[1];
  }'
# 两次采样（隔 1 秒）：每核占用 / 磁盘速率 / 网卡速率都从这一秒里算
S1=$(cat /proc/stat); D1=$(cat /proc/diskstats); N1=$(cat /proc/net/dev)
sleep 1
S2=$(cat /proc/stat); D2=$(cat /proc/diskstats); N2=$(cat /proc/net/dev)

echo "$S1" | awk -v B="$S2" '
  /^cpu[0-9]/{
    t=0; for(i=2;i<=NF;i++) t+=$i;
    idx=substr($1,4)+0; T1[idx]=t; I1[idx]=$5+$6;
  }
  END{
    m=split(B,L,"\n"); o="";
    for(k=1;k<=m;k++){
      nf=split(L[k],F," ");
      if(F[1] !~ /^cpu[0-9]/) continue;
      idx=substr(F[1],4)+0; t=0;
      for(i=2;i<=nf;i++) t+=F[i];
      dt=t-T1[idx]; di=(F[5]+F[6])-I1[idx];
      p=(dt>0)?(100*(dt-di)/dt):0;
      if(p<0)p=0; if(p>100)p=100;
      o=o (o?",":"") sprintf("%.0f",p);
    }
    if(o) printf "PCU=%s\n", o;
  }'

# ---------- 显卡 ----------
NSMI=""
for p in nvidia-smi /usr/bin/nvidia-smi /usr/local/bin/nvidia-smi; do
  command -v "$p" >/dev/null 2>&1 || continue
  OUT=$("$p" --query-gpu=name,utilization.gpu,memory.total,memory.used,temperature.gpu,power.draw,power.limit,fan.speed,clocks.current.graphics,driver_version --format=csv,noheader,nounits 2>/dev/null)
  if [ -n "$OUT" ]; then
    NSMI=1
    echo "$OUT" | while IFS= read -r l; do
      [ -n "$l" ] && echo "GPUINFO=$l"
    done
    echo "GPU=$(echo "$OUT" | head -1 | cut -d, -f2-5 | tr -d ' ')"
    break
  fi
done
# 没有 nvidia-smi 的机器至少要报出型号（有 nvidia-smi 就不报，免得同一张卡出现两次）
if [ -z "$NSMI" ]; then
  lspci 2>/dev/null | grep -iE 'vga compatible controller|3d controller|display controller' | sed 's/^[0-9a-fA-F:.]* //; s/^[^:]*controller: //' | while IFS= read -r l; do
    [ -n "$l" ] && echo "GPUNAME=$l"
  done
fi

# ---------- 存储 ----------
# PDISK=名字|字节数|介质(SSD/HDD)|总线(NVMe/SATA/USB)|健康(未知留空)  ← 与 Windows 同序
BLK=""
for d in /sys/block/*; do
  n=$(basename "$d")
  case "$n" in loop*|ram*|sr*|dm-*|zram*|md*) continue;; esac
  sz=$(cat "$d/size" 2>/dev/null)
  case "$sz" in ''|*[!0-9]*) continue;; esac
  ro=$(cat "$d/queue/rotational" 2>/dev/null)
  md=$(cat "$d/device/model" 2>/dev/null | tr -d '\r' | tr '|' '/')
  med=SSD; [ "$ro" = "1" ] && med=HDD
  bus=SATA
  case "$n" in nvme*) bus=NVMe;; mmcblk*) bus=MMC;; esac
  echo "PDISK=$n|$((sz*512))|$med|$bus|"
  BLK="$BLK$n|$md|$med
"
done
# 一个挂载点一张卡：VOL=名字|字节数|可用|卷标(挂载点)|文件系统|物理盘型号|总线|介质 ← 与 Windows 同序
df -B1 -P -T 2>/dev/null | awk -v B="$BLK" '
  BEGIN{ m=split(B,L,"\n"); for(i=1;i<=m;i++){ if(!L[i])continue; split(L[i],F,"|"); MD[F[1]]=F[2]; MED[F[1]]=F[3] } }
  NR>1 && $1 ~ /^\/dev\/(sd|nvme|hd|vd|mmcblk|xvd)/{
    p=$1; sub(/.*\//,"",p);
    par=p; if(par ~ /[0-9]$/) sub(/p?[0-9]+$/,"",par);
    bus="SATA"; if(par ~ /^nvme/)bus="NVMe"; if(par ~ /^mmcblk/)bus="MMC";
    printf "VOL=%s|%s|%s|%s|%s|%s|%s|%s\n", p, $3, $5, $NF, $2, MD[par], bus, MED[par];
  }'
echo "$D1" | awk -v B="$D2" '
  { R1[$3]=$6; W1[$3]=$10 }
  END{
    m=split(B,L,"\n");
    for(k=1;k<=m;k++){
      nf=split(L[k],F," ");
      nm=F[3]; dr=F[6]-R1[nm]; dw=F[10]-W1[nm];
      if(dr<0)dr=0; if(dw<0)dw=0;
      if(dr||dw) printf "DRATE=%s|%d|%d\n", nm, dr*512, dw*512;
    }
  }'

# ---------- 网络 ----------
echo "$N1" | awk -v B="$N2" '
  function nm(s,i){ i=index(s,":"); s=(i?substr(s,1,i-1):""); gsub(/[ \t]/,"",s); return s }
  function rest(s,i){ i=index(s,":"); return (i?substr(s,i+1):"") }
  function ok(n){ return (n ~ /^[A-Za-z0-9._-]+$/) }
  { n=nm($0); if(!ok(n))next; r=rest($0); gsub(/^ +/,"",r); split(r,F," ");
    RX1[n]=F[1]; TX1[n]=F[9] }
  END{
    m=split(B,L,"\n");
    for(k=1;k<=m;k++){
      n=nm(L[k]); if(!ok(n))continue; r=rest(L[k]); gsub(/^ +/,"",r); split(r,F," ");
      dr=F[1]-RX1[n]; dt=F[9]-TX1[n];
      if(dr<0)dr=0; if(dt<0)dt=0;
      printf "NETRATE=%s|%d|%d\n", n, dr, dt;
    }
  }'
# NIC=名字|在线|链路Mbps|IP|MAC|虚拟|驱动 ← 与 Windows 同序
for d in /sys/class/net/*; do
  n=$(basename "$d")
  [ "$n" = "lo" ] && continue
  st=$(cat "$d/operstate" 2>/dev/null)
  sp=$(cat "$d/speed" 2>/dev/null)
  mac=$(cat "$d/address" 2>/dev/null)
  drv=$(grep -m1 '^DRIVER=' "$d/device/uevent" 2>/dev/null | cut -d= -f2)
  ip=$(ip -4 -o addr show dev "$n" 2>/dev/null | awk '{print $4}' | head -1)
  up=0; [ "$st" = "up" ] && up=1
  case "$n" in veth*|docker*|br-*|virbr*|zt*|tun*|tap*|wg*|tailscale*) v=1;; *) v=0;; esac
  echo "NIC=$n|$up|$sp|$ip|$mac|$v|$drv"
done
echo "DONE=1"`;
const PROBE_PS = String.raw`[Console]::OutputEncoding=[Text.Encoding]::UTF8; $ProgressPreference='SilentlyContinue'; $ErrorActionPreference='SilentlyContinue'; function L($k,$v){ Write-Output ($k + '=' + [string]$v) }; function S($s){ if($null -eq $s){ return '' }; $t=[string]$s; $t=$t -replace '\|','/'; $t=$t -replace '[\r\n]+',' '; return $t.Trim() }; $os=Get-CimInstance Win32_OperatingSystem; L 'HOST' $env:COMPUTERNAME; if($os){ L 'OS' (S $os.Caption); if($os.LastBootUpTime){ L 'UP' ([int]((Get-Date)-$os.LastBootUpTime).TotalSeconds) } }; $cpu=@(Get-CimInstance Win32_Processor); $model=($cpu|Select-Object -First 1).Name; if($model){ L 'CPUMODEL' (S $model) }; $phys=($cpu|Measure-Object -Property NumberOfCores -Sum).Sum; $logi=($cpu|Measure-Object -Property NumberOfLogicalProcessors -Sum).Sum; if($phys){ L 'CORES' $phys }; if($logi){ L 'LOGICAL' $logi }; $mx=($cpu|Measure-Object -Property MaxClockSpeed -Maximum).Maximum; if($mx){ L 'CPUMAXMHZ' $mx }; $pct=($cpu|Measure-Object -Property LoadPercentage -Average).Average; if($null -ne $pct){ $pct=[math]::Round($pct,0); L 'CPU' $pct; if($phys){ L 'LOAD' ([math]::Round($pct*$phys/100,2)) } }; if(-not ('HmCpuSet' -as [type])){ Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;public class HmCpuSet{[DllImport("kernel32.dll",SetLastError=true)]static extern bool GetSystemCpuSetInformation(IntPtr i,uint l,out uint r,IntPtr p,uint f);public static byte[] Get(uint n){IntPtr b=Marshal.AllocHGlobal((int)n);uint r=0;bool ok=GetSystemCpuSetInformation(b,n,out r,IntPtr.Zero,0);byte[] o=new byte[r];if(r>0)Marshal.Copy(b,o,0,(int)r);Marshal.FreeHGlobal(b);if(!ok&&r==0)return null;return o;}}' }; try{ $b=[HmCpuSet]::Get(131072); if($b -and $b.Length -ge 32){ $n=[int]($b.Length/32); $ids=New-Object System.Collections.ArrayList; $cls=New-Object System.Collections.ArrayList; for($i=0;$i -lt $n;$i++){ $o=$i*32; if([BitConverter]::ToUInt32($b,$o) -ne 32){ break }; if([BitConverter]::ToInt32($b,$o+4) -ne 0){ continue }; [void]$ids.Add([BitConverter]::ToInt32($b,$o+8)); [void]$cls.Add([int]$b[$o+18]) }; if($ids.Count -gt 1){ $maxc=($cls|Measure-Object -Maximum).Maximum; $minc=($cls|Measure-Object -Minimum).Minimum; if($maxc -ne $minc){ $ln=$ids.Count; if($logi){ $ln=[int]$logi }; $arr=New-Object string[] $ln; for($i=0;$i -lt $ln;$i++){ $arr[$i]='' }; $np=0; $ne=0; for($i=0;$i -lt $ids.Count;$i++){ $ix=[int]$ids[$i]; $kk='E'; if($cls[$i] -eq $maxc){ $kk='P' }; if($kk -eq 'P'){ $np++ } else { $ne++ }; if($ix -ge 0 -and $ix -lt $ln){ $arr[$ix]=$kk } }; $thr=1; if($logi -and $phys){ $thr=[math]::Max(1,[math]::Round($logi/$phys)) }; L 'CPUP' ([math]::Round($np/$thr)); L 'CPUE' ([math]::Round($ne/$thr)); L 'PCLS' ($arr -join ',') } } } }catch{ }; $pi=@(Get-CimInstance Win32_PerfFormattedData_Counters_ProcessorInformation|Where-Object{ $_.Name -match '^\d+,\d+$' }|ForEach-Object{ $q=$_.Name -split ','; [pscustomobject]@{ g=[int]$q[0]; i=[int]$q[1]; v=[int]$_.PercentProcessorTime } }|Sort-Object g,i); if($pi.Count){ L 'PCU' (($pi|ForEach-Object{ [math]::Min(100,[math]::Max(0,$_.v)) }) -join ',') }; $mods=@(Get-CimInstance Win32_PhysicalMemory); if($mods.Count){ L 'MMOD' $mods.Count }; $ty=@($mods|ForEach-Object{ $t=[int]$_.SMBIOSMemoryType; if($t -eq 34){ 'DDR5' } elseif($t -eq 26){ 'DDR4' } elseif($t -eq 24){ 'DDR3' } elseif($t -eq 20){ 'DDR2 FB-DIMM' } elseif($t -eq 19){ 'DDR2' } elseif($t -eq 18){ 'DDR' } elseif($t -eq 17){ 'RDRAM' } elseif($t -eq 16){ 'SGRAM' } elseif($t -eq 15){ 'SDRAM' } elseif($t -eq 2){ 'DRAM' } else { $m=[int]$_.MemoryType; if($m -eq 26){ 'DDR4' } elseif($m -eq 24){ 'DDR3' } elseif($m -eq 21){ 'DDR2' } elseif($m -eq 20){ 'DDR' } elseif($m -eq 17 -or $m -eq 3){ 'SDRAM' } elseif($m -eq 2){ 'DRAM' } else { '' } } }|Where-Object{ $_ }|Select-Object -Unique); if($ty.Count){ L 'MEMTYPE' ($ty -join '/') }; $sp=@($mods|ForEach-Object{ if($_.ConfiguredClockSpeed -gt 0){ $_.ConfiguredClockSpeed } elseif($_.Speed -gt 0){ $_.Speed } }|Where-Object{ $_ }); if($sp.Count){ L 'MEMSPD' (($sp|Measure-Object -Minimum).Minimum) }; if($os.TotalVisibleMemorySize){ $ci=[Globalization.CultureInfo]::InvariantCulture; L 'MEM' ([math]::Round($os.TotalVisibleMemorySize/1024).ToString($ci) + ',' + [math]::Round(($os.TotalVisibleMemorySize-$os.FreePhysicalMemory)/1024).ToString($ci)) }; $perf=@(Get-CimInstance Win32_PerfFormattedData_PerfDisk_LogicalDisk); foreach($v in (Get-CimInstance Win32_LogicalDisk -Filter "DriveType=3")){ $id=[string]$v.DeviceID; $md=''; $bus=''; $media=''; $letter=$id.TrimEnd(':'); $pt=Get-Partition -DriveLetter $letter -ErrorAction SilentlyContinue; if($pt){ $dk=Get-Disk -Number $pt.DiskNumber -ErrorAction SilentlyContinue; if($dk){ $md=S $dk.FriendlyName; $bus=[string]$dk.BusType; $media=[string]$dk.MediaType } }; L 'VOL' ($id+'|'+[string]$v.Size+'|'+[string]$v.FreeSpace+'|'+(S $v.VolumeName)+'|'+[string]$v.FileSystem+'|'+$md+'|'+$bus+'|'+$media); $pr=$perf|Where-Object{ $_.Name -eq $id }|Select-Object -First 1; if($pr){ L 'DRATE' ($id+'|'+[string][int64]$pr.DiskReadBytesPerSec+'|'+[string][int64]$pr.DiskWriteBytesPerSec) } }; foreach($d in (Get-PhysicalDisk)){ L 'PDISK' ((S $d.FriendlyName)+'|'+[string]$d.Size+'|'+[string]$d.MediaType+'|'+[string]$d.BusType+'|'+[string]$d.HealthStatus) }; $nsmi=$null; foreach($p in @('nvidia-smi',(Join-Path $env:ProgramFiles 'NVIDIA Corporation\NVSMI\nvidia-smi.exe'),(Join-Path $env:SystemRoot 'System32\nvidia-smi.exe'))){ try{ $o=& $p '--query-gpu=name,utilization.gpu,memory.total,memory.used,temperature.gpu,power.draw,power.limit,fan.speed,clocks.current.graphics,driver_version' '--format=csv,noheader,nounits' 2>$null; if($o -and "$o".Trim()){ $nsmi=@($o|Where-Object{ "$_".Trim() }); break } }catch{ } }; if($nsmi){ foreach($l in $nsmi){ L 'GPUINFO' (S $l) }; L 'GPU' (((($nsmi[0] -split ',')[1..4]) -join ',') -replace ' ','') } else { foreach($g in (Get-CimInstance Win32_VideoController)){ L 'GPUNAME' (S $g.Name) } }; $b1=@{}; foreach($s in (Get-NetAdapterStatistics)){ $b1[$s.Name]=@([int64]$s.ReceivedBytes,[int64]$s.SentBytes) }; Start-Sleep -Seconds 1; foreach($a in (Get-NetAdapter)){ $link=0; if($a.Speed){ $link=[int64]([int64]$a.Speed/1000000) }; $up=0; if($a.Status -eq 'Up'){ $up=1 }; $virt=0; if($a.Virtual -eq $true){ $virt=1 }; $ip=''; $ia=Get-NetIPAddress -InterfaceIndex $a.ifIndex -AddressFamily IPv4 -ErrorAction SilentlyContinue|Where-Object{ $_.IPAddress -notlike '169.254.*' }|Select-Object -First 1; if($ia){ $ip=[string]$ia.IPAddress }; L 'NIC' ((S $a.Name)+'|'+$up+'|'+$link+'|'+$ip+'|'+[string]$a.MacAddress+'|'+$virt+'|'+(S $a.InterfaceDescription)); $s=Get-NetAdapterStatistics -Name $a.Name -ErrorAction SilentlyContinue; if($s){ $rx=[int64]$s.ReceivedBytes; $tx=[int64]$s.SentBytes; if($b1.ContainsKey($a.Name)){ $rx=$rx-$b1[$a.Name][0]; $tx=$tx-$b1[$a.Name][1] }; if($rx -lt 0){ $rx=0 }; if($tx -lt 0){ $tx=0 }; L 'NETRATE' ((S $a.Name)+'|'+$rx+'|'+$tx) } }; $sys=@(Get-CimInstance Win32_LogicalDisk -Filter "DriveType=3"|Where-Object{ $_.DeviceID -eq $env:SystemDrive })[0]; if($sys){ L 'DISK' ([string]$sys.Size + ',' + [string]($sys.Size-$sys.FreeSpace)) }; L 'DONE' 1`;;
// 脚本整段走 stdin 的那两条命令。stdin 没有 cmd.exe 那条 8191 字符的上限，字段想加多少加多少。
const PROBE_CMD = { linux: "sh -s", win: "powershell -NoProfile -ExecutionPolicy Bypass -Command -" };

let ssh2mod = null;
try { ssh2mod = await import("ssh2"); } catch { /* 没装就是没装，下面会报出来 */ }

// 探测审计：只记时间 + 目标主机 + 成败 + 错误首行，绝不记用户名/口令。
// 有了它，"有没有偷偷连过某台机器"是可以在磁盘上查证的，不用凭印象说。
const LOG = path.join(DIR, "探测记录.log");
async function logProbe(host, ok, msg) {
  try {
    await appendFile(LOG, new Date().toISOString() + "  " + (ok ? "OK  " : "FAIL") + "  " + host + (msg ? "  " + String(msg).split("\n")[0].slice(0, 120) : "") + "\n");
  } catch { /* 日志写不进不影响主流程 */ }
}

// 只允许页面自己调：挡掉别的网站往这个端口上打。
// 口径是" Origin 的主机 == 请求打到的 Host "，不是写死 127.0.0.1 —— 写死的话，从
// http://10.226.127.138:8123 打开的页面发回 /api/probe 时自带 Origin: 10.226.127.138:8123，
// 会被自己挡掉，症状是"远端页面画得出来、但一台机器的数据都抓不到"。
// 同源比对仍然是真同源：evil.com 打过来照样 403。
function sameOrigin(req) {
  const o = req.headers.origin;
  if (!o) return true;
  try { return new URL(o).host === req.headers.host; } catch { return false; }
}

// ---------- 把 KEY=value 行变成一帧 ----------
// 同一个 KEY 出现多行 = 一组（VOL / PDISK / NIC / DRATE / NETRATE / GPUINFO 都是）。
// 老字段名一个不动（HOST/OS/CORES/MEM/LOAD/CPU/DISK/GPU）—— 那是"即配即用"的兼容面；
// 新字段取不到就是 null / 空数组，页面据此把那一块整个藏掉，绝不拿模拟值顶上。
function parseLines(out) {
  const recs = {};
  for (const raw of String(out || "").split("\n")) {
    const l = raw.replace(/\r/g, "").trim();
    if (!l || l[0] === "#") continue;
    const i = l.indexOf("=");
    if (i <= 0) continue;
    const k = l.slice(0, i).trim();
    if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(k)) continue;   // stderr / CLIXML 混进来的杂行不认
    (recs[k] || (recs[k] = [])).push(l.slice(i + 1).trim());
  }
  return recs;
}
const oneOf = (R, k) => (R[k] && R[k].length ? R[k][0] : undefined);
const numOf = (v) => (v != null && v !== "" && Number.isFinite(Number(v)) ? Number(v) : null);
const listOf = (R, k) => {
  const s = oneOf(R, k);
  if (s === undefined || s === "") return null;
  const a = s.split(",").map((x) => Number(x)).filter((x) => Number.isFinite(x));
  return a.length ? a : null;
};
const pairOf = (R, k) => { const a = listOf(R, k); return a && a.length >= 2 ? [a[0], a[1]] : null; };
const clampPct = (v) => (v == null ? null : Math.min(100, Math.max(0, Math.round(v))));
const rowsOf = (R, k, n) => (R[k] || []).map((r) => r.split("|").map((x) => x.trim())).filter((f) => f.length >= n);
// nvidia-smi 的 [N/A] / [Not Supported] 一律变 null —— 编一个 0 出来最误导人
const csvNum = (s) => (s == null || s === "" || /^\[?(n\/?a|not supported)\]?$/i.test(s) ? null
  : (Number.isFinite(Number(s)) ? Number(s) : null));

function buildFrame(out) {
  const R = parseLines(out);
  const mem = pairOf(R, "MEM") || [0, 0];
  const swp = pairOf(R, "SWAP");
  const dsk = pairOf(R, "DISK");
  // 老字段 GPU=：两面都出这一行（nvidia-smi 第一行的 利用率,显存总量,显存已用,温度），
  // 解析方式跟加新字段之前一模一样，页面老代码不用改。
  const g = oneOf(R, "GPU");
  const gpu = g && g !== "none"
    ? (() => { const a = g.split(",").map(Number); return { util: a[0], memTotalMb: a[1], memUsedMb: a[2], temp: a[3] }; })()
    : null;
  // 新字段：显卡逐张（nvidia-smi 一行一张）。142 那台两张 2080 Ti 走的就是这里。
  const gpus = (R.GPUINFO || []).map((r) => {
    const f = r.split(",").map((x) => x.trim());
    return { name: f[0] || "", util: clampPct(csvNum(f[1])), memTotalMb: csvNum(f[2]), memUsedMb: csvNum(f[3]),
      tempC: csvNum(f[4]), powerW: csvNum(f[5]), powerLimitW: csvNum(f[6]), fanPct: csvNum(f[7]),
      clockMhz: csvNum(f[8]), driver: f[9] || "" };
  });
  // 有型号没指标的那种：nvidia-smi 不在，但 lspci / WMI 报了名字。名字是真数据，单独一栏，
  // 页面按"只有型号"画，不去编利用率。
  const gpuNames = (R.GPUNAME || []).slice(0, 8);
  const perCore = listOf(R, "PCU");
  const pctFromCores = perCore && perCore.length
    ? Math.round(perCore.reduce((a, b) => a + b, 0) / perCore.length) : null;
  const cpuPctWin = oneOf(R, "CPU") === undefined ? null : clampPct(Number(oneOf(R, "CPU")));
  // 速率是先按名字建索引、再并进对应那张网卡 / 那个卷
  const rates = {};
  for (const r of (R.NETRATE || [])) {
    const f = r.split("|");
    if (f.length >= 3) rates[f[0].trim()] = { rxBps: Number(f[1]) || 0, txBps: Number(f[2]) || 0 };
  }
  const drates = {};
  for (const r of (R.DRATE || [])) {
    const f = r.split("|");
    if (f.length >= 3) drates[f[0].trim()] = { readBps: Number(f[1]) || 0, writeBps: Number(f[2]) || 0 };
  }
  return {
    // ---- 老字段（一条不动）----
    hostname: oneOf(R, "HOST") || "", os: oneOf(R, "OS") || "",
    cores: numOf(oneOf(R, "CORES")) || 0, load1: numOf(oneOf(R, "LOAD")) || 0,
    // win 是 CIM 的真占用率；linux 没有这个数，就用刚采到的每逻辑核占用率求平均（不是拿负载均值假装）
    cpuPct: cpuPctWin !== null ? cpuPctWin : pctFromCores,
    memTotalMb: Math.round(mem[0] || 0), memUsedMb: Math.round(mem[1] || 0),
    diskTotalBytes: dsk ? dsk[0] : 0, diskUsedBytes: dsk ? dsk[1] : 0,
    gpu, at: new Date().toISOString(),
    // ---- 新字段（取不到就是 null / []）----
    uptimeSec: numOf(oneOf(R, "UP")),
    cpu: {
      model: oneOf(R, "CPUMODEL") || null,
      phys: numOf(oneOf(R, "CORES")), logical: numOf(oneOf(R, "LOGICAL")),
      p: numOf(oneOf(R, "CPUP")), e: numOf(oneOf(R, "CPUE")),
      pct: cpuPctWin !== null ? cpuPctWin : pctFromCores,
      maxMhz: numOf(oneOf(R, "CPUMAXMHZ")),
      curMhz: numOf(oneOf(R, "CPUCURMHZ")),        // 只有 linux 有；Windows 取不到实时频率
      tempC: numOf(oneOf(R, "CPUTEMP")),           // 只有 linux 有；Windows 取不到 CPU 温度
      perCore, perMhz: listOf(R, "PCFREQ"),        // perMhz 只有 linux 有
      pcls: oneOf(R, "PCLS") ? oneOf(R, "PCLS").split(",").map((x) => x.trim()) : null,   // 只有 win 有
    },
    mem: {
      type: oneOf(R, "MEMTYPE") || null, speedMhz: numOf(oneOf(R, "MEMSPD")),
      modules: numOf(oneOf(R, "MMOD")), cacheMb: numOf(oneOf(R, "MEMCACHE")),
      swapTotalMb: swp ? swp[0] : null, swapUsedMb: swp ? swp[1] : null,
    },
    // VOL=id|sizeBytes|freeBytes|label|fs|model|bus|media（windows 的 label 是卷标、linux 的是挂载点）
    disks: rowsOf(R, "VOL", 3).map((f) => Object.assign({ id: f[0], sizeBytes: Number(f[1]) || 0,
      freeBytes: Number(f[2]) || 0, label: f[3] || "", fs: f[4] || "", model: f[5] || "",
      bus: f[6] || "", media: f[7] || "" }, drates[f[0]] || { readBps: null, writeBps: null })),
    // PDISK=name|sizeBytes|media|bus|health（整块物理盘；health 只有 windows 有）
    physDisks: rowsOf(R, "PDISK", 2).map((f) => ({ name: f[0], sizeBytes: Number(f[1]) || 0,
      media: f[2] || "", bus: f[3] || "", health: f[4] || "" })),
    gpus, gpuNames,
    // NIC=name|up|linkMbps|ip|mac|virtual|desc
    nics: rowsOf(R, "NIC", 4).map((f) => Object.assign({ name: f[0], up: f[1] === "1",
      linkMbps: Number(f[2]) || 0, ip: f[3] || "", mac: f[4] || "", virtual: f[5] === "1",
      desc: f[6] || "" }, rates[f[0]] || { rxBps: null, txBps: null })),
    done: oneOf(R, "DONE") === "1",
  };
}

// 口令可以为空：办公那几台 Windows 是"账号 user、不设密码"，空口令是它们的正常配置，
// 不是"没填全"。所以这道门只看地址和用户名（linux 那几台口令不对的话，下面会如实报失败）。
function probe({ host, user, pass, os }) {
  return new Promise((resolve) => {
    if (!ssh2mod) return resolve({ ok: false, error: "本机未安装 ssh2（在项目目录跑 npm i ssh2 后重启 serve.mjs）" });
    if (!host || !user) return resolve({ ok: false, error: "地址或用户名为空" });
    // 只认准 "win" 两个字：别的（含没传）一律按 linux 那条老路子走，跟加这个分支之前一样
    const win = os === "win";
    const script = win ? PROBE_PS : PROBE_SH;
    // Windows 上 PowerShell 冷启动就要好几秒（实测 138 / 195 各 10~11 s，含两次网速采样之间那 1 s），
    // 原来 25 s 那条线已经会掐掉正常的连接，放宽到 45 s；linux 实测 1.6 s，给 15 s。
    const budget = win ? 45000 : 15000;
    const conn = new ssh2mod.Client();
    const timer = setTimeout(() => { conn.end(); resolve({ ok: false, error: "连接超时（" + Math.round(budget / 1000) + "s）" }); }, budget);
    const fail = (msg) => { clearTimeout(timer); conn.end(); resolve({ ok: false, error: String(msg).slice(0, 200) }); };
    conn.on("ready", () => {
      conn.exec(win ? PROBE_CMD.win : PROBE_CMD.linux, { pty: false }, (err, stream) => {
        if (err) return fail(err.message);
        let out = "", errOut = "";
        stream.on("data", (c) => { out += c; });
        stream.stderr.on("data", (c) => { errOut += c; });
        stream.on("close", () => {
          clearTimeout(timer);
          conn.end();
          const frame = buildFrame(out);
          // 脚本最后一句是 DONE=1：没见到它就说明中途断了（sh 语法错、PowerShell 静默断块）。
          // 这时候宁可如实报失败，也不把半截数据当成一帧画到墙上。
          if (!frame.done) {
            const tail = String(errOut || out).replace(/\s+/g, " ").trim().slice(0, 140);
            return resolve({ ok: false, error: "脚本没跑完（没见到 DONE）" + (tail ? "：" + tail : "") });
          }
          resolve({ ok: true, frame });
        });
        // 脚本整段走 stdin：cmd.exe 那条 8191 字符的命令行限制就此绕开
        stream.end(script.endsWith("\n") ? script : script + "\n");
      });
    });
    conn.on("error", (e) => fail(e.message));
    conn.connect({ host, username: user, password: pass, readyTimeout: 8000, algorithms: { kex: ["ecdh-sha2-nistp256", "curve25519-sha256"] } });
  });
}

const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8", ".json": "application/json; charset=utf-8",
  ".css": "text/css; charset=utf-8" };

createServer(async (req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  // 来源这道门在最前面：连页面带接口一起挡，不给自己留"页面能开、接口不给"那种半开状态
  if (!fromAllowed(req)) {
    return send(res, 403, "这台只对指定来源开放（serve.mjs 的 HM_ALLOW）", "text/plain; charset=utf-8");
  }
  // 所有 /api/* 都先过同源这道门：读的那几个口子回的是含口令的清单，写的那几个口子能改清单和设置，
  // 而跨站请求可以不带预检地打过来（text/plain 的"简单请求"照样被下面 JSON.parse 当 JSON 收下）。
  if (url.pathname.startsWith("/api/") && !sameOrigin(req)) {
    return send(res, 403, JSON.stringify({ ok: false, error: "来源不是本机" }));
  }
  if (url.pathname === "/api/probe") {
    if (req.method !== "POST") return send(res, 405, JSON.stringify({ ok: false, error: "只支持 POST" }));
    let raw = "";
    req.on("data", (c) => { raw += c; if (raw.length > 4096) req.destroy(); });
    req.on("end", async () => {
      let body = {};
      try { body = JSON.parse(raw); } catch { return send(res, 400, JSON.stringify({ ok: false, error: "请求体不是 JSON" })); }
      // 这条 try/catch 是必需的：以前 probe 里一个笔误（ssh2 未定义）在 Promise 里抛出，
      // 变成 unhandled rejection → 整个服务被自己带崩，页面只看到一个断掉的连接
      let r;
      try { r = await probe({ host: String(body.host || ""), user: String(body.user || ""),
        pass: String(body.pass || ""), os: String(body.os || "") }); }
      catch (e) { r = { ok: false, error: "服务内部错误：" + String((e && e.message) || e) }; }
      logProbe(String(body.host || "?"), r.ok, r.ok ? "" : r.error);
      // 抓不到也回 200：HTTP 这一层是成功的（请求到了、连也试过了），成败在 ok 那一格上。
      // 用 502 的话浏览器控制台会替每一台抓不到的机器记一条红色错误 —— 页面打开时本来就对
      // 每台填了地址的机器各抓一帧，看板机一开机就是几行红的，看着像坏了。
      send(res, 200, JSON.stringify(r));
    });
    return;
  }
  if (url.pathname === "/api/devices") {
    if (req.method === "GET") {
      const { source, list } = await load();
      return send(res, 200, JSON.stringify({ list, source }));
    }
    if (req.method === "PUT") {
      let raw = "";
      req.on("data", (c) => { raw += c; if (raw.length > MAX_BYTES) req.destroy(); });
      req.on("end", async () => {
        try {
          const list = normalize(JSON.parse(raw).list);
          if (!list) return send(res, 400, JSON.stringify({ error: "清单为空或格式不对" }));
          await save(FILE, list);
          send(res, 200, JSON.stringify({ ok: true, count: list.length }));
        } catch (e) {
          send(res, 400, JSON.stringify({ error: String(e.message || e) }));
        }
      });
      return;
    }
    return send(res, 405, JSON.stringify({ error: "只支持 GET / PUT" }));
  }
  // 分区表（页面"分区设置"那一格）：独立文件、独立端点，改分区不碰设备清单
  if (url.pathname === "/api/zones") {
    if (req.method === "GET") {
      const { source, list } = await loadZones();
      return send(res, 200, JSON.stringify({ list, source }));
    }
    if (req.method === "PUT") {
      let raw = "";
      req.on("data", (c) => { raw += c; if (raw.length > MAX_BYTES) req.destroy(); });
      req.on("end", async () => {
        try {
          const list = normalizeZones(JSON.parse(raw).list);
          if (!list) return send(res, 400, JSON.stringify({ error: "分区表为空或格式不对" }));
          await save(ZFILE, list);
          send(res, 200, JSON.stringify({ ok: true, count: list.length }));
        } catch (e) {
          send(res, 400, JSON.stringify({ error: String(e.message || e) }));
        }
      });
      return;
    }
    return send(res, 405, JSON.stringify({ error: "只支持 GET / PUT" }));
  }
  // 设置（"设置"弹窗里那几项：脉冲 / 地面与雨 / 采集频率）：也是独立文件、独立端点。
  // 双向：页面启动读它、拖滑块写回它；部署成看板后直接改这个 json，页面每 5 秒自己读一次。
  if (url.pathname === "/api/settings") {
    if (req.method === "GET") {
      const { source, settings } = await loadSettings();
      return send(res, 200, JSON.stringify({ settings, source }));
    }
    if (req.method === "PUT") {
      let raw = "";
      req.on("data", (c) => { raw += c; if (raw.length > MAX_BYTES) req.destroy(); });
      req.on("end", async () => {
        try {
          const parsed = normalizeSettings(JSON.parse(raw).settings);
          if (!parsed) return send(res, 400, JSON.stringify({ error: "设置内容为空或格式不对" }));
          await saveSettings(parsed.settings, parsed.extra);
          send(res, 200, JSON.stringify({ ok: true }));
        } catch (e) {
          send(res, 400, JSON.stringify({ error: String(e.message || e) }));
        }
      });
      return;
    }
    return send(res, 405, JSON.stringify({ error: "只支持 GET / PUT" }));
  }

  if (req.method !== "GET") return send(res, 405, JSON.stringify({ error: "只支持 GET" }));
  // 目录穿越防护：解出来必须还在本目录内
  const rel = decodeURIComponent(url.pathname === "/" ? "monitor-wall.html" : url.pathname.slice(1));
  const abs = path.resolve(DIR, rel);
  if (abs !== DIR && !abs.startsWith(DIR + path.sep)) return send(res, 403, "forbidden", "text/plain");
  try {
    const buf = await readFile(abs);
    send(res, 200, buf, TYPES[path.extname(abs).toLowerCase()] || "application/octet-stream");
  } catch {
    send(res, 404, "not found", "text/plain");
  }
}).listen(PORT, BIND, () => {
  console.log(`原型服务已起：http://${LOOPBACK ? "127.0.0.1" : BIND}:${PORT}/monitor-wall.html` +
    (LOOPBACK ? "" : `（也从 http://<本机 IP>:${PORT}/monitor-wall.html 能开）`));
  console.log(`设备清单文件：${FILE}（页面编辑会写回这里${LOOPBACK ? "；只监听 127.0.0.1" : ""}）`);
  console.log(`分区文件：${ZFILE}`);
  console.log(`设置文件：${SFILE}（改它即改看板，页面每 5 秒读一次；页面里改也写回它）`);
  console.log(LOOPBACK ? "来源：只认环回（别的机器连不上）"
    : ALLOW.length ? `来源：只放 ${ALLOW.join(" / ")}（外加环回）`
    : "⚠ 来源：不限制 —— 绑在非环回地址上又没给 HM_ALLOW，同网段谁能连上谁就能读走整份设备清单（含口令）");
});
