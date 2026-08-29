#!/bin/bash
# 安装 / 更新 LianLianBot Dashboard 的 systemd 开机自起服务。
# 设计：只管 Dashboard 这一个网页进程的"开机自起 + 崩溃自愈"。
#       koishi 引擎与 napcat 一律保持手动（前端按钮 / 手动 ssh），本脚本绝不触碰它们。
# 幂等：可重复执行；若 Dashboard 已在运行则只刷新 unit 定义并 enable，绝不重启正在跑的进程
#       （部署流程本身就跑在 Dashboard 进程里，重启它会杀掉部署自己）。
# 用法: KOISHI_APP_DIR=/path/to/your/koishi-app DASHBOARD_PORT=5150 bash install-dashboard-service.sh
set -euo pipefail

DEFAULT_APP_DIR="$(pwd -P)"
APP_DIR="${KOISHI_APP_DIR:-${KOISHI_DIR:-$DEFAULT_APP_DIR}}"
DASHBOARD_HOST="${DASHBOARD_HOST:-0.0.0.0}"
DASHBOARD_PORT="${DASHBOARD_PORT:-5150}"
DATA_DIR="${DONGXUELIAN_AI_DATA_DIR:-$APP_DIR/data}"
SERVICE_NAME="lian-dashboard"
LAUNCHER="/usr/local/bin/lian-dashboard-start"
UNIT="/etc/systemd/system/${SERVICE_NAME}.service"

# 无 systemd 的环境（容器 / WSL 等）直接跳过，不报错，保持原有手动模式。
if ! command -v systemctl >/dev/null 2>&1 || ! systemctl --version >/dev/null 2>&1; then
  echo "[install-dashboard-service] systemd 不可用，跳过（保持手动启动）"
  exit 0
fi

echo "[install-dashboard-service] 写入启动器 $LAUNCHER"
cat > "$LAUNCHER" <<EOF
#!/bin/bash
set -euo pipefail
APP_DIR="$APP_DIR"
LOG_FILE="\$APP_DIR/koishi.log"
cd "\$APP_DIR"
export KOISHI_DIR="\$APP_DIR"
export DONGXUELIAN_AI_DATA_DIR="$DATA_DIR"
export DASHBOARD_HOST="$DASHBOARD_HOST"
export DASHBOARD_PORT="$DASHBOARD_PORT"
export NODE_PATH="\$APP_DIR/node_modules"
if [ -f "\$APP_DIR/.lian-releases/current/scripts/seal-data-dir.sh" ]; then
  sh "\$APP_DIR/.lian-releases/current/scripts/seal-data-dir.sh"
elif [ -f "\$APP_DIR/scripts/seal-data-dir.sh" ]; then
  sh "\$APP_DIR/scripts/seal-data-dir.sh"
fi
exec node packages/koishi-plugin-dashboard/standalone.js >> "\$LOG_FILE" 2>&1
EOF
chmod +x "$LAUNCHER"

echo "[install-dashboard-service] 写入 unit $UNIT"
cat > "$UNIT" <<EOF
[Unit]
Description=LianLianBot Dashboard
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=$APP_DIR
ExecStart=$LAUNCHER
Restart=always
RestartSec=5
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable "$SERVICE_NAME" >/dev/null 2>&1 || true

# 关键：已在运行就不动它（部署进程就在里面）；没在跑才拉起。
if systemctl is-active --quiet "$SERVICE_NAME"; then
  echo "[install-dashboard-service] 已在运行，仅刷新定义并 enable，不重启（避免打断当前部署）"
elif ss -tlnp 2>/dev/null | grep -q ":${DASHBOARD_PORT}\b"; then
  echo "[install-dashboard-service] 端口 ${DASHBOARD_PORT} 已被占用（Dashboard 可能由其他方式启动中），不重复启动"
else
  echo "[install-dashboard-service] Dashboard 未运行，启动中..."
  systemctl start "$SERVICE_NAME" || echo "[install-dashboard-service] 启动失败，请查看 journalctl -u $SERVICE_NAME"
fi

echo "[install-dashboard-service] 完成。状态：$(systemctl is-enabled $SERVICE_NAME 2>/dev/null) / $(systemctl is-active $SERVICE_NAME 2>/dev/null)"
