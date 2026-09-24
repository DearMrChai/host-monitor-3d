// 抓一帧 · linux 那一套：一条 sh 脚本，走 stdin 递给远端（PROBE_CMD.linux = "sh -s"）。
// 2026-09-24 T5 step5 从 serve.mjs 整块搬出，正文一字未改（只加了 export —— 那是这一刀的动作本身）。
// 这一格里头的规矩（为什么走 stdin、KEY=value 契约、字段顺序两条必须一致、凭据不进脚本）写在
//   serve.mjs 的"连通性 / 抓一帧"那一节头上 —— 那些是两套抓法共用的，别在这儿抄第二份。
// 输出必须是 KEY=value 行，最后一句 DONE=1：serve.mjs 没见到 DONE 就整帧判失败，不把半截数据画上墙。
export const PROBE_SH = String.raw`LC_ALL=C; export LC_ALL
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
# 每个逻辑处理器属于哪个物理核（下标 = 逻辑处理器号，与 /proc/stat 的 cpuN、PCU 那一路同一套编号）：
# lscpu -p=CORE,SOCKET 一行一个逻辑处理器、按逻辑序出，双路机上 CORE 会跨路重复，所以按 (SOCKET,CORE) 去重再编号。
# 编号是"第几个不同的核"而不是内核那个核号 —— 看板只要"哪几个逻辑处理器是同一个核"，不要核号本身。
# 取不到（没有 lscpu）就不报这个键：看板退回"一逻辑处理器一张卡"，不去猜谁跟谁同核。
# 这一路没有 P/E 之分（PCLS 只有 Windows 的混合架构报），linux 侧就不报 PCLS。
PCORE=$(lscpu -p=CORE,SOCKET 2>/dev/null | grep -v '^#' | awk -F, '
  { k=$2 "," $1; if(!(k in n)){ n[k]=c++ } o=o (o?",":"") n[k] }
  END{ if(NR) print o }')
[ -n "$PCORE" ] && echo "PCORE=$PCORE"
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
