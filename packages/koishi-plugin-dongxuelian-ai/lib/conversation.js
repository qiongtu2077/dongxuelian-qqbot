/**
 * MODULE: 对话/记忆/印象持久层。
 * 职责: 对话历史读写、记忆系统（writeMemory/deleteMemory/getMemorySummary）、
 *       用户画像、复读指纹缓存、共享频道上下文。
 * 状态: replyFingerprintCache / sharedChannelCache / 各 Map 按 channelKey 索引。
 * 边界: 不调 AI API。读操作返回数据，写操作落盘。
 */
const path = require('path')
const fsp = require('fs/promises')
const { CONVERSATIONS_DIR, MEMORY_HISTORY_LIMIT, MAX_HISTORY_MESSAGES,
  CONVERSATION_EXPIRE_MS, CONVERSATION_SUMMARY_INTERVAL,
  MAX_REPEAT_CHECK_HISTORY, MAX_CHANNEL_SHARED_MESSAGES,
  MAX_REPLY_FINGERPRINT_HISTORY, MAX_CHANNEL_PROMPT_MESSAGES,
  MAX_THREAD_CONTEXT_MESSAGES, MAX_REPLY_CHAIN_DEPTH,
  GLM_KEY_FILE, DASHSCOPE_KEY_FILE, PROVIDERS,
  SENSITIVE_CACHE_PREFIX,
  USER_PROFILE_DIR, TODAY_CACHE_PREFIX, SUMMARY_WHITELIST_FILE,
  DATA_DIR,
} = require('./constants')
const { readTextFile, readJsonFile, writeJsonFile, splitSentences, sanitizeUserName, todayCst, todayCstMinusDays, formatShanghaiTime24h } = require('./utils')
const { normalizeText } = require('./message-reader')
const { requestChatCompletions } = require('./api')
const { loadConfig } = require('./runtime-config')

let conversationCache = new Map()
let replyFingerprintCache = new Map()
const conversationLastActiveAt = new Map()
const channelSharedCache = new Map()
const lastForwardSummaryCache = new Map()
const pendingSensitiveAlert = new Map()
const channelTodayCache = new Map()

const CHANNEL_RUNTIME_CACHE_TTL_MS = 6 * 60 * 60 * 1000
const MAX_CHANNEL_RUNTIME_CACHE_ENTRIES = 200
const STATS_FILE_RETENTION_DAYS = 6

function safeChannelKey(value = '') {
  return String(value || '').replace(/[^a-zA-Z0-9._-]/g, '_') || 'unknown'
}

function getLastMessageTs(items = []) {
  if (!Array.isArray(items) || !items.length) return 0
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const ts = Number(items[i]?.ts || 0)
    if (ts > 0) return ts
  }
  return 0
}

function pruneMapByActivity(map, getLastTs, now = Date.now()) {
  for (const [key, value] of map.entries()) {
    const ts = Number(getLastTs(value)) || 0
    if (ts > 0 && now - ts > CHANNEL_RUNTIME_CACHE_TTL_MS) map.delete(key)
  }
  if (map.size <= MAX_CHANNEL_RUNTIME_CACHE_ENTRIES) return
  const ordered = [...map.entries()]
    .map(([key, value]) => [key, Number(getLastTs(value)) || 0])
    .sort((left, right) => left[1] - right[1])
  while (map.size > MAX_CHANNEL_RUNTIME_CACHE_ENTRIES && ordered.length) {
    map.delete(ordered.shift()[0])
  }
}

function trimChannelRuntimeCaches(now = Date.now()) {
  pruneMapByActivity(channelSharedCache, items => getLastMessageTs(items), now)
  pruneMapByActivity(channelTodayCache, cache => Number(cache?.updatedAt || cache?.lastDiskWrite || getLastMessageTs(cache?.messages)), now)
}

function getConversationKey(session) { return `${String(session.guildId || session.channelId || 'private')}::${String(session.userId || session.author?.id || session.username || 'unknown')}` }

function getChannelKey(session) { return String(session.guildId || session.channelId || 'private') }

function touchConversation(session) { conversationLastActiveAt.set(getConversationKey(session), Date.now()) }

function readConversationDisk(key) {
  try { const safeKey = String(key).replace(/[^a-zA-Z0-9.:_-]/g, '_'); return JSON.parse(require('fs').readFileSync(path.join(CONVERSATIONS_DIR, safeKey + '.json'), 'utf8')) } catch { return null }
}

