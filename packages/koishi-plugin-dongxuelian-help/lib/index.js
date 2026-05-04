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
    baseURL: 'https://token-plan-cn.xiaomimimo.com/v1',
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
    '- 人格',
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
    '【集合】',
    '【敏感话题检测】',
    '【白名单黑名单管理】',
    '【人格】',
  ].join('\n')
}

function renderCommonHelp() {
  return [
    '【常用】',
    '@东雪莲 你的问题',
    'AI状态',
    '- AI诊断（bot管理员）',
    'AI重载（bot管理员）',
    '东雪莲忘记我',
    '东雪莲清空群记忆（群管理员）',
    '东雪莲复读开 / 关 / 状态',
    '今日情绪',
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
    '东雪莲复读开 / 关 / 状态',
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

function renderCollectionHelp() {
  return [
    '\u3010\u96c6\u5408\u3011',
    '@A\u7528\u6237 \u6635\u79f0 \u540d\u79f0A',
    '\u67e5\u770b\u6635\u79f0 \u540d\u79f0A / \u8c01\u662f \u540d\u79f0A',
    '\u67e5\u770b\u6210\u5458 @A\u7528\u6237',
    '\u67e5\u770b\u5168\u90e8\u6635\u79f0',
    '\u521b\u5efa\u96c6\u5408 \u96c6\u5408A @A\u7528\u6237 @B\u7528\u6237',
    '\u96c6\u5408\u6dfb\u52a0 \u96c6\u5408A @A\u7528\u6237',
    '\u96c6\u5408\u5220\u9664 \u96c6\u5408A @A\u7528\u6237',
    '\u67e5\u770b\u96c6\u5408 \u96c6\u5408A / \u96c6\u5408\u5217\u8868 / \u67e5\u770b\u5168\u90e8\u96c6\u5408',
    '\u590d\u5236\u96c6\u5408 A B / \u5408\u5e76\u96c6\u5408 A B',
    '\u96c6\u5408\u4ea4\u96c6 A B / \u96c6\u5408\u5e76\u96c6 A B / \u96c6\u5408\u5dee\u96c6 A B',
    'at\u96c6\u5408A / at\u540d\u79f0A',
  ].join('\n')
}

function renderQuickReference() {
  return [
    '\u3010\u6307\u4ee4\u901f\u67e5\u3011',
    'help\u4e1c\u96ea\u83b2\uff1a\u67e5\u770b\u603b\u83dc\u5355',
    'helpAI\uff1a\u67e5\u770b AI \u83dc\u5355',
    'help\u96c6\u5408\uff1a\u67e5\u770b\u6635\u79f0\u4e0e\u96c6\u5408\u547d\u4ee4',
    'AI\u72b6\u6001\uff1a\u67e5\u770b AI \u5f53\u524d\u914d\u7f6e',
    'AI\u91cd\u8f7d\uff1a\u91cd\u8f7d AI \u914d\u7f6e\uff08bot\u7ba1\u7406\u5458\uff09',
    'AI\u8bca\u65ad\uff1a\u68c0\u67e5\u5404\u4f9b\u5e94\u5546\u72b6\u6001\uff08bot\u7ba1\u7406\u5458\uff09',
    '\u4e1c\u96ea\u83b2\u8054\u7f51\u5f00 / \u5173 / \u67e5\u770b',
    '\u4e1c\u96ea\u83b2\u7fa4\u804aAI\u6982\u7387\u67e5\u770b / \u8bbe\u7f6eX% / \u91cd\u7f6e',
    '\u654f\u611f\u8bdd\u9898\u68c0\u6d4b\u5f00 / \u5173 / \u67e5\u770b',
    '\u654f\u611f\u8bdd\u9898\u5904\u7406\u8005\u6dfb\u52a0 / \u5220\u9664 / \u67e5\u770b',
    '\u7528\u6237\u9ed1\u540d\u5355\u6dfb\u52a0 / \u5220\u9664 / \u67e5\u770b',
    '\u89c6\u9891\u9ed1\u540d\u5355\u6dfb\u52a0\u7fa4 / \u5220\u9664\u7fa4 / \u67e5\u770b',
  ].join('\n')
}

function renderSensitiveHelp() {
  return [
    '【敏感话题检测】',
    '敏感话题检测开（群主、群管理员或bot管理员）',
    '敏感话题检测关（群主、群管理员或bot管理员）',
    '敏感话题检测查看',
    '敏感话题处理者添加 <QQ号>',
    '敏感话题处理者删除 <QQ号>',
    '敏感话题处理者查看',
  ].join('\n')
}

function renderPersonaHelp() {
  return [
    '【人格】',
    '东雪莲我的人格 / 东雪莲人格查看（用户级）',
    '东雪莲人格切换 <名称>（用户级）',
    '东雪莲人格列表',
    '东雪莲人格重置（用户级）',
    '东雪莲群人格（管理员）',
    '东雪莲群人格切换 <名称>（管理员）',
    '东雪莲群人格重置（管理员）',
    '东雪莲测试开 / 关（bot管理员）',
    '东雪莲思考开 / 关',
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

    if (plain === '其他') {
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

    if (plain === '黑名单管理' || plain === '白名单黑名单管理' || plain === '黑名单白名单管理') {
      return renderBlacklistHelp()
    }

    if (plain === '人格') {
      return renderPersonaHelp()
    }

    if (plain === '集合') {
      return renderCollectionHelp()
    }

    if (plain === '敏感话题检测') {
      return renderSensitiveHelp()
    }

    if (plain === '切换模型') {
      return renderSwitchModels()
    }

    if (plain === '可用模型') {
      return renderAvailableModels()
    }

    // #4 /help xxx 模糊搜索
    const helpSearchMatch = plain.match(/^help(.+)/)
    if (helpSearchMatch) {
      const keyword = helpSearchMatch[1].trim()
      if (!keyword) return ''
      const allRenderers = [
        renderRootHelp, renderAiHelp, renderCommonHelp, renderGroupReplyHelp,
        renderNetworkHelp, renderEventHelp, renderCollectionHelp,
        renderBlacklistHelp, renderSensitiveHelp, renderPersonaHelp,
        renderSwitchModels, renderAvailableModels, renderQuickReference,
      ]
      const allText = allRenderers.map(fn => fn()).join('\n')
      const matchedLines = allText.split('\n').filter(line => line.includes(keyword))
      if (!matchedLines.length) return '未找到相关帮助。'
      return matchedLines.slice(0, 5).map(line => line.trim()).join('\n')
    }

    const providerMatch = plain.match(/^供应商\s+(.+)$/)
    if (providerMatch) {
      return renderProviderModels(providerMatch[1])
    }

    return next()
  })
}
