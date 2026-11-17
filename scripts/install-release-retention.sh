#!/bin/sh
# 为现有 systemd 发布单元安装成功后的旧包回收钩子，无需重启 Bot 或 Dashboard。
set -eu
SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)"
APP_DIR="${KOISHI_APP_DIR:-/root/koishi-app}"
DATA_DIR="${DONGXUELIAN_AI_DATA_DIR:-$APP_DIR/data}"
INSTALL_ROOT="${LIAN_RETENTION_INSTALL_ROOT:-}"
NODE_BIN="$(command -v node)"
case "$APP_DIR" in
  /*) ;;
  *) echo '[install-release-retention] app dir must be absolute' >&2; exit 1 ;;
esac
case "$APP_DIR$DATA_DIR$INSTALL_ROOT$NODE_BIN" in
  *[\"%[:space:]]*) echo '[install-release-retention] unsafe unit path' >&2; exit 1 ;;
esac
test "$(id -u)" -eq 0
test -d "$APP_DIR"
test -f "$SCRIPT_DIR/cleanup-dashboard-releases.js"

LIB_DIR="$INSTALL_ROOT/usr/local/lib/lian-bot"
SERVICE_FILE="$INSTALL_ROOT/etc/systemd/system/lian-package-retention.service"
DROPIN_DIR="$INSTALL_ROOT/etc/systemd/system/lian-release-.service.d"
install -d -m 0755 "$LIB_DIR" "$DROPIN_DIR"
install -m 0644 "$SCRIPT_DIR/cleanup-dashboard-releases.js" "$LIB_DIR/cleanup-dashboard-releases.js"
temp_dir="$(mktemp -d)"
service_tmp="$temp_dir/lian-package-retention.service"
trap 'rm -f "$service_tmp"; rmdir "$temp_dir"' EXIT INT TERM
cat > "$service_tmp" <<EOF
[Unit]
Description=LianLianBot retain current and previous verified release

[Service]
Type=oneshot
Environment=DONGXUELIAN_AI_DATA_DIR=$DATA_DIR
ExecStart=$NODE_BIN $LIB_DIR/cleanup-dashboard-releases.js $APP_DIR --apply
Nice=10
IOSchedulingClass=idle
TimeoutStartSec=300
EOF
systemd-analyze verify "$service_tmp"
install -m 0644 "$service_tmp" "$SERVICE_FILE"
# 回收服务自身使用不同前缀，防止继承 OnSuccess 后循环触发自己。
cat > "$DROPIN_DIR/60-package-retention.conf" <<EOF
[Unit]
OnSuccess=lian-package-retention.service
EOF
systemctl daemon-reload
echo '[install-release-retention] installed success hook for lian-release-*.service'
