exports.name = 'dongxuelian-help'

const PLUGIN_VERSION = '0.5.5'

// 统一压缩消息里的多余空白，方便做精确指令匹配。
function normalizeText(text = '') {
  return String(text).replace(/\s+/g, ' ').trim()
}

function stripMentions(text = '') {
  return String(text)
    .replace(/<at(?:\s+[^>]*?)?id="(\d+)"[^>]*\/?>/gi, ' ')
    .replace(/\[CQ:at,[^\]]*?(?:qq|id)=(\d+)[^\]]*\]/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

const PROVIDERS = {
  opencode: {
    name: 'OpenCode Go',
    baseURL: 'https://opencode.ai/zen/go/v1',
    models: [
      { id: 'glm-5', name: 'GLM-5' },
      { id: 'glm-5.1', name: 'GLM-5.1' },
      { id: 'kimi-k2.5', name: 'Kimi K2.5' },
      { id: 'kimi-k2.6', name: 'Kimi K2.6' },
      { id: 'deepseek-v4-pro', name: 'DSv4pro' },
      { id: 'deepseek-v4-flash', name: 'DSv4' },
      { id: 'mimo-v2-pro', name: 'MiMo-V2-Pro' },
      { id: 'mimo-v2-omni', name: 'MiMo-V2-Omni' },
      { id: 'mimo-v2.5-pro', name: 'MiMo-V2.5-Pro' },
      { id: 'mimo-v2.5', name: 'MiMo-V2.5' },
      { id: 'minimax-m2.7', name: 'MiniMax M2.7' },
      { id: 'minimax-m2.5', name: 'MiniMax M2.5' },
      { id: 'qwen3.6-plus', name: '千问3.6' },
      { id: 'qwen3.5-plus', name: '千问3.5' },
    ],
  },
  dashscope: {
    name: '阿里云',
    baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    models: [
      { id: 'qwen3.5-plus', name: 'qwen3.5' },
      { id: 'qwen3.6-plus', name: 'qwen3.6' },
      { id: 'qwen3.5-omni-flash', name: 'Qwen3.5-Omni-Flash' },
    ],
  },
  deepseek: {
    name: 'DeepSeek 官方',
    baseURL: 'https://api.deepseek.com',
    models: [
      { id: 'deepseek-chat', name: 'deepseek-chat' },
      { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash' },
      { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro' },
    ],
  },
  glm: {
    name: '智谱GLM',
    baseURL: 'https://open.bigmodel.cn/api/paas/v4',
    models: [
      { id: 'glm-4.6v-flash', name: 'GLM 4.6' },
    ],
  },
  mimorium: {
    name: '小米',
    baseURL: 'https://platform.mimorium.com',
    models: [
      { id: 'mimo-v2.5-pro', name: 'mimo 2.5' },
      { id: 'mimo-v2-omni', name: 'mimo v2' },
    ],
  },
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
    '【切换模型】',
    '【群聊主动回复】',
    '【联网】',
    '【抓取原始事件】',
    '【白名单黑名单管理】',
  ].join('\n')
}

function renderCommonHelp() {
  return [
    '【常用】',
    '@东雪莲 你的问题',
    'AI状态',
    'AI重载（bot管理员）',
  ].join('\n')
}

function renderBlacklistHelp() {
  return [
    '【白名单黑名单管理】',
    '用户黑名单添加／删除／查看',
    '解除上限群白名单添加／删除／查看',
    '视频黑名单添加群／删除群',
    '视频黑名单查看',
  ].join('\n')
}

function renderGroupReplyHelp() {
  return [
    '【群聊主动回复】',
    '东雪莲群聊AI概率查看',
    '东雪莲群聊AI概率设置X%（bot管理员）',
    '东雪莲群聊AI概率重置（bot管理员）',
    '群聊AI白名单查看（bot管理员）',
    '群聊AI白名单添加群号（bot管理员）',
    '群聊AI白名单删除群号（bot管理员）',
  ].join('\n')
}

function renderNetworkHelp() {
  return [
    '【联网】',
    '东雪莲联网查看',
    '东雪莲联网开（bot管理员）',
    '东雪莲联网关（bot管理员）',
  ].join('\n')
}

function renderEventHelp() {
  return [
    '【抓取原始事件】',
    'AI抓事件（bot管理员）',
    'AI抓事件查看（bot管理员）',
    'AI抓事件取消（bot管理员）',
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
    '东雪莲联网查看',
    '东雪莲联网开 / 关 仅限管理员',
    '东雪莲群聊AI概率查看',
    '东雪莲群聊AI概率设置5% / 重置 仅限管理员',
    '群聊AI白名单添加/删除/查看 仅限管理员',
    'AI抓事件 / 查看 / 取消 仅限管理员',
    '',
    '【集合】',
    '@A用户 昵称 名称A',
    '查看昵称 名称A / 谁是 名称A',
    '创建集合 集合A @A用户 @B用户',
    '集合添加 / 集合删除 / 查看集合 / 集合列表',
    '集合交集 / 集合并集 / 集合差集',
    'at集合A / at名称A',
  ].join('\n')
}

function renderSwitchModels() {
  return [
    '供应商 opencode',
    '供应商 dashscope',
    '供应商 deepseek',
    '供应商 glm',
    '供应商 mimorium',
  ].join('\n')
}

function renderProviderModels(providerId) {
  const id = String(providerId).toLowerCase()
  const prov = PROVIDERS[id] || Object.values(PROVIDERS).find(p => p.name.toLowerCase() === id)
  if (!prov) return `未找到供应商「${providerId}」`
  return [
    `${prov.name} 可用模型：`,
    ...prov.models.map(m => `切换${m.name}`),
  ].join('\n')
}

function renderAvailableModels() {
  let text = ''
  for (const [, prov] of Object.entries(PROVIDERS)) {
    text += `${prov.name}：\n`
    text += prov.models.map(m => `  ${m.name}（${m.id}）`).join('\n') + '\n\n'
  }
  return text.trim()
}

exports.apply = (ctx) => {
  ctx.on('ready', () => {
    ctx.logger('dongxuelian-help').info(`dongxuelian-help ${PLUGIN_VERSION} loaded`)
  })

  ctx.middleware((session, next) => {
    const plain = normalizeText(stripMentions(session.content || ''))

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

    if (plain === '常用') {
      return renderCommonHelp()
    }

    if (plain === '群聊主动回复') {
      return renderGroupReplyHelp()
    }

    if (plain === '联网') {
      return renderNetworkHelp()
    }

    if (plain === '抓取原始事件') {
      return renderEventHelp()
    }

    if (plain === '黑名单管理') {
      return renderBlacklistHelp()
    }

    if (plain === '切换模型') {
      return renderSwitchModels()
    }

    if (plain === '可用模型') {
      return renderAvailableModels()
    }

    const providerMatch = plain.match(/^供应商\s+(.+)$/)
    if (providerMatch) {
      return renderProviderModels(providerMatch[1])
    }

    return next()
  })
}
