#!/usr/bin/env bash
# systemd 启动前核对持久协议选择，阻止旧入口或开机自启拉起另一套协议。
set -Eeuo pipefail
provider="${1:?usage: qq-protocol-gate.sh napcat|sl}"
app_dir="${KOISHI_APP_DIR:-/root/koishi-app}"
exec /usr/bin/node - "$app_dir/data/qq-protocol.json" "$provider" <<'NODE'
const fs = require('fs')
const [file, provider] = process.argv.slice(2)
const selected = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')).provider : 'napcat'
if (!['napcat', 'sl'].includes(selected)) throw new Error('Invalid QQ protocol selection')
process.exit(selected === provider ? 0 : 1)
NODE
