#!/bin/sh
# Install bounded rotation for Koishi and NapCat text logs without restarting either service.

set -eu

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)"
APP_DIR="${KOISHI_APP_DIR:-$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd -P)}"
KOISHI_LOG_FILE="${KOISHI_LOG_FILE:-$APP_DIR/koishi.log}"
NAPCAT_LOG_FILE="${NAPCAT_LOG_FILE:-/root/napcat.log}"
LOGROTATE_CONFIG="${LIAN_LOGROTATE_CONFIG:-/etc/logrotate.d/lian-bot}"
ROTATE_SIZE="${LIAN_LOGROTATE_SIZE:-50M}"
ROTATE_COUNT="${LIAN_LOGROTATE_COUNT:-14}"

# Reject paths that could escape the generated logrotate grammar.
require_safe_log_path() {
  case "$1" in
    /*) ;;
    *) echo "[install-logrotate] log path must be absolute: $1" >&2; exit 1 ;;
  esac
  case "$1" in
    *[\"{}[:space:]]*) echo "[install-logrotate] unsafe log path: $1" >&2; exit 1 ;;
  esac
}

# Ensure the host has a supported logrotate binary before installing configuration.
ensure_logrotate() {
  if command -v logrotate >/dev/null 2>&1; then return 0; fi
  if [ "$(id -u)" -ne 0 ] || ! command -v apt-get >/dev/null 2>&1; then
    echo "[install-logrotate] logrotate is missing and cannot be installed automatically" >&2
    exit 1
  fi
  DEBIAN_FRONTEND=noninteractive apt-get install -y logrotate
}

if [ "$(id -u)" -ne 0 ]; then
  echo "[install-logrotate] root is required" >&2
  exit 1
fi

require_safe_log_path "$KOISHI_LOG_FILE"
require_safe_log_path "$NAPCAT_LOG_FILE"
ensure_logrotate

tmp="$(mktemp "${LOGROTATE_CONFIG}.tmp.XXXXXX")"
trap 'rm -f "$tmp"' EXIT INT TERM
cat > "$tmp" <<EOF
$KOISHI_LOG_FILE $NAPCAT_LOG_FILE {
    size $ROTATE_SIZE
    rotate $ROTATE_COUNT
    missingok
    notifempty
    compress
    delaycompress
    copytruncate
    su root root
}
EOF

logrotate --debug "$tmp" >/dev/null 2>&1
install -m 0644 "$tmp" "$LOGROTATE_CONFIG"

if command -v systemctl >/dev/null 2>&1 && systemctl list-unit-files logrotate.timer >/dev/null 2>&1; then
  systemctl enable --now logrotate.timer >/dev/null
fi

echo "[install-logrotate] installed $LOGROTATE_CONFIG (size=$ROTATE_SIZE rotate=$ROTATE_COUNT)"
