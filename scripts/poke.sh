rm -rf /root/koishi-app/node_modules/koishi-plugin-dongxuelian-poke
mkdir -p /root/koishi-app/node_modules/koishi-plugin-dongxuelian-poke/lib
cat > /root/koishi-app/node_modules/koishi-plugin-dongxuelian-poke/package.json <<'EOF'
{
  "name": "koishi-plugin-dongxuelian-poke",
  "version": "1.1.0",
  "main": "lib/index.js"
}
EOF
cat > /root/koishi-app/node_modules/koishi-plugin-dongxuelian-poke/lib/index.js <<'EOF'
exports.name = 'dongxuelian-poke'

async function pokeBack(session, ctx) {
  const userId = String(session.userId || '')
  const guildId = String(session.guildId || '')
  if (!userId) return

  const internal = session.bot?.internal
  if (!internal || typeof internal._request !== 'function') {
    ctx.logger('dongxuelian-poke').warn('no _request method, cannot poke back')
    return
  }

  // NapCat OneBot 扩展 API：group_poke
  await internal._request('group_poke', { group_id: guildId, user_id: userId })
  ctx.logger('dongxuelian-poke').info(`poke back: group=${guildId} user=${userId}`)
}

exports.apply = (ctx) => {
  ctx.on('notice', async (session) => {
    const sub = session.subtype || session.sub_type || ''
    if (sub !== 'poke') return

    const botId = String(session.selfId || session.bot?.selfId || '')
    const targetId = String(session.targetId || session.target_id || '')
    if (!botId || targetId !== botId) return

    try {
      await pokeBack(session, ctx)
    } catch (err) {
      ctx.logger('dongxuelian-poke').warn('poke back failed:', err)
    }
  })
}
EOF
node <<'EOF'
const fs = require('fs')

const configFile = '/root/koishi-app/koishi.yml'
const pluginLine = 'dongxuelian-poke: {}'

const text = fs.readFileSync(configFile, 'utf8')
fs.copyFileSync(configFile, `${configFile}.bak-dongxuelian-poke`)

const lines = text
  .split(/\r?\n/)
  .filter(line => !/^\s*dongxuelian-poke(?::[a-z0-9]+)?:\s*\{\}\s*$/.test(line))
let inserted = false

for (let index = 0; index < lines.length; index += 1) {
  const match = lines[index].match(/^(\s*)group:basic:\s*$/)
  if (match) {
    lines.splice(index + 1, 0, `${match[1]}  ${pluginLine}`)
    inserted = true
    break
  }
}

if (!inserted) {
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(/^(\s*)plugins:\s*$/)
    if (match) {
      lines.splice(index + 1, 0, `${match[1]}  ${pluginLine}`)
      inserted = true
      break
    }
  }
}

if (!inserted) {
  lines.push('')
  lines.push('plugins:')
  lines.push(`  ${pluginLine}`)
}

fs.writeFileSync(configFile, lines.join('\n'), 'utf8')
console.log('enabled dongxuelian-poke in koishi.yml')
EOF
printf '\nInstalled koishi-plugin-dongxuelian-poke 1.0.0\n'
systemctl restart koishi
printf 'Restarted koishi. Check logs with:\n'
printf 'journalctl -u koishi -n 60 --no-pager | grep dongxuelian-poke\n'
