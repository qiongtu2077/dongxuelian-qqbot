const name = 'dongxuelian-poke'

interface LoggerLike {
  info(...args: unknown[]): void
  warn(...args: unknown[]): void
}

interface ContextLike {
  on(event: 'notice', handler: (session: NoticeSessionLike) => Promise<void> | void): unknown
  logger(name: string): LoggerLike
}

interface NapcatInternalLike {
  _request(action: string, params: Record<string, unknown>): Promise<unknown>
}

interface BotLike {
  selfId?: string | number
  internal?: Partial<NapcatInternalLike>
}

interface NoticeSessionLike {
  subtype?: string
  sub_type?: string
  selfId?: string | number
  targetId?: string | number
  target_id?: string | number
  userId?: string | number
  guildId?: string | number
  bot?: BotLike
}

async function pokeBack(session: NoticeSessionLike, ctx: ContextLike): Promise<void> {
  const userId = String(session.userId || '')
  const guildId = String(session.guildId || '')
  if (!userId || !guildId) return

  const internal = session.bot?.internal
  if (!internal || typeof internal._request !== 'function') {
    ctx.logger('dongxuelian-poke').warn('no _request method, cannot poke back')
    return
  }

  // NapCat OneBot 扩展 API：group_poke
  await internal._request('group_poke', { group_id: guildId, user_id: userId })
  ctx.logger('dongxuelian-poke').info(`poke back: group=${guildId} user=${userId}`)
}

function apply(ctx: ContextLike): void {
  ctx.on('notice', async (session) => {
    const sub = session.subtype || session.sub_type || ''
    if (sub !== 'poke') return

    const botId = String(session.selfId || session.bot?.selfId || '')
    const targetId = String(session.targetId || session.target_id || '')
    if (!botId || targetId !== botId) return

    try {
      await pokeBack(session, ctx)
    } catch (err) {
      ctx.logger('dongxuelian-poke').warn('poke back failed:', err)
    }
  })
}

export = { name, apply }