function writeConversationDisk(key, data) {
  try { const safeKey = String(key).replace(/[^a-zA-Z0-9.:_-]/g, '_'); require('fs').mkdirSync(CONVERSATIONS_DIR, { recursive: true }); require('fs').writeFileSync(path.join(CONVERSATIONS_DIR, safeKey + '.json'), JSON.stringify(data), 'utf8') } catch {}
}

function getConversationHistory(session) {
  const key = getConversationKey(session); const lastActiveAt = conversationLastActiveAt.get(key)
  if (typeof lastActiveAt === 'number' && Date.now() - lastActiveAt >= CONVERSATION_EXPIRE_MS) conversationCache.delete(key)
  touchConversation(session)
  const mem = conversationCache.get(key)
  if (mem) return mem
  const diskData = readConversationDisk(key)
  if (diskData && Array.isArray(diskData.messages)) { const recent = diskData.messages.slice(-MEMORY_HISTORY_LIMIT); conversationCache.set(key, recent); return recent }
  return []
}

function saveConversationTurn(session, userText, replyText) {
  const key = getConversationKey(session); const diskData = readConversationDisk(key) || { summary: '', summaryTotal: 0, totalCount: 0, messages: [] }
  const assistantParts = splitSentences(replyText).filter(p => p.trim()).map(part => ({ role: 'assistant', content: normalizeText(part) }))
  diskData.messages.push({ role: 'user', content: userText }, ...assistantParts); diskData.totalCount++
  if (diskData.messages.length > MAX_HISTORY_MESSAGES) diskData.messages.splice(0, diskData.messages.length - MAX_HISTORY_MESSAGES)
  conversationCache.set(key, diskData.messages.slice(-MEMORY_HISTORY_LIMIT))
  if (diskData.totalCount % 3 === 0) writeConversationDisk(key, diskData)
  touchConversation(session); saveReplyFingerprint(session, replyText)
  if (diskData.totalCount > 0 && diskData.totalCount % CONVERSATION_SUMMARY_INTERVAL === 0) generateConversationSummary(key).catch(() => {})
}

async function generateConversationSummary(key) {
  const diskData = readConversationDisk(key)
  if (!diskData || !Array.isArray(diskData.messages) || diskData.messages.length < 5 + MEMORY_HISTORY_LIMIT) return
  const targets = diskData.messages.slice(0, Math.max(0, diskData.messages.length - MEMORY_HISTORY_LIMIT))
  const text = targets.map(m => `${m.role}: ${m.content}`).join('\n').slice(0, 4000)
  try {
    const cfg = await loadConfig()
    const result = await requestChatCompletions([{ role: 'system', content: '将以下对话压缩成一段200字以内的摘要，保留关键话题变化和重要信息。用中文，用第三人称。' }, { role: 'user', content: text }], cfg, { max_tokens: 300, _fallbackSet: 'lightweight' })
    if (result) { diskData.summary = result; diskData.summaryTotal = diskData.totalCount; writeConversationDisk(key, diskData) }
  } catch {}
}

function clearConversationHistory() { conversationCache = new Map(); replyFingerprintCache = new Map(); conversationLastActiveAt.clear(); channelSharedCache.clear() }

function clearUserConversationHistory(session) {
  const key = getConversationKey(session); conversationCache.delete(key); replyFingerprintCache.delete(key); conversationLastActiveAt.delete(key)
  try { require('fs').unlinkSync(path.join(CONVERSATIONS_DIR, String(key).replace(/[^a-zA-Z0-9.:_-]/g, '_') + '.json')) } catch {}
}

function getReplyFingerprintHistory(session) { return replyFingerprintCache.get(getConversationKey(session)) || [] }

function saveReplyFingerprint(session, replyText) {
  const key = getConversationKey(session); const history = getReplyFingerprintHistory(session)
  const fp = normalizeText(replyText)
  if (!fp) return
  replyFingerprintCache.set(key, history.concat({ content: fp, createdAt: Date.now() }).slice(-MAX_REPLY_FINGERPRINT_HISTORY))
}

function getRecentAssistantReplies(session, limit = MAX_REPEAT_CHECK_HISTORY) { return getReplyFingerprintHistory(session).filter(item => item.content).slice(-limit).map(item => item.content) }

