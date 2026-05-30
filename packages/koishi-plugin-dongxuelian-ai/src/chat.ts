/**
 * ARCHITECTURE CONSTRAINT:
 * - 本文件是聊天核心，职责：chat() 主循环 + callOpenAI + 记忆/印象/语义守卫。
 * - 禁止在此文件新增 Map/Set/全局缓存。新状态归属到 conversation.js 或独立模块。
 * - 修改 chat() 前必须先回答："补旧功能还是长新器官？"
 *   长新器官 → 拆出独立模块（如 reply-guard.js）。
 * - 禁止直接调用 fetch/execFile。统一通过 api.js。
 */
const path = require('path')
const {
  TEST_MODE_FILE, HOSTILE_MODE_FILE,
  REQUEST_TIMEOUT,
  MAX_OUTPUT_CHARS_FRIENDLY, MAX_OUTPUT_CHARS_ABUSIVE,
  PROVIDERS, DASHSCOPE_KEY_FILE, GLM_KEY_FILE,
  USER_PROFILE_DIR, POLITICAL_DETECT_FILE,
  JAILBREAK_OUTPUT_RE,
  JAPAN_SELF_IDENTIFY_RE, GENERATION_REQUEST_RE,
  SENSITIVE_KEYWORDS_RE,
} = require('./core/constants') as typeof import('./core/constants')
const { resolvePersona, loadPersonalSkill } = require('./persona/persona') as typeof import('./persona/persona') // 人格解析 + 技能文件加载
const { calculateRetaliationScore } = require('./behavior/retaliation') as typeof import('./behavior/retaliation') // 攻击性评分（决定回怼力度）
const {
  requestChatCompletions,       // 通用 LLM 请求（含 fallback 链）
  requestOpenAIResponsesWithSearch, // OpenAI Responses API（联网搜索）
  isVisionModel,                // 判断模型是否支持视觉
} = require('./core/api') as typeof import('./core/api')
const { isVisionSession, clearVisionSession, appendVisionMessage, isVisionBlindnessReply, downgradeVisionMessageToText } = require('./media/image/vision') as typeof import('./media/image/vision') // 多模态图片会话管理
const {
  getConversationKey, getChannelKey, // 会话/频道唯一标识生成
  readConversationDisk,             // 从磁盘加载历史（冷启动）
  getConversationHistory,           // 获取当前会话历史（内存缓存 + 磁盘回退）
  saveConversationTurn,             // 保存一轮对话到缓存 + 磁盘
  clearUserConversationHistory,     // 话题切换时清空用户会话
  getRecentAssistantReplies,        // 取最近 N 条 AI 回复
  normalizeUserMessageForPrompt,    // 历史消息格式标准化
  getQuoteInfo,                     // 解析引用消息内容和作者
  getMemorySummary, // 用户记忆摘要
  channelSharedCache,               // 频道共享消息缓存（群聊上下文）
  conversationLastActiveAt,         // 会话最后活跃时间戳（用于历史降级判断）
} = require('./conversation') as typeof import('./conversation')
const { getRecentAgentContextNote, clearAgentContextForUser } = require('./chat/agent-chat-bridge') as typeof import('./chat/agent-chat-bridge') // Agent 工具摘要注入 + 话题切换清理
const { getChatToolDefinitions, getChatToolSystemHint } = require('./chat/chat-tools') as typeof import('./chat/chat-tools') // 聊天内嵌工具（表情包/贴纸等）
const {
  buildFileFollowupState,
} = require('./media/file/file-followup-guard') as typeof import('./media/file/file-followup-guard')
const {
  handleChatToolFlow,
} = require('./chat/chat-tool-flow') as typeof import('./chat/chat-tool-flow')
const { buildActiveGroupSceneNote } = require('./routing/group-scene-index') as typeof import('./routing/group-scene-index')
const { buildRandomModePrompt } = require('./behavior/random-reply-mode') as typeof import('./behavior/random-reply-mode') // 随机回复内部 mode 协议
const {
  testChatPromptRegex,
  createChatPromptBaseMessages,
  createChatPromptNsfwMessage,
  resolveChatPromptPersonaLore,
  createChatPromptLoreMessage,
  createChatPromptSearchRuleMessage,
  createChatPromptRandomContextMessage,
  createChatPromptForwardSummaryMessage,
  createChatPromptShortFollowUpMessage,
  createChatPromptGenerationRequestMessage,
  createChatPromptRareContextMessage,
  createChatPromptConversationSummaryMessage,
  createChatPromptMemoryMessage,
  createChatPromptHistoryBackgroundMessage,
  createChatPromptSeriousQuestionMessage,
  createChatPromptUncertainQuestionMessage,
  createChatPromptPoliticalSensitiveMessage,
  createChatPromptHostileEvaluationMessage,
  createChatPromptPlainUserMessage,
} = require('./chat/chat-prompt-builder') as typeof import('./chat/chat-prompt-builder') // prompt 片段构造器（纯函数）
const { routePersonaLore } = require('./persona/persona-lore-router') as typeof import('./persona/persona-lore-router') // 世界观按需注入与预算路由（纯函数）
const { normalizeText } = require('./message/message-reader') as typeof import('./message/message-reader')
const {
  isRareProvocation, isWideRareProvocation, isHostileInput, // 挑衅/敌意检测
  isJailbreakAttempt,             // 越狱检测
  hasAdminPermission,              // 管理员权限判断
  sanitizeUserInput, sanitizeUserName, // 输入/昵称安全清洗
  readTextFile, readJsonFile,      // 文件读取工具
  safeChannelKey,                  // 统一频道文件名清洗
  isEvaluationRequest,             // 评价请求识别
  getSearchCapability,             // 当前模型联网搜索能力查询
  trimReply,                       // 回复后处理（截断）
  errorMessage,                    // catch 错误消息安全提取
} = require('./core/utils') as typeof import('./core/utils')
const {
  pickRepeatedFallbackReply,  // 重复回复兜底
  isConsecutiveUserRepeat,    // 用户连续重复发言检测
} = require('./reply/reply-guard') as typeof import('./reply/reply-guard')
const {
  trimChatMemoryRuntime,
  clearGroupMemoryIfExpired,
  handleDirectMemoryWrite,
  handleMemoryConfirmation,
  rememberMemoryPrompt,
} = require('./chat/chat-memory') as typeof import('./chat/chat-memory')
const {
  finalizeChatReply,
} = require('./chat/chat-final-output-flow') as typeof import('./chat/chat-final-output-flow')
const {
  isContextJailbroken,
  chatJailbreak,
} = require('./chat/chat-jailbreak-flow') as typeof import('./chat/chat-jailbreak-flow')
const {
  resolveTopicSwitch,
} = require('./chat/chat-topic-switch') as typeof import('./chat/chat-topic-switch')
const {
  retellAgentResultForChat,
} = require('./chat/chat-agent-retell-flow') as typeof import('./chat/chat-agent-retell-flow')
const { redactSensitiveText } = require('./core/redactor') as typeof import('./core/redactor')
const {
  loadConfig,          // 加载运行时配置（API key/model/provider）
  resetConfigCache,    // 强制刷新配置缓存
  getThinkingArgs,     // 获取 thinking/推理模式参数
  getThinkingEnabled,  // 查询 thinking 开关状态
  setThinkingEnabled,  // 设置 thinking 开关
} = require('./core/runtime-config') as typeof import('./core/runtime-config')
const { isDebugLogEnabled, logDebug } = require('./core/logging-config') as typeof import('./core/logging-config') // 调试日志开关 + 输出
const {
  loadSkills,
  loadSkillsContentCache,
  refreshSkillsContentCacheIfChanged,
  getSkillsContentCache,
  buildTestSystemPrompt,
  buildFriendlySystemPrompt,
  buildFriendlySafetyFramework,
  buildAbusiveSystemPrompt,
  shouldInjectLore,
  shouldInjectTerraLore,
  getSkillsCount,
} = require('./persona/skills/skills-loader') as typeof import('./persona/skills/skills-loader') // 技能文件加载、缓存刷新和基础 system prompt
const {
  buildExpressionShadowPlan,
  formatExpressionShadowDiagnostic,
  detectExpressionSensitiveTopicActive,
  EXPRESSION_SHADOW_RECENT_SPEAKER_WINDOW_MS,
} = require('./behavior/expression/expression-shadow-router') as typeof import('./behavior/expression/expression-shadow-router') // 表达学习旁路诊断（v2.3，仅日志）
const {
  buildPersonaProfileBlocks,
  buildPersonaProfileReinforcementShadow,
  formatPersonaProfileReinforcementShadowDiagnostic,
  selectPersonaProfileBlocksByEffectiveConfidence,
  buildPersonaProfileSelectionDiagnostic,
  formatPersonaProfileSelectionDiagnostic,
  buildPersonaProfileSourceDiagnostic,
  formatPersonaProfileSourceDiagnostic,
  buildPersonaProfileShadowPreview,
  appendPersonaProfileShadowLog,
  formatPersonaProfileShadowLearningDiagnostic,
  formatPersonaProfileShadowPromptPreviewDiagnostic,
} = require('./persona/persona-profile') as typeof import('./persona/persona-profile') // 证据化 profile 影子选择诊断（不注入 prompt）

