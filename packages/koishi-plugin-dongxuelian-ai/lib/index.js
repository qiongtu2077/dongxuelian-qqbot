/* ==========================================================================
 * 东雪莲 AI 插件 — 核心入口
 *
 * 拆分/修改前先阅读：
 *   - AI协作规则.md（架构红线、修改规范、测试规范）
 *   - 教训总结.md（代码拆分 5 步法、部署教训）
 *   - 测试文件维护指南.md（新增模块的 check/test 同步清单）
 *
 * 红线：
 *   1. 拆模块时先加后删，每步 node -c + npm run test:quick 验证
 *   2. 行为变更优先加 scenario，不要加源码字符串扫描
 *   3. 新模块只从 constants/utils/api/conversation/persona 导入，
 *      不反向 import index.js
 *   4. 非必要不要在此文件加职责，优先考虑独立模块
 *
 * ARCHITECTURE CONSTRAINT:
 * - 本文件是路由入口，职责：中间件编排 + apply() 注册 + 状态初始化。
 * - 禁止在此文件新增 Map/Set/全局缓存。新状态归属到对应子模块。
 * - 禁止在此文件直接调用 AI API 或低层 IO。统一走 api.js / utils.js。
 * - 新增函数超过 50 行 → 独立模块。
 * ========================================================================== */
const fs = require('fs/promises')
const path = require('path')
const satoriCore = require('@satorijs/core')
const KoishiSession = satoriCore.Session
const KoishiBot = satoriCore.Bot
const { handleCommand } = require('./handler') // 指令路由（/help /reset 等）
const { analyzeIncomingMessage, normalizeText } = require('./message-reader') // 消息解析（图片/语音/转发提取）+ 文本清洗
const { loadStickerCache, sendReply } = require('./reply') // 贴纸缓存加载 + 统一回复发送（含分段/重试）
const { resolveForwardSummary } = require('./forward') // 合并转发消息摘要提取
const { prepareVisionRequest, isVisionSession } = require('./vision') // 图片消息构建 + 视觉会话判断
const { storeImageUrl } = require('./image-store') // 图片 URL/文件持久化存储
const { enqueueAnalysis } = require('./image-analyzer') // 图片异步分析队列
const { storeFile, cacheFileLocally, setLocalPath } = require('./file-store') // 文件元数据持久化存储
const { checkFile, getExtension, sanitizeFileName, summarizeFileContentForChat } = require('./file-safety') // 文件安全检查
const { transcribeVoice } = require('./voice') // 语音转文字
const {
  classifySendError,          // 发送错误分类（限流/禁言/网络）
  sanitizeForRateLimit,       // 限流场景消息精简
  sleepForRateLimitRetry,     // 限流等待
  getCachedPlatformMuteStatus, // 平台禁言状态缓存读取
  markPlatformMute,           // 标记被禁言
  clearPlatformMute,          // 清除禁言标记
  checkPlatformMuteStatus,    // 主动检测禁言状态
} = require('./send-guard')


const {
  notifySensitiveHandlers,       // 触发敏感词时通知处理器
  handleSensitiveMessage,        // 敏感消息拦截主逻辑
} = require('./sensitive')
const { handleAdminInlineCommands } = require('./admin-commands') // 白名单/黑名单/概率/敏感等内联管理命令
const {
  loadRepeatConfig,       // 加载复读配置
  setRepeatEnabled,       // 设置复读开关
  getRepeatEnabledCache,  // 查询复读开关缓存
  buildRepeatCandidate,   // 构建复读候选（判断是否跟读）
  checkGroupRepeat,       // 群复读触发检测
} = require('./repeat')
const {
  chat,                   // 主聊天入口（session → AI 回复）
  loadSkills, loadSkillsContentCache, // 技能文件列表/内容加载
  callOpenAI,             // 底层 LLM 调用
  getSkillsCount,         // 已加载技能数量
} = require('./chat')
const {
  loadConfig, resetConfigCache,   // 运行时配置加载/刷新
  getThinkingEnabled, setThinkingEnabled, // thinking 模式开关
  getAdminUserIds, // 管理员权限判断
} = require('./runtime-config')
const {
  DATA_DIR, PLUGIN_VERSION,
  PERSONA_GROUPS_FILE, PERSONA_USERS_FILE, EVENT_DUMP_DIR,
  RANDOM_WHITELIST_FILE, RANDOM_RATE_FILE,
  MAINTENANCE_FILE,
  RANDOM_TRIGGER_RATE_BASE, RANDOM_TRIGGER_WARMUP, RANDOM_TRIGGER_RAMP,
  DEFAULT_GROUP_RANDOM_WHITELIST,
  MAX_CHANNEL_SHARED_MESSAGES,
  EVENT_DUMP_ARM_EXPIRE_MS,
  USER_BLACKLIST_FILE, TODAY_CACHE_PREFIX,
  THINKING_MODE_FILE,
  POLITICAL_DETECT_FILE, SENSITIVE_CACHE_PREFIX,
  CONVERSATIONS_DIR,
  NUMERIC_GROUP_ID_RE, SENSITIVE_KEYWORDS_RE,
} = require('./constants')
const {
  loadPersonaGroups,   // 加载人格-群组绑定配置
  getGroupPersona,     // 查询群级人格配置
  loadPersonaUsers,    // 加载人格-用户绑定配置
  resolvePersona,      // 解析当前会话应使用的人格
  loadPersonalSkill,   // 加载人格技能文件内容
} = require('./persona')
const {
  channelSharedCache,       // 频道共享消息缓存（群聊上下文窗口）
  channelTodayCache,        // 频道今日统计缓存
  getConversationKey,       // 用户会话唯一标识生成
  getChannelKey,            // 频道唯一标识生成
  saveSharedChannelTurn,    // 保存群聊共享消息轮次
  findChannelMessageById, collectReplyChain, // 消息查找 + 引用链收集
  getQuotedMessageNote, getSharedContextNote, // 引用/共享上下文注入文本
  analyzeChannelSensitive,  // 频道敏感消息分析
  trimChannelRuntimeCaches, cleanupDailyStatsFiles, // 运行时缓存裁剪 + 日统计文件清理
  getRecentUserMessages,     // 取最近用户消息，用于搜索追问补全
} = require('./conversation')
const {
  isReservedCommand,        // 判断是否为保留指令前缀
  getSenderUserId,          // 提取发送者 ID（兼容多平台）
  hasAdminPermission,       // 管理员权限判断
  stripMentions,            // 去除 @mention 标记
  collapseRepeatedBotCalls, // 折叠连续重复 @bot 调用
  sanitizeUserName,         // 昵称安全清洗
  extractAtIds,             // 提取消息中所有 @id
  isDirectAtBot, getBotMentionCount, hasOtherMentions, // @bot 检测
  isJailbreakAttempt,       // 越狱尝试检测
  sanitizeUserInput,        // 用户输入安全清洗
  pickJailbreakFallbackReply, // 越狱兜底回复
  readTextFile, readJsonFile, // 文件 IO 工具
  shouldTriggerRandom, calculateWillFactor, // 随机触发判断 + 意愿因子计算
  normalizeUrl, extractImageUrls, // URL 标准化 + 图片 URL 提取
  sanitizeFileToken, safeJsonStringify, // 文件 token 清洗 + 安全 JSON 序列化
  todayCst,                 // 获取当前 CST 日期字符串
} = require('./utils')
const { logDebug, isDebugLogEnabled } = require('./logging-config') // 调试日志输出
const { shouldTriggerRareVoice, readRareVoiceAudioBuffer } = require('./rare-voice') // 罕见触发固定语音
const {
  loadRandomVoiceRateCache,
  getRandomVoiceRate,
} = require('./random-voice-rate') // 群聊随机语音升级概率配置
const { heuristicRoute, buildExplicitSearchRunOptions, buildExplicitUrlFetchRunOptions } = require('./agent/router') // Agent 路由决策（启发式 + 显式搜索）
const { externalToolsDenied } = require('./external-tool-policy')
const agentEngine = require('./agent/engine') // Agent 执行引擎
const { enqueueAgentTask, configureAgentQueue } = require('./agent/queue') // Agent 任务队列
const { recordAgentChatResult, summarizeAgentToolResults } = require('./agent-chat-bridge') // Agent 结果写入普通对话历史
const { guardAgentRetellReply, redactAgentMaterial } = require('./agent-retell-guard') // Agent 复述守卫（防止照搬工具原文）
const {
  buildReplyTimingDiagnostic,
  formatReplyTimingDiagnostic,
} = require('./reply-timing') // 回复时机旁路诊断（只记录，不接管概率）
const {
  buildAffectRouterDiagnostic,
  formatAffectRouterDiagnostic,
} = require('./affect-router') // 情绪输出旁路诊断（只记录，不接管文本/语音/表情）
const {
  runExpressionHarvestForAllChannels,
  formatExpressionHarvestDiagnostic,
} = require('./expression-abstractor') // 表达学习每日 harvest（旁路；只写池，不改主链路）
const { buildAmbientWaterSendOptions } = require('./random-reply-mode') // 随机非锚定水群发送策略

// @satorijs/core@3.7.0 缺少 stripped / parsed / resolve / send，这里随插件加载安装兼容补丁。
function patchElementText(element) {
  if (!element) return ''
  if (typeof element === 'string') return element
  if (element.type === 'text') return String(element.attrs?.content || '')
  if (element.type === 'at') {
    const id = element.attrs?.id || element.attrs?.qq || element.attrs?.userId || element.attrs?.user_id || ''
    return id ? `<at id="${id}"/>` : ''
  }
  if (typeof element.toString === 'function' && element.toString !== Object.prototype.toString) {
    const text = String(element)
    return text === '[object Object]' ? '' : text
  }
  return ''
}

function patchElementsToText(elements) {
  return Array.isArray(elements) ? elements.map(element => patchElementText(element)).join('') : ''
}

function patchElementId(element) {
  return String(element?.attrs?.id || element?.attrs?.qq || element?.attrs?.userId || element?.attrs?.user_id || '')
}

