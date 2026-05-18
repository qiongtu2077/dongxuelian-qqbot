#!/bin/bash
# Dashboard 守护脚本：崩溃后自动重启
# 用法: nohup bash watchdog.sh > watchdog.log 2>&1 &

DASHBOARD_DIR="/root/koishi-app/packages/koishi-plugin-dashboard"
KOISHI_DIR="/root/koishi-app"
DATA_DIR="/root/koishi-app/data"
DASHBOARD_HOST="${DASHBOARD_HOST:-0.0.0.0}"
DASHBOARD_PORT="${DASHBOARD_PORT:-5150}"
WATCHDOG_LOG="$DASHBOARD_DIR/watchdog.log"

if [ -f "$KOISHI_DIR/scripts/seal-data-dir.sh" ]; then
  KOISHI_DIR="$KOISHI_DIR" DONGXUELIAN_AI_DATA_DIR="$DATA_DIR" sh "$KOISHI_DIR/scripts/seal-data-dir.sh" >> "$WATCHDOG_LOG" 2>&1
fi

echo "[$(date)] Watchdog 启动" >> "$WATCHDOG_LOG"

while true; do
  if ss -tlnp | grep -q ":$DASHBOARD_PORT"; then
    sleep 10
    continue
  fi

  echo "[$(date)] Dashboard 未运行，启动中..." >> "$WATCHDOG_LOG"
  cd "$DASHBOARD_DIR"
  if [ -f "$KOISHI_DIR/scripts/seal-data-dir.sh" ]; then
    KOISHI_DIR="$KOISHI_DIR" DONGXUELIAN_AI_DATA_DIR="$DATA_DIR" sh "$KOISHI_DIR/scripts/seal-data-dir.sh" >> "$WATCHDOG_LOG" 2>&1
  fi
  KOISHI_DIR="$KOISHI_DIR" DONGXUELIAN_AI_DATA_DIR="$DATA_DIR" DASHBOARD_HOST="$DASHBOARD_HOST" DASHBOARD_PORT="$DASHBOARD_PORT" nohup node standalone.js >> "$WATCHDOG_LOG" 2>&1 &
  PID=$!
  sleep 5

  if kill -0 $PID 2>/dev/null; then
    echo "[$(date)] Dashboard 已启动 (PID=$PID)" >> "$WATCHDOG_LOG"
  else
    echo "[$(date)] Dashboard 启动失败" >> "$WATCHDOG_LOG"
  fi

  sleep 10
done
