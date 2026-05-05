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

# 3. 清空日志（可选，保留最近几次）
# tail -n 1000 "$LOG_FILE" > "${LOG_FILE}.prev" 2>/dev/null || true

# 4. 启动 bot
echo "启动 bot..."
cd "$APP_DIR"
DONGXUELIAN_AI_DATA_DIR="$DATA_DIR" nohup node node_modules/.bin/koishi start >> "$LOG_FILE" 2>&1 &
PID=$!
echo "启动中 (PID=$PID) ..."

# 5. 等待并验证
sleep 15
if grep -q 'daily-report loaded' "$LOG_FILE" && grep -q 'adapter connect to server' "$LOG_FILE"; then
  echo "启动成功 ✓"
  echo "   daily-report loaded"
  echo "   adapter connected"
else
  echo "警告: 启动可能有异常，请检查日志: tail -20 $LOG_FILE"
fi