function patchStripNickname(session, content) {
  const nicknames = session?.app?.koishi?.config?.nickname || session?.app?.config?.nickname || []
  const list = Array.isArray(nicknames) ? nicknames : [nicknames]
  let value = String(content || '')
  if (value.startsWith('@')) value = value.slice(1)
  for (const rawName of list) {
    const name = String(rawName || '')
    if (!name || !value.startsWith(name)) continue
    const rest = value.slice(name.length)
    const match = /^([,\uFF0C\u3001\s]+|$)/.exec(rest)
    if (!match) continue
    return rest.slice(match[0].length).trim()
  }
  return null
}

function patchBuildStripped(session) {
  if (session._stripped && typeof session._stripped === 'object') return session._stripped
  const source = Array.isArray(session.elements) ? session.elements : Array.isArray(session.event?.message?.elements) ? session.event.message.elements : []
  const elements = source.slice()
  let hasAt = false
  let appel = false
  let atSelf = false
  const selfId = String(session.selfId || session.bot?.selfId || session.event?.selfId || '')
  const quoteUserId = String(session.quote?.user?.id || '')
  while (elements[0]?.type === 'at') {
    const id = patchElementId(elements.shift())
    if (selfId && id === selfId) {
      atSelf = true
      appel = true
    }
    if (!quoteUserId || id !== quoteUserId) hasAt = true
    while (elements[0]?.type === 'text' && !String(elements[0].attrs?.content || '').trim()) elements.shift()
  }
  let content = patchElementsToText(elements).trim()
  if (!hasAt) {
    const stripped = patchStripNickname(session, content)
    if (stripped !== null) {
      appel = true
      content = stripped
    }
  }
  session._stripped = { hasAt, content, appel, atSelf, prefix: null }
  return session._stripped
}

function patchInstallAccessors(target) {
  if (!target || Object.prototype.hasOwnProperty.call(target, '__dongxuelianStrippedPatch')) return
  Object.defineProperty(target, 'stripped', {
    configurable: true,
    enumerable: false,
    get() { return patchBuildStripped(this) },
    set(value) { if (value && typeof value === 'object') this._stripped = value; else if (value === undefined) this._stripped = undefined },
  })
  Object.defineProperty(target, 'parsed', {
    configurable: true,
    enumerable: false,
    get() { return this.stripped },
    set(value) { this.stripped = value },
  })
  Object.defineProperty(target, '__dongxuelianStrippedPatch', { configurable: true, enumerable: false, value: true })
}

function patchEnsureSession(session) {
  if (!session || typeof session !== 'object') return session
  try { if (session.stripped !== undefined) return session } catch {}
  patchInstallAccessors(session)
  return session
}

patchInstallAccessors(KoishiSession && KoishiSession.prototype)

const originalSessionFactory = KoishiBot && KoishiBot.prototype && KoishiBot.prototype.session
if (originalSessionFactory && !originalSessionFactory.__dongxuelianPatched) {
  KoishiBot.prototype.session = function(event) {
    const session = originalSessionFactory.call(this, event)
    return patchEnsureSession(session)
  }
  KoishiBot.prototype.session.__dongxuelianPatched = true
}

if (KoishiSession && KoishiSession.prototype && !KoishiSession.prototype.resolve) {
  KoishiSession.prototype.resolve = function(value) {
    if (typeof value === 'function') return value(this)
    return value
  }
}

if (KoishiSession && KoishiSession.prototype && !KoishiSession.prototype.send) {
  KoishiSession.prototype.send = async function(content) {
    if (!this.bot || typeof this.bot.sendMessage !== 'function') {
      throw new Error('Bot not available for sending')
    }
    return this.bot.sendMessage(this.channelId, require('koishi').h.normalize(content), this.guildId)
  }
}

function resolveCurrentBot(ctx, fallbackBot = null, selfId = '') {
  const bots = Array.isArray(ctx?.bots) ? ctx.bots : []
  const targetSelfId = String(selfId || '')
  if (targetSelfId) {
    const matched = bots.find(bot => String(bot?.selfId || '') === targetSelfId)
    if (matched) return matched
  }
  return bots[0] || ctx?.bot || fallbackBot || null
}

function createBotResolver(ctx, session) {
  const selfId = String(session?.selfId || session?.bot?.selfId || session?.event?.selfId || '')
  const fallbackBot = session?.bot || null
  return () => resolveCurrentBot(ctx, fallbackBot, selfId)
}

function withCurrentBot(session, bot) {
  if (!session || !bot || session.bot === bot) return session
  const runtimeSession = Object.assign(Object.create(Object.getPrototypeOf(session) || Object.prototype), session)
  runtimeSession.bot = bot
  return patchEnsureSession(runtimeSession)
}

exports.name = 'dongxuelian-ai'

let runtimeSettingsLoaded = false
let runtimeSettingsFingerprint = ''
let randomWhitelistCache = new Set(DEFAULT_GROUP_RANDOM_WHITELIST)
let randomRateCache = new Map()
const channelQueues = new Map()
const channelQueueDepth = new Map()
const channelMissCount = new Map()
const armedEventDumpCache = new Map()
const channelMutedUntil = new Map()
const lastRandomReplyTs = new Map()
const channelPendingRandom = new Map()
const channelMessageVersions = new Map()
const channelExplicitVersions = new Map()
const MAX_RANDOM_CHANNEL_STATE_ENTRIES = 200

const sendFailState = {
  streak: 0,
  lastFailAt: 0,
  lastNotifyAt: 0,
  restrictedUntil: 0,
  maxStreak: 2,
  cooldownMs: 5 * 60 * 1000,
  restrictDurationMs: 60 * 60 * 1000,
  notifyIntervalMs: 30 * 1000,
  notifyScheduled: false,
}

let userBlacklistCache = null
let userBlacklistFingerprint = ''
const lastEmotionCache = new Map()

function restoreTodayCacheEntry(key, data) {
  if (!data || data.date !== todayCst() || !Array.isArray(data.messages) || data.messages.length <= 0) return
  channelTodayCache.set(key, { date: data.date, messages: data.messages.slice(-3000), updatedAt: Date.now() })
}

// 人格系统：per-group persona 配置
// 格式: { "channelKey": { persona: "name" | null } }

// 原子写入 JSON（先写临时文件再 rename，防并发损坏）

// 人格系统：per-user persona 配置
// 格式: { "userId": "personaName" }

// 计算最终 persona：用户级 > 群级 > 默认

const AGENT_RETELL_FALLBACK = '我查到了点东西，但刚刚没组织好，换个问法。'

function normalizeChatResultText(chatResult, fallback = '') {
  if (typeof chatResult === 'string') return chatResult
  if (chatResult && typeof chatResult === 'object') return chatResult.text || fallback
  return chatResult || fallback
}

async function retellAgentResult(agentResult, { ctx, session, channelKey, currentUserId, userName, userText, randomTriggered, emptyText = '(未获取有效回复)' }) {
  const safeAgentResult = {
    ...agentResult,
    reply: redactAgentMaterial(agentResult?.reply || ''),
    toolResults: Array.isArray(agentResult?.toolResults)
      ? agentResult.toolResults.map(item => ({ ...item, result: redactAgentMaterial(item?.result || '') }))
      : [],
  }
  const agentReplyText = String(safeAgentResult.reply || '').trim() || emptyText
  const toolSummary = summarizeAgentToolResults(safeAgentResult.toolResults || [])
  const agentMaterial = toolSummary
    ? `${agentReplyText}\n\n[工具摘要]\n${toolSummary}`
    : agentReplyText
  try {
    const chatReply = await chat(session, userText, ctx, {
      randomTriggered,
      isAgentResult: true,
      agentResultText: agentMaterial,
    })
    const rawFinalReply = normalizeChatResultText(chatReply, AGENT_RETELL_FALLBACK).trim() || AGENT_RETELL_FALLBACK
    const finalReply = redactAgentMaterial(guardAgentRetellReply(rawFinalReply, safeAgentResult, {
      searchFailureFallback: rawFinalReply,
    }))
    recordAgentChatResult({ session: null, userMessage: userText, userName, userId: currentUserId, channelKey, agentResult: { ...safeAgentResult, reply: finalReply } })
    return finalReply
  } catch (error) {
    ctx.logger('dongxuelian-ai').warn(`agent result retell failed: ${error.message}`)
    return AGENT_RETELL_FALLBACK
  }
}

