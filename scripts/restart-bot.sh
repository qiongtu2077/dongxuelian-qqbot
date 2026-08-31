#!/bin/bash
# 重启 Koishi Bot（服务器端）
# 用法: ssh root@host "bash <YOUR_APP_DIR>/restart.sh"
# 可通过环境变量覆盖: KOISHI_APP_DIR, KOISHI_PORT, DASHBOARD_PORT

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)"
APP_DIR="${KOISHI_APP_DIR:-$SCRIPT_DIR}"
if [ ! -f "$APP_DIR/package.json" ] && [ -f "$SCRIPT_DIR/../package.json" ]; then
  APP_DIR="$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd -P)"
fi
KOISHI_PORT="${KOISHI_PORT:-5140}"
DASHBOARD_PORT="${DASHBOARD_PORT:-5150}"
DASHBOARD_HOST="${DASHBOARD_HOST:-0.0.0.0}"
LOG_FILE="$APP_DIR/koishi.log"
DATA_DIR="${DONGXUELIAN_AI_DATA_DIR:-$APP_DIR/data}"
DASHBOARD_DIR="$APP_DIR/packages/koishi-plugin-dashboard"
NODE_MODULES="$APP_DIR/node_modules"
RESOURCE_WORKER_RELATIVE="node_modules/koishi-plugin-dongxuelian-ai/lib/resource-workers/worker-main.js"
RESOURCE_WORKER_ENTRY="$APP_DIR/$RESOURCE_WORKER_RELATIVE"
RESOURCE_RELEASE_ROOT="$APP_DIR/.lian-releases"
RESOURCE_WORKER_STATE_DIR="$DATA_DIR/resource-workers/workers"
RESOURCE_SUPERVISOR_STATE="$DATA_DIR/resource-workers/supervisor/state.json"

if [ -f "$APP_DIR/scripts/seal-data-dir.sh" ]; then
  KOISHI_DIR="$APP_DIR" DONGXUELIAN_AI_DATA_DIR="$DATA_DIR" sh "$APP_DIR/scripts/seal-data-dir.sh"
fi

start_koishi() {
  cd "$APP_DIR" || exit 1
  export KOISHI_DIR="$APP_DIR"
  export NODE_PATH="$NODE_MODULES"
  export DONGXUELIAN_AI_DATA_DIR="$DATA_DIR"
  nohup node "$APP_DIR/node_modules/koishi/bin.js" start >> "$LOG_FILE" 2>&1 &
  KOISHI_PID=$!
}

# 核验 PID 当前命令行仍是本应用的白名单资源 worker，避免 PID 复用误杀。
is_managed_resource_worker_pid() {
  pid="$1"
  [ -r "/proc/$pid/cmdline" ] || return 1
  cmdline="$(cat "/proc/$pid/cmdline" 2>/dev/null | tr '\0' ' ' || true)"
  case "$cmdline" in
    *"$RESOURCE_WORKER_ENTRY --type daily"*|*"$RESOURCE_WORKER_ENTRY --type agent"*|*"$RESOURCE_WORKER_ENTRY --type media"*|\
    *"$RESOURCE_RELEASE_ROOT/"*"/$RESOURCE_WORKER_RELATIVE --type daily"*|*"$RESOURCE_RELEASE_ROOT/"*"/$RESOURCE_WORKER_RELATIVE --type agent"*|*"$RESOURCE_RELEASE_ROOT/"*"/$RESOURCE_WORKER_RELATIVE --type media"*) return 0 ;;
    *) return 1 ;;
  esac
}

# 从受控状态文件和精确 cmdline 收集本应用资源 worker PID。
list_managed_resource_worker_pids() {
  if [ -d "$RESOURCE_WORKER_STATE_DIR" ]; then
    node - "$RESOURCE_WORKER_STATE_DIR" <<'NODE'
const fs = require('fs')
const path = require('path')
const root = process.argv[2]
for (const name of fs.readdirSync(root)) {
  if (!/^(daily|agent|media)-worker\.json$/.test(name)) continue
  try {
    const state = JSON.parse(fs.readFileSync(path.join(root, name), 'utf8'))
    const pid = Number(state.pid || 0)
    if (Number.isInteger(pid) && pid > 1) console.log(pid)
  } catch { /* unreadable state is ignored; exact /proc scan remains */ }
}
NODE
  fi
  for file in /proc/[0-9]*/cmdline; do
    [ -r "$file" ] || continue
    pid="${file#/proc/}"
    pid="${pid%/cmdline}"
    if is_managed_resource_worker_pid "$pid"; then printf '%s\n' "$pid"; fi
  done
}

# 先温和停止，五秒后只对仍匹配精确 cmdline 的 PID 强停。
stop_managed_resource_workers() {
  pids="$(list_managed_resource_worker_pids | sort -nu)"
  [ -n "$pids" ] || return 0
  for pid in $pids; do
    if is_managed_resource_worker_pid "$pid"; then kill -TERM "$pid" 2>/dev/null || true; fi
  done
  for _ in 1 2 3 4 5; do
    remaining=""
    for pid in $pids; do
      if is_managed_resource_worker_pid "$pid"; then remaining="$remaining $pid"; fi
    done
    [ -z "$remaining" ] && return 0
    sleep 1
  done
  for pid in $pids; do
    if is_managed_resource_worker_pid "$pid"; then kill -KILL "$pid" 2>/dev/null || true; fi
  done
}

