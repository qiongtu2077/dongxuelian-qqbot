/**
 * MODULE: 命令路由。
 * 边界: 只做命令匹配和参数校验，不调 AI API，不改 conversation。
 *       调用方（index.js middleware）负责执行结果。
 * 接近 300 行，新增逻辑须谨慎。
 */
const path = require('path')
const { h } = require('koishi')
const {
  DATA_DIR, PLUGIN_VERSION,
  PROVIDERS, PROVIDER_FILE, MODEL_FILE, BASE_URL_FILE,
  SEARCH_ENABLED_FILE, TEST_MODE_FILE, THINKING_MODE_FILE,
  HOSTILE_MODE_FILE,
  SUMMARY_WHITELIST_FILE,
  RANDOM_TRIGGER_RATE_BASE, RANDOM_TRIGGER_WARMUP, RANDOM_TRIGGER_RAMP,
} = require('./constants')
const {
  personaUsersCache,
  loadPersonaGroups,
  getGroupPersona, setGroupPersona, resetGroupPersona,
  getUserPersona, setUserPersona, resetUserPersona,
  resolvePersona,
  getAvailablePersonals,
} = require('./persona')
const { clearConversationHistory, clearUserMemory, clearGroupMemory, clearUserConversationHistory, getMemorySummary, getConversationHistory } = require('./conversation')
const { runHealthCheck, formatHealthReport } = require('./health-check')
const { renderEmotionImage } = require('./emotion-renderer')
const {
  hasAdminPermission, isReservedCommand,
  readJsonFile, writeJsonFile, writeTextFile, safeUnlink,
  formatPercent, getModelDisplayName, getSearchCapability, formatSearchStatus,
  extractAtIds, todayCst, todayCstMinusDays,
  sanitizeUserName,
  sanitizeUserInput,
  isJailbreakAttempt,
  pickJailbreakFallbackReply,
} = require('./utils')
const { logDebug } = require('./logging-config')

const forgetPendingConfirm = new Map()
const EMOTION_IMAGE_TEXT_LIMIT = 1500
const EMOTION_FALLBACK_TEXT_LIMIT = 500
const EMOTION_ANALYSIS_MAX_MESSAGES = 1200
const EMOTION_COMPRESS_BATCH_SIZE = 100
const EMOTION_MAX_SUMMARY_CHARS = 10000
let lastForgetCleanupTs = 0

function trimForgetPendingConfirm(now = Date.now()) {
  if (now - lastForgetCleanupTs < 300000) return
  lastForgetCleanupTs = now
  for (const [key, ts] of forgetPendingConfirm.entries()) {
    if (now - ts > 300000) forgetPendingConfirm.delete(key)
  }
}

function isGroupAdmin(session) {
  if (!session?.event?.sender?.role) return false
  return session.event.sender.role === 'owner' || session.event.sender.role === 'admin'
}

function isGroupAdminOrBotAdmin(session) {
  return isGroupAdmin(session) || hasAdminPermission(session)
}

function handled(response) {
  return { matched: true, response }
}

function notHandled() {
  return { matched: false }
}

function clampInteger(value, min, max, fallback) {
  const number = parseInt(value, 10)
  if (!Number.isFinite(number)) return fallback
  return Math.max(min, Math.min(max, number))
}

function cleanEmotionText(value = '', max = 120) {
  return String(value || '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)
}

function limitPlainText(value = '', max = 500) {
  const text = String(value || '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/[\t ]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  if (text.length <= max) return text
  return text.slice(0, Math.max(0, max - 3)).trim() + '...'
}

function truncateEmotionText(value = '', max = 120) {
  const text = cleanEmotionText(value, max + 20)
  if (text.length <= max) return text
  return text.slice(0, Math.max(0, max - 3)).trim() + '...'
}

function normalizeEmotionMood(score, mood = '') {
  const value = String(mood || '')
  if (/悲|低|消沉|焦虑|负/.test(value)) return '偏悲观'
  if (/乐|活跃|积极|高涨|正/.test(value)) return '偏乐观'
  if (/中|平/.test(value)) return '中性'
  if (score >= 65) return '偏乐观'
  if (score <= 40) return '偏悲观'
  return '中性'
}

function parseJsonObject(text = '') {
  const raw = String(text || '').trim()
  if (!raw) return null
  try { return JSON.parse(raw) } catch {}
  const match = raw.match(/\{[\s\S]*\}/)
  if (!match) return null
  try { return JSON.parse(match[0]) } catch { return null }
}

function normalizeEmotionReasons(value, fallbackSummary) {
  const source = Array.isArray(value) ? value : String(value || '').split(/(?:\d+[.、]\s*|[；;])/)
  const reasons = source.map(item => cleanEmotionText(item, 300)).filter(Boolean)
  if (reasons.length >= 2) return reasons.slice(0, 4)
  if (reasons.length === 1) return [reasons[0], '群聊样本仍在积累，结论以当前收录文本为准。']
  return [fallbackSummary || '聊天内容整体较平稳，没有明显单一情绪压倒其他话题。', '群聊样本仍在积累，结论以当前收录文本为准。']
}

function parseEmotionAnalysis(rawText, stats, summaryText = '') {
  const parsed = parseJsonObject(rawText)
  const text = String(rawText || '')
  const fallbackSummary = cleanEmotionText(summaryText || text, 80) || '今天整体情绪比较平稳。'
  const scoreMatch = text.match(/(?:score|指数)[^\d]*(\d{1,3})/i)
  const confidenceMatch = text.match(/(?:confidence|置信度)[^\d]*(\d{1,3})/i)
  const score = clampInteger(parsed?.score ?? parsed?.emotionScore ?? scoreMatch?.[1], 0, 100, 50)
  const confidence = clampInteger(parsed?.confidence ?? confidenceMatch?.[1], 0, 100, stats.messageCount >= 50 ? 78 : 65)
  const summary = cleanEmotionText(parsed?.summary || parsed?.comment || parsed?.overall || fallbackSummary, 80) || fallbackSummary
  const mood = normalizeEmotionMood(score, parsed?.mood || parsed?.label)
  const reasons = normalizeEmotionReasons(parsed?.reasons || parsed?.reason, summary)
  const keywords = Array.isArray(parsed?.keywords)
    ? parsed.keywords.map(item => cleanEmotionText(item, 16)).filter(Boolean).slice(0, 6)
    : []
  return { score, confidence, mood, summary, reasons, keywords }
}

function normalizeEmotionHistoryItem(item) {
  if (!item || typeof item !== 'object' || !item.date) return null
  const score = clampInteger(item.score, 0, 100, 50)
  return {
    date: String(item.date),
    score,
    mood: normalizeEmotionMood(score, item.mood),
    summary: cleanEmotionText(item.summary || item.text || '', 70),
  }
}

function renderEmotionReport(analysis, stats, history = []) {
  const lines = [
    `群聊情绪指数：${analysis.score}/100（${analysis.mood}）`,
    `置信度：${analysis.confidence}%`,
    `今日样本：${stats.messageCount} 条文本消息，${stats.userCount} 位活跃成员`,
    '',
  ]
  if (history.length) {
    lines.push('近5日对比：')
    for (const item of history) {
      const suffix = item.summary ? ` ${item.summary}` : ''
      lines.push(`- ${item.date}：${item.score}/100（${item.mood}）${suffix}`)
    }
  } else {
    lines.push('近5日对比：暂无对比数据')
  }
  lines.push('', `总评：${analysis.summary}`, '原因：')
  analysis.reasons.forEach((reason, index) => lines.push(`${index + 1}. ${reason}`))
  if (analysis.keywords.length) lines.push('', `关键词：${analysis.keywords.join('、')}`)
  return lines.join('\n').trim()
}

function limitEmotionAnalysisForImage(analysis, stats, history = [], max = EMOTION_IMAGE_TEXT_LIMIT) {
  const base = {
    ...analysis,
    summary: truncateEmotionText(analysis.summary, 80),
    reasons: (Array.isArray(analysis.reasons) ? analysis.reasons : [])
      .map(reason => truncateEmotionText(reason, 300))
      .filter(Boolean)
      .slice(0, 4),
    keywords: (Array.isArray(analysis.keywords) ? analysis.keywords : [])
      .map(keyword => truncateEmotionText(keyword, 16))
      .filter(Boolean)
      .slice(0, 6),
  }
  if (renderEmotionReport(base, stats, history).length <= max) return base

  for (const reasonLimit of [240, 200, 160, 120, 90, 70, 50]) {
    const candidate = {
      ...base,
      reasons: base.reasons.map(reason => truncateEmotionText(reason, reasonLimit)),
    }
    if (renderEmotionReport(candidate, stats, history).length <= max) return candidate
  }

  return {
    ...base,
    summary: truncateEmotionText(base.summary, 60),
    reasons: base.reasons.slice(0, 2).map(reason => truncateEmotionText(reason, 50)),
    keywords: [],
  }
}

async function renderEmotionImageWithRetry(ctx, renderImage, analysis, stats, history, channelKey) {
  let lastError = null
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      return await renderImage(analysis, stats, history)
    } catch (err) {
      lastError = err
      ctx.logger('dongxuelian-ai').warn(`emotion image render failed channel=${channelKey} attempt=${attempt}: ${err.message}`)
    }
  }
  throw lastError || new Error('emotion image render failed')
}

