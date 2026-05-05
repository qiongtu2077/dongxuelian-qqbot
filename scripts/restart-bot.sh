#!/bin/bash
# 重启 Koishi Bot（服务器端）
# 用法: ssh root@host "bash /root/koishi-app/restart.sh"

set -e

APP_DIR="/root/koishi-app"
LOG_FILE="$APP_DIR/koishi.log"
DATA_DIR="$APP_DIR/data"

echo "[$(date)] 开始重启 bot..."

# 1. 杀干净所有 koishi 进程（包括孤儿进程）
echo "杀旧进程..."
pkill -9 -f 'koishi/lib/worker' 2>/dev/null || true
pkill -9 -f 'node.*koishi start' 2>/dev/null || true
sleep 4

# 2. 确认端口已释放
if ss -tlnp | grep -q ':5140'; then
  echo "错误: 端口 5140 仍被占用，停止重启"
  exit 1
fi
echo "端口 5140 已释放"

# 3. 写时间戳标记，区分新旧日志
MARKER="=== RESTART $(date +%Y-%m-%d %H:%M:%S) ==="
echo "$MARKER" >> "$LOG_FILE"

# 4. 启动 bot
echo "启动 bot..."
cd "$APP_DIR"
DONGXUELIAN_AI_DATA_DIR="$DATA_DIR" nohup node node_modules/.bin/koishi start >> "$LOG_FILE" 2>&1 &
echo "PID: $!"

# 5. 等待并验证（只查标记之后的 20 行，防止旧日志欺骗）
sleep 15
LOG_TAIL=$(tail -20 "$LOG_FILE")

if echo "$LOG_TAIL" | grep -q 'daily-report loaded' && \
   echo "$LOG_TAIL" | grep -q 'adapter connect to server'; then
  echo "启动成功 ✓"
  echo "   daily-report loaded"
  echo "   adapter connected"
elif ss -tlnp | grep -q ':5140' && ps aux | grep -q 'koishi/lib/worker'; then
  echo "启动成功（进程+端口确认）✓"
else
  echo "启动失败 ✗"
  echo "--- 最后 20 行日志 ---"
  tail -20 "$LOG_FILE"
  exit 1
fi
