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
const satoriCore = require('@satorijs/core')
const KoishiSession = satoriCore.Session
const KoishiBot = satoriCore.Bot
const {
  installSessionCompatibility,
} = require('./lifecycle/session-compat') as typeof import('./lifecycle/session-compat') // Koishi/Satori Session 兼容补丁
const {
  createBotResolver,
  withCurrentBot,
} = require('./lifecycle/bot-resolver') as typeof import('./lifecycle/bot-resolver') // 当前 bot 解析与异步 session 注入
const {
  enqueueForChannel,
} = require('./lifecycle/channel-task-queue') as typeof import('./lifecycle/channel-task-queue') // 同频道任务串行队列
const {
  getArmedEventDump,
  armEventDump,
  clearArmedEventDump,
  dumpSessionEvent,
} = require('./lifecycle/event-dump') as typeof import('./lifecycle/event-dump') // 原始事件一次性抓取与安全落盘
const {
  registerPluginLifecycle,
} = require('./lifecycle/plugin-lifecycle') as typeof import('./lifecycle/plugin-lifecycle') // ready/dispose 生命周期注册
const {
  logReplyTimingDiagnostic,
  logAffectRouterDiagnosticForOutputShadow,
  logStickerShadowSendDiagnostic,
} = require('./diagnostics/diagnostics') as typeof import('./diagnostics/diagnostics') // 入口旁路诊断日志
const {
  resolveSharedRecordText,
} = require('./diagnostics/shared-record-text') as typeof import('./diagnostics/shared-record-text') // 群共享上下文保存文本归一
const {
  isFileQuickReadIntent,
  resolveFileQuickReadReply,
} = require('./routing/file-quick-read') as typeof import('./routing/file-quick-read') // 显式读文件快捷分支
const { handleCommand } = require('./handler') as typeof import('./handler') // 指令路由（/help /reset 等）
const { analyzeIncomingMessage, normalizeText } = require('./message/message-reader') as typeof import('./message/message-reader')
const { resolveForwardSummary } = require('./message/forward') as typeof import('./message/forward')
const { prepareVisionRequest, isVisionSession } = require('./media/image/vision') as typeof import('./media/image/vision') // 图片消息构建 + 视觉会话判断
const {
  handleIncomingMessageArtifacts,
} = require('./message/incoming-message-flow') as typeof import('./message/incoming-message-flow') // 入站图片/文件/语音材料处理
const {
  handleSensitiveMessage,        // 敏感消息拦截主逻辑
} = require('./behavior/sensitive') as typeof import('./behavior/sensitive')
const { handleAdminInlineCommands } = require('./commands/admin-commands') as typeof import('./commands/admin-commands') // 白名单/黑名单/概率/敏感等内联管理命令
const {
  setRepeatEnabled,       // 设置复读开关
  getRepeatEnabledCache,  // 查询复读开关缓存
  buildRepeatCandidate,   // 构建复读候选（判断是否跟读）
  checkGroupRepeat,       // 群复读触发检测
} = require('./behavior/repeat') as typeof import('./behavior/repeat')
const {
  logStaleRandomSkip,
  safeSendRepeat,
  safeSendReply: safeSendReplyImpl,
  safeSendRareVoice,
} = require('./reply/safe-send') as typeof import('./reply/safe-send')
const {
  chat,                   // 主聊天入口（session → AI 回复）
  loadSkills, loadSkillsContentCache, // 技能文件列表/内容加载
  callOpenAI,             // 底层 LLM 调用
  getSkillsCount,         // 已加载技能数量
} = require('./chat') as typeof import('./chat')
const {
  loadConfig, resetConfigCache,   // 运行时配置加载/刷新
  getThinkingEnabled, setThinkingEnabled, // thinking 模式开关
} = require('./core/runtime-config') as typeof import('./core/runtime-config')
const {
  randomWhitelistCache,
  loadRuntimeSettings,
  getRandomTriggerBaseRate,
  getRandomWhitelistStatus,
} = require('./behavior/runtime-settings') as typeof import('./behavior/runtime-settings')
const {
  loadUserBlacklist,
} = require('./core/user-blacklist') as typeof import('./core/user-blacklist')
const {
  MAINTENANCE_FILE,
  SENSITIVE_KEYWORDS_RE,
} = require('./core/constants') as typeof import('./core/constants')
const {
  resolvePersona,      // 解析当前会话应使用的人格
  loadPersonalSkill,   // 加载人格技能文件内容
} = require('./persona/persona') as typeof import('./persona/persona')
const {
  getGroupPersonaName,
  isPersonaSwitchRisky,
} = require('./behavior/random-persona-risk') as typeof import('./behavior/random-persona-risk') // 随机回复人格切换风险判断
const {
  channelSharedCache,       // 频道共享消息缓存（群聊上下文窗口）
  channelTodayCache,        // 频道今日统计缓存
  getConversationKey,       // 用户会话唯一标识生成
  getChannelKey,            // 频道唯一标识生成
  saveSharedChannelTurn,    // 保存群聊共享消息轮次
  findChannelMessageById, collectReplyChain, // 消息查找 + 引用链收集
  getQuotedMessageNote, getSharedContextNote, // 引用/共享上下文注入文本
  getRecentUserMessages,     // 取最近用户消息，用于搜索追问补全
  getRecentUserMessageRecords, // 带时间戳的用户消息记录
} = require('./conversation') as typeof import('./conversation')
const {
  isReservedCommand,        // 判断是否为保留指令前缀
  hasAdminPermission,       // 管理员权限判断
  stripMentions,            // 去除 @mention 标记
  collapseRepeatedBotCalls, // 折叠连续重复 @bot 调用
  sanitizeUserName,         // 昵称安全清洗
  extractAtIds,             // 提取消息中所有 @id
  isDirectAtBot, getBotMentionCount, hasOtherMentions, // @bot 检测
  pickJailbreakFallbackReply, // 越狱兜底回复
  readJsonFile,             // 文件 IO 工具
  shouldTriggerRandom, calculateWillFactor, // 随机触发判断 + 意愿因子计算
} = require('./core/utils') as typeof import('./core/utils')
const { logDebug } = require('./core/logging-config') as typeof import('./core/logging-config') // 调试日志输出
const { shouldTriggerRareVoice } = require('./behavior/rare-voice') as typeof import('./behavior/rare-voice') // 罕见触发固定语音
const { buildPrivateSearchContext } = require('./routing/search-context') as typeof import('./routing/search-context')
const agentEngine = require('./agent/engine') as typeof import('./agent/engine') // Agent 执行引擎
const { enqueueAgentTask, configureAgentQueue } = require('./agent/queue') as typeof import('./agent/queue') // Agent 任务队列
const {
  handleChatResult,
  retellAgentResult,
} = require('./chat/chat-result-flow') as typeof import('./chat/chat-result-flow') // chat heavy tool 与 Agent 结果转述桥接
const {
  handleAgentAutoRoute,
} = require('./routing/agent-auto-route-flow') as typeof import('./routing/agent-auto-route-flow')
const {
  sendChatReplyFlow,
} = require('./chat/chat-send-flow') as typeof import('./chat/chat-send-flow') // chat 回复发送流水
const {
  channelMissCount,
  incrementRandomMiss,
  resetRandomMiss,
  getRandomTriggerRate: getRandomTriggerRateFromState,
  isRandomCooldownActive,
  markRandomReplySent,
  getRandomMuteRemaining,
  muteRandomChannel,
  isRandomMuted,
  getChannelMessageVersion,
  bumpChannelMessageVersion,
  getExplicitInteractionVersion,
  bumpExplicitInteractionVersion,
  takePendingRandom,
  setPendingRandom,
  cancelPendingRandom,
  buildRandomSendOptions,
  isRandomReplyFresh,
  isSafeSendReplyFresh,
} = require('./behavior/random-state') as typeof import('./behavior/random-state') // 随机回复状态、pending timer 与 freshness
const { buildAmbientWaterSendOptions } = require('./behavior/random-reply-mode') as typeof import('./behavior/random-reply-mode') // 随机非锚定水群发送策略

