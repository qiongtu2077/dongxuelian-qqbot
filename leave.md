mkdir -p /root/koishi-app/node_modules/koishi-plugin-group-leave-notice/lib
cat > /root/koishi-app/node_modules/koishi-plugin-group-leave-notice/package.json <<'EOF'
{
  "name": "koishi-plugin-group-leave-notice",
  "version": "0.1.0",
  "main": "lib/index.js"
}
EOF
cat > /root/koishi-app/node_modules/koishi-plugin-group-leave-notice/lib/index.js <<'EOF'
exports.name = 'group-leave-notice'

const PLUGIN_VERSION = '0.1.0'

function getGuildId(session) {
  return session.guildId || session.event?.guild?.id || session.event?.channel?.id
}

function getUserId(session) {
  return session.userId || session.event?.user?.id || session.event?.member?.user?.id
}

async function sendLeaveNotice(session) {
  const guildId = getGuildId(session)
  const userId = getUserId(session)
  if (!guildId || !userId) return

  await session.bot.sendMessage(guildId, `${userId} 退群了`)
}

exports.apply = (ctx) => {
  ctx.on('ready', () => {
    ctx.logger('group-leave-notice').info(`group-leave-notice ${PLUGIN_VERSION} loaded`)
  })

  ctx.on('guild-member-removed', async (session) => {
    try {
      await sendLeaveNotice(session)
    } catch (error) {
      ctx.logger('group-leave-notice').warn(error.message)
    }
  })
}
EOF
node <<'EOF'
const fs = require('fs')

const configFile = '/root/koishi-app/koishi.yml'
const pluginLine = 'group-leave-notice: {}'

let text = fs.readFileSync(configFile, 'utf8')
if (new RegExp(`(^|\\n)\\s*${pluginLine.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(text)) {
  console.log('group-leave-notice already enabled in koishi.yml')
  process.exit(0)
}

fs.copyFileSync(configFile, `${configFile}.bak-group-leave-notice`)

const lines = text.split(/\r?\n/)
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
console.log('enabled group-leave-notice in koishi.yml')
EOF
printf '\nInstalled koishi-plugin-group-leave-notice 0.1.0\n'
systemctl restart koishi
printf 'Restarted koishi. Check logs with:\n'
printf 'journalctl -u koishi -n 120 --no-pager | grep group-leave-notice\n'
