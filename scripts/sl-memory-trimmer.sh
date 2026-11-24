#!/bin/sh
# SnowLuma 冷内存定时回收：仅在满足全部安全守卫时最小化闲置 QQ 窗口并将冷匿名页温和换入 zram。
#
# 四道安全守卫：
#   1. 服务与协议守卫：lian-snowluma.service 未运行时静默跳过（兼容切回 NapCat）。
#   2. 扫码与桌面守卫：仅当 OneBot (:8080) 已监听且 VNC (:5909) 无活跃连接时才最小化窗口，绝不黑屏打断扫码。
#   3. 冷页阈值与热集守卫：仅当 memory.current >= 215MB 且 inactive_anon >= 50MB 时触发，
#      下探目标取 max(活跃热内存 + 48MB, 160MB)，绝不触碰热工作集或压迫 lian-koishi.service。
#   4. 稳态水位恢复守卫：trap 保证任何信号或退出路径均将 MemoryHigh 恢复为稳态值（默认 260M），且绝不重启服务。
set -eu

MODE="dry-run"
for arg in "$@"; do
  case "$arg" in
    --apply) MODE="apply" ;;
    --dry-run) MODE="dry-run" ;;
    *) echo "[sl-memory-trimmer] unknown argument: $arg" >&2; exit 1 ;;
  esac
done

SL_SERVICE_NAME="${SL_MEMORY_TRIM_SERVICE:-lian-snowluma.service}"
CGROUP_DIR="${SL_MEMORY_TRIM_CGROUP_DIR:-/sys/fs/cgroup/system.slice/${SL_SERVICE_NAME}}"
STEADY_HIGH_MB="${SL_MEMORY_TRIM_STEADY_HIGH_MB:-260}"
TRIGGER_CURRENT_MB="${SL_MEMORY_TRIM_TRIGGER_MB:-215}"
MIN_INACTIVE_ANON_MB="${SL_MEMORY_TRIM_MIN_INACTIVE_ANON_MB:-50}"
FLOOR_HIGH_MB="${SL_MEMORY_TRIM_FLOOR_MB:-160}"
HOLD_SEC="${SL_MEMORY_TRIM_HOLD_SEC:-2}"
ONEBOT_PORT="${SL_MEMORY_TRIM_ONEBOT_PORT:-8080}"
VNC_PORT="${SL_MEMORY_TRIM_VNC_PORT:-5909}"
DISPLAY_NUM="${SL_MEMORY_TRIM_DISPLAY:-:199}"

for num in "$STEADY_HIGH_MB" "$TRIGGER_CURRENT_MB" "$MIN_INACTIVE_ANON_MB" "$FLOOR_HIGH_MB" "$HOLD_SEC" "$ONEBOT_PORT" "$VNC_PORT"; do
  case "$num" in
    ''|*[!0-9]*) echo "[sl-memory-trimmer] invalid numeric parameter: $num" >&2; exit 1 ;;
  esac
done

if ! systemctl is-active --quiet "$SL_SERVICE_NAME" 2>/dev/null; then
  echo "[sl-memory-trimmer] skip: $SL_SERVICE_NAME is not active"
  exit 0
fi

if [ ! -r "$CGROUP_DIR/memory.current" ] || [ ! -r "$CGROUP_DIR/memory.stat" ]; then
  echo "[sl-memory-trimmer] skip: cgroup v2 memory files unavailable at $CGROUP_DIR"
  exit 0
fi

# 守卫 2：仅在 QQ 已登录（OneBot 端口已监听）且无活跃 VNC 桌面连接时最小化窗口。
onebot_ready=0
if ss -tln 2>/dev/null | grep -Eq ":${ONEBOT_PORT}([[:space:]]|$)"; then
  onebot_ready=1
fi
vnc_busy=0
if ss -tn state established 2>/dev/null | grep -Eq ":${VNC_PORT}([[:space:]]|$)"; then
  vnc_busy=1
fi

if [ "$onebot_ready" -eq 1 ] && [ "$vnc_busy" -eq 0 ]; then
  if [ "$MODE" = "apply" ]; then
    if command -v xwininfo >/dev/null 2>&1 && command -v python3 >/dev/null 2>&1; then
      python3 - "$DISPLAY_NUM" <<'PY' || true