interface IndexLogger {
  info(...args: unknown[]): void
  warn(...args: unknown[]): void
  error(...args: unknown[]): void
}

interface IndexBot {
  selfId?: string
  sendPrivateMessage?: (id: string, message: string) => Promise<unknown> | unknown
  internal?: {
    sendPrivateMsg?: (id: string, message: string) => Promise<unknown> | unknown
  }
}

interface IndexContext {
  [key: string]: unknown
  bots?: IndexBot[]
  bot?: IndexBot
  logger(name: string): IndexLogger
  middleware(handler: (session: IndexSession, next: () => unknown | Promise<unknown>) => unknown | Promise<unknown>): unknown
  on(event: 'ready' | 'dispose', handler: () => unknown): void
}

interface IndexSession {
  [key: string]: unknown
  content?: string
  selfId?: string
  userId?: string
  username?: string
  isDirect?: boolean
  guildId?: string
  channelId?: string
  messageId?: string
  type?: string
  subtype?: string
  author?: {
    id?: string
    nick?: string
    name?: string
  }
  event?: {
    user?: { id?: string }
    sender?: { role?: string }
    selfId?: string
    message?: IndexSegment[]
  }
  quote?: {
    content?: string
    elements?: unknown[]
  }
  bot?: IndexBot
  elements?: unknown[]
  _skipVision?: boolean
  send(message: unknown): Promise<unknown>
}