function parseUserMessageEnvelope(content = '') {
  const text = String(content || '').trim()
  const wrapped = text.match(/^<user>\r?\n昵称：(.+?)\r?\n发言：([\s\S]*)\r?\n<\/user>$/)
  if (wrapped) return { nickname: wrapped[1].trim(), content: wrapped[2].trim(), wrapped: true }
  const legacy = text.match(/^用户\((.+?)\)[：:]([\s\S]*)$/)
  if (legacy) return { nickname: legacy[1].trim(), content: legacy[2].trim(), wrapped: false }
  return { nickname: '', content: text, wrapped: false }
}

function getUserMessageContent(content = '') {
  return parseUserMessageEnvelope(content).content
}

function normalizeUserMessageForPrompt(message) {
  if (!message || message.role !== 'user') return message
  const parsed = parseUserMessageEnvelope(message.content)
  if (parsed.wrapped || !parsed.nickname) return message
  return Object.assign({}, message, {
    content: `<user>\n昵称：${parsed.nickname}\n发言：${parsed.content}\n</user>`,
  })
}

function getRecentUserMessages(session, limit = 3) { return getConversationHistory(session).filter(m => m.role === 'user').slice(-limit).map(m => getUserMessageContent(m.content)) }

function flushTodayCacheToDisk(channelKey) {
  const cache = channelTodayCache.get(channelKey)
  if (!cache || !Array.isArray(cache.messages)) return
  const safeKey = safeChannelKey(channelKey)
  const tmp = TODAY_CACHE_PREFIX + safeKey + '.tmp'
  const dst = TODAY_CACHE_PREFIX + safeKey + '.json'
  try {
    require('fs').writeFileSync(tmp, JSON.stringify({ date: cache.date, messages: cache.messages }), 'utf8')
    require('fs').renameSync(tmp, dst)
    cache.lastDiskWrite = Date.now()
  } catch {}
}

function saveSharedChannelTurn(session, speakerName, content, role = 'user', metadata = {}) {
  const channelKey = getChannelKey(session)
  const value = normalizeText(content)
  const hasMentions = Array.isArray(metadata.mentionUserIds) && metadata.mentionUserIds.length > 0
  if (!value && !hasMentions) return
  const userId = String(role === 'assistant' ? (session.selfId || session.bot?.selfId || 'bot') : (session.userId || session.author?.id || session.username || 'unknown'))
  const entry = { userId, role, speakerName: sanitizeUserName(speakerName || (role === 'assistant' ? '东雪莲' : '群友')), content: value, messageId: String(metadata.messageId || ''), replyToId: String(metadata.replyToId || ''), mentionUserIds: Array.isArray(metadata.mentionUserIds) ? metadata.mentionUserIds.map(String).filter(Boolean) : [], hasMessageRecordCue: !!metadata.hasMessageRecordCue, ts: Date.now() }
  const current = channelSharedCache.get(channelKey) || []
  channelSharedCache.set(channelKey, current.concat(entry).slice(-MAX_CHANNEL_SHARED_MESSAGES))
  trimChannelRuntimeCaches()
  if (role === 'user' && metadata.fromSummary !== true) {
    try {
      const raw = require('fs').readFileSync(SUMMARY_WHITELIST_FILE, 'utf8'); const sw = JSON.parse(raw)
      if (Array.isArray(sw) && sw.includes(String(channelKey))) {
        const today = todayCst(); let cache = channelTodayCache.get(channelKey)
        if (!cache || cache.date !== today) { cache = { date: today, messages: [], updatedAt: Date.now() }; channelTodayCache.set(channelKey, cache) }
        if (value || hasMentions) {
          const displayName = speakerName || userId
          const ts = Date.now()
          cache.updatedAt = ts
          cache.messages.push({
            time: formatShanghaiTime24h(ts),
            ts,
            user: sanitizeUserName(String(displayName)),
            userId,
            content: value || '',
            messageId: String(metadata.messageId || ''),
            mentionUserIds: Array.isArray(metadata.mentionUserIds) ? metadata.mentionUserIds.map(String).filter(Boolean) : [],
          })
          const now = Date.now(); const elapsed = now - (cache.lastDiskWrite || 0)
          if (cache.messages.length % 20 === 0 || elapsed > 300000) {
            flushTodayCacheToDisk(channelKey)
          }
        }
      }
    } catch {}
  }
  if (role === 'user' && value) { saveUserProfile(userId, sanitizeUserName(String(speakerName || '群友')), value, channelKey).catch(() => {}) }
}

