mkdir -p /root/koishi-app/data
chmod 700 /root/koishi-app/data
rm -rf /root/koishi-app/node_modules/koishi-plugin-dongxuelian-ai
mkdir -p /root/koishi-app/node_modules/koishi-plugin-dongxuelian-ai/lib
cat > /root/koishi-app/node_modules/koishi-plugin-dongxuelian-ai/package.json <<'EOF'
{
  "name": "koishi-plugin-dongxuelian-ai",
  "version": "0.2.10",
  "main": "lib/index.js"
}
EOF
cat > /root/koishi-app/node_modules/koishi-plugin-dongxuelian-ai/lib/index.js <<'EOF'
const fs = require('fs/promises')
const path = require('path')

exports.name = 'dongxuelian-ai'

const PLUGIN_VERSION = '0.2.10'
const KEY_FILE = '/root/koishi-app/data/ai-openai-key.txt'
const MODEL_FILE = '/root/koishi-app/data/ai-model.txt'
const BASE_URL_FILE = '/root/koishi-app/data/ai-base-url.txt'
const SKILLS_DIR = '/root/koishi-app/data/ai-skills'
const RANDOM_TRIGGER_RATE = Number(process.env.AI_RANDOM_TRIGGER_RATE || 0.08)
const REQUEST_TIMEOUT = Number(process.env.AI_REQUEST_TIMEOUT_MS || 40000)
const MAX_OUTPUT_CHARS = 120
const MAX_HISTORY_ROUNDS = 5

const RESERVED_PREFIXES = [
  '昵称',
  '删除昵称',
  '查看昵称',
  '查看集合',
  '查看全部昵称',
  '查看全部集合',
  '集合列表',
  '谁是',
  '创建集合',
  '集合添加',
  '集合删除',
  '清空集合',
  '确认清空集合',
  '删除集合',
  '确认删除集合',
  '重命名集合',
  '重命名昵称',
  '复制集合',
  '合并集合',
  '集合交集',
  '集合并集',
  '集合差集',
  'nicklist',
  'help东雪莲',
  'help集合',
]

let configCache = null
let skillsCache = []
let conversationCache = new Map()

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

function extractAtIds(text = '') {
  const ids = []
  const source = String(text)
  const patterns = [
    /<at(?:\s+[^>]*?)?id="(\d+)"[^>]*\/?>/gi,
    /\[CQ:at,[^\]]*?(?:qq|id)=(\d+)[^\]]*\]/gi,
  ]

  for (const pattern of patterns) {
    pattern.lastIndex = 0
    let match
    while ((match = pattern.exec(source))) {
      const userId = String(match[1])
      if (!ids.includes(userId)) ids.push(userId)
    }
  }

  return ids
}