import ctypes, re, subprocess, sys
display = sys.argv[1]
try:
    out = subprocess.check_output(["xwininfo", "-root", "-tree", "-display", display], text=True, errors="ignore")
    wids = []
    for line in out.splitlines():
        if '"QQ"' not in line:
            continue
        wid = re.search(r"(0x[0-9a-fA-F]+)", line)
        geom = re.search(r"(\d+)x(\d+)\+", line)
        if wid and (not geom or int(geom.group(1)) > 20):
            wids.append(int(wid.group(1), 16))
    if wids:
        x11 = ctypes.CDLL("libX11.so.6")
        x11.XOpenDisplay.argtypes = [ctypes.c_char_p]
        x11.XOpenDisplay.restype = ctypes.c_void_p
        x11.XIconifyWindow.argtypes = [ctypes.c_void_p, ctypes.c_ulong, ctypes.c_int]
        x11.XFlush.argtypes = [ctypes.c_void_p]
        x11.XCloseDisplay.argtypes = [ctypes.c_void_p]
        dpy = x11.XOpenDisplay(display.encode("utf-8"))
        if dpy:
            for w in wids:
                x11.XIconifyWindow(dpy, w, 0)
            x11.XFlush(dpy)
            x11.XCloseDisplay(dpy)
            print(f"[sl-memory-trimmer] iconified {len(wids)} QQ window(s) on {display}")
except Exception:
    pass
PY
    fi
  else
    echo "[sl-memory-trimmer] dry-run: would iconify visible QQ windows on $DISPLAY_NUM"
  fi
else
  echo "[sl-memory-trimmer] skip window iconify: onebot_ready=$onebot_ready vnc_busy=$vnc_busy"
fi

# 守卫 3：读取当前驻留与冷热页分布，低水位或无冷页时绝不制造无效换页抖动。
current_bytes="$(cat "$CGROUP_DIR/memory.current")"
active_anon="$(awk '$1=="active_anon"{print $2; exit}' "$CGROUP_DIR/memory.stat")"
inactive_anon="$(awk '$1=="inactive_anon"{print $2; exit}' "$CGROUP_DIR/memory.stat")"
active_file="$(awk '$1=="active_file"{print $2; exit}' "$CGROUP_DIR/memory.stat")"
: "${active_anon:=0}"
: "${inactive_anon:=0}"
: "${active_file:=0}"

current_mb=$((current_bytes / 1048576))
inactive_anon_mb=$((inactive_anon / 1048576))
hot_mb=$(((active_anon + active_file) / 1048576))
steady_bytes=$((STEADY_HIGH_MB * 1048576))
cur_high="$(cat "$CGROUP_DIR/memory.high" 2>/dev/null || printf 'max')"

if [ "$current_mb" -lt "$TRIGGER_CURRENT_MB" ] || [ "$inactive_anon_mb" -lt "$MIN_INACTIVE_ANON_MB" ]; then
  if [ "$MODE" = "apply" ] && [ "$cur_high" != "max" ]; then
    case "$cur_high" in
      ''|*[!0-9]*) ;;
      *)
        if [ "$cur_high" -lt "$steady_bytes" ]; then
          systemctl set-property "$SL_SERVICE_NAME" "MemoryHigh=${STEADY_HIGH_MB}M" >/dev/null 2>&1 || true
        fi
        ;;
    esac
  fi
  echo "[sl-memory-trimmer] skip reclaim: current=${current_mb}MB (trigger=${TRIGGER_CURRENT_MB}MB) inactive_anon=${inactive_anon_mb}MB (min=${MIN_INACTIVE_ANON_MB}MB)"
  exit 0
fi

target_mb=$((hot_mb + 48))
if [ "$target_mb" -lt "$FLOOR_HIGH_MB" ]; then
  target_mb="$FLOOR_HIGH_MB"
fi
max_target=$((STEADY_HIGH_MB - 20))
if [ "$target_mb" -gt "$max_target" ]; then
  echo "[sl-memory-trimmer] skip reclaim: hot=${hot_mb}MB leaves target=${target_mb}MB too close to steady=${STEADY_HIGH_MB}MB"
  exit 0
fi

if [ "$MODE" = "dry-run" ]; then
  echo "[sl-memory-trimmer] DRY-RUN would reclaim: current=${current_mb}MB inactive_anon=${inactive_anon_mb}MB hot=${hot_mb}MB target=${target_mb}MB steady=${STEADY_HIGH_MB}MB"
  exit 0
fi

# 守卫 4：临时下探仅挤出冷页，所有退出路径均强制恢复稳态 MemoryHigh。
restore_steady_high() {
  systemctl set-property "$SL_SERVICE_NAME" "MemoryHigh=${STEADY_HIGH_MB}M" >/dev/null 2>&1 || true
}
trap 'restore_steady_high' EXIT INT TERM

systemctl set-property "$SL_SERVICE_NAME" "MemoryHigh=${target_mb}M"
sleep "$HOLD_SEC"
restore_steady_high
trap - EXIT INT TERM

after_bytes="$(cat "$CGROUP_DIR/memory.current" 2>/dev/null || printf '%s' "$current_bytes")"
after_mb=$((after_bytes / 1048576))
echo "[sl-memory-trimmer] APPLY reclaimed: before=${current_mb}MB after=${after_mb}MB target=${target_mb}MB steady=${STEADY_HIGH_MB}MB"