interface IndexChatMeta {
  rareConfirmed?: boolean
  randomReplyMode?: string
  [key: string]: unknown
}

interface IndexSegment {
  type?: string
  data?: {
    url?: unknown
    file?: unknown
    [key: string]: unknown
  }
  attrs?: unknown
  [key: string]: unknown
}

interface IndexIncomingAnalysis {
  plain: string
  memory: string
  replyToId: string
  hasUsableText: boolean
  hasMessageRecordCue: boolean
  hasVisual: boolean
  hasAudio: boolean
  hasFile: boolean
  hasLink: boolean
  hasEmbed: boolean
  hasOnlyForwardShell: boolean
  shouldSkipForRandomReply: boolean
  [key: string]: unknown
}

interface IndexRandomSendOptions {
  randomFreshness?: {
    channelKey: string
    triggerMessageVersion: number
    explicitVersion: number
    triggerAt: number
  }
  forceQuote?: boolean
  quoteMessageId?: string
  noQuote?: boolean
  noReplyTo?: boolean
  personaName?: string
  [key: string]: unknown
}

interface IndexPendingRandomEntry extends Record<string, unknown> {
  timer?: NodeJS.Timeout
  combinedText: string
  sharedContextNote: string
  quotedMessageNote: string
  forwardSummaryText: string
  replyToId: string
  explicitVersion: number
  triggerMessageId: string
  triggerMessageVersion: number
  triggerAt: number
  personaName: string
  groupPersonaName: string
  highRisk: boolean
}

interface IndexErrorLike {
  name?: unknown
  code?: unknown
  message?: unknown
}

interface IndexRepeatSession {
  isDirect?: boolean
  content?: string
  event?: {
    message?: unknown[] | {
      elements?: unknown[]
      content?: unknown[]
    }
  }
}

interface IndexRepeatAnalysis {
  hasFile?: boolean
  hasEmbed?: boolean
  hasMessageRecordCue?: boolean
  hasVisual?: boolean
}

interface IndexRepeatCandidate {
  key: string
  reply: string
  kind: string
  supported: boolean
  reason?: string
}

type IndexBuildRepeatCandidate = (session: IndexRepeatSession, plain: string, analyzed?: IndexRepeatAnalysis) => IndexRepeatCandidate
type IndexCheckGroupRepeat = (session: IndexRepeatSession, candidate: IndexRepeatCandidate | null | undefined, channelKey: string, currentUserId: string, now?: number) => IndexRepeatCandidate | null

function getIndexErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String((error as IndexErrorLike | null | undefined)?.message || '')
}

function getIndexErrorCode(error: unknown): string {
  return String((error as IndexErrorLike | null | undefined)?.code || '')
}

function getIndexErrorName(error: unknown): string {
  return String((error as IndexErrorLike | null | undefined)?.name || '')
}

function ignoreIndexSendFailure(error?: unknown): void {
  void error
}

installSessionCompatibility({ KoishiSession, KoishiBot })

const name = 'dongxuelian-ai'