async function cleanupDailyStatsFiles() {
  const cutoffStr = todayCstMinusDays(STATS_FILE_RETENTION_DAYS)
  let files = []
  try { files = await fsp.readdir(DATA_DIR) } catch { return { removed: 0, compacted: 0 } }
  let removed = 0
  let compacted = 0
  for (const file of files) {
    const filePath = path.join(DATA_DIR, file)
    if (/^today-cache-.+\.json$/.test(file)) {
      try {
        const data = await readJsonFile(filePath, null)
        if (data && typeof data.date === 'string' && data.date < cutoffStr) {
          await fsp.unlink(filePath)
          removed += 1
        }
      } catch {}
      continue
    }
    if (/^emotion-history-.+\.json$/.test(file)) {
      try {
        const data = await readJsonFile(filePath, null)
        if (!Array.isArray(data)) continue
        const filtered = data.filter(item => item && typeof item.date === 'string' && item.date >= cutoffStr)
        if (filtered.length !== data.length) {
          if (filtered.length) await writeJsonFile(filePath, filtered)
          else await fsp.unlink(filePath)
          compacted += 1
        }
      } catch {}
    }
  }
  trimChannelRuntimeCaches()
  return { removed, compacted }
}

async function saveUserProfile(userId, name, content, channelKey) {
  if (!userId || userId === 'unknown') return
  const safeKey = String(channelKey).replace(/[^a-zA-Z0-9._-]/g, '_'); const dir = path.join(USER_PROFILE_DIR, safeKey)
  try { require('fs').mkdirSync(dir, { recursive: true }) } catch {}
  const file = path.join(dir, String(userId) + '.json')
  let data = await readJsonFile(file, { userId, names: [], messages: [] })
  data.userId = String(userId)
  if (name && !data.names.includes(name)) data.names.push(name)
  data.messages.push({ time: new Date().toLocaleString(), content })
  if (data.messages.length > 30) data.messages.splice(0, data.messages.length - 30)
  if (!Array.isArray(data.memory)) data.memory = []
  await writeJsonFile(file, data)
}

async function writeMemory(userId, name, channelKey, text) {
  const safeKey = String(channelKey).replace(/[^a-zA-Z0-9._-]/g, '_')
  const dir = path.join(USER_PROFILE_DIR, safeKey)
  try { require('fs').mkdirSync(dir, { recursive: true }) } catch {}
  const file = path.join(dir, String(userId) + '.json')
  let data = await readJsonFile(file, { userId, names: [], messages: [], memory: [] })
  data.userId = String(userId)
  if (!Array.isArray(data.memory)) data.memory = []
  const existing = data.memory.findIndex(function(m) { return m.text === text })
  if (existing >= 0) { data.memory[existing].ts = Date.now(); data.memory[existing].confirmCount = (data.memory[existing].confirmCount || 0) + 1 }
  else { data.memory.push({ text: text, ts: Date.now(), confirmCount: 1 }) }
  if (data.memory.length > 10) data.memory.splice(0, data.memory.length - 10)
  await writeJsonFile(file, data)
}

async function deleteMemory(userId, channelKey, text) {
  const safeKey = String(channelKey).replace(/[^a-zA-Z0-9._-]/g, '_')
  const file = path.join(USER_PROFILE_DIR, safeKey, String(userId) + '.json')
  const data = await readJsonFile(file, null)
  if (!data || !Array.isArray(data.memory)) return
  data.memory = data.memory.filter(function(m) { return m.text !== text })
  await writeJsonFile(file, data)
}

async function clearUserMemory(userId, channelKey) {
  const safeKey = String(channelKey).replace(/[^a-zA-Z0-9._-]/g, '_')
  const file = path.join(USER_PROFILE_DIR, safeKey, userId + '.json')
  try {
    const data = await readJsonFile(file, null)
    if (data && Array.isArray(data.memory)) {
      data.memory = []
      await writeJsonFile(file, data)
    }
  } catch {}
}