interface ChatLoggerLike {
  info?: (...args: unknown[]) => void
  warn: (...args: unknown[]) => void
}

interface ChatContextLike {
  logger(name: string): ChatLoggerLike
}

interface ChatAuthorLike {
  id?: string
  nick?: string
  name?: string
}

interface ChatBotLike {
  selfId?: string
  user?: { name?: string }
  username?: string
}

interface ChatSessionLike {
  content?: string
  guildId?: string
  channelId?: string
  isDirect?: boolean
  userId?: string
  username?: string
  selfId?: string
  messageId?: string
  type?: string
  subtype?: string
  author?: ChatAuthorLike
  bot?: ChatBotLike
  event?: {
    selfId?: string
    message?: unknown[]
    sender?: { role?: string }
  }
  quote?: {
    messageId?: string
    content?: string
    elements?: unknown
  }
  _skipVision?: boolean
  [key: string]: unknown
}

interface ChatRunOptions {
  randomTriggered?: boolean
  isAgentResult?: boolean
  agentResultText?: string
  sharedContextNote?: string
  activeSceneNote?: string
  quotedMessageNote?: string
  forwardSummaryText?: string
  replyToId?: string
  directAt?: boolean
  nameMentioned?: boolean
  mentionUserIds?: unknown[]
  meta?: Record<string, unknown>
  [key: string]: unknown
}

interface ChatMessageLike {
  role?: string
  content?: string | null | Array<Record<string, unknown>>
  tool_calls?: unknown
  tool_call_id?: string
}

interface ChatToolCallReplyLike {
  type?: string
  tool_calls?: unknown[]
  message?: { content?: string | null }
  content?: string
  reasoning?: string
}

interface ChatHeavyToolRequest {
  name?: string
  args: Record<string, unknown>
}

interface ChatHeavyToolResult {
  text: unknown
  heavyToolsRequested: ChatHeavyToolRequest[]
}

interface PublicRuntimeConfig {
  apiKey: string
  model: string
  baseURL: string
  provider: string
  searchEnabled: boolean
  [key: string]: unknown
}

interface HostileLevelEntry {
  level: number
  expireAt: number
}

interface UserProfileData {
  messages?: Array<{ content?: string }>
  names?: string[]
}

type ChatModelReply = string | ChatToolCallReplyLike
type ChatResult = string | ChatHeavyToolResult
type PublicLoadConfig = (force?: boolean) => Promise<PublicRuntimeConfig>
type PublicGetThinkingArgs = (config: PublicRuntimeConfig) => Record<string, unknown>

function asChatApiMessages(messages: ChatMessageLike[]): Parameters<typeof requestChatCompletions>[0] {
  return messages as unknown as Parameters<typeof requestChatCompletions>[0]
}

function asChatTools(tools: unknown): Parameters<typeof requestChatCompletions>[3] {
  return tools as Parameters<typeof requestChatCompletions>[3]
}

function asVisionMessages(messages: ChatMessageLike[]): Parameters<typeof appendVisionMessage>[0] {
  return messages as unknown as Parameters<typeof appendVisionMessage>[0]
}

function asChatToolFlowMessages(messages: ChatMessageLike[]): NonNullable<Parameters<typeof handleChatToolFlow>[0]>['messages'] {
  return messages as unknown as NonNullable<Parameters<typeof handleChatToolFlow>[0]>['messages']
}

function asFinalizeMessages(messages: ChatMessageLike[]): Parameters<typeof finalizeChatReply>[0]['messages'] {
  return messages as unknown as Parameters<typeof finalizeChatReply>[0]['messages']
}

function getChatErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error || '')
}

function getChatCompletionText(result: Awaited<ReturnType<typeof requestChatCompletions>> | string | null | undefined): string {
  if (typeof result === 'string') return result
  if (!result) return ''
  if (result.type === 'text') return result.content
  const message = result.message && typeof result.message === 'object' ? result.message : {}
  return String((message as { content?: unknown }).content || '')
}

function toChatText(value: unknown): string {
  if (typeof value === 'string') return value
  if (!value || typeof value !== 'object') return String(value || '')
  const record = value as Record<string, unknown>
  if (typeof record.content === 'string') return record.content
  const message = record.message
  if (message && typeof message === 'object' && typeof (message as { content?: unknown }).content === 'string') {
    return String((message as { content?: unknown }).content || '')
  }
  return String(value || '')
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {}
}

