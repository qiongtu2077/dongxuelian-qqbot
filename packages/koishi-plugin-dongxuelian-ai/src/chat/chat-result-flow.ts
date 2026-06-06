/**
 * MODULE: chat-result-flow
 * 职责: 处理 chat 返回的 heavy tool 请求，并将 Agent 结果转回 chat 口吻。
 * 边界: 不发送消息、不注册队列、不拥有中间件；chat/Agent/队列由调用方注入。
 * 状态: 无。
 */
const { createBotResolver } = require('../lifecycle/bot-resolver') as typeof import('../lifecycle/bot-resolver')
const { getRecentUserMessages } = require('../conversation') as typeof import('../conversation')
const { externalToolsDenied } = require('../routing/external-tool-policy') as typeof import('../routing/external-tool-policy')
const { isToolEnabled: isAgentToolEnabled, getAgentConfig } = require('../agent/config') as typeof import('../agent/config')
const {
  buildExplicitSearchRunOptions,
  buildExplicitUrlFetchRunOptions,
  isExecutableSearchQuery,
} = require('../agent/router') as typeof import('../agent/router')
const { recordAgentChatResult, summarizeAgentToolResults } = require('./agent-chat-bridge') as typeof import('./agent-chat-bridge')
const { guardAgentRetellReply, redactAgentMaterial } = require('./agent-retell-guard') as typeof import('./agent-retell-guard')

const AGENT_RETELL_FALLBACK: string = '我查到了点东西，但刚刚没组织好，换个问法。'

interface LoggerLike {
  warn: (...args: unknown[]) => void
}

interface ContextLike {
  logger: (name: string) => LoggerLike
}

interface SessionLike {
  guildId?: string
  channelId?: string
  isDirect?: boolean
  userId?: string
  username?: string
  messageId?: string
  author?: { id?: string }
  bot?: unknown
}

interface HeavyToolRequest {
  name?: string
  args?: Record<string, unknown>
}

interface ChatResultObject {
  text?: string
  heavyToolsRequested?: HeavyToolRequest[]
}

interface AgentToolResult {
  name?: string
  result?: unknown
}

interface AgentResultLike {
  reply?: unknown
  toolResults?: AgentToolResult[]
  toolCalls?: number
  pendingId?: unknown
}

interface SearchContextLike {
  searchReadiness?: string
  blockedReason?: string
  recentUserMessages?: string[]
}

type ChatFn = (session: SessionLike, userText: string, ctx: ContextLike, options?: Record<string, unknown>) => Promise<string | ChatResultObject>

interface RetellToolBlockedOptions {
  ctx: ContextLike
  session: SessionLike
  userText: string
  randomTriggered?: boolean
  chat: ChatFn
  reason?: string
}

interface RetellAgentResultOptions {
  ctx: ContextLike
  session: SessionLike
  channelKey: string
  currentUserId: string
  userName: string
  userText: string
  randomTriggered?: boolean
  chat: ChatFn
  emptyText?: string
}

interface AgentEngineLike {
  run(options: Record<string, unknown>): Promise<AgentResultLike>
}

interface HandleChatResultOptions extends RetellAgentResultOptions {
  isAdmin?: boolean
  resolveBot?: (() => unknown) | null
  searchContext?: SearchContextLike | null
  agentEngine: AgentEngineLike
  enqueueAgentTask: (options: { channelKey: string; userId: string; timeoutMs?: number; fn: () => Promise<AgentResultLike> }) => Promise<AgentResultLike>
  configureAgentQueue: (options: Record<string, unknown>) => void
}

function getChatResultErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error || '')
}

function normalizeChatResultText(chatResult: unknown, fallback: string = ''): string {
  if (typeof chatResult === 'string') return chatResult
  if (chatResult && typeof chatResult === 'object') return String((chatResult as ChatResultObject).text || fallback)
  return String(chatResult || fallback)
}

async function retellToolBlockedReply(chatResult: unknown, {
  ctx,
  session,
  userText,
  randomTriggered,
  chat,
  reason = '',
}: RetellToolBlockedOptions): Promise<string> {
  const seedText = normalizeChatResultText(chatResult).trim()
  try {
    const chatReply = await chat(session, userText, ctx, {
      randomTriggered,
      isAgentResult: true,
      agentResultText: [
        seedText || '工具没有执行。',
        reason ? `工具边界：${reason}` : '',
        '请用当前人格自然回应：不要声称已经搜索、读取网页或拿到评论区；如果需要澄清或说明依据不足，语气保持自然，不要套固定兜底句。',
      ].filter(Boolean).join('\n'),
    })
    return normalizeChatResultText(chatReply, seedText).trim() || seedText
  } catch (error) {
    ctx.logger('dongxuelian-ai').warn(`tool blocked retell failed: ${getChatResultErrorMessage(error)}`)
    return seedText
  }
}