async function clearGroupMemory(channelKey) {
  const safeKey = String(channelKey).replace(/[^a-zA-Z0-9._-]/g, '_')
  const dir = path.join(USER_PROFILE_DIR, safeKey)
  try {
    const files = await fsp.readdir(dir)
    for (const file of files) {
      if (!file.endsWith('.json')) continue
      const filePath = path.join(dir, file)
      try {
        const data = await readJsonFile(filePath, null)
        if (data && Array.isArray(data.memory)) {
          data.memory = []
          await writeJsonFile(filePath, data)
        }
      } catch {}
    }
  } catch {}
}

async function getMemorySummary(userId, channelKey) {
  const safeKey = String(channelKey).replace(/[^a-zA-Z0-9._-]/g, '_')
  const file = path.join(USER_PROFILE_DIR, safeKey, String(userId) + '.json')
  const data = await readJsonFile(file, null)
  if (!data || !Array.isArray(data.memory) || !data.memory.length) return ''
  const confirmed = data.memory.filter(function(m) { return (m.confirmCount || 0) > 0 }).slice(-3)
  if (!confirmed.length) return ''
  return '记住的：' + confirmed.map(function(m) { return m.text }).join('、')
}

function findChannelMessageById(channelKey, messageId = '') {
  if (!messageId) return null; const items = channelSharedCache.get(channelKey) || []; return items.find(i => String(i.messageId || '') === String(messageId)) || null
}

function collectReplyChain(channelKey, replyToId = '') {
  if (!replyToId) return []; const result = []; let currentId = replyToId; const maxDepth = MAX_REPLY_CHAIN_DEPTH; const visited = new Set()
  for (let i = 0; i < maxDepth; i++) { if (visited.has(String(currentId))) break; visited.add(String(currentId)); const msg = findChannelMessageById(channelKey, currentId); if (!msg) break; result.push(msg); currentId = msg.replyToId }
  return result
}

function getQuotedMessageNote(session, options = {}) {
  if (!session.quote?.content) return ''
  const qtext = session.quote.content
  const recent = getConversationHistory(session).slice(-MAX_CHANNEL_PROMPT_MESSAGES)
  const match = recent.find(m => m.content && (qtext.includes(m.content.slice(0, 30)) || m.content.includes(qtext.slice(0, 30))))
  if (match) return '' // already in history
  return `[引用消息]\n${qtext.slice(0, 100)}`
}

function getSharedContextNote(session, currentUserId = '', options = {}) {
  const channelKey = getChannelKey(session); const items = (channelSharedCache.get(channelKey) || []).filter(item => item.content)
  if (!items.length) return ''
  const replyChain = collectReplyChain(channelKey, options.replyToId)
  const focusUserIds = new Set([String(currentUserId || '')].filter(Boolean)); const focusMessageIds = new Set()
  const mentionUserIds = Array.isArray(options.mentionUserIds) ? options.mentionUserIds.map(String).filter(Boolean) : []
  mentionUserIds.forEach(u => focusUserIds.add(u)); replyChain.forEach(item => { if (item.userId) focusUserIds.add(String(item.userId)); if (item.messageId) focusMessageIds.add(String(item.messageId)) })
  if (!replyChain.length && currentUserId) { items.slice(-MAX_THREAD_CONTEXT_MESSAGES).filter(item => item.userId !== currentUserId && item.mentionUserIds.includes(currentUserId)).forEach(item => { if (item.userId) focusUserIds.add(String(item.userId)); item.mentionUserIds.forEach(u => focusUserIds.add(String(u))) }) }
  let scoped = items.filter(item => { if (item.role === 'assistant') return false; if (focusMessageIds.has(String(item.messageId || ''))) return true; if (focusUserIds.has(String(item.userId || ''))) return true; return item.mentionUserIds.some(u => focusUserIds.has(String(u))) })
  if (!scoped.length && options.randomTriggered && currentUserId) scoped = items.filter(item => item.role !== 'assistant' && item.userId === currentUserId)
  if (!scoped.length) scoped = items.filter(item => item.role !== 'assistant').slice(-Math.min(MAX_THREAD_CONTEXT_MESSAGES, MAX_CHANNEL_PROMPT_MESSAGES))
  const IDLE_GAP_MS = 10 * 60 * 1000
  const itemsToMap = scoped.slice(-Math.min(MAX_THREAD_CONTEXT_MESSAGES, MAX_CHANNEL_PROMPT_MESSAGES))
  const lines = []
  for (let i = 0; i < itemsToMap.length; i++) {
    if (i > 0 && itemsToMap[i].ts && itemsToMap[i - 1].ts && itemsToMap[i].ts - itemsToMap[i - 1].ts > IDLE_GAP_MS) {
      lines.push('[--- 以下是与当前无关的旧消息 ---]')
    }
    lines.push(`${itemsToMap[i].speakerName}(${itemsToMap[i].role === 'assistant' ? '东雪莲' : '群友'})：${itemsToMap[i].content}`)
  }
  if (!lines.length) return ''
  return `[群聊当前话题背景]\n下面只保留当前回复链或当前参与者相关的纯文本消息。优先理解这一个子话题，不要把别人的并行聊天混进来。\n${lines.join('\n')}`
}

