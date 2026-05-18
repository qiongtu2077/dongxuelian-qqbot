#!/bin/bash
# 重启 Koishi Bot（服务器端）
# 用法: ssh root@host "bash /root/koishi-app/restart.sh"
# 可通过环境变量覆盖: KOISHI_APP_DIR, KOISHI_PORT, DASHBOARD_PORT

APP_DIR="${KOISHI_APP_DIR:-/root/koishi-app}"
KOISHI_PORT="${KOISHI_PORT:-5140}"
DASHBOARD_PORT="${DASHBOARD_PORT:-5150}"
DASHBOARD_HOST="${DASHBOARD_HOST:-0.0.0.0}"
LOG_FILE="$APP_DIR/koishi.log"
DATA_DIR="$APP_DIR/data"
DASHBOARD_DIR="$APP_DIR/packages/koishi-plugin-dashboard"
NODE_MODULES="$APP_DIR/node_modules"

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

echo "[$(date)] 开始重启 bot..."

# 1. 杀干净所有 koishi 进程
echo "杀旧进程..."
pkill -9 -f 'koishi/lib/worker' 2>/dev/null || true
pkill -9 -f 'node.*koishi start' 2>/dev/null || true
sleep 4

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
     echo "$LOG_TAIL" | grep -q 'adapter connect to server'; then
    echo "启动成功 ✓（${i}秒）"
    echo "  port listening"
    echo "  http healthy"
    echo "  adapter connected"
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
