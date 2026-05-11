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
} = require('./utils')
const { logDebug } = require('./logging-config')

const forgetPendingConfirm = new Map()
const EMOTION_IMAGE_TEXT_LIMIT = 1500
const EMOTION_FALLBACK_TEXT_LIMIT = 500

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

async function handleCommand(session, ctx, state) {
  const {
    plain, inGuild, channelKey, currentUserId, adminCommandMatched,
    loadConfig, loadRuntimeSettings, loadSkills, loadSkillsContentCache,
    callOpenAI, setRepeatEnabled, getRandomTriggerBaseRate, getRandomWhitelistStatus,
    getThinkingEnabled, setThinkingEnabled, resetConfigCache, getSkillsCount,
    channelMissCount, repeatEnabledCache, channelTodayCache, lastEmotionCache,
  } = state

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

  if (/^定位消息\s+(\d+)$/.test(plain)) {
    const targetIdx = parseInt(RegExp.$1, 10) - 1
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
    const ctx = cache.messages.slice(start, end).map((m, i) => {
      const prefix = start + i === cacheIdx ? '→ ' : '  '
      return `${prefix}${m.user || '群友'} ${m.time ? m.time.slice(0, 5) : ''}：${(m.content || '').replace(/【[^】]*】/g, '').trim().slice(0, 80)}`
    }).join('\n')
    return handled(`消息上下文（共${cache.messages.length}条）：\n\n${ctx}`)
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
    const value = plain.slice(7).trim()
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

    const batchSize = 100
    const batches = []
    for (let i = 0; i < msgs.length; i += batchSize) {
      const batch = msgs.slice(i, i + batchSize)
      const batchText = batch.map(m => `[${m.time}] ${m.user}：${m.content}`).join('\n')
      batches.push(callOpenAI([
        { role: 'system', content: '你是群聊消息摘要助手。将以下群聊记录压缩成一段100字以内的摘要，保留主要话题和情绪倾向。不要评价，只摘要。不得扩写，不得输出分析报告。' },
        { role: 'user', content: batchText.slice(0, 4000) },
      ], false, { _fallbackSet: 'lightweight' }).catch(() => ''))
    }
    const summaries = await Promise.all(batches)
    const allSummary = summaries.filter(Boolean).join('\n---\n') || msgs.slice(-80).map(m => `[${m.time}] ${m.user}：${m.content}`).join('\n').slice(0, 8000)

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

  return notHandled()
}

module.exports = { handleCommand }
