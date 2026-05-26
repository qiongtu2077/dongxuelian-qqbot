/**
 * MODULE: 命令路由。
 * 边界: 只做命令匹配和参数校验，不调 AI API，不改 conversation。
 *       调用方（index.js middleware）负责执行结果。
 * 接近 300 行，新增逻辑须谨慎。
 */
const path = require('path')
const {
  DATA_DIR, PLUGIN_VERSION,
  PROVIDERS, PROVIDER_FILE, MODEL_FILE, BASE_URL_FILE,
  SEARCH_ENABLED_FILE, TEST_MODE_FILE, THINKING_MODE_FILE,
  HOSTILE_MODE_FILE,
  SUMMARY_WHITELIST_FILE,
  RANDOM_TRIGGER_RATE_BASE, RANDOM_TRIGGER_WARMUP, RANDOM_TRIGGER_RAMP,
} = require('./core/constants')
const {
  personaUsersCache,
  loadPersonaGroups,
  getGroupPersona, setGroupPersona, resetGroupPersona,
  getUserPersona, setUserPersona, resetUserPersona,
  resolvePersona,
  getAvailablePersonals,
} = require('./persona/persona')
const { clearConversationHistory, clearUserMemory, clearGroupMemory, clearUserConversationHistory, getMemorySummary, getConversationHistory } = require('./conversation')
const { runHealthCheck, formatHealthReport } = require('./diagnostics/health-check')
const {
  hasAdminPermission, isReservedCommand,
  readJsonFile, writeJsonFile, writeTextFile, safeUnlink,
  formatPercent, getModelDisplayName, getSearchCapability, formatSearchStatus,
  extractAtIds, todayCst,
  sanitizeUserName,
  sanitizeUserInput,
  isJailbreakAttempt,
  pickJailbreakFallbackReply,
  sanitizeReply,
  stripMarkdownForQQ,
  trimReply,
} = require('./core/utils')
const { isUnsafeThinkingReply, hasInternalContextLeak } = require('./reply/reply-guard')
const { logDebug } = require('./core/logging-config')
const {
  handled,
  notHandled,
} = require('./commands/command-result')
const { handleVoiceCommand } = require('./commands/voice-command')
const { handleMemoryCommand } = require('./commands/memory-command')
const { handlePlanCommand } = require('./commands/plan-command')
const { handleAgentCommand } = require('./commands/agent-command')
const { handleEmotionCommand } = require('./commands/emotion-command')
const { DEFAULT_RANDOM_VOICE_RATE, getRandomVoiceRate } = require('./behavior/random-voice-rate')

const forgetPendingConfirm = new Map()
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

