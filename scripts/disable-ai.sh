rm -rf /root/koishi-app/node_modules/koishi-plugin-dongxuelian-ai
node <<'EOF'
const fs = require('fs')

const configFile = '/root/koishi-app/koishi.yml'

let text = fs.readFileSync(configFile, 'utf8')
fs.copyFileSync(configFile, `${configFile}.bak-disable-ai`)

const lines = text
  .split(/\r?\n/)
  .filter(line => !/^\s*dongxuelian-ai(?::[a-z0-9]+)?:\s*\{\}\s*$/.test(line))

fs.writeFileSync(configFile, lines.join('\n'), 'utf8')
console.log('disabled dongxuelian-ai in koishi.yml')
EOF
printf '\nDisabled koishi-plugin-dongxuelian-ai\n'
systemctl restart koishi
printf 'Restarted koishi. Check logs with:\n'
printf 'journalctl -u koishi -n 120 --no-pager\n'
