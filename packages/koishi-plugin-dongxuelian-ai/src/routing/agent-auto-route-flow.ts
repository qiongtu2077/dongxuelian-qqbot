/**
 * MODULE: agent-auto-route-flow
 * 职责: 执行 QQ 消息的 Agent 自动路由桥接，并把 Agent 结果转成 chat 口吻文本。
 * 边界: 不发送消息、不注册 middleware、不拥有队列；Agent/队列/chat 由调用方注入。
 * 状态: 无模块级状态。
 */
const { heuristicRoute, buildExplicitSearchRunOptions } = require('../agent/router') as typeof import('../agent/router')
const { getAgentConfig } = require('../agent/config') as typeof import('../agent/config')
const { hasAdminPermission, isJailbreakAttempt, sanitizeUserInput } = require('../core/utils') as typeof import('../core/utils')
const { logDebug } = require('../core/logging-config') as typeof import('../core/logging-config')

interface LoggerLike {
  info(message: string): void
  warn(message: string): void
}

interface AutoRouteContext {
  logger(name: string): LoggerLike
  [key: string]: unknown
}

interface AutoRouteSession {
  userId?: string
  selfId?: string
  content?: string
  author?: { id?: string }
  event?: {
    user?: { id?: string }
    message?: unknown[] | { elements?: unknown[]; content?: unknown[] }
  }
  bot?: { selfId?: string }
}

interface AgentRouteResult {
  useAgent?: boolean
  reason?: string
}

interface AgentConfigLike {
  queue?: {
    timeoutMs?: number
    [key: string]: unknown
  }
}

interface AgentEngineLike {
  run(input: Record<string, unknown>): Promise<unknown>
}

interface AgentTaskInput {
  channelKey: string
  userId: string
  timeoutMs?: number
  fn: () => Promise<unknown>
}

interface HandleAgentAutoRouteInput {
  ctx: AutoRouteContext
  liveSession: AutoRouteSession
  channelKey: string
  currentUserId: string
  userName: string
  userText: string
  randomTriggered?: boolean
  recentUserMessages?: string[]
  searchContext?: Record<string, unknown>
  resolveBot: () => unknown
  chat: unknown
  agentEngine: AgentEngineLike
  enqueueAgentTask: (input: AgentTaskInput) => Promise<unknown>
  configureAgentQueue: (queue: Record<string, unknown>) => void
  retellAgentResult: (result: unknown, input: Record<string, unknown>) => Promise<string>
}

interface HandleAgentAutoRouteResult {
  handled: boolean
  reply?: string
}

interface AutoRouteErrorLike {
  code?: string
  message?: string
}

function getAutoRouteErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String((error as AutoRouteErrorLike)?.message || error)
}

async function handleAgentAutoRoute({
  ctx,
  liveSession,
  channelKey,
  currentUserId,
  userName,
  userText,
  randomTriggered,
  recentUserMessages,
  searchContext,
  resolveBot,
  chat,
  agentEngine,
  enqueueAgentTask,
  configureAgentQueue,
  retellAgentResult,
}: HandleAgentAutoRouteInput): Promise<HandleAgentAutoRouteResult> {
  let route: AgentRouteResult = heuristicRoute(userText, 'qq', { recentUserMessages, searchContext })
  if (isJailbreakAttempt(sanitizeUserInput(userText))) route = { useAgent: false, reason: 'jailbreak-chat-guard' }
  if (!route.useAgent) return { handled: false }

  logDebug(ctx, 'agent', `auto-route reason=${route.reason} channel=${channelKey}`)
  const searchRunOptions = buildExplicitSearchRunOptions(userText, { recentUserMessages, searchContext })
  const agentConfig = getAgentConfig() as AgentConfigLike
  configureAgentQueue(agentConfig.queue || {})
  try {
    const agentResult = await enqueueAgentTask({
      channelKey,
      userId: currentUserId,
      timeoutMs: agentConfig.queue?.timeoutMs,
      fn: () => agentEngine.run({
        userMessage: searchRunOptions.agentUserMessage || userText,
        userName,
        userId: currentUserId,
        channelKey,
        channel: 'qq',
        bot: resolveBot(),
        agentMode: true,
        isAdmin: hasAdminPermission(liveSession),
        ...searchRunOptions,
      }),
    })
    const reply = await retellAgentResult(agentResult, {
      ctx,
      session: liveSession,
      channelKey,
      currentUserId,
      userName,
      userText,
      randomTriggered,
      chat,
    })
    return { handled: true, reply }
  } catch (error) {
    const errorLike = error && typeof error === 'object' ? error as AutoRouteErrorLike : {}
    const code = errorLike.code ? String(errorLike.code) : ''
    if (code === 'AGENT_QUEUE_FULL' || code === 'AGENT_QUEUE_REJECTED') {
      return { handled: true, reply: getAutoRouteErrorMessage(error) }
    }
    ctx.logger('dongxuelian-ai').warn(`agent auto-route failed: ${getAutoRouteErrorMessage(error)}`)
    return { handled: true, reply: 'Agent 暂时不可用。' }
  }
}

export = {
  handleAgentAutoRoute,
}
