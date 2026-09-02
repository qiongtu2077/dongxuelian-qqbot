#!/usr/bin/env bash
# 安装或更新由 systemd 独立托管的 Koishi 服务；仅刷新定义和 enable，不在此阶段启动 Bot。
set -Eeuo pipefail

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)"
DEFAULT_APP_DIR="$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd -P)"
APP_DIR="${KOISHI_APP_DIR:-${KOISHI_DIR:-$DEFAULT_APP_DIR}}"
DATA_DIR="${DONGXUELIAN_AI_DATA_DIR:-$APP_DIR/data}"
SERVICE_NAME="lian-koishi"
UNIT="/etc/systemd/system/${SERVICE_NAME}.service"
NODE_BIN="$(command -v node || true)"

if [ -z "$NODE_BIN" ]; then
  echo "[install-koishi-service] 未找到 node" >&2
  exit 1
fi
NODE_BIN="$(readlink -f "$NODE_BIN")"
if [ ! -x "$NODE_BIN" ]; then
  echo "[install-koishi-service] node 不可执行: $NODE_BIN" >&2
  exit 1
fi
if ! command -v systemctl >/dev/null 2>&1 || ! systemctl --version >/dev/null 2>&1; then
  echo "[install-koishi-service] systemd 不可用，无法安装 Koishi 服务" >&2
  exit 1
fi
if [ ! -f "$APP_DIR/node_modules/koishi/bin.js" ]; then
  echo "[install-koishi-service] 未找到 Koishi 启动入口: $APP_DIR/node_modules/koishi/bin.js" >&2
  exit 1
fi

mkdir -p "$DATA_DIR"
echo "[install-koishi-service] 写入 unit $UNIT"
cat > "$UNIT" <<EOF
[Unit]
Description=LianLianBot Koishi
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=$APP_DIR
ExecStart=$NODE_BIN $APP_DIR/node_modules/koishi/bin.js start
Restart=on-failure
RestartSec=5
Environment=NODE_ENV=production
Environment=KOISHI_DIR=$APP_DIR
Environment=DONGXUELIAN_AI_DATA_DIR=$DATA_DIR
Environment=NODE_PATH=$APP_DIR/node_modules

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable "$SERVICE_NAME"
echo "[install-koishi-service] 完成。状态：$(systemctl is-enabled "$SERVICE_NAME") / $(systemctl is-active "$SERVICE_NAME")"
