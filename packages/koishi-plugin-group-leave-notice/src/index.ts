const name = 'group-leave-notice'

const PLUGIN_VERSION = '0.1.0'

interface LoggerLike {
  info(...args: unknown[]): void
  warn(...args: unknown[]): void
}

interface ContextLike {
  on(event: 'ready', handler: () => void): unknown
  on(event: 'guild-member-removed', handler: (session: LeaveSessionLike) => Promise<void> | void): unknown
  logger(name: string): LoggerLike
}

interface BotLike {
  sendMessage?(target: string, message: string): Promise<unknown>
}

interface LeaveSessionLike {
  channelId?: string
  guildId?: string
  userId?: string
  event?: {
    guild?: { id?: string }
    channel?: { id?: string }
    user?: { id?: string }
    member?: { user?: { id?: string } }
  }
  bot?: BotLike
}

function getGuildId(session: LeaveSessionLike): string | undefined {
  return session.channelId || session.guildId || session.event?.guild?.id || session.event?.channel?.id
}

function getUserId(session: LeaveSessionLike): string | undefined {
  return session.userId || session.event?.user?.id || session.event?.member?.user?.id
}

async function sendLeaveNotice(session: LeaveSessionLike): Promise<void> {
  const guildId = getGuildId(session)
  const userId = getUserId(session)
  if (!guildId || !userId || typeof session.bot?.sendMessage !== 'function') return

  await session.bot.sendMessage(guildId, userId + ' 退群了')
}

function apply(ctx: ContextLike): void {
  ctx.on('ready', () => {
    ctx.logger('group-leave-notice').info('group-leave-notice ' + PLUGIN_VERSION + ' loaded')
  })

  ctx.on('guild-member-removed', async (session) => {
    try {
      await sendLeaveNotice(session)
    } catch (error) {
      ctx.logger('group-leave-notice').warn(error instanceof Error ? error.message : String(error))
    }
  })
}

export = { name, apply }
