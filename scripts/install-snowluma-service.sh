#!/usr/bin/env bash
# 安装独立 SL 服务与双向互斥门禁；保留已有 NapCat 代码、配置和登录数据。
set -Eeuo pipefail
umask 077
sl_dir="${SNOWLUMA_DIR:-/root/SnowLuma}"
app_dir="${KOISHI_APP_DIR:-/root/koishi-app}"
qq_source="${NAPCAT_QQ_SOURCE:-/root/Napcat/opt/QQ}"
script_dir="$(cd -- "$(dirname -- "$0")" && pwd)"
if [ "$sl_dir" != /root/SnowLuma ] || [ "$app_dir" != /root/koishi-app ]; then
  echo 'This service installer targets /root/SnowLuma and /root/koishi-app only.' >&2
  exit 2
fi
test -x "$sl_dir/runtime/node"
test -f "$sl_dir/runtime/index.mjs"
test -f "$sl_dir/novnc/usr/share/novnc/core/rfb.js"
command -v x11vnc Xvfb xdpyinfo openbox >/dev/null
mkdir -p "$sl_dir/bin" "$sl_dir/state" "$sl_dir/home" "$sl_dir/run" "$sl_dir/qq/opt"
chmod 700 "$sl_dir" "$sl_dir/bin" "$sl_dir/state" "$sl_dir/home" "$sl_dir/run"

if [ ! -x "$sl_dir/qq/opt/QQ/qq" ]; then
  # 当前腾讯下载站拒绝下载，复用已安装 QQ 的完整代码副本。
  # 原始 launcher 仍在；只在副本恢复它，并移除 NapCat 加载器和插件。
  test -x "$qq_source/qq"
  cp -a "$qq_source" "$sl_dir/qq/opt/QQ"
  /usr/bin/node - "$sl_dir/qq/opt/QQ" <<'NODE'
const fs = require('fs')
const path = require('path')
const root = process.argv[2]
const original = path.join(root, 'resources/app/app_launcher/index.js')
if (!fs.readFileSync(original, 'utf8').includes("require('../major.node').load('internal_index', module)")) throw new Error('Original QQ launcher is missing')
const packagePath = path.join(root, 'resources/app/package.json')
const pkg = JSON.parse(fs.readFileSync(packagePath, 'utf8'))
pkg.main = './app_launcher/index.js'
fs.writeFileSync(packagePath, JSON.stringify(pkg, null, 2) + '\n')
fs.rmSync(path.join(root, 'resources/app/app_launcher/napcat'), { recursive: true, force: true })
fs.rmSync(path.join(root, 'resources/app/loadNapCat.js'), { force: true })
NODE
fi

if [ ! -f "$sl_dir/bootstrap-password" ]; then
  /usr/bin/node - "$sl_dir/bootstrap-password" <<'NODE'
const fs = require('fs')
fs.writeFileSync(process.argv[2], require('crypto').randomBytes(32).toString('base64url'), { mode: 0o600, flag: 'wx' })
NODE
fi
for script in qq-protocol-gate.sh start-snowluma.sh; do
  install -m 700 "$script_dir/$script" "$sl_dir/bin/$script"
done

cat > /etc/systemd/system/lian-snowluma.service <<EOF
[Unit]
Description=LianLianBot SnowLuma v2.4.2
After=network-online.target
Wants=network-online.target
Conflicts=lian-napcat.service
Before=lian-napcat.service

[Service]
Type=simple
User=root
WorkingDirectory=$sl_dir/state
Environment=SNOWLUMA_DIR=$sl_dir
Environment=KOISHI_APP_DIR=$app_dir
ExecCondition=/bin/bash $sl_dir/bin/qq-protocol-gate.sh sl
ExecStart=/bin/bash $sl_dir/bin/start-snowluma.sh
Restart=on-failure
RestartSec=5
KillMode=control-group
TimeoutStopSec=15
LimitNOFILE=65535
StandardOutput=append:$sl_dir/snowluma.log
StandardError=append:$sl_dir/snowluma.log

[Install]
WantedBy=multi-user.target
EOF
mkdir -p /etc/systemd/system/lian-napcat.service.d
cat > /etc/systemd/system/lian-napcat.service.d/40-protocol-gate.conf <<EOF
[Unit]
Conflicts=lian-snowluma.service
[Service]
Environment=KOISHI_APP_DIR=$app_dir
ExecCondition=/bin/bash $sl_dir/bin/qq-protocol-gate.sh napcat
EOF
systemctl daemon-reload
echo 'SnowLuma service installed. Select SL in Dashboard to start; NapCat remains the current selection.'