async function handleChatResult(chatResult, { ctx, session, channelKey, currentUserId, userName, userText, randomTriggered, resolveBot = null }) {
  const getBot = typeof resolveBot === 'function' ? resolveBot : createBotResolver(ctx, session)
  if (chatResult && typeof chatResult === 'object' && chatResult.heavyToolsRequested) {
    if (externalToolsDenied(userText)) return normalizeChatResultText(chatResult)
    const agentConfig = require('./agent/config').getAgentConfig()
    configureAgentQueue(agentConfig.queue || {})
    const explicitFetchOptions = buildExplicitUrlFetchRunOptions(userText)
    const webSearchRequests = chatResult.heavyToolsRequested
      .filter(t => t.name === 'web_search')
      .map(t => ({
        name: 'web_search',
        args: {
          query: String(t.args?.query || userText).trim() || userText,
          ...(Array.isArray(t.args?.queries) ? { queries: t.args.queries } : {}),
        },
      }))
    const webFetchRequests = chatResult.heavyToolsRequested
      .filter(t => t.name === 'web_fetch' && t.args?.url)
      .map(t => ({
        name: 'web_fetch',
        args: {
          url: String(t.args.url || '').trim(),
          ...(t.args.maxChars ? { maxChars: t.args.maxChars } : {}),
        },
      }))
      .filter(t => t.args.url)
    const recentUserMessages = getRecentUserMessages(session, 4)
    const searchQuery = webSearchRequests[0]?.args?.query || userText
    const searchRunOptions = explicitFetchOptions.forceTools ? explicitFetchOptions : buildExplicitSearchRunOptions(searchQuery, { recentUserMessages })
    if (webSearchRequests.length) {
      searchRunOptions.forceTools = Array.from(new Set([...(searchRunOptions.forceTools || []), 'web_search']))
      const existingSearchPreExec = (searchRunOptions.preExecuteTools || []).filter(item => item?.name === 'web_search')
      searchRunOptions.preExecuteTools = [...(searchRunOptions.preExecuteTools || []), ...webSearchRequests.slice(existingSearchPreExec.length, 2)]
      searchRunOptions.systemExtra = [
        ...(searchRunOptions.systemExtra || []),
        { role: 'system', content: '聊天模型已判断当前问题需要 web_search。已预执行搜索工具；必须基于工具结果回答。若结果是 weak_hit、未打开正文或无可靠来源，只能说明搜索没拿到可靠依据，并建议可继续换关键词。' },
      ]
    }
    if (webFetchRequests.length) {
      searchRunOptions.forceTools = Array.from(new Set([...(searchRunOptions.forceTools || []), 'web_fetch']))
      searchRunOptions.preExecuteTools = [...(searchRunOptions.preExecuteTools || []), ...webFetchRequests.slice(0, 2)]
      searchRunOptions.systemExtra = [
        ...(searchRunOptions.systemExtra || []),
        { role: 'system', content: '聊天模型已判断当前问题需要 web_fetch。已预执行网页读取工具；必须基于读取到的正文回答。只有“正文质量：usable”的正文可作为主要依据；失败、正文过短、非文本页面或拒绝访问时不要猜网页内容。' },
      ]
    }
    try {
      const agentResult = await enqueueAgentTask({
        channelKey,
        userId: currentUserId,
        timeoutMs: agentConfig.queue?.timeoutMs,
        fn: () => agentEngine.run({ userMessage: searchRunOptions.agentUserMessage || userText, userName, userId: currentUserId, channelKey, channel: 'qq', bot: getBot(), agentMode: true, ...searchRunOptions }),
      })
      return retellAgentResult(agentResult, { ctx, session, channelKey, currentUserId, userName, userText, randomTriggered, emptyText: '(搜索未获取有效结果)' })
    } catch (error) {
      const code = error && error.code ? String(error.code) : ''
      if (code === 'AGENT_QUEUE_FULL' || code === 'AGENT_QUEUE_REJECTED') return error.message
      ctx.logger('dongxuelian-ai').warn(`chat heavy-tool agent failed: ${error.message}`)
      return 'Agent 暂时不可用。'
    }
  }
  return normalizeChatResultText(chatResult)
}

function enqueueForChannel(channelKey, fn, maxDepth) {
  const existing = channelQueues.get(channelKey) || Promise.resolve()
  const next = existing
    .then(() => {
      const depth = channelQueueDepth.get(channelKey) || 0
      if (depth >= maxDepth) return
      channelQueueDepth.set(channelKey, depth + 1)
      let timeoutHandle
      const timeoutPromise = new Promise((_, reject) => { timeoutHandle = setTimeout(() => reject(new Error('queue timeout (60s)')), 60000) })
      return Promise.race([fn(), timeoutPromise]).finally(() => clearTimeout(timeoutHandle))
    })
    .catch(() => {})
    .then(() => {
      const d = channelQueueDepth.get(channelKey) || 1
      if (d <= 1) channelQueueDepth.delete(channelKey)
      else channelQueueDepth.set(channelKey, d - 1)
      if (channelQueues.get(channelKey) === next) channelQueues.delete(channelKey)
    })
  channelQueues.set(channelKey, next)
}

function getRandomTriggerRate(channelKey) {
  const baseRate = getRandomTriggerBaseRate(channelKey)
  if (!baseRate || baseRate <= 0) return 0
  const miss = channelMissCount.get(channelKey) || 0
  if (miss < RANDOM_TRIGGER_WARMUP) return baseRate
  return baseRate + (miss - RANDOM_TRIGGER_WARMUP) * RANDOM_TRIGGER_RAMP
}

// 输入净化：移除常见 prompt injection 结构标签，防止角色标签注入（PCFI 思路）

// 昵称净化：剔除游戏前缀、书名号、各类括号等特殊字符，限制长度防止昵称内容污染回复

function getRandomTriggerBaseRate(channelKey) {
  const key = String(channelKey || '')
  return randomRateCache.has(key) ? randomRateCache.get(key) : RANDOM_TRIGGER_RATE_BASE
}

// 白名单为空时视为全群禁用主动回复，只有显式加入的群才允许触发。
function getRandomWhitelistStatus(channelKey) {
  return randomWhitelistCache.has(String(channelKey || ''))
}

function getChannelMessageVersion(channelKey) {
  return channelMessageVersions.get(String(channelKey || '')) || 0
}

function bumpChannelMessageVersion(channelKey) {
  const key = String(channelKey || '')
  if (!key || key === 'private') return getChannelMessageVersion(key)
  const next = getChannelMessageVersion(key) + 1
  channelMessageVersions.set(key, next)
  trimRandomChannelState()
  return next
}

function getExplicitInteractionVersion(channelKey) {
  return channelExplicitVersions.get(String(channelKey || '')) || 0
}

function bumpExplicitInteractionVersion(channelKey) {
  const key = String(channelKey || '')
  if (!key || key === 'private') return getExplicitInteractionVersion(key)
  const next = getExplicitInteractionVersion(key) + 1
  channelExplicitVersions.set(key, next)
  trimRandomChannelState()
  return next
}

function trimRandomChannelState() {
  if (channelMessageVersions.size <= MAX_RANDOM_CHANNEL_STATE_ENTRIES) return
  for (const key of channelMessageVersions.keys()) {
    if (channelMessageVersions.size <= MAX_RANDOM_CHANNEL_STATE_ENTRIES) break
    if (channelPendingRandom.has(key)) continue
    channelMessageVersions.delete(key)
    channelExplicitVersions.delete(key)
  }
}

function cancelPendingRandom(channelKey, reason = '') {
  const key = String(channelKey || '')
  const pending = channelPendingRandom.get(key)
  if (!pending) return false
  if (pending.timer) clearTimeout(pending.timer)
  channelPendingRandom.delete(key)
  return true
}

function getGroupPersonaName(channelKey) {
  const entry = getGroupPersona(channelKey)
  return entry && entry.persona ? String(entry.persona) : ''
}

function isPersonaSwitchRisky(personaResolution, groupPersonaName) {
  return !!(
    personaResolution &&
    personaResolution.source === 'user' &&
    personaResolution.name &&
    String(personaResolution.name) !== String(groupPersonaName || '')
  )
}

function buildRandomSendOptions(context = {}) {
  if (!context.randomTriggered) return {}
  const channelKey = String(context.channelKey || '')
  const triggerVersion = Number(context.triggerMessageVersion || 0)
  const explicitVersion = Number(context.explicitVersion || 0)
  const triggerAt = Number(context.triggerAt || 0)
  return {
    randomFreshness: {
      channelKey,
      triggerMessageVersion: triggerVersion,
      explicitVersion,
      triggerAt,
    },
    ...(context.highRisk && context.triggerMessageId && (context.delayed || Number(context.currentMessageVersion || 0) > triggerVersion)
      ? { forceQuote: true, quoteMessageId: String(context.triggerMessageId) }
      : {}),
  }
}

function isRandomReplyFresh(options = {}) {
  const info = options.randomFreshness || null
  if (!info || !info.channelKey) return true
  const channelKey = String(info.channelKey)
  const triggerVersion = Number(info.triggerMessageVersion || 0)
  const explicitVersion = Number(info.explicitVersion || 0)
  const triggerAt = Number(info.triggerAt || 0)
  if (triggerAt > 0 && Date.now() - triggerAt > 60000) return false
  if (getExplicitInteractionVersion(channelKey) !== explicitVersion) return false
  if (getChannelMessageVersion(channelKey) !== triggerVersion) return false
  return true
}

function logStaleRandomSkip(ctx, stage, options = {}) {
  try {
    const info = options.randomFreshness || {}
    ctx.logger('dongxuelian-ai').info(`random reply stale skipped at ${stage}: channel=${info.channelKey || ''}`)
  } catch {}
}

async function safeSendRepeat(ctx, session, reply) {
  try {
    await session.send(reply)
    return true
  } catch (error) {
    const classified = classifySendError(error)
    if (classified.type === 'muted') {
      markPlatformMute(session, { reason: classified.reason })
      ctx.logger('dongxuelian-ai').warn(`repeat send muted: ${classified.message.slice(0, 120)}`)
      return false
    }
    if (classified.type === 'rate-limit') {
      ctx.logger('dongxuelian-ai').warn(`repeat send rate-limited: ${classified.message.slice(0, 120)}`)
      return false
    }
    ctx.logger('dongxuelian-ai').warn(`repeat send failed: ${classified.message.slice(0, 120)}`)
    return false
  }
}

function resolveSharedRecordText(plain, analyzed = {}) {
  const text = normalizeText(stripMentions(plain || analyzed.memory || analyzed.plain || ''))
  if (text) return text
  if (analyzed.hasAudio) return '[语音]'
  if (analyzed.hasMessageRecordCue) return normalizeText(analyzed.plain || '')
  return ''
}

function logReplyTimingDiagnostic(ctx, input = {}) {
  try {
    const diagnostic = buildReplyTimingDiagnostic(input)
    logDebug(ctx, 'reply-timing', formatReplyTimingDiagnostic(diagnostic))
    return diagnostic
  } catch (error) {
    logDebug(ctx, 'reply-timing', `diagnostic_failed ${error && error.message ? error.message : String(error)}`)
    return null
  }
}

function logAffectRouterDiagnostic(ctx, input = {}) {
  if (!isDebugLogEnabled('affect-router')) return null
  try {
    const diagnostic = buildAffectRouterDiagnostic({
      ...input,
      randomVoiceRate: input.randomVoiceRate === undefined && input.channelKey ? getRandomVoiceRate(input.channelKey) : input.randomVoiceRate,
    })
    logDebug(ctx, 'affect-router', formatAffectRouterDiagnostic(diagnostic))
    return diagnostic
  } catch (error) {
    logDebug(ctx, 'affect-router', `diagnostic_failed ${error && error.message ? error.message : String(error)}`)
    return null
  }
}

