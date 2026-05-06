#!/bin/bash
# Dashboard 守护脚本：崩溃后自动重启
# 用法: nohup bash watchdog.sh > watchdog.log 2>&1 &
# 可通过环境变量覆盖: KOISHI_APP_DIR, DASHBOARD_PORT

DASHBOARD_DIR="${KOISHI_APP_DIR:-/root/koishi-app}/packages/koishi-plugin-dashboard"
DATA_DIR="${KOISHI_APP_DIR:-/root/koishi-app/data}"
DASHBOARD_PORT="${DASHBOARD_PORT:-5150}"
WATCHDOG_LOG="$DASHBOARD_DIR/watchdog.log"

echo "[$(date)] Watchdog 启动" >> "$WATCHDOG_LOG"

while true; do
  if ss -tlnp | grep -q ":$DASHBOARD_PORT"; then
    sleep 10
    continue
  fi

  echo "[$(date)] Dashboard 未运行，启动中..." >> "$WATCHDOG_LOG"
  cd "$DASHBOARD_DIR"
  DONGXUELIAN_AI_DATA_DIR="$DATA_DIR" nohup node standalone.js >> "$WATCHDOG_LOG" 2>&1 &
  PID=$!
  sleep 5

  if kill -0 $PID 2>/dev/null; then
    echo "[$(date)] Dashboard 已启动 (PID=$PID)" >> "$WATCHDOG_LOG"
  else
    echo "[$(date)] Dashboard 启动失败" >> "$WATCHDOG_LOG"
  fi

  sleep 10
done
