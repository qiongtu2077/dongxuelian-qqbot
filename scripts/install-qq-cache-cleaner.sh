#!/bin/sh
# 安装 QQ 缓存每日清理：systemd service + timer。
#
# 设计说明（为什么不在 Koishi 插件里做）：
#   - nt_data 是 QQ/NapCat 的内部缓存，路径含账号 hash，换号/升级会变，
#     焊进插件会破坏跨平台（Windows 部署器用户）和模块边界。
#   - 独立 timer 出问题不影响 bot 进程，journalctl -u lian-qq-cache-cleaner
#     可直接排查。与 install-logrotate.sh 同为服务器级运维脚本。
#
# 安装内容：
#   /usr/local/sbin/qq-cache-cleaner.sh        # 清理脚本本体
#   /etc/systemd/system/lian-qq-cache-cleaner.service
#   /etc/systemd/system/lian-qq-cache-cleaner.timer  # 每日 04:00
#
# 用法：
#   sh scripts/install-qq-cache-cleaner.sh              # 安装并启用 timer
#   CLEAN_TIME=05:30 sh scripts/install-qq-cache-cleaner.sh
#
# 验证：
#   systemctl list-timers | grep qq-cache
#   journalctl -u lian-qq-cache-cleaner.service -n 20
set -eu

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)"
CLEANER_SRC="$SCRIPT_DIR/qq-cache-cleaner.sh"
CLEANER_DST="/usr/local/sbin/qq-cache-cleaner.sh"
SERVICE_NAME="lian-qq-cache-cleaner"
SERVICE_FILE="/etc/systemd/system/${SERVICE_NAME}.service"
TIMER_FILE="/etc/systemd/system/${SERVICE_NAME}.timer"
CLEAN_TIME="${CLEAN_TIME:-04:00}"

if [ "$(id -u)" -ne 0 ]; then
  echo "[install-qq-cache-cleaner] root is required" >&2
  exit 1
fi
if [ ! -f "$CLEANER_SRC" ]; then
  echo "[install-qq-cache-cleaner] cleaner script not found: $CLEANER_SRC" >&2
  exit 1
fi
command -v systemctl >/dev/null 2>&1 || {
  echo "[install-qq-cache-cleaner] systemctl not available" >&2; exit 1;
}

install -m 0750 "$CLEANER_SRC" "$CLEANER_DST"

svc_tmp="$(mktemp "${SERVICE_FILE}.tmp.XXXXXX")"
timer_tmp="$(mktemp "${TIMER_FILE}.tmp.XXXXXX")"
trap 'rm -f "$svc_tmp" "$timer_tmp"' EXIT INT TERM

cat > "$svc_tmp" <<EOF
[Unit]
Description=LianLianBot QQ cache cleaner (Pic/Emoji/Video/log only)
# 只清 QQ 客户端缓存；bot 数据（koishi-app/data）与 nt_db 永不由本服务触碰。
After=local-fs.target

[Service]
Type=oneshot
ExecStart=$CLEANER_DST --apply
# 低优先级 IO，避免和 bot 识图/资源 worker 抢磁盘。
Nice=10
IOSchedulingClass=idle
# 即使删除失败也只记日志，不重试堆积。
SuccessExitStatus=0 1
EOF

cat > "$timer_tmp" <<EOF
[Unit]
Description=Daily QQ cache cleanup for LianLianBot

[Timer]
OnCalendar=*-*-* ${CLEAN_TIME}:00
Persistent=true
RandomizedDelaySec=600

[Install]
WantedBy=timers.target
EOF

install -m 0644 "$svc_tmp" "$SERVICE_FILE"
install -m 0644 "$timer_tmp" "$TIMER_FILE"
systemctl daemon-reload
systemctl enable --now "${SERVICE_NAME}.timer" >/dev/null

echo "[install-qq-cache-cleaner] installed:"
echo "  $CLEANER_DST"
echo "  $SERVICE_FILE"
echo "  $TIMER_FILE (daily ${CLEAN_TIME}, randomized +0-10min)"
echo "next run: $(systemctl list-timers --no-pager 2>/dev/null | grep "${SERVICE_NAME}" || echo 'see systemctl list-timers')"