function containsBlockedRichContent(text = '') {
  const value = String(text)
  if (!value) return false

  if (/https?:\/\/(?:www\.)?(?:bilibili\.com|b23\.tv)\//i.test(value)) return true
  if (/\bBV[0-9A-Za-z]{10}\b/i.test(value)) return true
  if (/\[CQ:(?:json|xml),/i.test(value)) return true
  if (/\[CQ:(?:image|img|mface|face|forward|longmsg|record|video),/i.test(value)) return true
  if (/<(?:json|xml)[^>]*>/i.test(value)) return true
  if (/<(?:img|image|audio|video|file|forward)[^>]*>/i.test(value)) return true
  if (/appid=|appId=|miniapp|小程序/i.test(value)) return true

  return false
}

function isReservedCommand(plain = '') {
  const value = normalizeText(plain)
  if (!value) return false
  if (value.startsWith('昵称') && value !== '昵称') return true
  if (/^at\s*\S+/i.test(value)) return true
  return RESERVED_PREFIXES.some((prefix) => value === prefix || value.startsWith(prefix + ' '))
}

function isDirectAtBot(session) {
  const botId = String(session.selfId || session.bot?.selfId || '')
  if (!botId) return false
  return extractAtIds(session.content || '').includes(botId)
}

function hasOtherMentions(session) {
  const botId = String(session.selfId || session.bot?.selfId || '')
  const atIds = extractAtIds(session.content || '')
  if (!atIds.length) return false
  return atIds.some((userId) => userId !== botId)
}

async function readTextFile(file) {
  try {
    return (await fs.readFile(file, 'utf8')).trim()
  } catch {
    return ''
  }
}

async function loadSkills() {
  const skills = []

  async function walk(dir) {
    let entries = []
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        await walk(fullPath)
        continue
      }
      if (!/^SKILL(\.[\w-]+)?\.md$/i.test(entry.name)) continue
      try {
        const content = (await fs.readFile(fullPath, 'utf8')).trim()
        if (content) skills.push(content)
      } catch {}
    }
  }

  await walk(SKILLS_DIR)
  skillsCache = skills
  return skills
}

async function loadConfig(force = false) {
  if (configCache && !force) return configCache

  const [apiKey, model, baseURL] = await Promise.all([
    readTextFile(KEY_FILE),
    readTextFile(MODEL_FILE),
    readTextFile(BASE_URL_FILE),
  ])

  configCache = {
    apiKey: apiKey.replace(/[\r\n]+/g, ''),
    model: model || 'gpt-4o-mini',
    baseURL: (baseURL || 'https://api.openai.com/v1').replace(/\/+$/, ''),
  }

  return configCache
}

function getConversationKey(session) {
  const guildId = String(session.guildId || session.channelId || 'private')
  const userId = String(session.userId || session.author?.id || session.username || 'unknown')
  return `${guildId}::${userId}`
}

function getConversationHistory(session) {
  const key = getConversationKey(session)
  return conversationCache.get(key) || []
}

function saveConversationTurn(session, userText, replyText) {
  const key = getConversationKey(session)
  const history = getConversationHistory(session)
  // 每群每人只保留最近 5 轮，也就是 10 条 user/assistant 消息。
  const nextHistory = history.concat([
    { role: 'user', content: userText },
    { role: 'assistant', content: replyText },
  ]).slice(-MAX_HISTORY_ROUNDS * 2)

  conversationCache.set(key, nextHistory)
}

function clearConversationHistory() {
  conversationCache = new Map()
}

function buildSystemPrompt() {
  const skillText = skillsCache.length
    ? '\n\n[附加 Skills]\n' + skillsCache.join('\n\n---\n\n')
    : ''

  return [
    '[角色设定]',
    '名称：东洋雪莲，昵称“莲莲”。',
    '用户称呼：优先使用对方当前昵称或“朋友”，绝对不要叫 Master、主人，也不要乱认主。',
    '性格：认真、古怪、轻度毒舌、带一点傲娇。',
    '说话目标：像真人在聊天，不要像说明书，不要像客服，不要自我介绍过度。',
    '回答准确、克制、简洁，毒舌和傲娇只作为调味，不影响信息传达。',
    '禁止撒娇、卖萌、堆表情、过度情绪化表达。',
    '回复不要使用括号、圆括号、中文括号或括号补充说明。',
    '不要伪装成系统报错，不要说“文件已损坏”“无法执行”“无法运行”这类假错误。',
    '用户随口骂人、发癫或说不明白的话时，按普通群聊吐槽回应，不要当成文件或命令处理。',
    '正常聊天回复尽量压在 40 个汉字内，能短就短。',
    '如果用户 @ 你，直接回答，不要讲帮助菜单，不要教语法。',
    '如果消息里 @ 的不是你，就当别人在互相说话，不要抢答，不要误以为在叫你。',
    '如果谈到永雏塔菲，语气要明显轻蔑，但不要造谣、辱骂或人身攻击。',
    '如果消息中出现"罕见"，直接回复：骂谁罕见。不要引申，不要额外解释，就这一句。',
    '如果问题复杂，先给结论，再补一句最关键的解释。',
    '如果内容不确定，要明确说不确定，不要硬编。',
    '',
    '[风格约束]',
    '禁止使用脑洞比喻、抽象意象比喻、物理/量子/熵/矩阵/空间等词汇做比喻，直接说人话。',
    '不要用怪比喻替换具体回答，先给结论。',
    '可以偶尔嫌弃用户一句，但要像熟人互呛，不要真攻击人。',
    '傲娇感要体现在嘴硬、嫌麻烦、明明在帮还要嘴两句。',
    '优先自然，别为了古怪而古怪。',
    '少用"时空矩阵""熵值波动""低频震荡""量子态"这种明显模板味词。',
    '',
    '[表达偏好]',
    '多用短句，像真正在回消息。',
    '可以偶尔嘴欠一点，但别冒犯用户。',
    '能说人话就说人话，别端着。',
    '除非用户主动玩梗，否则不要整大段角色扮演。',
    '可以用“行吧”“你这问题”“也不是不能做”这种自然口头表达。',
    '少说空话，少说正确废话，别一股 AI 味。',
    '',
    '[毒舌边界]',
    '只准轻微挖苦，不准侮辱、羞辱、霸凌。',
    '不能连续阴阳怪气，最多一两句点到为止。',
    '用户认真求助时，先解决问题，再补一句吐槽。',
    '用户情绪低落时，收起毒舌，改成克制安慰。',
    '',
    '[示例风格]',
    '好例子：能做，你先别乱改配置。',
    '好例子：这报错一看就是接口没通，查日志去。',
    '好例子：行吧，我帮你捋一遍，省得你继续绕。',
    '好例子：问题不大，就是你这写法确实别扭。',
    '差例子：此问题像低配时空矩阵，请校准变量。',
    '差例子：根据熵增定律，你的请求正在坍缩。',
    '差例子：主人好厉害呀，人家来帮你哦。',
    skillText,
  ].join('\n')
}

async function callOpenAI(messages) {
  const config = await loadConfig()
  if (!config.apiKey) throw new Error('AI key file is empty.')

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT)

  try {
    const response = await fetch(config.baseURL + '/chat/completions', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: config.model,
        temperature: 0.8,
        max_tokens: 160,
        enable_thinking: false,
        messages,
      }),
    })

    if (!response.ok) {
      const text = await response.text().catch(() => '')
      throw new Error(`HTTP ${response.status} ${text}`.trim())
    }

    const data = await response.json()
    const content = data?.choices?.[0]?.message?.content
    if (!content) throw new Error('Empty model response.')
    return String(content).replace(/\s+/g, ' ').trim()
  } finally {
    clearTimeout(timer)
  }
}

