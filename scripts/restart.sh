#!/bin/bash
APP_DIR="${KOISHI_APP_DIR:-/root/koishi-app}"
KOISHI_PORT="${KOISHI_PORT:-5140}"
DASHBOARD_PORT="${DASHBOARD_PORT:-5150}"
LOG_FILE="$APP_DIR/koishi.log"
DATA_DIR="$APP_DIR/data"

echo "[$(date)] 开始重启 bot..."

echo "杀旧进程..."
pkill -9 -f 'koishi' 2>/dev/null || true
pkill -9 -f 'standalone.js' 2>/dev/null || true
sleep 4

if ss -tlnp | grep -q ":$KOISHI_PORT"; then
  echo "错误: 端口 $KOISHI_PORT 仍被占用"
  exit 1
fi
echo "端口 $KOISHI_PORT 已释放"

MARKER="=== RESTART $(date +%Y%m%d%H%M%S) ==="
echo "$MARKER" >> "$LOG_FILE"

cd "$APP_DIR" || exit 1
DONGXUELIAN_AI_DATA_DIR="$DATA_DIR" nohup node packages/koishi-plugin-dashboard/standalone.js >> "$LOG_FILE" 2>&1 &
DASH_PID=$!
echo "Dashboard PID: $DASH_PID"
sleep 2

nohup node "$APP_DIR/node_modules/koishi/bin.js" start >> "$LOG_FILE" 2>&1 &
KOISHI_PID=$!
echo "Koishi PID: $KOISHI_PID"

echo "等待 koishi 启动..."
for i in $(seq 1 20); do
  sleep 1
  LOG_TAIL=$(tail -40 "$LOG_FILE")
  if ss -tlnp | grep -q ":$KOISHI_PORT" && echo "$LOG_TAIL" | grep -q 'adapter connect to server'; then
    echo "启动成功 ✓（${i}秒）"
    echo "  port listening"
    echo "  http healthy"
    echo "  adapter connected"
    exit 0
  fi
  if ! kill -0 "$KOISHI_PID" 2>/dev/null; then
    tail -10 "$LOG_FILE" | grep -iE "error|Error|cannot" | tail -3 || true
    DONGXUELIAN_AI_DATA_DIR="$DATA_DIR" nohup node "$APP_DIR/node_modules/koishi/bin.js" start >> "$LOG_FILE" 2>&1 &
    KOISHI_PID=$!
  fi
done
echo "启动失败 ✗"
tail -20 "$LOG_FILE"
exit 1
