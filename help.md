mkdir -p /root/koishi-app/node_modules/koishi-plugin-dongxuelian-help/lib
cat > /root/koishi-app/node_modules/koishi-plugin-dongxuelian-help/package.json <<'EOF'
{
  "name": "koishi-plugin-dongxuelian-help",
  "version": "0.4.3",
  "main": "lib/index.js"
}
EOF
cat > /root/koishi-app/node_modules/koishi-plugin-dongxuelian-help/lib/index.js <<'EOF'
exports.name = 'dongxuelian-help'

const PLUGIN_VERSION = '0.4.3'

function normalizeText(text = '') {
  return String(text).replace(/\s+/g, ' ').trim()
}

function renderRootHelp() {
  return [
    '东雪莲帮助',
    '',
    '可用子菜单：',
    '- help集合 / 帮助集合',
  ].join('\n')
}

function renderCollectionHelp() {
  return [
    '集合帮助',
    'help集合 / 帮助集合',
    '',
    '【昵称绑定】',
    '@A用户 昵称 名称A',
    '@A用户 昵称名称A',
    '',
    '【昵称查询】',
    '查看昵称 名称A / 谁是 名称A',
    '查看成员 A用户 / 查看成员 @A用户',
    '查看全部昵称 / nicklist',
    '',
    '【集合操作】',
    '创建集合 集合A @A用户 @B用户',
    '集合添加 集合A @A用户 @B用户',
    '集合删除 集合A @A用户 @B用户',
    '查看集合 集合A',
    '查看全部集合 / 集合列表',
    '',
    '【集合管理】',
    '重命名集合 集合A 集合B',
    '复制集合 集合A 集合B',
    '合并集合 集合A 集合B',
    '清空集合 集合A / 确认清空集合 集合A',
    '删除集合 集合A / 确认删除集合 集合A',
    '',
    '【集合运算】',
    '集合交集 集合A 集合B',
    '集合并集 集合A 集合B',
    '集合差集 集合A 集合B',
    '',
    '【批量艾特】',
    'at集合A / at名称A',
  ].join('\n')
}

exports.apply = (ctx) => {
  ctx.on('ready', () => {
    ctx.logger('dongxuelian-help').info(`dongxuelian-help ${PLUGIN_VERSION} loaded`)
  })

  ctx.middleware((session, next) => {
    const plain = normalizeText(session.content || '')

    if (plain === 'help东雪莲' || plain === '帮助东雪莲' || plain === '东雪莲help' || plain === '东雪莲帮助') {
      return renderRootHelp()
    }

    if (plain === 'help集合' || plain === '帮助集合') {
      return renderCollectionHelp()
    }

    return next()
  })
}
EOF
printf '\nInstalled koishi-plugin-dongxuelian-help 0.4.1\n'
systemctl restart koishi
