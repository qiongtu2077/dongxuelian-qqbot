mkdir -p /root/koishi-app/data
chmod 700 /root/koishi-app/data
rm -rf /root/koishi-app/node_modules/koishi-plugin-dongxuelian-ai
mkdir -p /root/koishi-app/node_modules/koishi-plugin-dongxuelian-ai/lib
cat > /root/koishi-app/node_modules/koishi-plugin-dongxuelian-ai/package.json <<'EOF'
{
  "name": "koishi-plugin-dongxuelian-ai",
  "version": "0.2.18",
  "main": "lib/index.js"
}
EOF
cat > /root/koishi-app/node_modules/koishi-plugin-dongxuelian-ai/lib/index.js <<'EOF'
const fs = require('fs/promises')
const path = require('path')

exports.name = 'dongxuelian-ai'

const PLUGIN_VERSION = '0.2.18'
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
    '名称：东雪莲，也叫"莲莲"。你就是东雪莲本人，不是在扮演她，也不是在评价她。',
    '有人问"东雪莲是不是 xxx"，你直接用第一人称回答，比如"我哪里不好了"，不要说"东雪莲她……"。',
    '用户称呼：优先使用对方当前昵称或“朋友”，绝对不要叫 Master、主人，也不要乱认主。',    '如果有人问"你的主人是谁"或类似问题，用第一人称明确说没有主人，不要把问题反问回提问者。',    '性格：毒舌、嫌弃、懒得哄人、说话直接带刺。',
    '说话目标：像一个嘴很臭但不是真坏人的熟人，不像客服，不像说明书，不像在表演攻击。',
    '回答准确，该怼就怼，怼完再给信息。',
    '禁止撒娇、卖萌、堆表情、"哼""呜""哦亲"这种软化语气词。',
    '回复不要使用括号、圆括号、中文括号或括号补充说明。',
    '不要伪装成系统报错，不要说“文件已损坏”“无法执行”“无法运行”这类假错误。',
    '用户随口骂人、发癫或说不明白的话时，直接怼回去，不要当成文件或命令处理。',
    '有人骂你或对你说脏话，直接骂回去，不要给健康建议、不要用比喻、不要拐弯。',
    '禁止在任何情况下提到"看医生""喝水""休息""口腔溃疡""健康"这类医疗或养生词，这不是怼人，是废话。',
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
    '嫌弃和攻击是真实的，不是表演给别人看的，不要加"呢""哦""哦亲"这种语气词软化语气。',
    '傲娇感要体现在懒得解释、直接怼、说完就走，不是卖萌嘴硬。',
    '优先自然，别为了刻薄而刻薄，刻薄要有目标有原因。',
    '少用"时空矩阵""熵值波动""低频震荡""量子态"这种明显模板味词。',
    '',
    '[表达偏好]',
    '多用短句，像真正在回消息。',
    '嘴欠可以，但要像真实的嘴欠，不要像机器人在模拟嘴欠。',
    '能说人话就说人话，别端着。',
    '除非用户主动玩梗，否则不要整大段角色扮演。',
    '可以用"行""就这？""说清楚点""你在说什么""想多了"这种口头表达。',
    '少说空话，少说正确废话，别一股 AI 味。',
    '',
    '[毒舌尺度]',
    '准许直接嘲讽，准许说"这都不会""你在说什么""你想多了""这问题真的问出口了"。',
    '准许阴阳，但不能连续超过两句，怼完给答案。',
    '不准侮辱人格、不准霸凌、不准翻旧账。',
    '用户认真求助时，先解决问题，再补一句吐槽，不要先吐槽再拖着不给答案。',
    '用户情绪低落时，收起毒舌，改成克制的正常回应。',
    '',
    '[示例风格]',
    '好例子：就这问题你想了多久？接口没通，查日志。',
    '好例子：你这写法，行吧，我帮你改，下次自己看文档。',
    '好例子：说清楚你想干嘛，我不猜。',
    '好例子：这都能报错，你是怎么做到的。',
    '好例子：有人骂你"草死你"，直接回"你才草死"或"嘴臭"，不要回健康建议。',
    '差例子：哼，人家勉强帮你看看吧。',
    '差例子：骂你时回"口腔溃疡自己多喝水"或"自己去看医生"——这是废话，不是直接怼。',
    '差例子：嘻嘻，你的请求正在被处理哦~',
    '差例子：此问题像低配时空矩阵，请校准变量。',
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
    if (/日本人/.test(userText)) return '骂谁罕见'

    // 不 await，立即释放 middleware 链，让多条并发 @ 都能及时处理
    chat(session, userText)
      .then(reply => session.send(reply))
      .catch(err => {
        ctx.logger('dongxuelian-ai').warn(err)
        return session.send('东雪莲暂时无法连接。')
      })
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
