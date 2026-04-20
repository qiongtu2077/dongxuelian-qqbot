mkdir -p /root/koishi-app/node_modules/koishi-plugin-dongxuelian-help/lib
cat > /root/koishi-app/node_modules/koishi-plugin-dongxuelian-help/package.json <<'EOF'
{
  "name": "koishi-plugin-dongxuelian-help",
  "version": "0.3.0",
  "main": "lib/index.js"
}
EOF
cat > /root/koishi-app/node_modules/koishi-plugin-dongxuelian-help/lib/index.js <<'EOF'
exports.name = 'dongxuelian-help'

const PLUGIN_VERSION = '0.3.0'

const TRIGGERS = {
  all: 'help东雪莲',
  collection: 'help集合',
}

const HELP_ALL = [
  '东雪莲帮助菜单',
  '',
  '可用子菜单：',
  'help集合',
].join('\n')

const HELP_COLLECTION = [
  '集合功能菜单',
  '',
  '一、基础绑定',
  '@A用户 昵称 名称A / 删除昵称 名称A / 删除昵称 名称A @A用户 / at名称A',
  '',
  '二、查询',
  '查看昵称 @A用户 / 查看昵称 A用户',
  '查看集合 集合A / 谁是 集合A',
  '查看全部昵称 / nicklist',
  '查看全部集合 / 集合列表',
  '说明：1 人的是昵称，2 人及以上的是集合',
  '',
  '三、集合管理',
  '创建集合 集合A @A用户 @B用户 / 集合添加 集合A @A用户 @B用户 / 集合删除 集合A @A用户 @B用户',
  '清空集合 集合A / 确认清空集合 集合A',
  '删除集合 集合A / 确认删除集合 集合A',
  '重命名集合 集合A 集合B / 重命名昵称 名称A 名称B',
  '复制集合 集合A 集合B / 合并集合 集合A 集合B',
  '',
  '四、集合运算',
  '集合交集 集合A 集合B / 集合并集 集合A 集合B / 集合差集 集合A 集合B',
].join('\n')

const HELP_MAP = {
  [TRIGGERS.all]: HELP_ALL,
  [TRIGGERS.collection]: HELP_COLLECTION,
}

function normalizeText(text = '') {
  return String(text).replace(/\s+/g, '').trim()
}

exports.apply = (ctx) => {
  ctx.on('ready', () => {
    ctx.logger('dongxuelian-help').info(`dongxuelian-help ${PLUGIN_VERSION} loaded`)
  })

  for (const [trigger, message] of Object.entries(HELP_MAP)) {
    ctx.command(trigger, `show help for ${trigger}`).action(() => message)
  }

  ctx.middleware(async (session, next) => {
    const text = normalizeText(session.content || '')
    if (HELP_MAP[text]) return HELP_MAP[text]
    return next()
  })
}
EOF
node <<'EOF'
const fs = require('fs')

const configFile = '/root/koishi-app/koishi.yml'
const pluginLine = 'dongxuelian-help: {}'

let text = fs.readFileSync(configFile, 'utf8')
if (new RegExp(`(^|\\n)\\s*${pluginLine.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(text)) {
  console.log('dongxuelian-help already enabled in koishi.yml')
  process.exit(0)
}

fs.copyFileSync(configFile, `${configFile}.bak-dongxuelian-help`)

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
console.log('enabled dongxuelian-help in koishi.yml')
EOF
printf '\nInstalled koishi-plugin-dongxuelian-help 0.3.0\n'
systemctl restart koishi
printf 'Restarted koishi. Check logs with:\n'
printf 'journalctl -u koishi -n 120 --no-pager | grep dongxuelian-help\n'
