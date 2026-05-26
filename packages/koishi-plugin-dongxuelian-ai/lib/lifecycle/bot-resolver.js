/* ==========================================================================
 * MODULE: bot-resolver
 * 职责：解析当前 Koishi bot，并为异步队列中的 session 注入最新 bot 引用。
 * 边界：不注册 middleware、不发送消息、不读写配置或 conversation。
 * 状态：无模块级缓存；每次从 ctx/session 当前状态解析。
 * ========================================================================== */
const { patchEnsureSession } = require('./session-compat')

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

module.exports = {
  resolveCurrentBot,
  createBotResolver,
  withCurrentBot,
}