async function callOpenAIForText(messages: ChatMessageLike[], isRandom: boolean = false, extraBody: Record<string, unknown> = {}): Promise<string> {
  return toChatText(await callOpenAI(messages, isRandom, extraBody))
}

const hostileLevelCache: Map<string, HostileLevelEntry> = new Map()
let lastCacheCleanupTs = 0

function trimRuntimeCaches(now: number = Date.now()): void {
  trimChatMemoryRuntime(now)
  if (now - lastCacheCleanupTs < 300000) return
  lastCacheCleanupTs = now
  for (const [key, entry] of hostileLevelCache.entries()) {
    if (!entry || entry.expireAt <= now) hostileLevelCache.delete(key)
  }
}

// 提取当前发言者 QQ 号，管理员权限统一按这个 ID 判断。

// 管理命令只允许固定 QQ 号使用，不再跟群管理员/群主角色绑定。

// 保存群聊消息摘要，给主动插话和跨人回复理解提供线程上下文。

// 保存用户发言到磁盘，供风格注入和评价使用

// 敏感话题缓存写入（与 today-cache 并列，供敏感检测使用）

// AI 分析敏感话题（定时/消息阈值触发）

// 按消息 ID 反查最近群聊记录，供 reply 链和话题链路拼接使用。

// 追溯 reply 链，尽量把当前回复关联到正确的话题上下文里。

// 生成引用消息提示，避免用户回“这是什么”时模型对聊天记录卡片乱脑补。

// 根据 reply、@关系和最近提到当前用户的消息，尽量只截取当前子话题的上下文。

// LCS 主判据是 lcs/shorter >= 0.5，因此只关心 lcs 是否超过阈值。
// 优化点：
// 1. 总让较短串作内层循环，dp 长度从 max(m,n)+1 缩到 min(m,n)+1。
// 2. 一旦 lcs 达到阈值立即返回，避免完整 O(m*n) 扫描。

// 廉价的字符集 Jaccard 上界估计：两串的字符集交集大小是 LCS 长度的上界。
// 如果连字符集都不够重叠，就不可能达到相似度阈值，可以直接放弃 LCS。

// 统一请求 OpenAI 兼容的 Chat Completions 接口。

// 把 Chat 风格消息转成 Responses API 所需的 input 结构。

// 从 Responses API 返回值中提取最终文本。

// 通过 OpenAI 官方 Responses API 调用 `web_search` 工具。

// 按当前接口能力选择普通对话或联网检索调用方式。
async function callOpenAI(messages: ChatMessageLike[], isRandom: boolean, extraBody: Record<string, unknown> = {}, tools: unknown = null): Promise<ChatModelReply> {
  const config = await loadConfig()
  if (!config.apiKey) throw new Error('AI key file is empty.')
  const thinkingEnabled = getThinkingEnabled()
  const managedThinkingMeta = {
    _thinkingManaged: true,
    _thinkingEnabled: thinkingEnabled,
    _explicitThinkingKeys: ['enable_thinking', 'thinking'].filter(key => extraBody[key] !== undefined),
  }

  const capability = getSearchCapability(config)
  if (!config.searchEnabled || !capability.supported) {
    const result = await requestChatCompletions(asChatApiMessages(messages), config, { ...getThinkingArgs(config), ...(isRandom ? { max_tokens: 200 } : {}), ...extraBody, ...managedThinkingMeta }, asChatTools(tools))
    if (result && result.type === 'tool_calls') return result
    return getChatCompletionText(result)
  }

  if (capability.mode === 'dashscope-chat') {
    const result = await requestChatCompletions(asChatApiMessages(messages), config, { ...getThinkingArgs(config), enable_search: true, search_options: { forced_search: true }, ...extraBody, ...managedThinkingMeta }, asChatTools(tools))
    if (result && result.type === 'tool_calls') return result
    return getChatCompletionText(result)
  }

  if (capability.mode === 'openai-chat-search') {
    const result = await requestChatCompletions(asChatApiMessages(messages), config, { ...getThinkingArgs(config), web_search_options: {}, ...extraBody, ...managedThinkingMeta }, asChatTools(tools))
    if (result && result.type === 'tool_calls') return result
    return getChatCompletionText(result)
  }

  if (capability.mode === 'openai-responses') {
    return requestOpenAIResponsesWithSearch(asChatApiMessages(messages), config)
  }

  const result = await requestChatCompletions(asChatApiMessages(messages), config, { ...getThinkingArgs(config), ...(isRandom ? { max_tokens: 200 } : {}), ...extraBody, ...managedThinkingMeta }, asChatTools(tools))
  if (result && result.type === 'tool_calls') return result
  return getChatCompletionText(result)
}