function getNextShanghaiMidnightDelayMs(now = Date.now()) {
  const [year, month, day] = todayCst(new Date(now)).split('-').map(Number)
  const nextMidnightUtc = Date.UTC(year, month - 1, day, 16, 0, 0, 0)
  return Math.max(1000, nextMidnightUtc - now)
}

let dailyCleanupTimer = null
let expressionHarvestTimer = null

function scheduleDailyStatsCleanup(ctx) {
  const runDailyStatsCleanup = async () => {
    try {
      const result = await cleanupDailyStatsFiles()
      trimChannelRuntimeCaches()
      logDebug(ctx, 'cleanup', `daily stats cleanup removed=${result.removed} compacted=${result.compacted}`)
    } catch (error) {
      ctx.logger('dongxuelian-ai').warn(`daily stats cleanup failed: ${error.message}`)
    } finally {
      dailyCleanupTimer = setTimeout(runDailyStatsCleanup, getNextShanghaiMidnightDelayMs())
      if (dailyCleanupTimer && typeof dailyCleanupTimer.unref === 'function') dailyCleanupTimer.unref()
    }
  }
  dailyCleanupTimer = setTimeout(runDailyStatsCleanup, getNextShanghaiMidnightDelayMs())
  if (dailyCleanupTimer && typeof dailyCleanupTimer.unref === 'function') dailyCleanupTimer.unref()
}

function getExpressionHarvestDelayMs(now = Date.now()) {
  const fiveMinutesMs = 5 * 60 * 1000
  const delayUntilNextMidnight = getNextShanghaiMidnightDelayMs(now)
  if (delayUntilNextMidnight > fiveMinutesMs) return delayUntilNextMidnight - fiveMinutesMs
  return delayUntilNextMidnight + (24 * 60 * 60 * 1000) - fiveMinutesMs
}

function scheduleExpressionHarvest(ctx) {
  const runExpressionHarvestTick = async () => {
    try {
      const result = await runExpressionHarvestForAllChannels(ctx)
      logDebug(ctx, 'expression-pool', formatExpressionHarvestDiagnostic(result))
    } catch (error) {
      ctx.logger('dongxuelian-ai').warn(`expression harvest failed: ${error.message}`)
    } finally {
      expressionHarvestTimer = setTimeout(runExpressionHarvestTick, getExpressionHarvestDelayMs())
      if (expressionHarvestTimer && typeof expressionHarvestTimer.unref === 'function') expressionHarvestTimer.unref()
    }
  }
  expressionHarvestTimer = setTimeout(runExpressionHarvestTick, getExpressionHarvestDelayMs())
  if (expressionHarvestTimer && typeof expressionHarvestTimer.unref === 'function') expressionHarvestTimer.unref()
}

// --- 原始事件抓取 --- //

// 清理过期的一次性抓取状态，避免命令挂太久。
function getArmedEventDump(channelKey = '') {
  const key = String(channelKey || '')
  const state = armedEventDumpCache.get(key)
  if (!state) return null
  if (Date.now() - state.armedAt > EVENT_DUMP_ARM_EXPIRE_MS) {
    armedEventDumpCache.delete(key)
    return null
  }
  return state
}

// 开启当前频道的下一条事件抓取。
function armEventDump(session) {
  const channelKey = getChannelKey(session)
  const state = {
    armedAt: Date.now(),
    armedBy: getSenderUserId(session),
  }
  armedEventDumpCache.set(channelKey, state)
  return state
}

// 取消当前频道的下一条事件抓取。
function clearArmedEventDump(channelKey = '') {
  armedEventDumpCache.delete(String(channelKey || ''))
}

function cacheSmallFileBackground(channelKey, messageId, url, ext) {
  const { downloadFile } = require('./file-analyzer')
  const { FILE_CACHE_DIR } = require('./file-store')
  const fsp = require('fs/promises')
  const safeChannel = String(channelKey).replace(/[^a-zA-Z0-9.:_-]/g, '_')
  const safeId = String(messageId).replace(/[^a-zA-Z0-9_-]/g, '_')
  const cacheDir = path.join(FILE_CACHE_DIR, safeChannel)
  const destFile = path.join(cacheDir, `${safeId}.${ext || 'bin'}`)
  fsp.mkdir(cacheDir, { recursive: true })
    .then(() => downloadFile(url, destFile))
    .then((savedPath) => setLocalPath(channelKey, messageId, savedPath))
    .then(() => fsp.readdir(cacheDir))
    .then(async (names) => {
      if (names.length <= 10) return
      const entries = []
      for (const n of names) {
        try { const s = await fsp.stat(path.join(cacheDir, n)); entries.push({ name: n, mtimeMs: s.mtimeMs }) } catch {}
      }
      entries.sort((a, b) => a.mtimeMs - b.mtimeMs)
      for (const e of entries.slice(0, entries.length - 10)) {
        try { await fsp.unlink(path.join(cacheDir, e.name)) } catch {}
      }
    })
    .catch(() => {})
}

