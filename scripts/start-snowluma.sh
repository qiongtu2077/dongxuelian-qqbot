#!/usr/bin/env bash
# 同一 systemd 控制组内运行独立 QQ、SL 和仅回环监听的扫码桌面。
set -Eeuo pipefail
umask 077
sl_dir="${SNOWLUMA_DIR:-/root/SnowLuma}"
export HOME="$sl_dir/home"
export XDG_CONFIG_HOME="$HOME/.config"
export XDG_DATA_HOME="$HOME/.local/share"
export XDG_RUNTIME_DIR="$sl_dir/run"
export SNOWLUMA_HOOK_RUNTIME_DIR="$sl_dir/run"
export DISPLAY=:199
export SNOWLUMA_WEBUI_HOST=127.0.0.1
export SNOWLUMA_WEBUI_PORT=5099
export SNOWLUMA_HOOK_AUTOLOAD=0
export SNOWLUMA_WEBUI_BOOTSTRAP_PASSWORD
SNOWLUMA_WEBUI_BOOTSTRAP_PASSWORD="$(cat "$sl_dir/bootstrap-password")"
mkdir -p "$HOME" "$XDG_CONFIG_HOME" "$XDG_DATA_HOME" "$XDG_RUNTIME_DIR" "$sl_dir/state"
children=()

# 所有退出路径都回收子进程；systemd KillMode 再兜住完整进程树。
cleanup() {
  trap - EXIT INT TERM
  for child in "${children[@]}"; do kill "$child" 2>/dev/null || true; done
  rm -f "$sl_dir/qq.pid"
  wait || true
}
trap cleanup EXIT INT TERM

Xvfb "$DISPLAY" -screen 0 1024x768x24 -nolisten tcp &
children+=("$!")
for _ in $(seq 1 50); do
  if xdpyinfo -display "$DISPLAY" >/dev/null 2>&1; then break; fi
  sleep 0.1
done
xdpyinfo -display "$DISPLAY" >/dev/null
openbox --sm-disable &
children+=("$!")
x11vnc -display "$DISPLAY" -rfbport 5909 -localhost -nopw -forever -shared -noxdamage -quiet &
children+=("$!")
"$sl_dir/qq/opt/QQ/qq" --no-sandbox --disable-gpu --disable-dev-shm-usage --user-data-dir="$HOME/.config/QQ" &
qq_pid=$!
children+=("$qq_pid")
printf '%s\n' "$qq_pid" > "$sl_dir/qq.pid"
cd "$sl_dir/state"
# 只限制 SL 运行时的 V8 新生代；QQ 已在上方启动，不继承该变量。
NODE_OPTIONS=--max-semi-space-size=4 "$sl_dir/runtime/node" "$sl_dir/runtime/index.mjs" &
children+=("$!")
# 任一核心进程退出即结束服务，由 systemd 整组清理并重试。
wait -n "${children[@]}"
exit 1
