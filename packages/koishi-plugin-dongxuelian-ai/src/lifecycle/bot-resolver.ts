/* ==========================================================================
 * MODULE: bot-resolver
 * 职责：解析当前 Koishi bot，并为异步队列中的 session 注入最新 bot 引用。
 * 边界：不注册 middleware、不发送消息、不读写配置或 conversation。
 * 状态：无模块级缓存；每次从 ctx/session 当前状态解析。
 * ========================================================================== */
const { patchEnsureSession } = require('./session-compat') as typeof import('./session-compat')

interface BotResolverBot {
  selfId?: string
  sendPrivateMessage?: (id: string, message: string) => Promise<unknown> | unknown
  internal?: {
    sendPrivateMsg?: (id: string, message: string) => Promise<unknown> | unknown
  }
}

interface BotResolverContextShape {
  bots?: unknown
  bot?: unknown
}

interface BotResolverSessionShape {
  selfId?: unknown
  bot?: unknown
  event?: { selfId?: unknown }
}

function asBotResolverObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? value as Record<string, unknown> : null
}

function asBotResolverBot(value: unknown): BotResolverBot | null {
  return value && typeof value === 'object' ? value as BotResolverBot : null
}

function asBotResolverContext(ctx: object | null | undefined): BotResolverContextShape {
  return asBotResolverObject(ctx) || {}
}

function asBotResolverSession(session: object | null | undefined): BotResolverSessionShape {
  return asBotResolverObject(session) || {}
}

function resolveCurrentBot(ctx: object | null | undefined, fallbackBot: object | null = null, selfId: string = ''): BotResolverBot | null {
  const source = asBotResolverContext(ctx)
  const bots: BotResolverBot[] = []
  if (Array.isArray(source.bots)) {
    for (const item of source.bots) {
      const bot = asBotResolverBot(item)
      if (bot) bots.push(bot)
    }
  }
  const targetSelfId = String(selfId || '')
  if (targetSelfId) {
    const matched = bots.find(bot => String(bot?.selfId || '') === targetSelfId)
    if (matched) return matched
  }
  return bots[0] || asBotResolverBot(source.bot) || asBotResolverBot(fallbackBot) || null
}

function createBotResolver(ctx: object | null | undefined, session: object | null | undefined = {}): () => BotResolverBot | null {
  const source = asBotResolverSession(session)
  const fallbackBot = asBotResolverBot(source.bot)
  const selfId = String(source.selfId || fallbackBot?.selfId || source.event?.selfId || '')
  return () => resolveCurrentBot(ctx, fallbackBot, selfId)
}

function withCurrentBot<T extends object | null | undefined>(session: T, bot: object | null | undefined): T {
  const resolvedBot = asBotResolverBot(bot)
  if (!session || !resolvedBot) return session
  const source = asBotResolverSession(session)
  if (source.bot === resolvedBot) return session
  const runtimeSession = Object.assign(Object.create(Object.getPrototypeOf(session) || Object.prototype), session)
  runtimeSession.bot = resolvedBot
  return patchEnsureSession(runtimeSession) as T
}

export = {
  resolveCurrentBot,
  createBotResolver,
  withCurrentBot,
}