function decodeEntityAttribute(value = '') {
  return String(value || '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
}

function extractAttrValue(tag = '', name = '') {
  const re = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i')
  const match = String(tag || '').match(re)
  return match ? decodeEntityAttribute(match[1] || match[2] || match[3] || '') : ''
}

function extractImageRefFromContent(content = '') {
  const value = String(content || '')
  const cq = value.match(/\[CQ:(?:image|img),([^\]]+)\]/i)
  if (cq) {
    const body = cq[1] || ''
    const url = extractAttrValue(body, 'url')
    const file = extractAttrValue(body, 'file')
    if (url || file) return { url, file }
  }
  const tag = value.match(/<(?:img|image)\b[^>]*>/i)
  if (tag) {
    const raw = tag[0]
    const src = extractAttrValue(raw, 'src') || extractAttrValue(raw, 'url')
    const file = extractAttrValue(raw, 'file')
    if (/^https?:\/\//i.test(src)) return { url: src, file }
    if (/^file:\/\//i.test(src)) return { url: '', file: src }
    if (src) return { url: '', file: src }
    if (file) return { url: '', file }
  }
  const urls = extractImageUrls(value)
  if (urls[0]) return { url: urls[0], file: '' }
  return { url: '', file: '' }
}

// 生成安全文件名，避免把群号和消息号直接拼出非法路径。

// 安全序列化复杂对象，避免循环引用或 bigint 把抓取过程搞挂。

// 把当前会话的原始 event 和解析结果落盘，供后续精修消息记录解析。
async function dumpSessionEvent(session, analyzed, plain, memoryText) {
  const now = new Date()
  const dateStamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`
  const timeStamp = `${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}${String(now.getSeconds()).padStart(2, '0')}`
  const channelToken = sanitizeFileToken(getChannelKey(session))
  const messageToken = sanitizeFileToken(session.messageId || 'no-message-id')
  const fileName = `ai-event-${dateStamp}-${timeStamp}-${channelToken}-${messageToken}.json`
  const filePath = path.join(EVENT_DUMP_DIR, fileName)

  const payload = {
    capturedAt: now.toISOString(),
    analyzed,
    session: {
      platform: session.platform,
      type: session.type,
      subtype: session.subtype,
      selfId: session.selfId,
      userId: session.userId,
      channelId: session.channelId,
      guildId: session.guildId,
      messageId: session.messageId,
      content: session.content,
      plain,
      memoryText,
      author: session.author,
      quote: session.quote,
      event: session.event,
    },
  }

  await fs.mkdir(EVENT_DUMP_DIR, { recursive: true })
  await fs.writeFile(filePath, safeJsonStringify(payload), 'utf8')
  return filePath
}

// --- 联网搜索 --- //

// 解析接口域名，统一给联网能力判断使用。

// 判断是否为 DashScope / 百炼的 OpenAI 兼容接口。

// 判断是否为 OpenAI 官方接口。

// 根据模型 ID 查找显示名称
// 从消息内容中提取图片 URL

// 根据模型 ID/Name 查找显示名称

// 汇总当前接口的联网搜索能力，避免命令提示和请求逻辑各写一套判断。

// 生成联网状态文本，给命令输出和状态页复用。

async function getFileFingerprint(filePath) {
  try {
    const stat = await fs.stat(filePath)
    return `${stat.mtimeMs}:${stat.size}`
  } catch {
    return 'missing'
  }
}

async function getRuntimeSettingsFingerprint() {
  const [whitelistStamp, rateStamp] = await Promise.all([
    getFileFingerprint(RANDOM_WHITELIST_FILE),
    getFileFingerprint(RANDOM_RATE_FILE),
  ])
  return `${whitelistStamp}|${rateStamp}`
}

async function loadRuntimeSettings(force = false) {
  const fingerprint = await getRuntimeSettingsFingerprint()
  if (!force && runtimeSettingsLoaded && fingerprint === runtimeSettingsFingerprint) return

  const [whitelist, rateMap] = await Promise.all([
    readJsonFile(RANDOM_WHITELIST_FILE, [...DEFAULT_GROUP_RANDOM_WHITELIST]),
    readJsonFile(RANDOM_RATE_FILE, {}),
  ])

  randomWhitelistCache = new Set(
    Array.isArray(whitelist)
      ? whitelist.map(item => String(item || '').trim()).filter(item => NUMERIC_GROUP_ID_RE.test(item))
      : [...DEFAULT_GROUP_RANDOM_WHITELIST]
  )

  const nextRateMap = new Map()
  if (rateMap && typeof rateMap === 'object') {
    for (const [channelId, rawRate] of Object.entries(rateMap)) {
      const normalizedId = String(channelId || '').trim()
      const numericRate = Number(rawRate)
      if (!NUMERIC_GROUP_ID_RE.test(normalizedId)) continue
      if (!Number.isFinite(numericRate) || numericRate < 0 || numericRate > 1) continue
      nextRateMap.set(normalizedId, numericRate)
    }
  }
  randomRateCache = nextRateMap
  runtimeSettingsLoaded = true
  runtimeSettingsFingerprint = fingerprint
}

async function loadUserBlacklist(force = false) {
  const fingerprint = await getFileFingerprint(USER_BLACKLIST_FILE)
  if (!force && userBlacklistCache !== null && fingerprint === userBlacklistFingerprint) return userBlacklistCache

  const raw = await readJsonFile(USER_BLACKLIST_FILE, [])
  userBlacklistCache = new Set(Array.isArray(raw) ? raw.map(String) : [])
  userBlacklistFingerprint = fingerprint
  return userBlacklistCache
}

async function notifyAdminsSendFailure(ctx, bot) {
  const admins = getAdminUserIds(true)
  const msg = '⚠️ 连续发送失败，已进入消息受限状态'
  await Promise.allSettled(
    [...admins].map(async (id) => {
      try {
        if (typeof bot?.sendPrivateMessage === 'function') {
          await bot.sendPrivateMessage(id, msg)
        } else if (bot?.internal?.sendPrivateMsg) {
          await bot.internal.sendPrivateMsg(id, msg)
        }
      } catch (error) {
        ctx.logger('dongxuelian-ai').warn('notify admin send failure: ' + error.message)
      }
    })
  )
}

function resetSendFailState() {
  sendFailState.streak = 0
  sendFailState.lastFailAt = 0
}

function logPlatformMute(ctx, status, prefix = 'safeSendReply') {
  const until = status?.until ? new Date(status.until).toISOString() : 'unknown'
  ctx.logger('dongxuelian-ai').warn(`${prefix}: platform muted, skipping reply (${status?.reason || '平台禁言'}, until=${until})`)
}

async function handleRateLimitedSendFailure(ctx, session, error, now, resolveBot = null) {
  const getBot = typeof resolveBot === 'function' ? resolveBot : createBotResolver(ctx, session)
  sendFailState.streak++
  sendFailState.lastFailAt = now
  ctx.logger('dongxuelian-ai').error(`safeSendReply: rate limited (streak=${sendFailState.streak}): ${error.message}`)
  if (sendFailState.streak <= 2) {
    sendFailState.lastNotifyAt = now
    notifyAdminsSendFailure(ctx, getBot()).catch(() => {})
  } else if (now - sendFailState.lastNotifyAt > sendFailState.notifyIntervalMs) {
    sendFailState.lastNotifyAt = now
    notifyAdminsSendFailure(ctx, getBot()).catch(() => {})
  }
  if (sendFailState.streak >= sendFailState.maxStreak) {
    if (now >= sendFailState.restrictedUntil) {
      sendFailState.restrictedUntil = now + sendFailState.restrictDurationMs
      ctx.logger('dongxuelian-ai').warn(`safeSendReply: restricted for 1 hour due to ${sendFailState.streak} consecutive rate-limit failures`)
    }
    if (!sendFailState.notifyScheduled) {
      sendFailState.notifyScheduled = true
      setTimeout(function() {
        const bot = getBot()
        const admins = getAdminUserIds(true)
        const unlockMsg = '🔓 30 分钟已过，风控可能已解除。BOT 冻结期还剩约 30 分钟，届时自动恢复。急需使用可重启 BOT。'
        Promise.allSettled([...admins].map(function(id) {
          try {
            if (typeof bot?.sendPrivateMessage === 'function') {
              return bot.sendPrivateMessage(id, unlockMsg)
            }
          } catch {}
        }))
      }, 30 * 60 * 1000)
    }
  }
}

async function safeSendReply(ctx, session, reply, isRandom = false, resolveBot = null, sendOptions = {}) {
  if (isRandom && !isRandomReplyFresh(sendOptions)) {
    logStaleRandomSkip(ctx, 'text', sendOptions)
    return
  }
  const now = Date.now()
  // 冻结到期后重置通知标记
  if (now >= sendFailState.restrictedUntil && sendFailState.notifyScheduled) {
    sendFailState.notifyScheduled = false
  }
  if (sendFailState.streak > 0 && now - sendFailState.lastFailAt > sendFailState.cooldownMs) {
    sendFailState.streak = 0
  }
  if (now < sendFailState.restrictedUntil) {
    if (!hasAdminPermission(session)) {
      if (!isDirectAtBot(session)) {
        ctx.logger('dongxuelian-ai').warn('safeSendReply: restricted, skipping reply')
        return
      }
      try {
        return await session.send('我被盯上了，有内鬼终止交易')
      } catch (error) {
        ctx.logger('dongxuelian-ai').error(`safeSendReply: restricted notice failed: ${error.message}`)
        return
      }
    }
  }
  const cachedMute = getCachedPlatformMuteStatus(session, now)
  if (cachedMute.muted) {
    logPlatformMute(ctx, cachedMute)
    return
  }
  const activeMute = await checkPlatformMuteStatus(session)
  if (activeMute.muted) {
    const marked = markPlatformMute(session, activeMute)
    logPlatformMute(ctx, marked)
    return
  }

  let currentReply = reply
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const sentCount = await sendReply(ctx, session, currentReply, isRandom, sendOptions)
      if (sentCount > 0) {
        resetSendFailState()
        clearPlatformMute(session)
      }
      return
    } catch (error) {
      const classified = classifySendError(error)
      if (classified.type === 'muted') {
        const marked = markPlatformMute(session, { reason: classified.reason })
        logPlatformMute(ctx, marked, 'safeSendReply: send error')
        return
      }
      if (classified.type !== 'rate-limit') {
        ctx.logger('dongxuelian-ai').warn(`safeSendReply: non-rate-limit error skipped: ${classified.message.slice(0, 120)}`)
        throw error
      }
      if (attempt === 0 && Number(error?.sentParts || 0) === 0) {
        const cleaned = sanitizeForRateLimit(currentReply)
        currentReply = cleaned || currentReply
        ctx.logger('dongxuelian-ai').warn('safeSendReply: rate limited, retrying once with sanitized content')
        await sleepForRateLimitRetry(ctx, attempt)
        continue
      }
      await handleRateLimitedSendFailure(ctx, session, error, Date.now(), resolveBot)
      throw error
    }
  }
}

/** 尝试发送罕见固定语音；失败时返回 false 交给文字回复回退。 */
async function safeSendRareVoice(ctx, session) {
  try {
    const { sendVoiceMessage } = require('./tts')
    const audioBuf = await readRareVoiceAudioBuffer()
    if (!audioBuf) {
      try { ctx.logger('dongxuelian-ai').warn('safeSendRareVoice skipped: rare voice audio unavailable') } catch {}
      return false
    }
    const sent = await sendVoiceMessage(session, audioBuf)
    if (!sent) {
      try { ctx.logger('dongxuelian-ai').warn('safeSendRareVoice skipped: sendVoiceMessage returned false') } catch {}
    }
    return sent
  } catch (error) {
    try {
      ctx.logger('dongxuelian-ai').warn(`safeSendRareVoice failed: ${error.message || error}`)
    } catch {}
    return false
  }
}

exports.buildRepeatCandidate = buildRepeatCandidate
exports.checkGroupRepeat = checkGroupRepeat

exports.apply = (ctx) => {
  ctx.on('ready', async () => {
    await loadRuntimeSettings(true)
    await loadConfig(true)
    await loadSkills()
    await loadSkillsContentCache()
    setThinkingEnabled((await readTextFile(THINKING_MODE_FILE).catch(() => '')).trim() === 'on')
    loadStickerCache()
    loadPersonaGroups()
    loadRepeatConfig()
    loadPersonaUsers()
    await loadRandomVoiceRateCache()
    // 恢复今日情绪磁盘缓存
    try {
      const files = require('fs').readdirSync(DATA_DIR).filter(f => f.startsWith('today-cache-') && f.endsWith('.json'))
      const today = todayCst()
      for (const f of files) {
        try {
          const raw = require('fs').readFileSync(path.join(DATA_DIR, f), 'utf8')
          const data = JSON.parse(raw)
          if (data && data.date === today && Array.isArray(data.messages) && data.messages.length > 0) {
            const key = f.replace('today-cache-', '').replace('.json', '')
            restoreTodayCacheEntry(key, data)
          }
        } catch {}
      }
    } catch {}
    trimChannelRuntimeCaches()
    cleanupDailyStatsFiles().catch(error => ctx.logger('dongxuelian-ai').warn(`daily stats cleanup failed: ${error.message}`))
    scheduleDailyStatsCleanup(ctx)
    scheduleExpressionHarvest(ctx)
    try {
      const agentConfig = require('./agent/config').getAgentConfig()
      configureAgentQueue(agentConfig.queue || {})
      const bot = Array.isArray(ctx.bots) ? ctx.bots[0] : ctx.bot
      const count = await require('./agent/cron').startCronScheduler({ bot, engine: agentEngine })
      if (agentConfig.cron?.enabled) ctx.logger('dongxuelian-ai').info(`agent cron scheduler restored ${count} task(s)`)
    } catch (error) {
      ctx.logger('dongxuelian-ai').warn(`agent cron scheduler restore failed: ${error.message}`)
    }
    ctx.logger('dongxuelian-ai').info(`dongxuelian-ai ${PLUGIN_VERSION} loaded`)
  })

  // 定时扫描敏感话题（每 30 分钟）
  const sensitiveTimer = setInterval(async () => {
    try {
      const enabled = await readJsonFile(POLITICAL_DETECT_FILE, [])
      if (Array.isArray(enabled)) {
        for (const ch of enabled) {
          analyzeChannelSensitive(ch).catch(() => {})
        }
      }
    } catch {}
  }, 1800000)
  ctx.on('dispose', () => {
    clearInterval(sensitiveTimer)
    try { require('./agent/cron').stopCronScheduler() } catch {}
    for (const [, entry] of channelPendingRandom) { if (entry && entry.timer) clearTimeout(entry.timer) }
    channelPendingRandom.clear()
    channelMessageVersions.clear()
    channelExplicitVersions.clear()
    if (dailyCleanupTimer) { clearTimeout(dailyCleanupTimer); dailyCleanupTimer = null }
    if (expressionHarvestTimer) { clearTimeout(expressionHarvestTimer); expressionHarvestTimer = null }
  })

  ctx.middleware(async (session, next) => {
    const content = session.content || ''
    const selfId = String(session.selfId || session.bot?.selfId || '')
    const resolveBot = createBotResolver(ctx, session)
    if (selfId && String(session.userId || session.author?.id || '') === selfId) return next()

    await loadRuntimeSettings()
    try {
      await fs.access(MAINTENANCE_FILE)
      if (!session.isDirect && !isDirectAtBot(session)) return next()
      if (!session.isDirect) {
        bumpExplicitInteractionVersion(getChannelKey(session))
        cancelPendingRandom(getChannelKey(session), 'maintenance-explicit')
      }
      const mt = (await fs.readFile(MAINTENANCE_FILE, 'utf8')).trim() || '优化中'
      await session.send(mt).catch(() => {})
      return
    } catch {}

    const analyzed = analyzeIncomingMessage(session, { sanitizeUserName })
    let plain = collapseRepeatedBotCalls(stripMentions(analyzed.plain || ''))
    const memoryText = normalizeText(stripMentions(analyzed.memory || plain))
    const directAt = isDirectAtBot(session)
    const isPrivate = !!session.isDirect
    const inGuild = !isPrivate
    const channelKey  = getChannelKey(session)
    let currentMessageVersion = getChannelMessageVersion(channelKey)
    let explicitInteractionMarked = false
    const markExplicitInteraction = (reason) => {
      if (!inGuild) return
      if (!explicitInteractionMarked) {
        bumpExplicitInteractionVersion(channelKey)
        explicitInteractionMarked = true
      }
      cancelPendingRandom(channelKey, reason)
    }

    const forwardSummaryText = await resolveForwardSummary(session, content, ctx)

    const armedEventDump = getArmedEventDump(getChannelKey(session))
    if (armedEventDump) {
      try {
        const dumpPath = await dumpSessionEvent(session, analyzed, plain, memoryText)
        clearArmedEventDump(getChannelKey(session))
        ctx.logger('dongxuelian-ai').info(`captured raw session event: ${dumpPath}`)
        await session.send(`已抓到原始事件：${dumpPath}`)
      } catch (error) {
        clearArmedEventDump(getChannelKey(session))
        ctx.logger('dongxuelian-ai').warn(error)
        await session.send('原始事件抓取失败。')
      }
    }

    if (!plain && !directAt && !session.isDirect && !analyzed.hasVisual && !analyzed.hasAudio && !analyzed.hasFile) return next()
    if (inGuild) currentMessageVersion = bumpChannelMessageVersion(channelKey)
    if (directAt) markExplicitInteraction('direct-at')

    logDebug(ctx, 'middleware', `entry userId=${session.userId} isDirect=${!!session.isDirect} guildId=${session.guildId} type=${session.type} subtype=${session.subtype} contentLen=${(session.content || '').length}`)
    logDebug(ctx, 'middleware', `plain=${JSON.stringify(plain).slice(0, 100)} directAt=${directAt} isDirect=${!!session.isDirect}`)

    if (isReservedCommand(plain)) {
      markExplicitInteraction('reserved-command')
      return next()
    }

    if (analyzed.hasVisual && channelKey && session.messageId) {
      const segments = Array.isArray(session.event?.message) ? session.event.message : []
      const imgSeg = segments.find(s => s.type === 'image')
      const imgFile = imgSeg?.data?.file || null
      const imgUrl = imgSeg?.data?.url || ''
      const imageMeta = { conversationKey: getConversationKey(session), userId: session.userId || session.author?.id || session.username || '' }
      const contentImageRef = extractImageRefFromContent(content)
      const storableUrl = /^https?:\/\//i.test(imgUrl) ? imgUrl : contentImageRef.url
      const storableFile = imgFile || contentImageRef.file || ''
      await storeImageUrl(channelKey, session.messageId, storableUrl || '', storableFile || null, imageMeta)
      if (!plain.includes('[图片]')) plain = (plain ? plain + ' ' : '') + '[图片]'
      await enqueueAnalysis(channelKey, session.messageId)
    }

    if (analyzed.hasFile && channelKey && session.messageId) {
      const segments = Array.isArray(session.event?.message) ? session.event.message : []
      const fileSeg = segments.find(s => s.type === 'file')
      if (fileSeg) {
        const fileName = fileSeg.data?.name || fileSeg.data?.file || 'unknown'
        const fileSize = Number(fileSeg.data?.size) || 0
        const fileUrl = fileSeg.data?.url || ''
        const fileId = fileSeg.data?.file || fileSeg.data?.id || null
        const ext = getExtension(fileName)
        const safety = checkFile(fileName, fileSize)

        const fileMeta = {
          fileName: sanitizeFileName(fileName),
          fileSize,
          mimeType: fileSeg.data?.mime || '',
          ext,
          url: fileUrl,
          fileId,
          conversationKey: getConversationKey(session),
          userId: session.userId || session.author?.id || session.username || '',
          skipped: !safety.allowed,
          skipReason: safety.reason || null,
        }
        await storeFile(channelKey, session.messageId, fileMeta)

        if (safety.allowed) {
          if (!plain.includes('[文件]')) plain = (plain ? plain + ' ' : '') + `[文件: ${sanitizeFileName(fileName)} (fileId:${session.messageId})]`
          if (fileUrl && fileSize <= 1024 * 1024) {
            cacheSmallFileBackground(channelKey, session.messageId, fileUrl, ext)
          }
        } else {
          if (!plain.includes('[文件]')) plain = (plain ? plain + ' ' : '') + `[文件: ${sanitizeFileName(fileName)} - 已跳过${safety.reason ? '(' + safety.reason + ')' : ''}]`
        }
      }
    }

    if (analyzed.hasAudio && (session.isDirect || directAt)) {
      try {
        const { loadConfig } = require('./runtime-config')
        const cfg = await loadConfig()
        const transcribed = await Promise.race([
          transcribeVoice(session, cfg),
          new Promise((_, rej) => setTimeout(() => rej(new Error('asr timeout')), 10000)),
        ])
        if (transcribed) {
          plain = `[语音转文字：${transcribed}]`
        } else {
          plain = '[语音消息]'
        }
      } catch {
        plain = '[语音消息]'
      }
    }

    const currentUserId = session.userId || session.author?.id || session.username
    const userName = sanitizeUserName(
      session.author?.nick ||
      session.author?.name ||
      session.username ||
      '群友'
    )
    const adminCommandMatched =
      /^(?:东雪莲)?测试(?:开|关)$/.test(plain) ||
      /^群聊AI白名单(?:添加|删除|查看|列表)/.test(plain) ||
      /^东雪莲群聊AI概率(?:设置|重置)(?:\s|$)/.test(plain) ||
      /^东雪莲联网(?:开|关)$/.test(plain) ||
      /^东雪莲思考(?:开|关)$/.test(plain) ||
      /^解除上限群白名单/.test(plain) ||
      /^敏感话题处理者/.test(plain) ||
      plain === 'AI重载'
    if (adminCommandMatched) markExplicitInteraction('admin-command')

    await handleSensitiveMessage(session, ctx, {
      inGuild,
      channelKey,
      analyzed,
      plain,
      userName,
      currentUserId,
      lastEmotionCache,
    })

    if (adminCommandMatched && !hasAdminPermission(session)) {
      return '只有指定管理员能操作这个命令。'
    }

    const isGroupAdmin = session.event?.sender?.role === 'owner' || session.event?.sender?.role === 'admin'
    const inlineAdminResult = await handleAdminInlineCommands(session, ctx, {
      plain,
      inGuild,
      channelKey,
      isGroupAdmin,
      randomWhitelistCache,
      randomRateCache,
      loadUserBlacklist,
      getFileFingerprint,
      setBlacklistFingerprint: (value) => { userBlacklistFingerprint = value },
      armEventDump,
      getArmedEventDump,
      clearArmedEventDump,
      getRandomWhitelistStatus,
    })
    if (inlineAdminResult.matched) {
      markExplicitInteraction('inline-admin-command')
      return inlineAdminResult.response
    }

    const commandResult = await handleCommand(session, ctx, {
      plain, inGuild, channelKey, currentUserId, adminCommandMatched,
      loadConfig, loadRuntimeSettings, loadSkills, loadSkillsContentCache,
      callOpenAI, setRepeatEnabled, getRandomTriggerBaseRate, getRandomWhitelistStatus,
      getThinkingEnabled,
      setThinkingEnabled,
      resetConfigCache,
      getSkillsCount,
      channelMissCount, repeatEnabledCache: getRepeatEnabledCache(), channelTodayCache, lastEmotionCache,
    })
    if (commandResult.matched) {
      markExplicitInteraction('command')
      if (Object.prototype.hasOwnProperty.call(commandResult, 'response')) return commandResult.response
      return
    }
    // 以 / 开头且非命令的消息交给后续插件处理（如 dongxuelian-help 的 /help 搜索）
    if (plain.startsWith('/')) {
      markExplicitInteraction('slash-command')
      return next()
    }

    const botMentionCount = getBotMentionCount(session)
    const otherMentions = hasOtherMentions(session)
    const mentionUserIds = extractAtIds(session.content || '')
      .map(userId => String(userId))
      .filter(userId => userId && userId !== String(session.selfId || session.bot?.selfId || ''))
    const personaResolution = resolvePersona(channelKey, currentUserId)
    const currentPersonaName = personaResolution.name
    const groupPersonaName = getGroupPersonaName(channelKey)
    const randomPersonaHighRisk = isPersonaSwitchRisky(personaResolution, groupPersonaName)
    const personaWillContent = currentPersonaName ? loadPersonalSkill(currentPersonaName) : null
    const nameMentioned = !currentPersonaName && /莲莲|东雪莲/.test(plain)
    const inRandomWhitelist = getRandomWhitelistStatus(channelKey)
    let isRandomCandidate = inGuild && !directAt && !otherMentions && !nameMentioned && inRandomWhitelist && !analyzed.shouldSkipForRandomReply
    // 30秒冷却：触发后不再次主动发言
    let randomCooldownActive = false
    if (lastRandomReplyTs.has(channelKey) && Date.now() - (lastRandomReplyTs.get(channelKey) || 0) < 15000) {
      randomCooldownActive = true
      isRandomCandidate = false
    }
    const willFactor = calculateWillFactor(channelKey, currentPersonaName, channelSharedCache, personaWillContent)
    const userText = normalizeText(plain)
    const quotedMessageNote = getQuotedMessageNote(session, { replyToId: analyzed.replyToId })
    const sharedRecordText = resolveSharedRecordText(plain, analyzed)

    // "闭嘴" 静默十分钟主动回复
    if (inGuild && !directAt && !nameMentioned && /^(?:闭嘴|别吵|别说了|不要说话)/.test(plain)) {
      const remaining = (channelMutedUntil.get(channelKey) || 0) - Date.now()
      if (remaining < 600000) {
        channelMutedUntil.set(channelKey, Date.now() + 600000)
        ctx.logger('dongxuelian-ai').info(`muted ${channelKey} for 10min due to 闭嘴`)
      }
    }
    // 静默期中抑制随机触发
    let randomMutedActive = false
    if (channelMutedUntil.get(channelKey) > Date.now()) {
      randomMutedActive = true
      if (isRandomCandidate) channelMissCount.set(channelKey, (channelMissCount.get(channelKey) || 0) + 1)
      isRandomCandidate = false
    }

    // 连续复读检测（在随机回复之前，2人相同→bot跟第3条）
    if (inGuild && !directAt && !otherMentions) {
      const repeatCandidate = buildRepeatCandidate(session, plain, analyzed)
      const repeatResult = checkGroupRepeat(session, repeatCandidate, channelKey, currentUserId)
      if (repeatResult && !SENSITIVE_KEYWORDS_RE.test(String(repeatResult.reply || ''))) {
        ctx.logger('dongxuelian-ai').info(`repeat triggered in ${channelKey}: kind=${repeatResult.kind} keyLen=${String(repeatResult.key || '').length}`)
        await safeSendRepeat(ctx, session, repeatResult.reply)
        return next()
      }
    }

    let randomTriggered = isRandomCandidate && shouldTriggerRandom(Math.min(getRandomTriggerRate(channelKey) * willFactor, 1.0))
    const randomHit = randomTriggered
    let delayedRandomScheduled = false

    // 连续发言延迟触发
    if (randomTriggered && isRandomCandidate && inGuild && !directAt && !nameMentioned) {
      const recentMsgs = channelSharedCache.get(channelKey)
        ?.filter(e => e.userId === currentUserId && e.role === 'user')
        ?.slice(-2)
      if (recentMsgs?.length >= 2 && (Date.now() - (recentMsgs[recentMsgs.length - 1]?.ts || 0)) < 10000) {
        randomTriggered = false
        delayedRandomScheduled = true
        cancelPendingRandom(channelKey, 'replace-delayed-random')
        const pendingSharedContextNote = getSharedContextNote(session, currentUserId, {
          replyToId: analyzed.replyToId,
          mentionUserIds,
          randomTriggered: true,
        })
        const pendingExplicitVersion = getExplicitInteractionVersion(channelKey)
        const pendingMessageVersion = currentMessageVersion
        const pendingTriggerMessageId = session.messageId || ''
        const timer = setTimeout(() => {
          const p = channelPendingRandom.get(channelKey)
          channelPendingRandom.delete(channelKey)
          if (!p) return
          if (getExplicitInteractionVersion(channelKey) !== p.explicitVersion) return
          if (getChannelMessageVersion(channelKey) !== p.triggerMessageVersion) return
          if (shouldTriggerRandom(Math.min(getRandomTriggerRate(channelKey) * willFactor, 1.0))) {
            channelMissCount.set(channelKey, 0)
            lastRandomReplyTs.set(channelKey, Date.now())
            enqueueForChannel(channelKey, async () => {
              if (getExplicitInteractionVersion(channelKey) !== p.explicitVersion) return
              if (getChannelMessageVersion(channelKey) !== p.triggerMessageVersion) return
              const liveSession = withCurrentBot(session, resolveBot())
              const chatMeta = {}
              let reply = await handleChatResult(await chat(liveSession, p.combinedText, ctx, { randomTriggered: true, sharedContextNote: p.sharedContextNote, quotedMessageNote: p.quotedMessageNote, forwardSummaryText: p.forwardSummaryText, replyToId: p.replyToId, meta: chatMeta }), { ctx, session: liveSession, channelKey, currentUserId, userName, userText: p.combinedText, randomTriggered: true, resolveBot })
              if (reply) {
                reply = reply.replace(/【语音风格[：:][^】]+】/g, '').trim() || reply
                let randomSendOptions = buildRandomSendOptions({
                  randomTriggered: true,
                  channelKey,
                  delayed: true,
                  highRisk: p.highRisk,
                  triggerMessageId: p.triggerMessageId,
                  triggerMessageVersion: p.triggerMessageVersion,
                  currentMessageVersion: getChannelMessageVersion(channelKey),
                  explicitVersion: p.explicitVersion,
                  triggerAt: p.triggerAt,
                })
                if (chatMeta.randomReplyMode === 'ambient_water') {
                  randomSendOptions = buildAmbientWaterSendOptions(randomSendOptions)
                }
                if (shouldTriggerRareVoice(chatMeta)) {
                  if (!isRandomReplyFresh(randomSendOptions)) {
                    logStaleRandomSkip(ctx, 'delayed-rare-voice', randomSendOptions)
                    return
                  }
                  const rareVoiceSent = await safeSendRareVoice(ctx, liveSession)
                  if (rareVoiceSent) return
                }
                await safeSendReply(ctx, liveSession, reply, true, resolveBot, randomSendOptions)
              }
            }, 4)
          } else {
            channelMissCount.set(channelKey, (channelMissCount.get(channelKey) || 0) + 1)
          }
        }, 15000)
        channelPendingRandom.set(channelKey, {
          timer,
          combinedText: plain,
          sharedContextNote: pendingSharedContextNote,
          quotedMessageNote,
          forwardSummaryText,
          replyToId: analyzed.replyToId,
          explicitVersion: pendingExplicitVersion,
          triggerMessageId: pendingTriggerMessageId,
          triggerMessageVersion: pendingMessageVersion,
          triggerAt: Date.now(),
          personaName: currentPersonaName || '',
          groupPersonaName,
          highRisk: randomPersonaHighRisk,
        })
      }
    }

    if (inGuild && !directAt && !nameMentioned) {
      const randomBaseRate = getRandomTriggerRate(channelKey)
      logDebug(ctx, 'random', `key=${channelKey} whitelist=${inRandomWhitelist} candidate=${isRandomCandidate} hit=${randomHit} triggered=${randomTriggered} delayed=${delayedRandomScheduled} rate=${getRandomTriggerRate(channelKey)} skip=${analyzed.shouldSkipForRandomReply} hasUsableText=${analyzed.hasUsableText} hasLink=${analyzed.hasLink} hasVisual=${analyzed.hasVisual} hasFile=${analyzed.hasFile} hasEmbed=${analyzed.hasEmbed} directAt=${directAt} otherMentions=${otherMentions} nameMentioned=${nameMentioned} whitelistSize=${randomWhitelistCache.size}`)
      logReplyTimingDiagnostic(ctx, {
        phase: 'legacy-random',
        channelKey,
        inGuild,
        isPrivate,
        directAt,
        otherMentions,
        nameMentioned,
        inRandomWhitelist,
        isRandomCandidate,
        randomHit,
        randomTriggered,
        delayedRandomScheduled,
        cooldownActive: randomCooldownActive,
        mutedActive: randomMutedActive,
        baseRate: randomBaseRate,
        effectiveRate: Math.min(randomBaseRate * willFactor, 1.0),
        willFactor,
        missCount: channelMissCount.get(channelKey) || 0,
        personaName: currentPersonaName || '',
        personaSource: personaResolution.source || '',
        groupPersonaName,
        highRisk: randomPersonaHighRisk,
        hasUsableText: analyzed.hasUsableText,
        hasLink: analyzed.hasLink,
        hasVisual: analyzed.hasVisual,
        hasFile: analyzed.hasFile,
        hasEmbed: analyzed.hasEmbed,
        skipForRandomReply: analyzed.shouldSkipForRandomReply,
      })
    }

    if (inGuild && !directAt && !nameMentioned && inRandomWhitelist) {
      if (isRandomCandidate && randomHit) {
        channelMissCount.set(channelKey, 0)
        if (!delayedRandomScheduled) lastRandomReplyTs.set(channelKey, Date.now())
      } else if (!delayedRandomScheduled) {
        channelMissCount.set(channelKey, (channelMissCount.get(channelKey) || 0) + 1)
      }
    }

    const sharedContextNote = getSharedContextNote(session, currentUserId, {
      replyToId: analyzed.replyToId,
      mentionUserIds,
      randomTriggered,
      currentText: userText,
    })

    if (inGuild && sharedRecordText) {
      saveSharedChannelTurn(session, userName, sharedRecordText, 'user', {
        messageId: session.messageId,
        replyToId: analyzed.replyToId,
        mentionUserIds,
        hasMessageRecordCue: analyzed.hasMessageRecordCue,
        hasAudio: analyzed.hasAudio,
      })
    }

// 用户黑名单：群聊中不回复，但仍记录消息供上下文使用
    if (inGuild && !hasAdminPermission(session)) {
      const userBlacklist = await loadUserBlacklist()
      if (userBlacklist.has(String(currentUserId))) return next()
    }

    if (!isPrivate && !directAt && !nameMentioned) {
      if (analyzed.hasVisual || analyzed.hasFile || analyzed.hasEmbed) {
        if (!inRandomWhitelist) return next()
        // 跳过 emoji/sticker/gif 表情包
        if (/Qzone|Emoji|Sticker|gif/i.test(content)) return next()
        // 图片也按概率回复，不无条件回复
        if (!randomTriggered && !shouldTriggerRandom(getRandomTriggerRate(channelKey))) return next()
        if (!prepareVisionRequest(session, analyzed, { content, allowCurrentMessage: true, includeQuote: false }) && !analyzed.hasUsableText) {
          return next()
        }
      } else if (!randomTriggered) {
        return next()
      }
    }

    // 引用/回复中的图片：当前消息不含图，但被引用的消息可能含图片
    prepareVisionRequest(session, analyzed, { content, allowCurrentMessage: false, includeQuote: true })

    if ((directAt || nameMentioned || isPrivate) && (analyzed.hasVisual || analyzed.hasFile || analyzed.hasEmbed)) {
      // 有图片 → 尝试识图
      if (!prepareVisionRequest(session, analyzed, { content, allowCurrentMessage: true, includeQuote: false }) && !analyzed.hasUsableText) {
        await session.send('我不识图，也不读文件链接。发文字。')
        return
      }
    } else if ((directAt || nameMentioned) && !analyzed.hasUsableText) {
      if (analyzed.hasLink) return next()
      return
    }
    if (session._skipVision) { delete session._skipVision; return next() }
    if (!userText && !isVisionSession(session)) return next()

    if (botMentionCount > 1) {
      logDebug(ctx, 'middleware', `collapsed repeated @bot mentions: ${botMentionCount}`)
    }

    let randomSendOptions = buildRandomSendOptions({
      randomTriggered,
      channelKey,
      delayed: false,
      highRisk: randomPersonaHighRisk,
      triggerMessageId: session.messageId || '',
      triggerMessageVersion: currentMessageVersion,
      currentMessageVersion: getChannelMessageVersion(channelKey),
      explicitVersion: getExplicitInteractionVersion(channelKey),
      triggerAt: Date.now(),
    })
    const maxDepth = inGuild ? 4 : 2

    if (/^(读文件|看文件|分析文件|打开文件|文件内容)$/.test(userText.trim())) {
      const { getRecentFiles } = require('./file-store')
      const { analyzeFileNow } = require('./file-analyzer')
      const recentFiles = await getRecentFiles(channelKey, 10)
      const target = recentFiles.find(f => !f.skipped && !f.analyzed)
        || recentFiles.find(f => !f.skipped && f.analyzed)
      if (target) {
        const liveSession = withCurrentBot(session, resolveBot())
        if (target.analyzed && target.analysis) {
          await safeSendReply(ctx, liveSession, summarizeFileContentForChat(target.analysis, target.fileName), randomTriggered, resolveBot, randomSendOptions)
          return
        }
        const result = await analyzeFileNow(channelKey, target.messageId)
        if (result) {
          await safeSendReply(ctx, liveSession, summarizeFileContentForChat(result, target.fileName), randomTriggered, resolveBot, randomSendOptions)
          return
        }
        await safeSendReply(ctx, liveSession, '文件下载失败了，可能已经过期。如果还需要，请重新发一次文件。', randomTriggered, resolveBot, randomSendOptions)
        return
      }
      await safeSendReply(ctx, withCurrentBot(session, resolveBot()), '没有找到最近可分析的文件。', randomTriggered, resolveBot, randomSendOptions)
      return
    }

    enqueueForChannel(channelKey, async () => {
      const liveSession = withCurrentBot(session, resolveBot())
      try {
        const recentUserMessages = getRecentUserMessages(liveSession, 4)
        let route = heuristicRoute(userText, 'qq', { recentUserMessages })
        if (isJailbreakAttempt(sanitizeUserInput(userText))) route = { useAgent: false, reason: 'jailbreak-chat-guard' }
        if (route.useAgent) {
          logDebug(ctx, 'agent', `auto-route reason=${route.reason} channel=${channelKey}`)
          const searchRunOptions = buildExplicitSearchRunOptions(userText, { recentUserMessages })
          const agentConfig = require('./agent/config').getAgentConfig()
          configureAgentQueue(agentConfig.queue || {})
          try {
            const agentResult = await enqueueAgentTask({
              channelKey,
              userId: currentUserId,
              timeoutMs: agentConfig.queue?.timeoutMs,
              fn: () => agentEngine.run({ userMessage: searchRunOptions.agentUserMessage || userText, userName, userId: currentUserId, channelKey, channel: 'qq', bot: resolveBot(), agentMode: true, ...searchRunOptions }),
            })
            const finalReply = await retellAgentResult(agentResult, { ctx, session: liveSession, channelKey, currentUserId, userName, userText, randomTriggered })
            return safeSendReply(ctx, liveSession, finalReply, randomTriggered, resolveBot, randomSendOptions)
          } catch (error) {
            const code = error && error.code ? String(error.code) : ''
            if (code === 'AGENT_QUEUE_FULL' || code === 'AGENT_QUEUE_REJECTED') return safeSendReply(ctx, liveSession, error.message, randomTriggered, resolveBot, randomSendOptions)
            ctx.logger('dongxuelian-ai').warn(`agent auto-route failed: ${error.message}`)
            return safeSendReply(ctx, liveSession, 'Agent 暂时不可用。', randomTriggered, resolveBot, randomSendOptions)
          }
        }
        const chatMeta = {}
        const chatResult = await chat(liveSession, userText, ctx, { randomTriggered, sharedContextNote, quotedMessageNote, forwardSummaryText, mentionUserIds, replyToId: analyzed.replyToId, meta: chatMeta })
        const reply = await handleChatResult(chatResult, { ctx, session: liveSession, channelKey, currentUserId, userName, userText, randomTriggered, resolveBot })
        if (!reply) return
        if (randomTriggered && chatMeta.randomReplyMode === 'ambient_water') {
          randomSendOptions = buildAmbientWaterSendOptions(randomSendOptions)
        }
        logAffectRouterDiagnostic(ctx, {
          personaName: currentPersonaName || '',
          userText,
          replyText: reply,
          randomTriggered,
          voiceCandidate: randomTriggered && inGuild && !chatMeta.rareConfirmed,
          channelKey,
        })
        if (randomTriggered && inGuild && !chatMeta.rareConfirmed) {
          try {
            const { shouldTriggerRandomVoice, markChannelCooldown, synthesizeSpeech, sendVoiceMessage, resolvePersonaVoice, extractVoiceStyle, stripVoiceStyleTag, composeTtsStyle } = require('./tts')
            if (shouldTriggerRandomVoice(channelKey)) {
              const resolved = resolvePersona(channelKey, currentUserId)
              const voiceOpts = resolvePersonaVoice(resolved.name)
              const styleOverride = extractVoiceStyle(reply)
              voiceOpts.style = composeTtsStyle(voiceOpts.style, styleOverride)
              const ttsText = stripVoiceStyleTag(reply)
              const ttsDiagnostics = {
                diagnostics: {},
                logger: ctx.logger('dongxuelian-ai'),
                context: 'random-voice',
              }
              const buf = await synthesizeSpeech(ttsText, { ...voiceOpts, ...ttsDiagnostics })
              if (buf) {
                if (!isRandomReplyFresh(randomSendOptions)) {
                  logStaleRandomSkip(ctx, 'random-voice', randomSendOptions)
                  return
                }
                const sent = await sendVoiceMessage(liveSession, buf, ttsDiagnostics)
                if (sent) { markChannelCooldown(channelKey); return }
              }
            }
          } catch {}
        }
        if (inGuild && /别问了，这个我不聊/.test(reply)) {
          notifySensitiveHandlers(liveSession, channelKey, { throttle: true }).catch(() => {})
        }
        const finalReply = reply.replace(/【语音风格[：:][^】]+】/g, '').trim() || reply
        if (shouldTriggerRareVoice(chatMeta)) {
          if (randomTriggered && !isRandomReplyFresh(randomSendOptions)) {
            logStaleRandomSkip(ctx, 'rare-voice', randomSendOptions)
            return
          }
          const rareVoiceSent = await safeSendRareVoice(ctx, liveSession)
          if (rareVoiceSent) return
        }
        return safeSendReply(ctx, liveSession, finalReply, randomTriggered, resolveBot, randomSendOptions)
      } catch (err) {
        const m = err && err.message ? String(err.message) : ''
        const code = err && err.code ? String(err.code) : ''
        ctx.logger('dongxuelian-ai').warn(`chat failed: name=${err && err.name} code=${code} message=${m}`)
        let msg = '东雪莲暂时无法连接。'
        if (/fallback/i.test(m)) msg = '我寄了'
        else if (/Empty model/i.test(m)) msg = '我摆了，懒得回'
        else if (/data_inspection|DataInspection|inappropriate content|content_filter|content policy|moderation|safety|审核|风控|ResponsibleAIPolicy|ResponsibleAI|blocked|censored/i.test(m)) {
          msg = /data_inspection|DataInspection|inappropriate content|图/i.test(m) ? '这个图不合适，不说了吧' : '这话我接不了，换一句吧。'
        } else if (/timeout|ETIMEDOUT|aborted|AbortError|deadline/i.test(m) || /TIMED_OUT|ETIMEDOUT/i.test(code)) {
          msg = '请求超时了，一会再来。'
        } else if (/ECONNRESET|ECONNREFUSED|ENOTFOUND|ENETUNREACH|socket hang|TLS|SSL|fetch failed/i.test(m) || /^ECONN/.test(code)) {
          msg = '网络抖了一下，一会再来。'
        } else if (/429|rate limit|too many requests|quota/i.test(m)) {
          msg = '请求太勤了，稍后再试。'
        }
        return safeSendReply(ctx, liveSession, msg, randomTriggered, resolveBot, randomSendOptions)
      }
    }, maxDepth)
  })
}