# 核验 supervisor 属于当前 Koishi worker，且所有活资源 worker 都属于当前 generation。
validate_resource_worker_generation() {
  [ -r "$RESOURCE_SUPERVISOR_STATE" ] || return 1
  node - "$RESOURCE_SUPERVISOR_STATE" "$RESOURCE_WORKER_STATE_DIR" <<'NODE'
const fs = require('fs')
const path = require('path')
const supervisorFile = process.argv[2]
const workerDir = process.argv[3]
try {
  const supervisor = JSON.parse(fs.readFileSync(supervisorFile, 'utf8'))
  const generation = String(supervisor.generation || '')
  const supervisorPid = Number(supervisor.pid || 0)
  if (!generation || !Number.isInteger(supervisorPid) || supervisorPid <= 1) process.exit(1)
  const supervisorCmdline = fs.readFileSync(`/proc/${supervisorPid}/cmdline`, 'utf8').replace(/\0/g, ' ')
  if (!supervisorCmdline.includes('koishi/lib/worker')) process.exit(1)
  if (!fs.existsSync(workerDir)) process.exit(0)
  for (const name of fs.readdirSync(workerDir)) {
    if (!/^(daily|agent|media)-worker\.json$/.test(name)) continue
    const worker = JSON.parse(fs.readFileSync(path.join(workerDir, name), 'utf8'))
    const pid = Number(worker.pid || 0)
    if (!Number.isInteger(pid) || pid <= 1 || !fs.existsSync(`/proc/${pid}/cmdline`)) continue
    if (String(worker.ownerGeneration || '') !== generation || !String(worker.startToken || '')) process.exit(1)
  }
  process.exit(0)
} catch {
  process.exit(1)
}
NODE
}

echo "[$(date)] 开始重启 bot..."

# 1. 杀干净所有 koishi 进程
echo "杀旧进程..."
stop_managed_resource_workers
pkill -9 -f 'koishi/lib/worker' 2>/dev/null || true
pkill -9 -f 'node.*koishi start' 2>/dev/null || true
sleep 4

remaining_workers="$(list_managed_resource_worker_pids | while read -r pid; do is_managed_resource_worker_pid "$pid" && printf '%s\n' "$pid"; done)"
if [ -n "$remaining_workers" ]; then
  echo "错误: 仍存在旧资源 worker，停止重启"
  echo "$remaining_workers"
  exit 1
fi

# 2. 确认端口已释放
if ss -tlnp | grep -q ":$KOISHI_PORT"; then
  echo "错误: 端口 $KOISHI_PORT 仍被占用，停止重启"
  exit 1
fi
echo "端口 $KOISHI_PORT 已释放"

# 3. 确保 Dashboard 在运行
if ! ss -tlnp | grep -q ":$DASHBOARD_PORT"; then
  echo "启动 Dashboard..."
  cd "$DASHBOARD_DIR" || exit 1
  KOISHI_DIR="$APP_DIR" DONGXUELIAN_AI_DATA_DIR="$DATA_DIR" DASHBOARD_HOST="$DASHBOARD_HOST" DASHBOARD_PORT="$DASHBOARD_PORT" NODE_PATH="$NODE_MODULES" nohup node standalone.js >> "$LOG_FILE" 2>&1 &
  echo "Dashboard PID: $!"
  sleep 2
else
  echo "Dashboard 已在运行"
fi

# 4. 写时间戳标记
MARKER="=== RESTART $(date +%Y%m%d%H%M%S) ==="
echo "$MARKER" >> "$LOG_FILE"

# 5. 启动 koishi（使用本地 binary，不用全局 /usr/bin/koishi）
echo "启动 koishi..."
start_koishi
echo "Koishi PID: $KOISHI_PID"

# 6. 轮询等待
echo "等待 koishi 启动..."
for i in $(seq 1 20); do
  sleep 1
  LOG_TAIL=$(tail -40 "$LOG_FILE")
  if ss -tlnp | grep -q ":$KOISHI_PORT" && \
     ps aux | grep -q 'koishi/lib/worker' && \
     echo "$LOG_TAIL" | grep -q 'adapter connect to server' && \
     validate_resource_worker_generation; then
    echo "启动成功 ✓（${i}秒）"
    echo "  port listening"
    echo "  http healthy"
    echo "  adapter connected"
    echo "  worker generation healthy"
    exit 0
  fi
  if ! kill -0 "$KOISHI_PID" 2>/dev/null; then
    echo "警告: 进程已退出，尝试重新启动..."
    tail -10 "$LOG_FILE" | grep -E "error|Error|cannot" | tail -3 || true
    start_koishi
  fi
done

echo "启动失败 ✗"
echo "--- 最后 20 行日志 ---"
tail -20 "$LOG_FILE"
exit 1