// FUNCTION SIZE GATE: 该函数当前约 350 行。上限 400 行。
// 触发线：新增逻辑超过 10 行 / 新增状态超过 2 个 key → 先提出拆分方案。
async function chat(session: ChatSessionLike, userText: string, ctx: ChatContextLike, options: ChatRunOptions = {}): Promise<ChatResult> {
  trimRuntimeCaches()
  await refreshSkillsContentCacheIfChanged()
  const skillsContentCache = getSkillsContentCache() as Record<string, string>
  const cleanInput = sanitizeUserInput(userText)
  const rareProvocation = isRareProvocation(cleanInput)
  const japanLinked = JAPAN_SELF_IDENTIFY_RE.test(cleanInput)
  const wideRareHit = isWideRareProvocation(cleanInput) || japanLinked
  const testMode = require('fs').existsSync(TEST_MODE_FILE) && hasAdminPermission(session)

  // #7 群记忆定时清空检查
  const channelKey = getChannelKey(session)
  await clearGroupMemoryIfExpired(session, channelKey)

  // 人格系统：用户级 > 群级 > 默认（必须在 hostile 之前，因为 hostile 需要 personaName）
  const currentUserId = session.userId || session.author?.id || session.username || ''
  const personaResolution = resolvePersona(channelKey, currentUserId)
  let personaName = personaResolution.name
  let personaSkillContent = null
  // 测试模式强制忽略人格
  if (testMode) personaName = null
  if (personaName) {
    personaSkillContent = loadPersonalSkill(personaName)
    if (!personaSkillContent) {
      try { ctx.logger('dongxuelian-ai').warn(`persona bound but skill load failed: persona=${personaName} channelKey=${channelKey} source=${personaResolution.source}`) } catch { /* non-critical: logger may be unavailable in tests */ }
    }
  }

  // 主动记忆写入：用户说"记住XXX"直接存，跳过AI反问
  const directMemoryReply = await handleDirectMemoryWrite({ cleanInput, currentUserId, channelKey, inGuild: !!session.guildId })
  if (directMemoryReply) return directMemoryReply

  // 记忆系统：用户确认写入 / 口头纠正
  await handleMemoryConfirmation({ session, cleanInput, currentUserId, channelKey, inGuild: !!session.guildId })

  // 反击值系统：三态（0=友善, 1=阴阳, 2=嘴臭），自定义人格时绕过 + 仇恨缓存 30s
  let retaliationLevel = 0
  if (!testMode && !personaName) {
    const hostileInputDetected = isHostileInput(cleanInput) || japanLinked || rareProvocation
    let newLevel = 0
    if (hostileInputDetected) {
      const score = await calculateRetaliationScore(cleanInput, currentUserId, channelSharedCache, channelKey)
      if (score >= 90 && require('fs').existsSync(HOSTILE_MODE_FILE)) {
        newLevel = 2
      } else if (score >= 60) {
        newLevel = 1
      }
    }
    const cacheKey = channelKey + ':' + currentUserId
    const cached = hostileLevelCache.get(cacheKey)
    if (cached && cached.expireAt > Date.now()) {
      if (hostileInputDetected) {
        retaliationLevel = Math.max(newLevel, cached.level)
        hostileLevelCache.set(cacheKey, { level: retaliationLevel, expireAt: Date.now() + 30000 })
      } else {
        retaliationLevel = Math.max(0, cached.level - 1)
        if (retaliationLevel === 0) {
          hostileLevelCache.delete(cacheKey)
        } else {
          hostileLevelCache.set(cacheKey, { level: retaliationLevel, expireAt: Date.now() + 30000 })
        }
      }
    } else if (hostileInputDetected) {
      retaliationLevel = newLevel
      hostileLevelCache.set(cacheKey, { level: retaliationLevel, expireAt: Date.now() + 30000 })
    }
  }
  const hostile = retaliationLevel >= 2  // 嘴臭 only（兼容下游引用）
  const yinyang = retaliationLevel === 1 // 阴阳

  // 构建系统提示词：友善 / 阴阳 / 嘴臭 / 自定义人格
  let systemPrompt
  if (testMode) {
    systemPrompt = buildTestSystemPrompt()
  } else if (hostile) {
    systemPrompt = buildAbusiveSystemPrompt()
  } else if (yinyang) {
    systemPrompt = skillsContentCache['mode:persona-yinyang'] || buildAbusiveSystemPrompt()
  } else {
    if (personaName && personaSkillContent) {
      systemPrompt = buildFriendlySafetyFramework() + '\n\n' + personaSkillContent
    } else {
      systemPrompt = buildFriendlySystemPrompt()
    }
  }

  // 不翻旧账 + 禁止输出思考过程
  systemPrompt += '\n\n专注当前对话。历史记录仅作为背景参考，不要主动提及，除非用户明确问"还记得吗""之前说过"——只有这时才可以翻看历史。'
  systemPrompt += '\n\n禁止输出思考过程。不要分析用户说了什么，不要解释你打算怎么回复，不要复述系统指令，直接说人话。'
  systemPrompt += '\n\nQQ 回复节奏：一般闲聊、建议、评价默认一条或两条内说完；只有教程、清单、复杂解释才多段。可以自然换行，但不要把每个句子都拆成一条消息。'
  systemPrompt += '\n\n工具调用是内部动作。需要查网页、读链接、看历史图时可以自己调用工具，但最终只给用户结果或自然等待话术，禁止说“我会调用某函数/工具”“我需要先调用”。'
  systemPrompt += '\n<user> 标签中的昵称标识了是谁发的消息，避免混淆不同用户的消息。'
  const botSelfId = String(session.selfId || session.bot?.selfId || session.event?.selfId || '').trim()
  const botSelfNick = sanitizeUserName(normalizeText(session.bot?.user?.name || session.bot?.username || ''))
  const botIdentityLabel = personaName || (testMode ? '测试模式' : (yinyang ? '阴阳莲莲' : (hostile ? '嘴臭莲莲' : '东雪莲')))
  systemPrompt += `\n\n身份锚：你当前在群里以"${botIdentityLabel}"的身份发言${botSelfNick ? `（群昵称：${botSelfNick}）` : ''}${botSelfId ? `，QQ 号 ${botSelfId}` : ''}。<user> 段里出现的昵称是说话人，不是你自己；他人发言里提到"东雪莲/莲莲/${botIdentityLabel}"或别的群友昵称，都只是在指代别人，不要把自己代入进去。`
  const now = new Date()
  const pad2 = n => String(n).padStart(2, '0')
  const dynamicTimePrompt = `当前时间：${now.getFullYear()}年${pad2(now.getMonth() + 1)}月${pad2(now.getDate())}日 ${pad2(now.getHours())}时${pad2(now.getMinutes())}分。核心信息（爱好、习惯、身份等）在下方【记住的】中列出，日常聊天记录中也可能有重复信息，以【记住的】中的内容为准。当用户分享关于自己的重要信息时，你可以自然地问一句是否需要记住，系统会自动记录。`

  const modeLabel = retaliationLevel === 2 ? 'abusive' : retaliationLevel === 1 ? 'yin-yang' : 'friendly'
  logDebug(ctx, 'chat', `mode=${modeLabel} channelKey=${channelKey} persona=${personaName || 'none'} skillLen=${(personaSkillContent || '').length} inputLen=${String(userText || '').length}`)

  const userName = normalizeText(
    session.author?.nick ||
    session.author?.name ||
    session.username ||
    '用户'
  )
  const safeUserName = sanitizeUserName(userName)
  const currentUserMessage = `<user>\n昵称：${safeUserName}\n发言：${cleanInput}\n</user>`

  if (isConsecutiveUserRepeat(session, cleanInput)) {
    const repeatedReply = Math.random() < 0.5
      ? trimReply(cleanInput, MAX_OUTPUT_CHARS_FRIENDLY)
      : trimReply(pickRepeatedFallbackReply(session), MAX_OUTPUT_CHARS_ABUSIVE)
    saveConversationTurn(session, currentUserMessage, repeatedReply)
    return repeatedReply
  }

  // 输入层越狱拦截：检测到 prompt injection 走专用嘲讽模型，不走正常 chat 流程
  if (isJailbreakAttempt(cleanInput)) {
    ctx.logger('dongxuelian-ai').warn(`jailbreak attempt detected, blocking. input: ${cleanInput.slice(0, 80)}`)
    const jailbreakReply = await chatJailbreak(session, cleanInput, ctx, { systemPrompt })
    saveConversationTurn(session, currentUserMessage, jailbreakReply)
    return jailbreakReply
  }

  // 上下文越狱检测：历史回复显示已被软越狱积累（如持续出现喵/主人），清空历史重置
  if (!personaName && isContextJailbroken(session)) {
    ctx.logger('dongxuelian-ai').warn(`context jailbreak detected, clearing history. key: ${getConversationKey(session)}`)
    clearUserConversationHistory(session)
    const jailbreakReply = await chatJailbreak(session, cleanInput, ctx, { systemPrompt })
    saveConversationTurn(session, currentUserMessage, jailbreakReply)
    return jailbreakReply
  }

  // Agent 结果注入：Agent 结果作为上下文，走正常 chat 流程（1 次 AI 调用）
  if (options.isAgentResult && options.agentResultText) {
    const agentFinal = await retellAgentResultForChat({
      session,
      ctx,
      options,
      agentResultText: options.agentResultText,
      cleanInput,
      channelKey,
      systemPrompt,
      currentUserMessage,
      userName,
      retaliationLevel,
      callModel: callOpenAI,
      now,
    })
    saveConversationTurn(session, currentUserMessage, agentFinal)
    return agentFinal
  }

  const contextTag = options.randomTriggered ? '\n[群聊刷到]' : ''
  const quoteInfo = getQuoteInfo(session, { replyToId: options.replyToId })
  const qc2 = redactSensitiveText(String(quoteInfo.content || '')).replace(/[<>]/g, ch => (ch === '<' ? '＜' : '＞')).slice(0, 500)
  const quoteAuthor = quoteInfo.isSelf ? '你自己' : quoteInfo.authorName
  const quotedTag = qc2
    ? quoteInfo.isSelf
      ? '\n[引用你自己历史回复的原话]\n' + qc2 + '\n[以上是你自己之前说过的话，不是 ' + safeUserName + ' 说的，也不是群友观点；不要攻击自己]'
      : '\n[引用 ' + (quoteAuthor || '消息') + ' 的原话]\n' + qc2 + '\n[以上是引用内容，不是 ' + safeUserName + ' 说的]'
    : ''
  const inboundMentionIds = Array.isArray(options.mentionUserIds) ? options.mentionUserIds.map(item => String(item || '')).filter(Boolean) : []
  const mentionsBot = !!botSelfId && inboundMentionIds.includes(botSelfId)
  const otherMentionIds = inboundMentionIds.filter(id => !botSelfId || id !== botSelfId)
  const mentionTagParts = []
  if (mentionsBot) mentionTagParts.push('[此条@你本人]')
  if (otherMentionIds.length) mentionTagParts.push('[此条还@了群友：' + otherMentionIds.slice(0, 5).join('、') + '。提到的内容针对那些群友，不是针对你；除非也@你或直接喊你的名字，否则不要把自己代入]')
  const mentionTag = mentionTagParts.length ? '\n' + mentionTagParts.join('\n') : ''
  const isolatedUserMessage = `<user>\n昵称：${safeUserName}\n发言：${cleanInput}${contextTag}${quotedTag}${mentionTag}\n</user>`

  // 话题检测：对比上一条消息和当前消息（per-key lock）
  // 结果：true=切换 false=未切换 null=检测失败（降级处理）
  const topicKey = getConversationKey(session)
  const topicSwitchResult = await resolveTopicSwitch({ topicKey, session, currentText: cleanInput })
  if (topicSwitchResult === true) {
    clearUserConversationHistory(session)
    clearAgentContextForUser(channelKey, currentUserId)
  }

  const rawHistory = getConversationHistory(session).map(normalizeUserMessageForPrompt)

  // 历史分层：检测失败或长时间不活跃时，旧历史降级为背景参考而非活跃对话
  let historyMessages = rawHistory
  let historyAsBackground = ''
  const lastActiveAt = conversationLastActiveAt.get(topicKey)
  const inactiveDuration = lastActiveAt ? (Date.now() - lastActiveAt) : Infinity
  const HISTORY_DEGRADE_MS = 30 * 60 * 1000

  if (topicSwitchResult === null && rawHistory.length > 0) {
    historyAsBackground = rawHistory.map(m => `${m.role === 'user' ? '用户' : 'AI'}：${(m.content || '').slice(0, 150)}`).join('\n').slice(0, 2000)
    historyMessages = []
  } else if (inactiveDuration > HISTORY_DEGRADE_MS && rawHistory.length > 0) {
    historyAsBackground = rawHistory.map(m => `${m.role === 'user' ? '用户' : 'AI'}：${(m.content || '').slice(0, 150)}`).join('\n').slice(0, 2000)
    historyMessages = []
  }

  const messages: ChatMessageLike[] = createChatPromptBaseMessages(systemPrompt, dynamicTimePrompt)

  // NSFW 策略：自定义人格中 nsfw: reply 时注入适度宽松指引
  const nsfwMessage = createChatPromptNsfwMessage(personaName, personaSkillContent)
  if (nsfwMessage) messages.push(nsfwMessage)

  // 世界观按需注入：从人格文件的 frontmatter 读取 lore 绑定
  const personaLore = resolveChatPromptPersonaLore(personaName, personaSkillContent)
  const loreRoute = routePersonaLore({
    personaLore,
    cleanInput,
    skillsContentCache,
  })
  const loreMessage = createChatPromptLoreMessage({
    personaLore,
    skillsContentCache,
    cleanInput,
    shouldInjectLore,
    shouldInjectTerraLore,
    routeResult: loreRoute,
  })
  if (loreMessage) messages.push(loreMessage)

  // 联网搜索时强制模型先搜索再回答
  const configForSearch = await loadConfig()
  const searchCap = getSearchCapability(configForSearch)
  const searchRuleMessage = createChatPromptSearchRuleMessage(configForSearch, searchCap)
  if (searchRuleMessage) messages.push(searchRuleMessage)

  if (options.sharedContextNote) {
    messages.push({ role: 'system', content: options.sharedContextNote })
  }

  const activeSceneNote = options.activeSceneNote || buildActiveGroupSceneNote(channelKey, channelSharedCache.get(channelKey) || [], currentUserId, {
    currentText: cleanInput,
    randomTriggered: options.randomTriggered,
    personaName,
    directAt: !!options.directAt,
    nameMentioned: !!options.nameMentioned,
    isDirect: !!session.isDirect,
    currentMessageId: String(session.messageId || ''),
    currentReplyToId: String(options.replyToId || session.quote?.messageId || ''),
  })
  if (activeSceneNote) {
    messages.push({ role: 'system', content: activeSceneNote })
  }

  const agentContextNote = getRecentAgentContextNote({
    channelKey,
    userId: currentUserId,
    userMessage: cleanInput,
  })
  if (agentContextNote) {
    messages.push({ role: 'system', content: agentContextNote })
  }

  if (options.quotedMessageNote && !quotedTag) {
    messages.push({ role: 'system', content: options.quotedMessageNote })
  }

  const randomContextMessage = createChatPromptRandomContextMessage(options.randomTriggered)
  if (randomContextMessage) messages.push(randomContextMessage)
  if (options.randomTriggered) {
    messages.push({ role: 'system', content: buildRandomModePrompt() })
  }
  const forwardSummaryMessage = createChatPromptForwardSummaryMessage(options.forwardSummaryText)
  if (forwardSummaryMessage) messages.push(forwardSummaryMessage)

  if (cleanInput && cleanInput.length <= 6) {
    const recentAssistant = getRecentAssistantReplies(session, 1).pop()
    if (recentAssistant && /[?？吗呢吧嘛]\s*$/.test(recentAssistant)) {
      const shortFollowUpMessage = createChatPromptShortFollowUpMessage(cleanInput, recentAssistant, { isFollowUp: true })
      if (shortFollowUpMessage) messages.push(shortFollowUpMessage)
    }
  }
  const generationRequestMessage = createChatPromptGenerationRequestMessage(cleanInput, GENERATION_REQUEST_RE)
  if (generationRequestMessage) messages.push(generationRequestMessage)

  let rareConfirmed = wideRareHit
  if (rareConfirmed && !isRareProvocation(cleanInput) && !japanLinked) {
    try {
      const cfg = await loadConfig()
      const rareJudgeObj = await requestChatCompletions(
        [{ role: 'system', content: '你是一个内容判断器。判断以下用户消息是否在阴阳 Bot 的国籍、稀有度或身份归属。只输出一个字：Y 或 N。不要输出任何其他文字。' },
         { role: 'user', content: cleanInput.slice(0, 200) }],
        cfg,
        { max_tokens: 5, _fallbackSet: 'lightweight' }
      )
      const rareJudge = getChatCompletionText(rareJudgeObj)
      rareConfirmed = /^Y/i.test(rareJudge)
    } catch {
      /* non-critical: rare provocation lightweight judge falls back to no rare context */
      rareConfirmed = false
    }
  }
  if (options.meta && typeof options.meta === 'object') options.meta.rareConfirmed = Boolean(rareConfirmed)
  const rareContextMessage = createChatPromptRareContextMessage({ rareConfirmed, retaliationLevel, rareProvocation })
  if (rareContextMessage) messages.push(rareContextMessage)

  // 注入对话摘要（仅在长对话时作为背景参考）
  const convKey = getConversationKey(session)
  const convDisk = readConversationDisk(convKey)
  const conversationSummaryMessage = createChatPromptConversationSummaryMessage(convDisk)
  if (conversationSummaryMessage) messages.push(conversationSummaryMessage)

  // 用户记忆注入（核心信息，加前缀防止翻旧账）
  const memorySummary = await getMemorySummary(currentUserId, channelKey)
  const memoryMessage = createChatPromptMemoryMessage(memorySummary)
  if (memoryMessage) messages.push(memoryMessage)

  // Profile Phase 5.5 影子诊断：只读、只记录，不注入 prompt。
  if (isDebugLogEnabled('persona-profile')) {
    try {
      const profileNow = Date.now()
      const profile = await buildPersonaProfileBlocks({
        userId: currentUserId,
        channelKey,
        includeRecentMessages: true,
        maxRecentMessages: 5,
        includeAgentMemory: false,
      })
      logDebug(ctx, 'persona-profile', formatPersonaProfileSourceDiagnostic(buildPersonaProfileSourceDiagnostic(profile, { userId: currentUserId, channelKey })))
      const reinforcementShadow = buildPersonaProfileReinforcementShadow(profile.blocks, { now: profileNow })
      logDebug(ctx, 'persona-profile', formatPersonaProfileReinforcementShadowDiagnostic(reinforcementShadow))
      const selection = selectPersonaProfileBlocksByEffectiveConfidence(reinforcementShadow.blocks, {
        now: profileNow,
        limit: 5,
        minEffectiveConfidence: 0.1,
        allowedStatuses: ['active', 'candidate'],
      })
      const diagnostic = buildPersonaProfileSelectionDiagnostic(profile, { selection, userId: currentUserId, channelKey })
      logDebug(ctx, 'persona-profile', formatPersonaProfileSelectionDiagnostic(diagnostic))
      const shadowPreview = buildPersonaProfileShadowPreview({ ...profile, blocks: reinforcementShadow.blocks }, { selection, userId: currentUserId, channelKey, now: profileNow })
      logDebug(ctx, 'persona-profile', formatPersonaProfileShadowLearningDiagnostic(shadowPreview))
      logDebug(ctx, 'persona-profile', formatPersonaProfileShadowPromptPreviewDiagnostic(shadowPreview))
      appendPersonaProfileShadowLog(shadowPreview)
        .then(result => {
          const writeResult = asRecord(result)
          const preview = asRecord(shadowPreview)
          const candidates = Array.isArray(preview.candidates) ? preview.candidates.length : 0
          try { logDebug(ctx, 'persona-profile', `profile_shadow_jsonl written=true file=${path.basename(String(writeResult.file || ''))} candidates=${candidates} mode=shadow_only prompt=unchanged`) } catch { /* non-critical: debug log failure must not affect chat reply */ }
        })
        .catch(error => {
          try { logDebug(ctx, 'persona-profile', `profile_shadow_jsonl_failed reason=${String((error && error.message) || 'unknown').slice(0, 80)} mode=shadow_only prompt=unchanged`) } catch { /* non-critical: debug log failure must not affect chat reply */ }
        })
    } catch (profileError) {
      try { logDebug(ctx, 'persona-profile', `profile_selection_failed reason=${String(errorMessage(profileError) || 'unknown').slice(0, 80)}`) } catch { /* non-critical: debug log failure must not affect chat reply */ }
    }
  }

  const historyBackgroundMessage = createChatPromptHistoryBackgroundMessage(historyAsBackground)
  if (historyBackgroundMessage) messages.push(historyBackgroundMessage)
  messages.push(...(historyMessages as ChatMessageLike[]))

  // 用户发言风格注入 + 评价功能
  const chatUserId = String(session.userId || session.author?.id || session.username || '')
  const chatChannelKey = getChannelKey(session)
  const chatProfileSafeKey = safeChannelKey(chatChannelKey)
  if (chatUserId && session.guildId) {
    const pp = path.join(USER_PROFILE_DIR, chatProfileSafeKey, chatUserId + '.json')
    const pd = await readJsonFile(pp, null).catch(() => null)
    if (pd && Array.isArray(pd.messages) && pd.messages.length > 0) {
      const snippets = pd.messages.slice(-3).map(m => m.content).join('\n').slice(0, 2000)
      if (snippets) {
        messages.push({
          role: 'system',
          content: `[内部参考-用户近期发言风格]\n对象：${safeUserName}\n以下片段只用于判断这个用户平时的表达习惯，禁止原样输出，禁止用“这是你在本群的发言/昵称/发言”这类内部格式开头。\n${snippets}`,
        })
      }
    }
  }

  // 评价检测：@某人时用轻量模型摘要后注入
  const evalMatch = cleanInput.match(/(?:评价|如何评价|评价一下)\s*(.*)/)
  if (evalMatch && retaliationLevel === 0) {
    const requestedName = normalizeText(evalMatch[1]).replace(/[.,!?]+$/, '')
    let targetProfile = null
    const evalUserIds = Array.isArray(options.mentionUserIds) ? options.mentionUserIds.map(item => String(item || '')).filter(Boolean) : []
    if (evalUserIds.length > 0) {
      const ef = path.join(USER_PROFILE_DIR, chatProfileSafeKey, evalUserIds[0] + '.json')
      targetProfile = await readJsonFile(ef, null).catch(() => null)
    }
    if (targetProfile) {
      const rawMessages = (targetProfile.messages || []).slice(-20).map(m => m.content).join('\n').slice(0, 3000)
      if (rawMessages) {
        let summary = ''
        const summaryModels = [
          { provider: 'glm', model: 'glm-4.6v-flash', keyFile: GLM_KEY_FILE },
          { provider: 'dashscope', model: 'qwen-turbo', keyFile: DASHSCOPE_KEY_FILE },
          { provider: 'opencode', model: 'deepseek-v4-flash', keyFile: null },
        ]
        for (const am of summaryModels) {
          const provDef = PROVIDERS[am.provider]
          if (!provDef) continue
          try {
            const config = await loadConfig()
            const apiKey = am.keyFile ? (await readTextFile(am.keyFile).catch(() => '') || config.apiKey).replace(/[\r\n]+/g, '') : config.apiKey
            if (!apiKey) continue
            const ac = new AbortController()
            const timer = setTimeout(() => ac.abort(), 8000)
            const summaryResult = await requestChatCompletions(
              [{ role: 'system', content: '把以下发言用 200 字以内概括其发言风格和常用话题，越精炼越好。' },
               { role: 'user', content: rawMessages }],
              { model: am.model, baseURL: provDef.baseURL.replace(/\/+$/, ''), apiKey, provider: am.provider },
              { max_tokens: 200, signal: ac.signal, _fallbackSet: 'lightweight' }
            )
            summary = getChatCompletionText(summaryResult)
            clearTimeout(timer)
            if (summary) break
          } catch { /* non-critical: lightweight profile summary model fallback keeps trying next model */ }
        }
        if (summary) {
          const cleaned = summary.replace(/^(?:该用户|这个用户|此人|对方|ta)的发言风格[是为：]?\s*/i, '').slice(0, 200)
          messages.push({
            role: 'system',
            content: `用户在让你评价@${requestedName || targetProfile.names?.[0] || 'ta'}。ta 的发言风格：${cleaned}。用你当前的人设简单回应几句，不要变成中性分析报告。`,
          })
        } else {
          messages.push({
            role: 'user',
            content: `以下是"${targetProfile.names?.[0] || 'ta'}"最近的发言，请根据这些评价ta：\n${rawMessages.slice(0, 2000)}`,
          })
        }
      }
    } else if (evalUserIds.length > 0) {
      messages.push({
        role: 'user',
        content: '用户在让你评价对方。直接说。',
      })
    }
  }

  // 正经问题优先回答
  const seriousKeywords = /^(什么是|怎么|如何|为什么|哪个好|谁|多少|什么时候|鸣潮|原神|有没有|能不能|可以帮我|帮我查|给我|这图|这张图|这是什么|帮我写)/
  const seriousQuestionMessage = createChatPromptSeriousQuestionMessage(cleanInput, seriousKeywords, retaliationLevel)
  if (seriousQuestionMessage) messages.push(seriousQuestionMessage)

  // 不确定问题不要胡编
  const uncertainKeywords = /(?:是不是|对不对|帮我看看|怎么解决|报错|配置|什么原因|怎么回事|如何修复|该怎么做|好玩吗|好用吗|值得.{0,4}吗|推荐吗|怎么样$)/
  const uncertainQuestionMessage = createChatPromptUncertainQuestionMessage(cleanInput, uncertainKeywords, retaliationLevel)
  if (uncertainQuestionMessage) messages.push(uncertainQuestionMessage)

  // 敏感检测开启时固定拒答用语（仅当前消息含政治关键词时）
  const detectList = await readJsonFile(POLITICAL_DETECT_FILE, []).catch(() => [])
  const politicalSensitiveMessage = createChatPromptPoliticalSensitiveMessage({
    detectList,
    channelKey: getChannelKey(session),
    cleanInput,
    sensitiveKeywordsRe: SENSITIVE_KEYWORDS_RE,
  })
  if (politicalSensitiveMessage) messages.push(politicalSensitiveMessage)

  // 识图：获取本地图片 → 多模态或 OCR 回退
  let wasVisionRequest = false
  let visionContext = null
  if (isVisionSession(session)) {
    let vc = await loadConfig(true)
    if (!isVisionModel(vc.provider, vc.model)) {
      const visionFallbacks = [
        { provider: 'glm', model: 'glm-4.6v-flash', keyFile: GLM_KEY_FILE },
        { provider: 'dashscope', model: 'qwen3.5-plus', keyFile: DASHSCOPE_KEY_FILE },
        { provider: 'dashscope', model: 'qwen3.6-plus', keyFile: DASHSCOPE_KEY_FILE },
      ]
      let used = false
      for (const fb of visionFallbacks) {
        if (isVisionModel(fb.provider, fb.model)) {
          vc.model = fb.model
          vc.baseURL = PROVIDERS[fb.provider].baseURL
          vc.apiKey = (await readTextFile(fb.keyFile).catch(() => '') || vc.apiKey).replace(/[\r\n]+/g, '')
          vc.provider = fb.provider
          used = true
          break
        }
      }
      if (!used) {
        clearVisionSession(session)
        return ''
      }
    }
    const visionPromptText = options.randomTriggered
      ? '[群里刷到一张图。如果你看清了图，按你的人设风格说一句感受；不要假设这是有人专程拿给你看的。]'
      : '[用户发来一张图。按你的人设风格简单回应一句。]'
    const visionResult = await appendVisionMessage(asVisionMessages(messages), session, vc, ctx, {
      promptText: visionPromptText,
      readFailReply: '图片读取失败，换个图试试？',
      inaccessibleReply: '图片无法访问，换个图试试？',
      identifyFailReply: '图片识别失败，换个图试试？',
    })
    if (!visionResult.ok) return visionResult.reply
    visionContext = visionResult.visionContext || null
    wasVisionRequest = true
  } else {
    messages.push(createChatPromptPlainUserMessage(isolatedUserMessage))
  }

  const hostileEvaluationMessage = createChatPromptHostileEvaluationMessage(isEvaluationRequest, cleanInput, hostile)
  if (hostileEvaluationMessage) messages.push(hostileEvaluationMessage)

  // Chat 轻量工具注入
  const chatTools = getChatToolDefinitions({ channel: 'qq', userText: cleanInput, randomTriggered: options.randomTriggered })
  const fileFollowupState = await buildFileFollowupState(channelKey, cleanInput, { userId: currentUserId })
  const activeFileContext = fileFollowupState.targetFile
    ? {
        activeFileMessageId: String(fileFollowupState.targetFile.messageId || ''),
        activeFileName: fileFollowupState.targetFile.fileName || '',
      }
    : {}
  messages.push({ role: 'system', content: getChatToolSystemHint(channelKey, { channel: 'qq', userText: cleanInput }) })

  // 表达学习旁路诊断（v2.3，shadow，仅日志，不修改 messages）
  try {
    const shadowNow = Date.now()
    const cacheItems = (channelSharedCache && typeof channelSharedCache.get === 'function')
      ? (channelSharedCache.get(channelKey) || [])
      : []
    const recentItems: Array<{ content?: string; ts?: number; timestamp?: number }> = []
    const recentSpeakerSet: Set<string> = new Set()
    const since = shadowNow - EXPRESSION_SHADOW_RECENT_SPEAKER_WINDOW_MS
    for (const it of cacheItems) {
      if (!it || typeof it !== 'object') continue
      const ts = Number(it.ts || 0)
      if (Number.isFinite(ts) && ts > 0 && ts < since) continue
      recentItems.push(it)
      const uid = String(it.userId || '').trim()
      if (uid) recentSpeakerSet.add(uid)
    }
    const sensitiveTopicActive = detectExpressionSensitiveTopicActive(recentItems, shadowNow)
    const shadowPlan = buildExpressionShadowPlan({
      channelKey,
      personaName,
      cleanInput,
      recentSpeakerIds: Array.from(recentSpeakerSet),
      sensitiveTopicActive,
      now: shadowNow,
    } as Parameters<typeof buildExpressionShadowPlan>[0] & { cleanInput?: string })
    logDebug(ctx, 'expression-pool', formatExpressionShadowDiagnostic(shadowPlan))
  } catch (shadowError) {
    try { logDebug(ctx, 'expression-pool', `shadow_failed reason=${String(errorMessage(shadowError) || 'unknown').slice(0, 80)}`) } catch { /* non-critical: expression shadow diagnostics never block chat */ }
  }

  let reply = await callOpenAI(messages, options.randomTriggered, {}, chatTools)

  const toolFlowResult = await handleChatToolFlow({
    reply,
    messages: asChatToolFlowMessages(messages),
    options,
    cleanInput,
    session,
    currentUserId,
    channelKey,
    activeFileContext,
    fileFollowupState: fileFollowupState as unknown as Record<string, unknown>,
    chatTools,
    callModel: callOpenAI,
  })
  if (toolFlowResult.heavyToolsRequested) {
    return {
      text: toolFlowResult.reply,
      heavyToolsRequested: toolFlowResult.heavyToolsRequested,
    }
  }
  let replyText = toChatText(toolFlowResult.reply)
  const usedReminderActionTool = toolFlowResult.usedReminderActionTool
  const usedUploadedFileVariantTool = toolFlowResult.usedUploadedFileVariantTool

  // 记录 AI 提问"需要记住"的时间戳，供 memory 确认超时使用
  rememberMemoryPrompt(currentUserId, channelKey, replyText)

  // 模型输出文本格式 tool_call 时，strip 后重试（不带 tools）
  if (/<tool_call>/i.test(replyText)) {
    const stripped = replyText.replace(/<tool_call>[\s\S]*?<\/tool_call>/gi, '').replace(/<tool_call>[\s\S]*$/gi, '').trim()
    if (stripped && stripped.length > 5) {
      replyText = stripped
    } else {
      messages.push({ role: 'assistant', content: replyText })
      messages.push({ role: 'user', content: '【系统提示：不要输出工具调用格式，直接用自然语言回答。】' })
      replyText = await callOpenAIForText(messages, !!options.randomTriggered)
    }
  }

  // vision 对账：模型说"看不到图/再发一遍"通常意味着 image_url 没被 provider/model 真正解析。
  // 把多模态 user 消息降级为纯文本占位，再请求一次，避免输出"我没法看到你说的图 + 编造话题硬蹭"这类自相矛盾结果。
  if (wasVisionRequest && visionContext && isVisionBlindnessReply(replyText)) {
    if (downgradeVisionMessageToText(asVisionMessages(messages), visionContext, '[图片暂时取不到，请按当前文字上下文回复，不要假设你看到了什么图]')) {
      try { ctx.logger('dongxuelian-ai').warn(`vision blindness detected, downgrading. provider=${visionContext.provider} model=${visionContext.model} reply=${replyText.slice(0, 60)}`) } catch { /* non-critical: logger may be unavailable in tests */ }
      replyText = await callOpenAIForText(messages, !!options.randomTriggered)
      visionContext = null
    }
  }

  if (JAILBREAK_OUTPUT_RE.test(replyText)) {
    ctx.logger('dongxuelian-ai').warn(`jailbreak output detected, forcing fallback. reply: ${replyText.slice(0, 80)}`)
    const jailbreakReply = await chatJailbreak(session, cleanInput, ctx, { systemPrompt })
    saveConversationTurn(session, currentUserMessage, jailbreakReply)
    return jailbreakReply
  }

  const finalResult = await finalizeChatReply({
    reply: replyText,
    messages: asFinalizeMessages(messages),
    session,
    ctx,
    options,
    cleanInput,
    currentUserId,
    channelKey,
    systemPrompt,
    currentUserMessage,
    userName,
    retaliationLevel,
    rareConfirmed,
    usedReminderActionTool,
    usedUploadedFileVariantTool,
    callModel: callOpenAIForText,
  })
  if (!finalResult.shouldSend) return ''
  const finalReply = finalResult.finalReply

  saveConversationTurn(session, currentUserMessage, finalReply)
  return finalReply
}

export = {
  chat,                  // 主聊天入口（session → AI 回复）
  loadConfig: loadConfig as PublicLoadConfig,            // re-export: 运行时配置加载
  resetConfigCache,      // re-export: 强制刷新配置
  loadSkills,            // 加载技能文件列表到缓存
  loadSkillsContentCache, // 加载技能文件内容到缓存
  refreshSkillsContentCacheIfChanged, // skill 文件变更时刷新聊天进程缓存
  callOpenAI,            // 底层 LLM 调用（带重试/截断/工具循环）
  getThinkingArgs: getThinkingArgs as PublicGetThinkingArgs,       // re-export: thinking 模式参数
  getSkillsCount,        // 已加载技能数量
  getThinkingEnabled,    // re-export: thinking 开关查询
  setThinkingEnabled,    // re-export: thinking 开关设置
}
