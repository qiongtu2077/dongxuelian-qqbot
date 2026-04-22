exports.name = 'dongxuelian-poke'

async function pokeBack(session, ctx) {
  const userId = String(session.userId || '')
  const guildId = String(session.guildId || '')
  if (!userId) return

  const internal = session.bot?.internal
  if (!internal || typeof internal._request !== 'function') {
    ctx.logger('dongxuelian-poke').warn('no _request method, cannot poke back')
    return
  }

  // NapCat OneBot 扩展 API：group_poke
  await internal._request('group_poke', { group_id: guildId, user_id: userId })
  ctx.logger('dongxuelian-poke').info(`poke back: group=${guildId} user=${userId}`)
}

exports.apply = (ctx) => {
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