async function generateShortEmotionFallback(callOpenAI, analysis, stats, history, renderedText) {
  const prompt = [
    '今日情绪图片生成失败。请根据以下结构化结果，重新生成一段500字以内的纯文本群聊情绪报告。',
    '必须包含：情绪指数、置信度、今日样本、近5日对比简述、总评、最多3条原因。',
    '不要输出 JSON，不要 Markdown 表格，不要超过500字。',
    '',
    `情绪指数：${analysis.score}/100（${analysis.mood}）`,
    `置信度：${analysis.confidence}%`,
    `今日样本：${stats.messageCount} 条文本消息，${stats.userCount} 位活跃成员`,
    history.length ? '近5日对比：\n' + history.map(item => `${item.date} ${item.score}/100 ${item.summary || ''}`).join('\n') : '近5日对比：暂无对比数据',
    `总评：${analysis.summary}`,
    `原因：${analysis.reasons.slice(0, 3).join('；')}`,
    analysis.keywords.length ? `关键词：${analysis.keywords.join('、')}` : '',
  ].filter(Boolean).join('\n')

  try {
    const fallback = await callOpenAI([
      { role: 'system', content: prompt },
      { role: 'user', content: '重新生成今日情绪文本回退' },
    ], false, { max_tokens: 500, noLazy: true, _fallbackSet: 'lightweight' })
    return limitPlainText(fallback, EMOTION_FALLBACK_TEXT_LIMIT) || limitPlainText(renderedText, EMOTION_FALLBACK_TEXT_LIMIT)
  } catch {
    return limitPlainText(renderedText, EMOTION_FALLBACK_TEXT_LIMIT)
  }
}

function trimEmotionCache(map) {
  const ttl = 5 * 60 * 1000
  const now = Date.now()
  for (const [key, value] of map.entries()) {
    if (!value || now - (value.ts || 0) > ttl) map.delete(key)
  }
  while (map.size > 200) map.delete(map.keys().next().value)
}

async function summarizeEmotionMessages(msgs, callOpenAI) {
  const source = (Array.isArray(msgs) ? msgs : []).slice(-EMOTION_ANALYSIS_MAX_MESSAGES)
  const summaries = []
  for (let i = 0; i < source.length; i += EMOTION_COMPRESS_BATCH_SIZE) {
    const batch = source.slice(i, i + EMOTION_COMPRESS_BATCH_SIZE)
    const batchText = batch.map(m => `[${m.time}] ${m.user}：${m.content}`).join('\n')
    try {
      const summary = await callOpenAI([
        { role: 'system', content: '你是群聊消息摘要助手。将以下群聊记录压缩成一段100字以内的摘要，保留主要话题和情绪倾向。不要评价，只摘要。不得扩写，不得输出分析报告。' },
        { role: 'user', content: batchText.slice(0, 4000) },
      ], false, { _fallbackSet: 'lightweight' })
      if (summary) summaries.push(summary)
    } catch {}
    if (summaries.join('\n---\n').length >= EMOTION_MAX_SUMMARY_CHARS) break
  }
  const fallback = source.slice(-80).map(m => `[${m.time}] ${m.user}：${m.content}`).join('\n').slice(0, 8000)
  return {
    sample: source,
    text: (summaries.filter(Boolean).join('\n---\n') || fallback).slice(0, EMOTION_MAX_SUMMARY_CHARS),
  }
}

