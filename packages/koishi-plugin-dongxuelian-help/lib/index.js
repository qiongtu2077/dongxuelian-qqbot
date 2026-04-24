exports.name = 'dongxuelian-help'

const PLUGIN_VERSION = '0.4.4'

// 统一压缩消息里的多余空白，方便做精确指令匹配。
function normalizeText(text = '') {
  return String(text).replace(/\s+/g, ' ').trim()
}

// 根帮助菜单：列出当前可查看的子菜单与速查入口。
function renderRootHelp() {
  return [
    '东雪莲帮助',
    '',
    '可用子菜单：',
    '- helpAI / 帮助AI / AI帮助',
    '- help集合 / 帮助集合',
    '- 指令速查 / help速查 / 帮助速查',
  ].join('\n')
}

// AI 帮助：集中展示对话、状态和管理员命令。
function renderAiHelp() {
  return [
    'AI帮助',
    'helpAI / 帮助AI / AI帮助',
    '',
    '【常用】',
    '@东雪莲 你的问题',
    'AI状态',
    'AI重载 仅限管理员',
    '',
    '【群聊主动回复】',
    '东雪莲群聊AI概率查看',
    '东雪莲群聊AI概率设置5%',
    '东雪莲群聊AI概率重置',
    '群聊AI白名单查看',
    '群聊AI白名单添加1234567890',
    '群聊AI白名单删除1234567890',
    '',
    '【联网】',
    '东雪莲联网查看',
    '东雪莲联网开',
    '东雪莲联网关',
    '',
    '【权限】',
    '管理员仅限 QQ 100000000 / 200000000',
  ].join('\n')
}

// 集合帮助：保留昵称/集合相关命令的完整速查。
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

// 指令速查：给群里直接看的一页版命令摘要。
function renderQuickReference() {
  return [
    '指令速查',
    '',
    '【帮助】',
    'help东雪莲 / helpAI / help集合 / 指令速查',
    '',
    '【AI】',
    '@东雪莲 你的问题',
    'AI状态',
    'AI重载 仅限管理员',
    '东雪莲联网开/关/查看 仅限管理员',
    '东雪莲群聊AI概率设置5% / 重置 / 查看 仅限管理员',
    '群聊AI白名单添加/删除/查看 仅限管理员',
    '',
    '【集合】',
    '@A用户 昵称 名称A',
    '查看昵称 名称A / 谁是 名称A',
    '创建集合 集合A @A用户 @B用户',
    '集合添加 / 集合删除 / 查看集合 / 集合列表',
    '集合交集 / 集合并集 / 集合差集',
    'at集合A / at名称A',
    '',
    '管理员仅限 QQ 100000000 / 200000000',
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

    if (plain === 'helpAI' || plain === '帮助AI' || plain === 'AI帮助') {
      return renderAiHelp()
    }

    if (plain === 'help集合' || plain === '帮助集合') {
      return renderCollectionHelp()
    }

    if (plain === '指令速查' || plain === 'help速查' || plain === '帮助速查') {
      return renderQuickReference()
    }

    return next()
  })
}