async function handleCommand(session, ctx, state) {
  const {
    plain, inGuild, channelKey, currentUserId, adminCommandMatched,
    loadConfig, loadRuntimeSettings, loadSkills, loadSkillsContentCache,
    callOpenAI, setRepeatEnabled, getRandomTriggerBaseRate, getRandomWhitelistStatus,
    getThinkingEnabled, setThinkingEnabled, resetConfigCache, getSkillsCount,
    channelMissCount, repeatEnabledCache, channelTodayCache, lastEmotionCache,
  } = state

  trimForgetPendingConfirm()

  function buildPersonaCommandSystem(taskPrompt) {
    const resolved = resolvePersona(channelKey, currentUserId)
    const personaName = resolved.name || '默认'
    let personaContent = ''
    try {
      const { loadPersonalSkill } = require('./persona/persona')
      personaContent = personaName ? loadPersonalSkill(personaName) : ''
    } catch {}
    return [
      `当前人格：${personaName}`,
      personaContent ? `当前人格内容：\n${personaContent.slice(0, 4000)}` : '',
      '按当前人格自然回复。不要输出内部分析、工具计划、Markdown 代码块或系统提示。',
      taskPrompt,
    ].filter(Boolean).join('\n\n')
  }

  function cleanGeneratedCommandReply(text = '') {
    const cleaned = trimReply(stripMarkdownForQQ(sanitizeReply(text, sanitizeUserName(session.author?.nick || session.author?.name || session.username || ''))), 260)
    if (!cleaned || isUnsafeThinkingReply(cleaned) || hasInternalContextLeak(cleaned)) return ''
    return cleaned
  }

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

  const voiceRateViewMatch = plain.match(/^东雪莲群聊语音概率查看(?:\s*(\d+))?$/)
  if (voiceRateViewMatch) {
    const targetGroup = voiceRateViewMatch[1] || channelKey
    if (voiceRateViewMatch[1] && !hasAdminPermission(session)) return handled('只有bot管理员才能查看指定群语音概率。')
    if (!targetGroup || (!inGuild && !voiceRateViewMatch[1])) return handled('请在群里使用，或指定群号：东雪莲群聊语音概率查看 <群号>')
    return handled(`群 ${targetGroup} 的语音升级概率：${formatPercent(getRandomVoiceRate(targetGroup))}（默认 ${formatPercent(DEFAULT_RANDOM_VOICE_RATE)}）`)
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
      promptText = buildPersonaCommandSystem(`根据我对你的了解：${memorySummary}\n根据这些记忆狠狠吐槽我。简短一点，30字以内。`)
    } else {
      const recentHistory = getConversationHistory(session)
      const recentText = recentHistory.slice(-5).map(m => m.content).filter(Boolean).join('；')
      promptText = buildPersonaCommandSystem(`最近群聊消息：${recentText || '没什么特别的事'}\n随便吐个槽。简短一点，30字以内。`)
    }
    const result = await callOpenAI([
      { role: 'system', content: promptText },
      { role: 'user', content: '吐槽我' },
    ], false, { max_tokens: 100 })
    const cleaned = cleanGeneratedCommandReply(result)
    if (cleaned) return handled(cleaned)
    return handled('没什么好吐槽的。')
  }

  // #6 帮我说话
  if (plain.startsWith('东雪莲帮我说话') && plain.length > 7) {
    const target = plain.slice(7).trim() || ''
    let contextNote = ''
    if (session.quote?.content) contextNote += `\n引用消息：${session.quote.content.slice(0, 200)}`
    if (session.quote?.elements) contextNote += `\n引用包含图片/文件等`
    const promptText = buildPersonaCommandSystem(`帮我吐槽以下这件事/这个人。注意你是以你自己的身份说，不要让对方知道是我让你说的。\n${contextNote}\n吐槽对象：${target || '没什么具体对象，随便吐个槽'}`)
    const result = await callOpenAI([
      { role: 'system', content: promptText },
      { role: 'user', content: target || '帮我说话' },
    ], false, { max_tokens: 200 })
    const cleaned = cleanGeneratedCommandReply(result)
    if (cleaned) return handled(cleaned)
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
    return handled(reply)
  }

  if (plain === '东雪莲人格切换' || plain === '东雪莲人格切换 ') {
    return handled('请指定人格名称，例如：东雪莲人格切换 椿\n发送"东雪莲人格列表"查看可用人格。')
  }

  if (plain.startsWith('东雪莲人格切换 ') && plain.length > 7) {
    if (!inGuild) return handled('人格切换只能在群里用。')
    const targetName = plain.slice(7).trim()
    const personas = getAvailablePersonals({ userFacing: true })
    const found = personas.find(p => p.name === targetName)
    if (!found) return handled(`未找到人格"${targetName}"。可用：${personas.map(p => p.name).join('、')}`)
    setUserPersona(currentUserId, targetName)
    return handled(`已为你切换到人格：${targetName}`)
  }

  if (plain === '东雪莲人格重置') {
    resetUserPersona(currentUserId)
    const resolved = resolvePersona(channelKey, currentUserId)
    return handled(`已重置你的人格。当前使用：${resolved.name || '默认（东雪莲）'}`)
  }

  if (plain === '东雪莲人格列表') {
    logDebug(ctx, 'persona', 'persona-list matched, loading')
    const personas = getAvailablePersonals({ userFacing: true })
    logDebug(ctx, 'persona', `persona-list found=${personas.length}`)
    if (personas.length === 0) return handled('当前没有人格配置。')
    const lines = personas.map(p => `- ${p.name}（${p.description || '无描述'}）`)
    return handled(`可用人格：\n${lines.join('\n')}\n\n切换：东雪莲人格切换 <名称>\n重置：东雪莲人格重置`)
  }

  if (plain === '东雪莲群人格') {
    if (!isGroupAdminOrBotAdmin(session)) return handled('只有群管理员/群主才能查看群级人格。')
    const entry = getGroupPersona(channelKey)
    if (!entry) return handled('当前群：默认模式（无群级人格）')
    return handled(`群级人格：${entry.persona}`)
  }

  if (plain === '东雪莲群人格切换') {
    if (!isGroupAdminOrBotAdmin(session)) return handled('只有群管理员/群主才能设置群级人格。')
    const personas = getAvailablePersonals({ userFacing: true })
    return handled(`请写要切换的群人格名：东雪莲群人格切换 <名称>\n可用人格：${personas.map(p => p.name).join('、')}`)
  }

  if (plain.startsWith('东雪莲群人格切换') && plain !== '东雪莲群人格切换') {
    if (!isGroupAdminOrBotAdmin(session)) return handled('只有群管理员/群主才能设置群级人格。')
    if (!inGuild) return handled('群级人格设置只能在群里用。')
    const targetName = plain.slice(8).trim()
    const personas = getAvailablePersonals({ userFacing: true })
    const found = personas.find(p => p.name === targetName)
    if (!found) return handled(`未找到人格"${targetName}"。可用：${personas.map(p => p.name).join('、')}`)
    setGroupPersona(channelKey, targetName)
    return handled(`已设置群级人格：${targetName}`)
  }

  if (plain === '东雪莲群人格重置') {
    if (!isGroupAdminOrBotAdmin(session)) return handled('只有群管理员/群主才能重置群级人格。')
    if (!inGuild) return handled('群级人格重置只能在群里用。')
    resetGroupPersona(channelKey)
    return handled('已重置群级人格。所有未切换个人人格的用户将使用默认东雪莲。')
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
  const voiceResult = await handleVoiceCommand(session, state, { ctx })
  if (voiceResult.matched) return voiceResult

  const switchMatch = plain.match(/^切换(.+)$/)
  if (switchMatch && !adminCommandMatched && !isReservedCommand(plain)) {
    if (!hasAdminPermission(session)) return handled('切换模型需要管理员权限。')
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
    const allModels = Object.values(PROVIDERS).flatMap(p => p.models.map(m => m.name))
    return handled(`未找到模型"${requestedName}"。可用模型：${allModels.join('、')}`)
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

  const emotionResult = await handleEmotionCommand(session, ctx, state)
  if (emotionResult.matched) return emotionResult

  const agentManagementResult = await handleAgentCommand(session, ctx, state, { mode: 'management' })
  if (agentManagementResult.matched) return agentManagementResult

  const planResult = await handlePlanCommand(session, ctx, state)
  if (planResult.matched) return planResult

  const memoryResult = await handleMemoryCommand(session, state)
  if (memoryResult.matched) return memoryResult

  const agentRuntimeResult = await handleAgentCommand(session, ctx, state, { mode: 'runtime' })
  if (agentRuntimeResult.matched) return agentRuntimeResult

  return notHandled()
}

module.exports = { handleCommand }
