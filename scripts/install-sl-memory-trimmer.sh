#!/bin/sh
# 安装 SnowLuma 冷内存定时回收：systemd service + timer。
# 仅注册和启动独立 oneshot timer，绝不重启 lian-snowluma / lian-koishi / lian-dashboard。
set -eu

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)"
INSTALL_ROOT="${LIAN_TRIMMER_INSTALL_ROOT:-}"
TRIMMER_SRC="$SCRIPT_DIR/sl-memory-trimmer.sh"
TRIMMER_EXEC="/usr/local/sbin/sl-memory-trimmer.sh"
TRIMMER_DST="${INSTALL_ROOT}${TRIMMER_EXEC}"
SERVICE_NAME="lian-sl-memory-trimmer"
SERVICE_FILE="${INSTALL_ROOT}/etc/systemd/system/${SERVICE_NAME}.service"
TIMER_FILE="${INSTALL_ROOT}/etc/systemd/system/${SERVICE_NAME}.timer"
TRIM_INTERVAL="${SL_MEMORY_TRIM_INTERVAL:-20min}"

case "$INSTALL_ROOT$TRIM_INTERVAL" in
  *[\"%[:space:]]*) echo "[install-sl-memory-trimmer] unsafe install path or interval" >&2; exit 1 ;;
esac

if [ "$(id -u)" -ne 0 ]; then
  echo "[install-sl-memory-trimmer] root is required" >&2
  exit 1
fi
if [ ! -f "$TRIMMER_SRC" ]; then
  echo "[install-sl-memory-trimmer] trimmer script not found: $TRIMMER_SRC" >&2
  exit 1
fi
command -v systemctl >/dev/null 2>&1 || {
  echo "[install-sl-memory-trimmer] systemctl not available" >&2
  exit 1
}

install -d -m 0755 "$(dirname "$TRIMMER_DST")" "$(dirname "$SERVICE_FILE")"
install -m 0750 "$TRIMMER_SRC" "$TRIMMER_DST"

svc_tmp="$(mktemp "${SERVICE_FILE}.tmp.XXXXXX")"
timer_tmp="$(mktemp "${TIMER_FILE}.tmp.XXXXXX")"
trap 'rm -f "$svc_tmp" "$timer_tmp"' EXIT INT TERM

cat > "$svc_tmp" <<EOF
[Unit]
Description=LianLianBot SnowLuma cold-page zram memory trimmer
After=local-fs.target

[Service]
Type=oneshot
ExecStart=$TRIMMER_EXEC --apply
Nice=10
TimeoutStartSec=30
EOF

cat > "$timer_tmp" <<EOF
[Unit]
Description=Periodic SnowLuma cold-page zram trimmer for LianLianBot

[Timer]
OnBootSec=10min
OnUnitActiveSec=$TRIM_INTERVAL
RandomizedDelaySec=60
Persistent=true

[Install]
WantedBy=timers.target
EOF

install -m 0644 "$svc_tmp" "$SERVICE_FILE"
install -m 0644 "$timer_tmp" "$TIMER_FILE"
systemctl daemon-reload
systemctl enable --now "${SERVICE_NAME}.timer" >/dev/null

echo "[install-sl-memory-trimmer] installed:"
echo "  $TRIMMER_DST"
echo "  $SERVICE_FILE"
echo "  $TIMER_FILE (every $TRIM_INTERVAL)"