const lastEmotionCache = new Map<string, { response?: unknown; text?: string; ts: number }>()

// 人格系统：per-group persona 配置
// 格式: { "channelKey": { persona: "name" | null } }

// 原子写入 JSON（先写临时文件再 rename，防并发损坏）

// 人格系统：per-user persona 配置
// 格式: { "userId": "personaName" }

// 计算最终 persona：用户级 > 群级 > 默认

function resolveRandomTriggerRate(channelKey: string): number {
  return getRandomTriggerRateFromState(channelKey, getRandomTriggerBaseRate)
}

function safeSendReplyWithFreshness(
  ctx: IndexContext,
  session: IndexSession,
  reply: string,
  isRandom = false,
  resolveBot: (() => IndexBot | null | undefined) | null = null,
  sendOptions: IndexRandomSendOptions = {}
): Promise<void> {
  return safeSendReplyImpl(ctx, session, reply, isRandom, resolveBot, sendOptions, isSafeSendReplyFresh)
}

function apply(ctx: IndexContext): void {
  registerPluginLifecycle(ctx, { agentEngine, configureAgentQueue })

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
      await session.send(mt).catch(ignoreIndexSendFailure)
      return
    } catch { /* non-critical: absence of maintenance flag is the normal path */ }

    const analyzed = analyzeIncomingMessage(session, { sanitizeUserName }) as IndexIncomingAnalysis
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
        await session.send(`已抓到原始事件：${dumpPath}`).catch(ignoreIndexSendFailure)
      } catch (error) {
        clearArmedEventDump(getChannelKey(session))
        ctx.logger('dongxuelian-ai').warn(`event dump failed: ${getIndexErrorMessage(error)}`)
        await session.send('原始事件抓取失败。').catch(ignoreIndexSendFailure)
      }
    }

    if (!plain && !directAt && !session.isDirect && !analyzed.hasVisual && !analyzed.hasAudio && !analyzed.hasFile) return next()
    currentMessageVersion = bumpChannelMessageVersion(channelKey)
    if (directAt) markExplicitInteraction('direct-at')

    logDebug(ctx, 'middleware', `entry userId=${session.userId} isDirect=${!!session.isDirect} guildId=${session.guildId} type=${session.type} subtype=${session.subtype} contentLen=${(session.content || '').length}`)
    logDebug(ctx, 'middleware', `plain=${JSON.stringify(plain).slice(0, 100)} directAt=${directAt} isDirect=${!!session.isDirect}`)

    if (isReservedCommand(plain)) {
      markExplicitInteraction('reserved-command')
      return next()
    }

    plain = await handleIncomingMessageArtifacts({ ctx, session, analyzed, plain, content, channelKey, directAt })

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
      armEventDump,
      getArmedEventDump,
      clearArmedEventDump,
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
    if (isRandomCooldownActive(channelKey)) {
      randomCooldownActive = true
      isRandomCandidate = false
    }
    const willFactor = calculateWillFactor(channelKey, currentPersonaName, channelSharedCache, personaWillContent)
    const userText = normalizeText(plain)
    const quotedMessageNote = getQuotedMessageNote(session, { replyToId: analyzed.replyToId })
    const sharedRecordText = resolveSharedRecordText(plain, analyzed)

    // "闭嘴" 静默十分钟主动回复
    if (inGuild && !directAt && !nameMentioned && /^(?:闭嘴|别吵|别说了|不要说话)/.test(plain)) {
      const remaining = getRandomMuteRemaining(channelKey)
      if (remaining < 600000) {
        muteRandomChannel(channelKey)
        ctx.logger('dongxuelian-ai').info(`muted ${channelKey} for 10min due to 闭嘴`)
      }
    }
    // 静默期中抑制随机触发
    let randomMutedActive = false
    if (isRandomMuted(channelKey)) {
      randomMutedActive = true
      if (isRandomCandidate) incrementRandomMiss(channelKey)
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

    let randomTriggered = isRandomCandidate && shouldTriggerRandom(Math.min(resolveRandomTriggerRate(channelKey) * willFactor, 1.0))
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
          personaName: currentPersonaName || '',
        })
        const pendingExplicitVersion = getExplicitInteractionVersion(channelKey)
        const pendingMessageVersion = currentMessageVersion
        const pendingTriggerMessageId = session.messageId || ''
        const timer = setTimeout(() => {
          const p = takePendingRandom(channelKey) as IndexPendingRandomEntry | null
          if (!p) return
          if (getExplicitInteractionVersion(channelKey) !== p.explicitVersion) return
          if (getChannelMessageVersion(channelKey) !== p.triggerMessageVersion) return
          if (shouldTriggerRandom(Math.min(resolveRandomTriggerRate(channelKey) * willFactor, 1.0))) {
            resetRandomMiss(channelKey)
            markRandomReplySent(channelKey)
            enqueueForChannel(channelKey, async () => {
              if (getExplicitInteractionVersion(channelKey) !== p.explicitVersion) return
              if (getChannelMessageVersion(channelKey) !== p.triggerMessageVersion) return
              const liveSession = withCurrentBot(session, resolveBot()) as IndexSession
              const chatMeta: IndexChatMeta = {}
                let reply = await handleChatResult(await chat(liveSession, p.combinedText, ctx, { randomTriggered: true, sharedContextNote: p.sharedContextNote, quotedMessageNote: p.quotedMessageNote, forwardSummaryText: p.forwardSummaryText, replyToId: p.replyToId, directAt: false, nameMentioned: false, meta: chatMeta }), {
                  ctx,
                  session: liveSession,
                  channelKey,
                  currentUserId,
                  userName,
                  isAdmin: hasAdminPermission(liveSession),
                  userText: p.combinedText,
                  randomTriggered: true,
                  resolveBot,
                  chat: chat as unknown as Parameters<typeof handleChatResult>[1]['chat'],
                agentEngine,
                enqueueAgentTask,
                configureAgentQueue,
              })
              if (reply) {
                reply = reply.replace(/【语音风格[：:][^】]+】/g, '').trim() || reply
                const affectDiagnostic = logAffectRouterDiagnosticForOutputShadow(ctx, {
                  personaName: p.personaName || '',
                  userText: p.combinedText,
                  replyText: reply,
                  randomTriggered: true,
                  voiceCandidate: inGuild && !chatMeta.rareConfirmed,
                  channelKey,
                })
                logStickerShadowSendDiagnostic(ctx, {
                  session: liveSession,
                  channelKey,
                  userId: currentUserId,
                  messageId: liveSession.messageId || session.messageId || '',
                  personaName: p.personaName || '',
                  replyText: reply,
                  isRandom: true,
                  affectDiagnostic,
                })
                let randomSendOptions: IndexRandomSendOptions = buildRandomSendOptions({
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
                await safeSendReplyWithFreshness(ctx, liveSession, reply, true, resolveBot, { ...randomSendOptions, personaName: p.personaName || '' })
              }
            }, 4, { ctx, maxQueueAgeMs: 20000 })
          } else {
            incrementRandomMiss(channelKey)
          }
        }, 15000)
        setPendingRandom(channelKey, {
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
      const randomBaseRate = resolveRandomTriggerRate(channelKey)
      logDebug(ctx, 'random', `key=${channelKey} whitelist=${inRandomWhitelist} candidate=${isRandomCandidate} hit=${randomHit} triggered=${randomTriggered} delayed=${delayedRandomScheduled} rate=${resolveRandomTriggerRate(channelKey)} skip=${analyzed.shouldSkipForRandomReply} hasUsableText=${analyzed.hasUsableText} hasLink=${analyzed.hasLink} hasVisual=${analyzed.hasVisual} hasFile=${analyzed.hasFile} hasEmbed=${analyzed.hasEmbed} directAt=${directAt} otherMentions=${otherMentions} nameMentioned=${nameMentioned} whitelistSize=${randomWhitelistCache.size}`)
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
        resetRandomMiss(channelKey)
        if (!delayedRandomScheduled) markRandomReplySent(channelKey)
      } else if (!delayedRandomScheduled) {
        incrementRandomMiss(channelKey)
      }
    }

    const sharedContextNote = getSharedContextNote(session, currentUserId, {
      replyToId: analyzed.replyToId,
      mentionUserIds,
      randomTriggered,
      currentText: userText,
      personaName: currentPersonaName || '',
      directAt,
      nameMentioned,
      isDirect: isPrivate,
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
        // 图片/文件/嵌入消息只使用上方统一随机门控，不能在这里二次抽概率。
        if (!randomTriggered) return next()
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
      if (analyzed.hasFile && !analyzed.hasVisual && !analyzed.hasEmbed && !analyzed.hasUsableText) return
      // 有图片 → 尝试识图
      if (!prepareVisionRequest(session, analyzed, { content, allowCurrentMessage: true, includeQuote: false }) && !analyzed.hasUsableText) {
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

    let randomSendOptions: IndexRandomSendOptions = buildRandomSendOptions({
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

    if (isFileQuickReadIntent(userText)) {
      const liveSession = withCurrentBot(session, resolveBot()) as IndexSession
      const reply = await resolveFileQuickReadReply(channelKey)
      await safeSendReplyWithFreshness(ctx, liveSession, reply, randomTriggered, resolveBot, randomSendOptions)
      return
    }

    enqueueForChannel(channelKey, async () => {
        const liveSession = withCurrentBot(session, resolveBot()) as IndexSession
        try {
          const recentUserMessages = getRecentUserMessages(liveSession, 4)
          const searchContext = buildPrivateSearchContext(liveSession, getRecentUserMessageRecords(liveSession, 8), { currentText: userText })
          const autoRouteResult = await handleAgentAutoRoute({
            ctx,
            liveSession,
            channelKey,
            currentUserId,
            userName,
            userText,
            randomTriggered,
            recentUserMessages,
            searchContext: searchContext as unknown as Record<string, unknown>,
            resolveBot,
            chat,
            agentEngine,
            enqueueAgentTask,
            configureAgentQueue,
            retellAgentResult: retellAgentResult as unknown as (result: unknown, input: Record<string, unknown>) => Promise<string>,
          })
          if (autoRouteResult.handled) {
            return safeSendReplyWithFreshness(ctx, liveSession, autoRouteResult.reply, randomTriggered, resolveBot, randomSendOptions)
          }
        const chatMeta: IndexChatMeta = {}
        const chatResult = await chat(liveSession, userText, ctx, { randomTriggered, sharedContextNote, quotedMessageNote, forwardSummaryText, mentionUserIds, replyToId: analyzed.replyToId, directAt, nameMentioned, meta: chatMeta })
          const reply = await handleChatResult(chatResult, {
            ctx,
            session: liveSession,
            channelKey,
            currentUserId,
            userName,
            isAdmin: hasAdminPermission(liveSession),
            userText,
            randomTriggered,
            resolveBot,
          searchContext,
          chat: chat as unknown as Parameters<typeof handleChatResult>[1]['chat'],
          agentEngine,
          enqueueAgentTask,
          configureAgentQueue,
        })
        if (!reply) return
        if (randomTriggered && chatMeta.randomReplyMode === 'ambient_water') {
          randomSendOptions = buildAmbientWaterSendOptions(randomSendOptions)
        }
        return sendChatReplyFlow({
          ctx,
          liveSession,
          channelKey,
          currentUserId,
          userText,
          reply,
          randomTriggered,
          inGuild,
          chatMeta,
          randomSendOptions,
          currentPersonaName,
          resolveBot,
          safeSendReplyWithFreshness: safeSendReplyWithFreshness as unknown as Parameters<typeof sendChatReplyFlow>[0]['safeSendReplyWithFreshness'],
        })
      } catch (err) {
        const m = getIndexErrorMessage(err)
        const code = getIndexErrorCode(err)
        ctx.logger('dongxuelian-ai').warn(`chat failed: name=${getIndexErrorName(err)} code=${code} message=${m}`)
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
        return safeSendReplyWithFreshness(ctx, liveSession, msg, randomTriggered, resolveBot, randomSendOptions)
      }
    }, maxDepth, { ctx, maxQueueAgeMs: randomTriggered ? 20000 : 45000 })
  })
}

export = {
  name,
  buildRepeatCandidate: buildRepeatCandidate as IndexBuildRepeatCandidate,
  checkGroupRepeat: checkGroupRepeat as IndexCheckGroupRepeat,
  apply,
}