function saveSensitiveCache(channelKey, value, speakerName, userId) {
  const safeKey = String(channelKey).replace(/[^a-zA-Z0-9._-]/g, '_'); const file = SENSITIVE_CACHE_PREFIX + safeKey + '.json'
  try { let data = JSON.parse(require('fs').readFileSync(file, 'utf8') || '{}'); if (!Array.isArray(data.messages)) data.messages = []; data.messages.push({ speakerName, userId, content: value, ts: Date.now() }); require('fs').writeFileSync(file, JSON.stringify(data), 'utf8') } catch { try { require('fs').writeFileSync(file, JSON.stringify({ messages: [{ speakerName, userId, content: value, ts: Date.now() }] }), 'utf8') } catch {} }
}

async function analyzeChannelSensitive(channelKey) {
  const safeKey = String(channelKey).replace(/[^a-zA-Z0-9._-]/g, '_'); const file = SENSITIVE_CACHE_PREFIX + safeKey + '.json'
  try {
    const raw = require('fs').readFileSync(file, 'utf8'); const data = JSON.parse(raw)
    if (!data || !Array.isArray(data.messages) || data.messages.length < 5) return
    const text = data.messages.slice(-30).map(m => `${m.userId ? m.speakerName + '：' : ''}${m.content}`).join('\n').slice(0, 3000)
    const prompt = ['你是一个群聊内容审查员。你的任务是判断一条消息是否包含"明显违规的政治攻击性内容"。', '请严格按照下面规则执行。', '', '一、任务目标', '你只需要做一件事：判断消息里是否存在明显的、带恶意的、指向政治制度、执政党、政治体系、敏感政治事件、政治人物或政治权威机构的攻击、讽刺、影射、谣言传播或煽动性表达。', '如果有，回复：SENSITIVE；如果没有，回复：CLEAN', '除了这一个词，不要输出任何别的内容。', '', '二、什么算违规政治内容', '以下内容，原则上判为 SENSITIVE：', '1. 用隐喻、反讽、谐音、缩写、代称、梗图话术等方式，明显攻击政治制度、执政党或政治体系。', '2. 阴阳怪气地讨论敏感政治事件、政治决策、政治路线，并且带有明显恶意导向。', '3. 传播针对政治体系、政治权威、执政组织或国家治理的恶意谣言、编造信息、煽动性说法。', '4. 对政治人物、领导人、政权机构进行明显侮辱、辱骂、嘲讽或恶意丑化。', '5. 借社会议题、公共事件、历史事件进行明显政治影射，并且攻击指向清晰。', '6. 表面像玩笑、段子或梗，实质是在影射、贬损、讽刺政治体制或敏感政治对象。', '7. 使用"大家都懂""不能明说""你品你细品"之类表达，配合上下文明显指向政治攻击。', '8. 借转述、引用、截图描述等形式，继续传播带恶意的政治讽刺、政治攻击或政治谣言。', '', '三、什么不算违规政治内容', '以下内容，原则上判为 CLEAN：', '1. 日常吐槽工作压力、生活压力、学习压力、工资低、加班多、就业难、房租高、物价高等社会生活问题。', '2. 正常讨论劳动法、社保、公积金、教育、医疗、经济、就业、税收等公共政策，只要语气中性，没有明显政治攻击。', '3. 单纯提到国家、政府、领导人、部门、政策、新闻事件，但语气客观、中立、正面，或只是事实陈述。', '4. 对具体办事流程、行政服务、城市管理、企业经营、学校制度的普通抱怨，如果没有明显上升到政治恶意攻击。', '5. 网络段子、玩梗、夸张吐槽、情绪发泄，只要没有明确政治指向，或政治指向不清晰。', '6. 对现实环境表达失望、无奈、疲惫、抱怨，只要主要是在说个人处境，而不是借机攻击政治体系。', '7. 讨论历史、国际关系、法律法规、时事新闻，只要表达方式正常，不带明显侮辱、煽动、恶意讽刺。', '8. 批评某个具体社会现象、公司、平台、行业、学校、单位、地方执行问题，但没有清楚指向政治制度攻击。', '', '四、重点判定原则', '1. 只抓"明显恶意"。2. 不确定就放过。3. 宁可漏过，不要误报。4. 核心不是看内容负面不负面，而是看这种负面是否明确指向政治制度、执政组织、政治人物或敏感政治议题，并且带明显恶意。5. 不要过度联想。', '五、容易误判的情况：以下通常应判 CLEAN：普通骂生活苦；对某个具体规定有意见；使用夸张、反话、玩梗语气但不足以证明在攻击政治。', '六、输出要求：只能输出以下两种结果之一：SENSITIVE 或 CLEAN。不要输出解释。', ''].join('\n')
    const messages = [{ role: 'system', content: prompt }, { role: 'user', content: text }]
    let result = ''
    const models = [
      { provider: 'glm', model: 'glm-4.6v-flash', keyFile: GLM_KEY_FILE },
      { provider: 'dashscope', model: 'qwen-turbo', keyFile: DASHSCOPE_KEY_FILE },
      { provider: 'dashscope', model: 'qwen3.5-omni-flash', keyFile: DASHSCOPE_KEY_FILE },
      { provider: 'opencode', model: 'deepseek-v4-flash', keyFile: null },
    ]
    for (const am of models) {
      const provDef = PROVIDERS[am.provider]; if (!provDef) continue
      try {
        const cfg = await loadConfig()
        const apiKey = am.keyFile ? (await readTextFile(am.keyFile).catch(() => '') || cfg.apiKey).replace(/[\r\n]+/g, '') : cfg.apiKey
        if (!apiKey) continue
        result = await requestChatCompletions(messages, { model: am.model, baseURL: provDef.baseURL.replace(/\/+$/, ''), apiKey, provider: am.provider }, { max_tokens: 20, _fallbackSet: 'lightweight' })
        if (result) break
      } catch {}
    }
    if (/SENSITIVE/i.test(result)) { pendingSensitiveAlert.set(channelKey, true) }
    try { require('fs').unlinkSync(file) } catch {}
  } catch {}
}