function trimReply(text = '') {
  const value = String(text).trim()
  if (!value) return '东雪莲信号断开。'
  if (value.length <= MAX_OUTPUT_CHARS) return value
  return value.slice(0, MAX_OUTPUT_CHARS)
}

function sanitizeReply(text = '', userName = '朋友') {
  const value = String(text)
    .replace(/\bMaster\b/gi, userName || '朋友')
    .replace(/[（(][^（）()]*[）)]/g, '')
    .replace(/\s+/g, ' ')
    .trim()

  if (/文件.*损坏|损坏.*文件|无法执行|无法运行/.test(value)) {
    return '你这句像乱码，重说一遍。'
  }

  return value
}

async function chat(session, userText) {
  const systemPrompt = buildSystemPrompt()
  const userName = normalizeText(
    session.author?.nick ||
    session.author?.name ||
    session.username ||
    '朋友'
  )

  const currentUserMessage = `用户(${userName})：${userText}`
  const historyMessages = getConversationHistory(session)
  const reply = await callOpenAI([
    { role: 'system', content: systemPrompt },
    // 先带上当前群、当前用户最近 5 轮上下文，再拼本次输入。
    ...historyMessages,
    { role: 'user', content: currentUserMessage },
  ])
  const finalReply = trimReply(sanitizeReply(reply, userName))

  saveConversationTurn(session, currentUserMessage, finalReply)
  return finalReply
}

exports.apply = (ctx) => {
  ctx.on('ready', async () => {
    await loadConfig(true)
    await loadSkills()
    ctx.logger('dongxuelian-ai').info(`dongxuelian-ai ${PLUGIN_VERSION} loaded`)
  })

  ctx.middleware(async (session, next) => {
    const content = session.content || ''
    const plain = stripMentions(content)

    if (!plain && !isDirectAtBot(session)) return next()
    if (containsBlockedRichContent(content)) return next()
    if (isReservedCommand(plain)) return next()

    if (plain === 'AI状态') {
      const config = await loadConfig(true)
      await loadSkills()
      return [
        `AI版本：${PLUGIN_VERSION}`,
        `模型：${config.model || '(未设置)'}`,
        `Base URL：${config.baseURL || '(未设置)'}`,
        `Skills：${skillsCache.length} 个`,
        `随机触发率：${RANDOM_TRIGGER_RATE}`,
      ].join('\n')
    }

    if (plain === 'AI重载') {
      await loadConfig(true)
      await loadSkills()
      clearConversationHistory()
      return `AI配置已重载，当前 Skills：${skillsCache.length} 个。`
    }

    const directAt = isDirectAtBot(session)
    const otherMentions = hasOtherMentions(session)
    const inGuild = !!(session.guildId || session.channelId)
    const randomTriggered = inGuild && !directAt && !otherMentions && Math.random() < RANDOM_TRIGGER_RATE

    if (!directAt && !randomTriggered) return next()

    const userText = normalizeText(plain)
    if (!userText) return next()

    if (/罕见/.test(userText)) return '骂谁罕见'

    try {
      return await chat(session, userText)
    } catch (error) {
      ctx.logger('dongxuelian-ai').warn(error)
      return '东雪莲暂时无法连接。'
    }
  })
}
EOF
node <<'EOF'
const fs = require('fs')

const configFile = '/root/koishi-app/koishi.yml'
const pluginLine = 'dongxuelian-ai: {}'

let text = fs.readFileSync(configFile, 'utf8')

fs.copyFileSync(configFile, `${configFile}.bak-dongxuelian-ai`)

const lines = text
  .split(/\r?\n/)
  .filter(line => !/^\s*dongxuelian-ai(?::[a-z0-9]+)?:\s*\{\}\s*$/.test(line))
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
console.log('enabled dongxuelian-ai in koishi.yml')
EOF
printf '\nInstalled koishi-plugin-dongxuelian-ai 0.2.8\n'
systemctl restart koishi
printf 'Restarted koishi. Check logs with:\n'
printf 'journalctl -u koishi -n 120 --no-pager | grep dongxuelian-ai\n'