async function retellAgentResult(agentResult: AgentResultLike, {
  ctx,
  session,
  channelKey,
  currentUserId,
  userName,
  userText,
  randomTriggered,
  chat,
  emptyText = '(未获取有效回复)',
}: RetellAgentResultOptions): Promise<string> {
  const safeAgentResult: AgentResultLike = {
    ...agentResult,
    reply: redactAgentMaterial(String(agentResult?.reply || '')),
    toolResults: Array.isArray(agentResult?.toolResults)
      ? agentResult.toolResults.map(item => ({ ...item, result: redactAgentMaterial(String(item?.result || '')) }))
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
    ctx.logger('dongxuelian-ai').warn(`agent result retell failed: ${getChatResultErrorMessage(error)}`)
    return AGENT_RETELL_FALLBACK
  }
}

async function handleChatResult(chatResult: unknown, {
  ctx,
  session,
  channelKey,
  currentUserId,
  userName,
  userText,
  randomTriggered,
  isAdmin = false,
  resolveBot = null,
  searchContext = null,
  chat,
  agentEngine,
  enqueueAgentTask,
  configureAgentQueue,
}: HandleChatResultOptions): Promise<string> {
  const getBot = typeof resolveBot === 'function' ? resolveBot : createBotResolver(ctx, session)
  if (chatResult && typeof chatResult === 'object' && (chatResult as ChatResultObject).heavyToolsRequested) {
    const chatResultObject = chatResult as ChatResultObject
    const heavyToolsRequested = Array.isArray(chatResultObject.heavyToolsRequested) ? chatResultObject.heavyToolsRequested : []
    if (externalToolsDenied(userText)) return normalizeChatResultText(chatResult)
    const webSearchRequests = isAgentToolEnabled('qq', 'web_search') ? heavyToolsRequested
      .filter(t => t.name === 'web_search')
      .map(t => ({
        name: 'web_search',
        args: {
          query: String(t.args?.query || userText).trim() || userText,
          ...(Array.isArray(t.args?.queries) ? { queries: t.args.queries } : {}),
        },
      })) : []
    const webFetchRequests = isAgentToolEnabled('qq', 'web_fetch') ? heavyToolsRequested
      .filter(t => t.name === 'web_fetch' && t.args?.url)
      .map(t => ({
        name: 'web_fetch',
        args: {
          url: String(t.args?.url || '').trim(),
          ...(t.args?.maxChars ? { maxChars: t.args.maxChars } : {}),
        },
      }))
      .filter(t => t.args.url) : []
    if (!webSearchRequests.length && !webFetchRequests.length) return normalizeChatResultText(chatResult)
    const hasExecutableWebSearchRequest = webSearchRequests.some(item => isExecutableSearchQuery(item?.args?.query || ''))
    const searchGateBlocked = searchContext && ['needs_chat_handling', 'blocked_by_cold'].includes(String(searchContext.searchReadiness || ''))
    const privateSearchGateBlocked = searchGateBlocked && (searchContext?.searchReadiness === 'blocked_by_cold' || !!searchContext?.blockedReason)
    if (searchGateBlocked && !webFetchRequests.length && webSearchRequests.length && (!hasExecutableWebSearchRequest || privateSearchGateBlocked)) {
      return retellToolBlockedReply(chatResult, { ctx, session, userText, randomTriggered, chat, reason: searchContext?.blockedReason || searchContext?.searchReadiness || '' })
    }
    const agentConfig = getAgentConfig()
    configureAgentQueue(agentConfig.queue || {})
    const explicitFetchOptions = buildExplicitUrlFetchRunOptions(userText)
    const recentUserMessages = searchContext?.recentUserMessages || getRecentUserMessages(session as Parameters<typeof getRecentUserMessages>[0], 4)
    const searchQuery = webSearchRequests[0]?.args?.query || userText
    const searchRunOptions = explicitFetchOptions.forceTools ? explicitFetchOptions : buildExplicitSearchRunOptions(searchQuery, { recentUserMessages, searchContext })
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
        fn: () => agentEngine.run({ userMessage: searchRunOptions.agentUserMessage || userText, userName, userId: currentUserId, channelKey, channel: 'qq', bot: getBot(), agentMode: true, isAdmin, ...searchRunOptions }),
      })
      return retellAgentResult(agentResult, { ctx, session, channelKey, currentUserId, userName, userText, randomTriggered, chat, emptyText: '(搜索未获取有效结果)' })
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error ? String((error as { code?: unknown }).code || '') : ''
      if (code === 'AGENT_QUEUE_FULL' || code === 'AGENT_QUEUE_REJECTED') return getChatResultErrorMessage(error)
      ctx.logger('dongxuelian-ai').warn(`chat heavy-tool agent failed: ${getChatResultErrorMessage(error)}`)
      return 'Agent 暂时不可用。'
    }
  }
  return normalizeChatResultText(chatResult)
}

export = {
  normalizeChatResultText,
  retellToolBlockedReply,
  retellAgentResult,
  handleChatResult,
}