async function handleCommand(session, ctx, state) {
  const {
    plain, inGuild, channelKey, currentUserId, adminCommandMatched,
    loadConfig, loadRuntimeSettings, loadSkills, loadSkillsContentCache,
    callOpenAI, setRepeatEnabled, getRandomTriggerBaseRate, getRandomWhitelistStatus,
    getThinkingEnabled, setThinkingEnabled, resetConfigCache, getSkillsCount,
    channelMissCount, repeatEnabledCache, channelTodayCache, lastEmotionCache,
  } = state

  trimForgetPendingConfirm()

  if (/^(?:东雪莲)?测试开$/.test(plain)) {
    try { require('fs').writeFileSync(TEST_MODE_FILE, 'on') } catch (e) { ctx.logger('dongxuelian-ai').warn(`test mode enable failed: ${e.message}`) }
    clearConversationHistory()
    channelMissCount.delete(channelKey)
    return handled('\u6d4b\u8bd5\u6a21\u5f0f\u5df2\u5f00\u542f\uff0c\u7ba1\u7406\u5458\u7684\u6307\u4ee4\u5c06\u7edd\u5bf9\u4f18\u5148\u3002')
  }

  if (/^(?:东雪莲)?测试关$/.test(plain)) {
    await safeUnlink(TEST_MODE_FILE)
    clearConversationHistory()
    channelMissCount.delete(channelKey)
    return handled('\u6d4b\u8bd5\u6a21\u5f0f\u5df2\u5173\u95ed\uff0c\u6062\u590d\u6b63\u5e38\u4eba\u683c\u3002')
  }

  if (/^(?:东雪莲)?嘴臭开$/.test(plain)) {
    if (!hasAdminPermission(session)) return handled('只有管理员能操作这个命令。')
    try { require('fs').writeFileSync(HOSTILE_MODE_FILE, 'on') } catch (e) { ctx.logger('dongxuelian-ai').warn(`hostile mode enable failed: ${e.message}`) }
    return handled('嘴臭模式已开启。被攻击时反击值 ≥ 90 将使用嘴臭人格。')
  }

  if (/^(?:东雪莲)?嘴臭关$/.test(plain)) {
    if (!hasAdminPermission(session)) return handled('只有管理员能操作这个命令。')
    await safeUnlink(HOSTILE_MODE_FILE)
    return handled('嘴臭模式已关闭。被攻击时反击值 ≥ 90 将保持阴阳人格。')
  }

  if (/^谁(?:艾特|@)我$/.test(plain)) {
    if (!inGuild) return handled('这个命令只能在群里用。')
    const sw = await readJsonFile(SUMMARY_WHITELIST_FILE, [])
    if (!Array.isArray(sw) || !sw.includes(String(channelKey))) {
      return handled('本群未启用该功能，请联系管理员添加白名单。')
    }
    const today = todayCst()
    const safeKey = String(channelKey).replace(/[^a-zA-Z0-9._-]/g, '_')
    const cacheFile = path.join(DATA_DIR, 'today-cache-' + safeKey + '.json')
    let cache = null
    try { cache = JSON.parse(require('fs').readFileSync(cacheFile, 'utf8')) } catch {}
    if (!cache || cache.date !== today || !Array.isArray(cache.messages)) {
      return handled('今天还没有收录足够消息，稍后再试。')
    }
    const userId = String(currentUserId || '')
    if (!userId) return handled('无法获取用户信息。')
    const atMe = cache.messages.filter(m => {
      if (Array.isArray(m.mentionUserIds) && m.mentionUserIds.includes(userId)) return true
      if (m.content && extractAtIds(m.content).includes(userId)) return true
      return false
    })
    if (!atMe.length) return handled('今天还没有人 @你。')
    const slice = atMe.slice(-10)
    const lines = slice.map((m, i) => `${i + 1}. ${m.user || '群友'} ${m.time ? m.time.slice(0, 5) : ''}:\n${(m.content || '').replace(/【[^】]*】/g, '').trim().slice(0, 60)}`)
    const total = atMe.length
    const shown = Math.min(total, 10)
    let reply = `今天有 ${total} 条消息 @了你（显示最近${shown}条）：\n\n${lines.join('\n\n')}`
    if (total > shown) reply += `\n\n${shown}/${total}`
    reply += `\n\n如需查看上下文可定位消息，示例：\n定位消息 1`
    return handled(reply)
  }

  const locateMatch = plain.match(/^定位消息\s+(\d+)$/)
  if (locateMatch) {
    const targetIdx = parseInt(locateMatch[1], 10) - 1
    if (!inGuild) return handled('这个命令只能在群里用。')
    const today = todayCst()
    const safeKey = String(channelKey).replace(/[^a-zA-Z0-9._-]/g, '_')
    const cacheFile = path.join(DATA_DIR, 'today-cache-' + safeKey + '.json')
    let cache = null
    try { cache = JSON.parse(require('fs').readFileSync(cacheFile, 'utf8')) } catch {}
    if (!cache || cache.date !== today || !Array.isArray(cache.messages)) {
      return handled('今天还没有收录足够消息。')
    }
    const userId = String(currentUserId || '')
    const atMe = cache.messages.filter(m => {
      if (Array.isArray(m.mentionUserIds) && m.mentionUserIds.includes(userId)) return true
      if (m.content && extractAtIds(m.content).includes(userId)) return true
      return false
    })
    if (targetIdx < 0 || targetIdx >= atMe.length) return handled('编号超出范围。')
    const cacheIdx = cache.messages.indexOf(atMe[targetIdx])
    if (cacheIdx === -1) return handled('未找到该消息。')
    const start = Math.max(0, cacheIdx - 2)
    const end = Math.min(cache.messages.length, cacheIdx + 3)
    const contextLines = cache.messages.slice(start, end).map((m, i) => {
      const prefix = start + i === cacheIdx ? '→ ' : '  '
      return `${prefix}${m.user || '群友'} ${m.time ? m.time.slice(0, 5) : ''}：${(m.content || '').replace(/【[^】]*】/g, '').trim().slice(0, 80)}`
    }).join('\n')
    return handled(`消息上下文（共${cache.messages.length}条）：\n\n${contextLines}`)
  }

  if (/^东雪莲群聊AI概率查看$/.test(plain)) {
    if (!inGuild) return handled('这个命令只能在群里用。')
    return handled(`本群主动回复基础概率：${formatPercent(getRandomTriggerBaseRate(channelKey))}`)
  }

  if (plain === '东雪莲思考开') {
    if (!hasAdminPermission(session)) return handled('只有指定管理员能操作这个命令。')
    await writeTextFile(THINKING_MODE_FILE, 'on')
    setThinkingEnabled(true)
    return handled('思考调试模式已开启；可见回复仍会过滤推理过程。')
  }

  if (plain === '东雪莲思考关') {
    if (!hasAdminPermission(session)) return handled('只有指定管理员能操作这个命令。')
    await writeTextFile(THINKING_MODE_FILE, 'off')
    setThinkingEnabled(false)
    return handled('思考调试模式已关闭；可见回复仍会过滤推理过程。')
  }

  if (/^东雪莲联网开$/.test(plain)) {
    const config = await loadConfig(true)
    config.searchEnabled = true
    await writeTextFile(SEARCH_ENABLED_FILE, 'on')
    const capability = getSearchCapability(config)
    return handled(capability.supported
      ? `东雪莲联网已开启。\n接口模式：${capability.label}`
      : `联网开关已打开，但当前接口不支持联网搜索。\n接口模式：${capability.label}`)
  }

  if (/^东雪莲联网关$/.test(plain)) {
    const config = await loadConfig(true)
    config.searchEnabled = false
    await writeTextFile(SEARCH_ENABLED_FILE, 'off')
    return handled('东雪莲联网已关闭。')
  }

  if (/^东雪莲联网查看$/.test(plain)) {
    const config = await loadConfig(true)
    return handled(formatSearchStatus(config))
  }

  // #2 忘记我二次确认
  if (plain === '东雪莲忘记我') {
    const forgetKey = 'forget:' + channelKey + ':' + currentUserId
    forgetPendingConfirm.set(forgetKey, Date.now())
    return handled('确定要清空我对你的所有记忆吗？再次发送「确认忘记我」即可。')
  }

  if (plain === '确认忘记我') {
    const forgetKey = 'forget:' + channelKey + ':' + currentUserId
    const ts = forgetPendingConfirm.get(forgetKey) || 0
    if (!ts || Date.now() - ts > 60000) return handled('确认超时，请重新发送「东雪莲忘记我」。')
    forgetPendingConfirm.delete(forgetKey)
    await clearUserMemory(currentUserId, channelKey)
    clearUserConversationHistory(session)
    return handled('已清空我对你的记忆。')
  }

  // #3 随机选 A/B
  if (plain.startsWith('东雪莲帮我选') && plain.includes('还是')) {
    const m = plain.match(/选\s*(.+?)\s*还是\s*(.+)/)
    if (m) {
      const chosen = Math.random() < 0.5 ? m[1].trim() : m[2].trim()
      return handled(`我投了个骰子……${chosen}！`)
    }
  }

  if (plain === '东雪莲清空群记忆') {
    if (!inGuild) return handled('这个命令只能在群里用。')
    if (!isGroupAdminOrBotAdmin(session)) return handled('只有群管理员/群主才能清空群记忆。')
    clearConversationHistory()
    await clearGroupMemory(channelKey)
    return handled('已清空本群的记忆。')
  }

  // #5 东雪莲吐槽我
  if (plain === '东雪莲吐槽我') {
    const memorySummary = await getMemorySummary(currentUserId, channelKey)
    let promptText
    if (memorySummary) {
      promptText = `根据我对你的了解：${memorySummary}\n用你现在的性格和语气，根据这些记忆狠狠吐槽我。简短一点，30字以内。`
    } else {
      const recentHistory = getConversationHistory(session)
      const recentText = recentHistory.slice(-5).map(m => m.content).filter(Boolean).join('；')
      promptText = `最近群聊消息：${recentText || '没什么特别的事'}\n用你现在的性格和语气，随便吐个槽。简短一点，30字以内。`
    }
    const result = await callOpenAI([
      { role: 'system', content: promptText },
      { role: 'user', content: '吐槽我' },
    ], false, { max_tokens: 100 })
    if (result) return handled(result)
    return handled('没什么好吐槽的。')
  }

  // #6 帮我说话
  if (plain.startsWith('东雪莲帮我说话') && plain.length > 7) {
    const target = plain.slice(7).trim() || ''
    let contextNote = ''
    if (session.quote?.content) contextNote += `\n引用消息：${session.quote.content.slice(0, 200)}`
    if (session.quote?.elements) contextNote += `\n引用包含图片/文件等`
    const promptText = `用你现在的性格和语气，帮我吐槽以下这件事/这个人。注意你是以你自己的身份说，不要让对方知道是我让你说的。\n${contextNote}\n吐槽对象：${target || '没什么具体对象，随便吐个槽'}`
    const result = await callOpenAI([
      { role: 'system', content: promptText },
      { role: 'user', content: target || '帮我说话' },
    ], false, { max_tokens: 200 })
    if (result) return handled(result)
    return handled('没什么好说的。')
  }

  // #7 群记忆定时清空
  if (plain.startsWith('东雪莲群记忆定时') && plain !== '东雪莲群记忆定时') {
    if (!isGroupAdminOrBotAdmin(session)) return handled('只有群管理员/群主才能设置。')
    if (!inGuild) return handled('这个命令只能在群里用。')
    const value = plain.slice(8).trim()
    if (value === '关') {
      try { await safeUnlink(path.join(DATA_DIR, 'memory-timers', String(channelKey).replace(/[^a-zA-Z0-9._-]/g, '_') + '.json')) } catch {}
      return handled('群记忆定时清空已关闭。')
    }
    const hours = parseFloat(value)
    if (!isFinite(hours) || hours < 0.5 || hours > 168) return handled('请设置 0.5-168 小时。例如：东雪莲群记忆定时 3')
    const timerData = { intervalHours: hours, lastClearTs: Date.now() }
    const timerFile = path.join(DATA_DIR, 'memory-timers', String(channelKey).replace(/[^a-zA-Z0-9._-]/g, '_') + '.json')
    try { require('fs').mkdirSync(path.join(DATA_DIR, 'memory-timers'), { recursive: true }) } catch {}
    await writeJsonFile(timerFile, timerData)
    return handled(`群记忆定时清空已设为每 ${hours} 小时清空一次。下次清空后会自动重置计时。`)
  }

  logDebug(ctx, 'persona', `persona-check plain=${JSON.stringify(plain)} len=${plain.length} charCodes=${Array.from(plain).map(c => c.charCodeAt(0)).join(',')}`)

  if (plain === '东雪莲我的人格' || plain === '东雪莲人格查看') {
    const userPersona = getUserPersona(currentUserId)
    const resolved = resolvePersona(channelKey, currentUserId)
    const sourceLabel = { user: '个人设置', group: '群级默认', default: '默认（东雪莲）' }
    const reply = `你的当前人格：${resolved.name || '默认（东雪莲）'}\n来源：${sourceLabel[resolved.source]}${userPersona ? '' : '\n提示：发送"东雪莲人格切换 椿"可切换'}`
    await session.send(reply)
    return handled()
  }

  if (plain === '东雪莲人格切换' || plain === '东雪莲人格切换 ') {
    await session.send('请指定人格名称，例如：东雪莲人格切换 椿\n发送"东雪莲人格列表"查看可用人格。')
    return handled()
  }

  if (plain.startsWith('东雪莲人格切换 ') && plain.length > 7) {
    if (!inGuild) { await session.send('人格切换只能在群里用。'); return handled() }
    const targetName = plain.slice(7).trim()
    const personas = getAvailablePersonals({ userFacing: true })
    const found = personas.find(p => p.name === targetName)
    if (!found) { await session.send(`未找到人格"${targetName}"。可用：${personas.map(p => p.name).join('、')}`); return handled() }
    setUserPersona(currentUserId, targetName)
    await session.send(`已为你切换到人格：${targetName}`)
    return handled()
  }

  if (plain === '东雪莲人格重置') {
    resetUserPersona(currentUserId)
    const resolved = resolvePersona(channelKey, currentUserId)
    await session.send(`已重置你的人格。当前使用：${resolved.name || '默认（东雪莲）'}`)
    return handled()
  }

  if (plain === '东雪莲人格列表') {
    logDebug(ctx, 'persona', 'persona-list matched, loading')
    const personas = getAvailablePersonals({ userFacing: true })
    logDebug(ctx, 'persona', `persona-list found=${personas.length}`)
    if (personas.length === 0) { await session.send('当前没有人格配置。'); return handled() }
    const lines = personas.map(p => `- ${p.name}（${p.description || '无描述'}）`)
    await session.send(`可用人格：\n${lines.join('\n')}\n\n切换：东雪莲人格切换 <名称>\n重置：东雪莲人格重置`)
    return handled()
  }

  if (plain === '东雪莲群人格') {
    if (!isGroupAdminOrBotAdmin(session)) { await session.send('只有群管理员/群主才能查看群级人格。'); return handled() }
    const entry = getGroupPersona(channelKey)
    if (!entry) { await session.send('当前群：默认模式（无群级人格）'); return handled() }
    await session.send(`群级人格：${entry.persona}`)
    return handled()
  }

  if (plain.startsWith('东雪莲群人格切换') && plain !== '东雪莲群人格切换') {
    if (!isGroupAdminOrBotAdmin(session)) { await session.send('只有群管理员/群主才能设置群级人格。'); return handled() }
    if (!inGuild) { await session.send('群级人格设置只能在群里用。'); return handled() }
    const targetName = plain.slice(8).trim()
    const personas = getAvailablePersonals({ userFacing: true })
    const found = personas.find(p => p.name === targetName)
    if (!found) { await session.send(`未找到人格"${targetName}"。可用：${personas.map(p => p.name).join('、')}`); return handled() }
    setGroupPersona(channelKey, targetName)
    await session.send(`已设置群级人格：${targetName}`)
    return handled()
  }

  if (plain === '东雪莲群人格重置') {
    if (!isGroupAdminOrBotAdmin(session)) { await session.send('只有群管理员/群主才能重置群级人格。'); return handled() }
    if (!inGuild) { await session.send('群级人格重置只能在群里用。'); return handled() }
    resetGroupPersona(channelKey)
    await session.send('已重置群级人格。所有未切换个人人格的用户将使用默认东雪莲。')
    return handled()
  }

  if (plain === '东雪莲复读开') {
    if (!hasAdminPermission(session)) return handled('只有管理员才能开启复读。')
    if (!inGuild) return handled('复读开关只能在群里用。')
    setRepeatEnabled(channelKey, true)
    return handled('本群连续复读已开启。')
  }

  if (plain === '东雪莲复读关') {
    if (!hasAdminPermission(session)) return handled('只有管理员才能关闭复读。')
    if (!inGuild) return handled('复读开关只能在群里用。')
    setRepeatEnabled(channelKey, false)
    return handled('本群连续复读已关闭。')
  }

  if (plain === '东雪莲复读状态') {
    const enabled = repeatEnabledCache[channelKey]
    return handled(`本群连续复读：${enabled ? '开启' : '关闭'}（默认关闭，同一复读组只跟一次）`)
  }

  // === TTS 语音合成命令 ===
  if (plain === '东雪莲说句话') {
    const { synthesizeSpeech, sendVoiceMessage, resolvePersonaVoice } = require('./tts')
    const resolved = resolvePersona(channelKey, currentUserId)
    const voiceOpts = resolvePersonaVoice(resolved.name)
    const phrases = ['哼，你好烦啊', '今天天气不错呢', '你在干嘛呀', '无聊死了', '哎呀别烦我啦']
    const text = phrases[Math.floor(Math.random() * phrases.length)]
    const buf = await synthesizeSpeech(text, voiceOpts)
    if (buf) {
      const sent = await sendVoiceMessage(session, buf)
      if (sent) return handled()
    }
    return handled('语音合成失败了，可能是服务暂时不可用。')
  }

  if (/^东雪莲朗读\s*(.+)/.test(plain)) {
    const text = RegExp.$1.trim()
    if (!text) return handled('请告诉我要朗读什么内容。')
    const { synthesizeSpeech, sendVoiceMessage, resolvePersonaVoice, MAX_TTS_TEXT_LENGTH } = require('./tts')
    if (text.length > MAX_TTS_TEXT_LENGTH) return handled(`文本太长了，最多支持 ${MAX_TTS_TEXT_LENGTH} 字。`)
    const resolved = resolvePersona(channelKey, currentUserId)
    const voiceOpts = resolvePersonaVoice(resolved.name)
    const buf = await synthesizeSpeech(text, voiceOpts)
    if (buf) {
      const sent = await sendVoiceMessage(session, buf)
      if (sent) return handled()
    }
    return handled('语音合成失败了，可能是服务暂时不可用。')
  }

  if (/^朗读$/.test(plain) && session.quote?.content) {
    const rawQuote = String(session.quote.content || '')
      .replace(/\[CQ:[^\]]+\]/gi, '')
      .replace(/<[^>]+\/?>/gi, '')
      .replace(/\s+/g, ' ')
      .trim()
    const quoteText = sanitizeUserInput(rawQuote).slice(0, 300)
    if (!quoteText) return handled('引用的消息没有可朗读的文本。')
    const { synthesizeSpeech, sendVoiceMessage, resolvePersonaVoice } = require('./tts')
    const resolved = resolvePersona(channelKey, currentUserId)
    const voiceOpts = resolvePersonaVoice(resolved.name)
    const buf = await synthesizeSpeech(quoteText, voiceOpts)
    if (buf) {
      const sent = await sendVoiceMessage(session, buf)
      if (sent) return handled()
    }
    return handled('语音合成失败了，可能是服务暂时不可用。')
  }

  if (plain === '东雪莲语音列表') {
    const { getBuiltinVoices } = require('./tts')
    return handled(`可用语音：${getBuiltinVoices().join('、')}\n人格 SKILL 文件可通过 voice_id 字段指定默认语音。`)
  }

  const switchMatch = plain.match(/^切换(.+)$/)
  if (switchMatch && !adminCommandMatched && !isReservedCommand(plain)) {
    const requestedName = switchMatch[1].trim()
    let foundProvider = null
    let foundModelId = null
    for (const [id, prov] of Object.entries(PROVIDERS)) {
      const found = prov.models.find(m => m.name === requestedName || m.id === requestedName)
      if (found) {
        foundProvider = id
        foundModelId = found.id
        break
      }
    }
    if (foundProvider) {
      const prov = PROVIDERS[foundProvider]
      await writeTextFile(PROVIDER_FILE, foundProvider)
      await writeTextFile(MODEL_FILE, foundModelId)
      await writeTextFile(BASE_URL_FILE, prov.baseURL)
      resetConfigCache()
      return handled(`已切换至 ${prov.name}：${foundModelId}`)
    }
  }

  if (plain === 'AI状态') {
    const config = await loadConfig(true)
    await loadRuntimeSettings(true)
    await loadSkills()
    await loadSkillsContentCache()
    const personaEntry = getGroupPersona(channelKey)
    return handled([
      `AI版本：${PLUGIN_VERSION}`,
      `主模型：${getModelDisplayName(config.provider, config.model) || '(未设置)'}`,
      `备用模型：Qwen3.5 → Qwen3.6 → DeepSeek V4 Flash → GLM 4.6`,
      `思考模式：${getThinkingEnabled() ? '开' : '关'}`,
      `Base URL：${config.baseURL || '(未设置)'}`,
      `联网：${config.searchEnabled ? '开' : '关'}`,
      `联网模式：${getSearchCapability(config).label}`,
      `Skills：${getSkillsCount()} 个`,
      `当前群人格：${personaEntry?.persona || '默认'}`,
      `当前群基础触发率：${formatPercent(getRandomTriggerBaseRate(channelKey))}`,
      `当前群白名单状态：${getRandomWhitelistStatus(channelKey) ? '允许主动回复' : '禁止主动回复'}`,
      `随机触发率规则：热身${RANDOM_TRIGGER_WARMUP}条后每条+${formatPercent(RANDOM_TRIGGER_RAMP)}`,
    ].join('\n'))
  }

  if (plain === 'AI诊断') {
    if (!hasAdminPermission(session)) return handled('只有 bot 管理员才能使用 AI 诊断。')
    const report = await runHealthCheck(true)
    return handled(formatHealthReport(report))
  }

  if (plain === 'AI重载') {
    await loadRuntimeSettings(true)
    await loadConfig(true)
    await loadSkills()
    await loadSkillsContentCache()
    loadPersonaGroups()
    clearConversationHistory()
    channelMissCount.delete(channelKey)
    return handled(`AI配置已重载，当前 Skills：${getSkillsCount()} 个。`)
  }

  if (plain === '今日情绪') {
    if (!inGuild) return handled('这个命令只能在群里用。')
    const today = todayCst()
    const cache = channelTodayCache.get(channelKey)
    if (!cache || cache.date !== today || !cache.messages.length) return handled('今天还没有收录消息。')
    const users = new Set(cache.messages.map(m => m.userId)).size
    const msgs = cache.messages

    const cached = lastEmotionCache.get(channelKey)
    if (cached && Date.now() - cached.ts < 300000) return handled(cached.response || cached.text)
    if (cached) lastEmotionCache.delete(channelKey)

    const emotionSummary = await summarizeEmotionMessages(msgs, callOpenAI)
    const allSummary = emotionSummary.text

    await loadConfig(true)
    const safeChannelKey = String(channelKey).replace(/[^a-zA-Z0-9._-]/g, '_')
    const historyFile = path.join(DATA_DIR, 'emotion-history-' + safeChannelKey + '.json')
    const historyData = await readJsonFile(historyFile, [])
    const todayDate = today
    const recentHistory = (Array.isArray(historyData) ? historyData : [])
      .map(normalizeEmotionHistoryItem)
      .filter(item => item && item.date !== todayDate)
      .slice(-5)

    const emotionPrompt = [
      '你是一个群聊情绪分析师。以下是一天中每段群聊记录的摘要，请分析整体情绪状态。',
      `今日样本：${msgs.length} 条消息，${users} 位活跃成员。`,
      '输出内容将用于图片展示。summary、reasons、keywords 中用于展示的中文正文总量不得超过1500字。summary 控制在80字以内；reasons 最多4条，每条300字以内；keywords 最多6个短词。',
      '只输出 JSON，不要 Markdown，不要解释。格式：',
      '{"score":0到100整数,"confidence":0到100整数,"mood":"偏悲观/中性/偏乐观","summary":"80字以内总结","reasons":["每条300字以内，最多4条"],"keywords":["短关键词，最多6个"]}',
      recentHistory.length ? '近5日对比：\n' + recentHistory.map(h => `${h.date} ${h.score}/100 ${h.summary}`).join('\n') : '近5日对比：暂无对比数据',
      '',
      '摘要如下：',
      allSummary.slice(0, 10000),
    ].join('\n')
    try {
      const result = await callOpenAI([
        { role: 'system', content: emotionPrompt },
        { role: 'user', content: `群 ${channelKey} 今日情绪分析` },
      ], false, { max_tokens: 600, noLazy: true, _fallbackSet: 'lightweight' })
      const stats = { messageCount: msgs.length, userCount: users }
      const analysis = parseEmotionAnalysis(result, stats, allSummary)
      const displayAnalysis = limitEmotionAnalysisForImage(analysis, stats, recentHistory)
      const rendered = renderEmotionReport(displayAnalysis, stats, recentHistory)

      try {
        const safeHistory = (Array.isArray(historyData) ? historyData : []).filter(item => item && item.date !== todayDate)
        safeHistory.push({ date: todayDate, score: displayAnalysis.score, confidence: displayAnalysis.confidence, mood: displayAnalysis.mood, summary: displayAnalysis.summary, reasons: displayAnalysis.reasons })
        const cutoffStr = todayCstMinusDays(5)
        await writeJsonFile(historyFile, safeHistory.filter(h => h.date >= cutoffStr))
      } catch (historyErr) {
        ctx.logger('dongxuelian-ai').warn(`emotion history save failed: ${historyErr.message}`)
      }

      logDebug(ctx, 'emotion', `analysis done channel=${channelKey} score=${analysis.score} messages=${msgs.length}`)
      const renderImage = state.renderEmotionImage || renderEmotionImage
      try {
        const imageBuffer = await renderEmotionImageWithRetry(ctx, renderImage, displayAnalysis, stats, recentHistory, channelKey)
        const imageBase64 = Buffer.isBuffer(imageBuffer) ? imageBuffer.toString('base64') : Buffer.from(imageBuffer).toString('base64')
        const imageMessage = h.image(`data:image/png;base64,${imageBase64}`)
        lastEmotionCache.set(channelKey, { response: imageMessage, text: rendered, ts: Date.now() })
        trimEmotionCache(lastEmotionCache)
        return handled(imageMessage)
      } catch (imageErr) {
        const fallbackText = await generateShortEmotionFallback(callOpenAI, displayAnalysis, stats, recentHistory, rendered)
        lastEmotionCache.set(channelKey, { text: fallbackText, ts: Date.now() })
        trimEmotionCache(lastEmotionCache)
        return handled(fallbackText)
      }
    } catch (err) {
      ctx.logger('dongxuelian-ai').warn(`emotion analysis failed: ${err.message}`)
      return handled('情绪分析失败了，稍后再试。')
    }
  }

  // === Agent 工具模式管理 ===
  if (/^(?:东雪莲)?工具模式\s+(auto|confirm|block|config)$/.test(plain)) {
    if (!hasAdminPermission(session)) return handled('只有管理员能操作此命令。')
    const m = RegExp.$1
    require('./agent/safety').setMode(m)
    const labels = { auto: '自动执行', confirm: '需确认', block: '已禁止', config: '跟随配置' }
    return handled(`工具安全模式：${labels[m]} (${m})`)
  }

  if (/^(?:东雪莲)?工具自动路由\s*(开|关|on|off)$/.test(plain)) {
    if (!hasAdminPermission(session)) return handled('只有管理员能操作此命令。')
    const enabled = /^(?:开|on)$/i.test(RegExp.$1)
    const agentConfig = require('./agent/config')
    const config = agentConfig.getAgentConfig()
    config.autoRoute.qq.enabled = enabled
    await agentConfig.saveAgentConfig(config)
    return handled(`QQ Agent 自动路由：${enabled ? '开启' : '关闭'}`)
  }

  const toolSwitchMatch = plain.match(/^(?:东雪莲)?工具开关\s+(qq|dashboard)\s+([a-zA-Z0-9_-]+)\s+(开|关|on|off)$/)
  if (toolSwitchMatch) {
    if (!hasAdminPermission(session)) return handled('只有管理员能操作此命令。')
    const [, channel, toolName, rawEnabled] = toolSwitchMatch
    if (channel === 'qq' && /^(?:execute_shell|read_file|list_files|find_files|write_file|edit_file|append_file|grep_search|execute_javascript|browser_action|query_logs)$/i.test(toolName)) {
      return handled('QQ Agent 不允许开启服务器/文件/浏览器高权限工具；请在 Agent Console 使用 Dashboard Agent，并通过审批执行危险操作。')
    }
    const enabled = /^(?:开|on)$/i.test(rawEnabled)
    const registry = require('./agent/tools/registry')
    if (!registry.toolRegistry[toolName]) return handled(`未知工具：${toolName}`)
    await require('./agent/config').setToolEnabled(channel, toolName, enabled)
    return handled(`${channel} 工具 ${toolName}：${enabled ? '开启' : '关闭'}`)
  }

  const skillSwitchMatch = plain.match(/^(?:东雪莲)?工具Skill\s+(开|关|on|off)\s+(.+)$/i)
  if (skillSwitchMatch) {
    if (!hasAdminPermission(session)) return handled('只有管理员能操作此命令。')
    const enabled = /^(?:开|on)$/i.test(skillSwitchMatch[1])
    const skillName = skillSwitchMatch[2].trim()
    const skillHub = require('./agent/skill-hub')
    try {
      const skill = await skillHub.setSkillHubEnabled(skillName, enabled)
      return handled(`Agent Skill ${skill.name}：${enabled ? '启用' : '禁用'}`)
    } catch (error) {
      return handled(error.message || `未知 Agent Skill：${skillName}`)
    }
  }

  if (/^(?:东雪莲)?工具Skill\s*(?:列表|list)?$/i.test(plain)) {
    const skills = require('./agent/skill-hub').listSkillHubItems().slice(0, 20)
    if (skills.length === 0) return handled('暂无 Agent Skill。')
    return handled(require('./agent/skill-hub').formatSkillHubItems(skills))
  }

  if (/^(?:东雪莲)?工具状态$/.test(plain)) {
    const safety = require('./agent/safety')
    const agentConfig = require('./agent/config').getAgentConfig()
    const stats = require('./agent/stats').getStats()
    const registry = require('./agent/tools/registry')
    const qqTools = registry.getToolDefinitions('qq').map(item => item.function.name).join(', ') || '无'
    const dashboardTools = registry.getToolDefinitions('dashboard').map(item => item.function.name).join(', ') || '无'
    return handled([
      `工具安全模式：${safety.getMode()}（危险工具策略：${agentConfig.dangerousPolicy}）`,
      `QQ Agent：${agentConfig.channels.qq.enabled ? '开启' : '关闭'} / 自动路由：${agentConfig.autoRoute?.qq?.enabled ? '开启' : '关闭'} / ${qqTools}`,
      `Dashboard Agent：${agentConfig.channels.dashboard.enabled ? '开启' : '关闭'} / ${dashboardTools}`,
      `可注册工具：${registry.getToolCount()} 个`,
      `累计调用：${stats.total} 次`,
      stats.total > 0 ? `最近：${stats.recent.slice(0, 3).map(c => c.tool).join(', ')}` : '',
    ].filter(Boolean).join('\n'))
  }

  if (/^(?:\/plan|莲莲计划)\s+(.+)/i.test(plain)) {
    const query = RegExp.$1.trim()
    const planEngine = require('./agent/plan/plan-engine')
    const planPrompts = require('./agent/plan/plan-prompts')
    const engine = require('./agent/engine')
    const agentConfig = require('./agent/config').getAgentConfig()
    if (!agentConfig.planMode?.enabled) return handled('计划模式当前未开启。')
    const userName = sanitizeUserName(session.author?.nick || session.author?.name || session.username || '群友')
    const tasks = query
      .split(/(?:；|;|\n|，然后|然后|再)/)
      .map(item => item.trim())
      .filter(Boolean)
      .slice(0, 8)
    const fallbackTasks = tasks.length >= 2 ? tasks : [
      `理解目标：${query}`,
      '收集必要信息并执行可用工具',
      '整理结果并汇报完成状态',
    ]
    try {
      const plan = await planEngine.createPlan({ title: query.slice(0, 80), tasks: fallbackTasks.map(desc => ({ desc })), channel: 'qq', channelKey, userId: currentUserId, userName })
      const agentQueue = require('./agent/queue')
      agentQueue.configureAgentQueue(agentConfig.queue || {})
      const result = await agentQueue.enqueueAgentTask({
        channelKey,
        userId: currentUserId,
        timeoutMs: agentConfig.queue?.timeoutMs,
        fn: () => engine.run({
          userMessage: query,
          userName,
          userId: currentUserId,
          channelKey,
          channel: 'qq',
          bot: session.bot,
          systemExtra: [
            { role: 'system', content: planPrompts.buildPlanSystemPrompt(plan) },
            { role: 'system', content: planPrompts.buildPlanCreatePrompt(query) },
          ],
          forceTools: ['check_plan_status', 'update_task_status', 'finish_plan'],
          preExecuteTools: [{ name: 'check_plan_status', args: { planId: plan.id } }],
        }),
      })
      return handled([planEngine.formatPlan(plan), '', result.reply || '计划已创建，正在执行。'].join('\n'))
    } catch (err) {
      if (err && (err.code === 'AGENT_QUEUE_FULL' || err.code === 'AGENT_QUEUE_REJECTED')) return handled(err.message)
      ctx.logger('dongxuelian-ai').warn(`plan mode failed: ${err.message}`)
      return handled('计划模式暂时不可用。')
    }
  }

  const planStatusMatch = plain.match(/^(?:计划查看|\/plans?)(?:\s+(plan_[a-zA-Z0-9_-]+))?$/i)
  if (planStatusMatch) {
    try {
      const planEngine = require('./agent/plan/plan-engine')
      return handled(planEngine.formatPlan(await planEngine.checkPlanStatus(planStatusMatch[1] || '')))
    } catch (err) {
      return handled(err.message || '计划查询失败。')
    }
  }

  const planResumeMatch = plain.match(/^(?:计划继续|\/plan-resume)(?:\s+(plan_[a-zA-Z0-9_-]+))?$/i)
  if (planResumeMatch) {
    try {
      const planEngine = require('./agent/plan/plan-engine')
      const planRunner = require('./agent/plan/plan-runner')
      const plan = await planRunner.resolvePlan(planResumeMatch[1] || '', { userId: currentUserId, channelKey })
      if (!plan) return handled('当前没有可继续的执行中计划。')
      if (plan.userId !== currentUserId && !hasAdminPermission(session)) return handled('只能继续自己的计划，或由 bot 管理员操作。')
      const userName = sanitizeUserName(session.author?.nick || session.author?.name || session.username || plan.userName || '群友')
      const result = await planRunner.resumePlan({ planId: plan.id, channelKey, userId: currentUserId, userName, bot: session.bot })
      return handled([planEngine.formatPlan(plan), '', result.reply || '计划已继续执行。'].join('\n'))
    } catch (err) {
      if (err && (err.code === 'AGENT_QUEUE_FULL' || err.code === 'AGENT_QUEUE_REJECTED')) return handled(err.message)
      ctx.logger('dongxuelian-ai').warn(`plan resume failed: ${err.message}`)
      return handled(err.message || '计划继续失败。')
    }
  }

  const planAbandonMatch = plain.match(/^(?:计划放弃|\/plan-abandon)\s+(plan_[a-zA-Z0-9_-]+)(?:\s+(.+))?$/i)
  if (planAbandonMatch) {
    try {
      const planEngine = require('./agent/plan/plan-engine')
      const plan = await planEngine.checkPlanStatus(planAbandonMatch[1])
      if (plan.userId !== currentUserId && !hasAdminPermission(session)) return handled('只能放弃自己的计划，或由 bot 管理员操作。')
      const abandoned = await planEngine.abandonPlan({ planId: planAbandonMatch[1], reason: planAbandonMatch[2] || '用户放弃计划' })
      return handled(planEngine.formatPlan(abandoned))
    } catch (err) {
      return handled(err.message || '计划放弃失败。')
    }
  }

  const memoryRememberMatch = plain.match(/^(?:莲莲记住|\/memory\s+remember)\s+(.+)/i)
  if (memoryRememberMatch) {
    const agentConfig = require('./agent/config').getAgentConfig()
    if (!agentConfig.memory?.enabled) return handled('Agent 记忆当前未开启。')
    if (agentConfig.memory?.adminOnly && !hasAdminPermission(session)) return handled('只有管理员能写入 Agent 长期记忆。')
    try {
      const item = await require('./agent/memory').remember({
        userId: currentUserId,
        channelKey,
        text: memoryRememberMatch[1].trim(),
      })
      return handled(`已记住：${item.id}`)
    } catch (err) {
      return handled(err.message || '记忆写入失败。')
    }
  }

  const memorySearchMatch = plain.match(/^(?:莲莲回忆|\/memory\s+search)\s*(.*)$/i)
  if (memorySearchMatch) {
    const agentConfig = require('./agent/config').getAgentConfig()
    if (!agentConfig.memory?.enabled) return handled('Agent 记忆当前未开启。')
    if (agentConfig.memory?.adminOnly && !hasAdminPermission(session)) return handled('只有管理员能检索 Agent 长期记忆。')
    try {
      const memory = require('./agent/memory')
      const items = await memory.searchMemory({
        userId: currentUserId,
        channelKey,
        query: memorySearchMatch[1].trim(),
        limit: 8,
      })
      return handled(memory.formatMemoryItems(items))
    } catch (err) {
      return handled(err.message || '记忆检索失败。')
    }
  }

  const memoryListMatch = plain.match(/^(?:莲莲记忆列表|\/memory\s+list)(?:\s+(\d+))?$/i)
  if (memoryListMatch) {
    const agentConfig = require('./agent/config').getAgentConfig()
    if (!agentConfig.memory?.enabled) return handled('Agent 记忆当前未开启。')
    if (agentConfig.memory?.adminOnly && !hasAdminPermission(session)) return handled('只有管理员能查看 Agent 长期记忆。')
    try {
      const memory = require('./agent/memory')
      return handled(memory.formatMemoryItems(await memory.listMemory({ userId: currentUserId, limit: memoryListMatch[1] || 20 })))
    } catch (err) {
      return handled(err.message || '记忆列表读取失败。')
    }
  }

  const memoryForgetMatch = plain.match(/^(?:莲莲忘记|\/memory\s+forget)\s+(mem_[a-zA-Z0-9_-]+)/i)
  if (memoryForgetMatch) {
    const agentConfig = require('./agent/config').getAgentConfig()
    if (!agentConfig.memory?.enabled) return handled('Agent 记忆当前未开启。')
    if (agentConfig.memory?.adminOnly && !hasAdminPermission(session)) return handled('只有管理员能删除 Agent 长期记忆。')
    try {
      const removed = await require('./agent/memory').forgetMemory({ userId: currentUserId, memoryId: memoryForgetMatch[1] })
      return handled(removed ? '已删除这条记忆。' : '没有找到这条记忆。')
    } catch (err) {
      return handled(err.message || '记忆删除失败。')
    }
  }

  // === Agent 对话命令 ===
  const agentMatch = plain.match(/^莲莲\s*(?:工具|agent)\s+(.+)/i)
  if (agentMatch && !adminCommandMatched) {
    const query = agentMatch[1].trim()
    if (isJailbreakAttempt(sanitizeUserInput(query))) return handled(pickJailbreakFallbackReply())
    const engine = require('./agent/engine')
    const agentConfig = require('./agent/config').getAgentConfig()
    const agentQueue = require('./agent/queue')
    agentQueue.configureAgentQueue(agentConfig.queue || {})
    const userName = sanitizeUserName(
      session.author?.nick || session.author?.name || session.username || '群友'
    )
    try {
      const searchRunOptions = require('./agent/router').buildExplicitSearchRunOptions(query)
      const result = await agentQueue.enqueueAgentTask({
        channelKey,
        userId: currentUserId,
        timeoutMs: agentConfig.queue?.timeoutMs,
        fn: () => engine.run({
          userMessage: query, userName, userId: currentUserId, channelKey, channel: 'qq', bot: session.bot, ...searchRunOptions,
          onProgress: (msg) => {
            if (msg.type === 'round' && msg.round === 0) {
              // 首轮执行中，不额外输出
            }
          },
        }),
      })
      return handled(result.reply || '(Agent 未获取有效回复)')
    } catch (err) {
      if (err && (err.code === 'AGENT_QUEUE_FULL' || err.code === 'AGENT_QUEUE_REJECTED')) return handled(err.message)
      ctx.logger('dongxuelian-ai').warn(`agent engine failed: ${err.message}`)
      return handled('Agent 暂时不可用。')
    }
  }

  // === Agent 待确认处理 ===
  const confirmToolMatch = plain.match(/^(?:确认工具|y|Y)(?:\s+(pnd[0-9a-z]+))?$/i)
  if (confirmToolMatch) {
    const pendingId = confirmToolMatch[1] || ''
    const pending = require('./agent/pending')
    const findPendingById = pending.findPendingToolById || pending.getPendingToolById || (id => (pending.listPendingTools && pending.listPendingTools().find(item => item.id === id)) || null)
    const p = pendingId ? findPendingById(pendingId) : pending.getPendingTool(channelKey, currentUserId)
    if (p) {
      if (p.channelKey !== channelKey || p.userId !== currentUserId) return handled('这个确认 ID 不属于当前会话。')
      const engine = require('./agent/engine')
      const result = await engine.resumePending({ channelKey, userId: currentUserId, channel: 'qq', expectedId: pendingId, bot: session.bot })
      if (!result.ok && result.message) return handled(`执行失败：${result.message || result.error || '未知错误'}`)
      return handled(result.reply || '(Agent 未获取到有效回复)')
    }
    if (pendingId) return handled('没有匹配的待确认工具。')
  }

  return notHandled()
}

module.exports = { handleCommand }