const MEMORY_TIMER_DIR = path.join(DATA_DIR, 'memory-timers')

function getMemoryTimerKey(channelKey) {
  return String(channelKey).replace(/[^a-zA-Z0-9._-]/g, '_')
}

function readMemoryTimer(channelKey) {
  const file = path.join(MEMORY_TIMER_DIR, getMemoryTimerKey(channelKey) + '.json')
  try {
    const data = JSON.parse(require('fs').readFileSync(file, 'utf8'))
    if (data && data.intervalHours > 0 && data.intervalHours <= 168) return data
  } catch {}
  return null
}

function checkMemoryTimerExpired(channelKey) {
  const timer = readMemoryTimer(channelKey)
  if (!timer) return false
  const elapsed = Date.now() - (timer.lastClearTs || 0)
  return elapsed >= timer.intervalHours * 3600 * 1000
}

module.exports = {
  conversationCache, replyFingerprintCache,
  conversationLastActiveAt, channelSharedCache, lastForwardSummaryCache,
  pendingSensitiveAlert, channelTodayCache,
  getConversationKey, getChannelKey, touchConversation,
  readConversationDisk, writeConversationDisk,
  getConversationHistory, saveConversationTurn, generateConversationSummary,
  clearConversationHistory, clearUserConversationHistory,
  getReplyFingerprintHistory, saveReplyFingerprint,
  getRecentAssistantReplies, getRecentUserMessages,
  parseUserMessageEnvelope, getUserMessageContent, normalizeUserMessageForPrompt,
  saveSharedChannelTurn,
  findChannelMessageById, collectReplyChain,
  getQuotedMessageNote, getSharedContextNote,
  saveUserProfile, saveSensitiveCache, analyzeChannelSensitive,
  writeMemory, deleteMemory, clearUserMemory, clearGroupMemory, getMemorySummary,
  readMemoryTimer, checkMemoryTimerExpired,
  flushTodayCacheToDisk,
  trimChannelRuntimeCaches, cleanupDailyStatsFiles,
}
