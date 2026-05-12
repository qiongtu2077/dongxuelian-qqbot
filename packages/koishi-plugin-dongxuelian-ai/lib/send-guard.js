/*
 * MODULE: send-guard
 * 职责: 发送前平台禁言检测、发送错误分类、风控重试清洗与运行时禁言缓存。
 * 边界: 不调用 AI API，不写 conversation，不直接发送消息。
 * 状态: platformMuteCache 按群/频道缓存平台禁言到期时间，重启后丢弃。
 */
const { getGroupMemberInfo, getGroupInfo } = require('./api')

const PLATFORM_MUTE_ERROR_CACHE_MS = 10 * 60 * 1000
const GROUP_ALL_MUTE_CACHE_MS = 60 * 1000
const platformMuteCache = new Map()

function getSendChannelKey(session) {
  return String(session?.guildId || session?.channelId || 'private')
}

function getBotSelfId(session) {
  return String(session?.selfId || session?.bot?.selfId || session?.event?.selfId || '')
}

function isGroupSession(session) {
  return !!session?.guildId && !session?.isDirect
}

function normalizeTimestampMs(value) {
  const numeric = Number(value)
  if (!Number.isFinite(numeric) || numeric <= 0) return 0
  return numeric > 1000000000000 ? numeric : numeric * 1000
}

function extractRetcode(error, message) {
  const direct = Number(error?.retcode ?? error?.data?.retcode ?? error?.response?.retcode)
  if (Number.isFinite(direct)) return direct
  const match = /retcode\s*[:=]\s*(-?\d+)/i.exec(message)
  return match ? Number(match[1]) : NaN
}

function classifySendError(error) {
  const message = String(error?.message || error || '')
  const retcode = extractRetcode(error, message)
  const mutedKeyword = /禁言|全员禁言|shut[_ -]?up|muted|不能发言|禁止发言|群成员禁言|group[_ -]?all[_ -]?shut/i.test(message)
  if (mutedKeyword || (retcode === 10 && /发言|发送|message|send/i.test(message))) {
    return { type: 'muted', retcode, message, reason: '平台禁言导致消息无法发送' }
  }
  if (retcode === 1200 || /风控|risk control|rate.?limit|too frequent|发送频繁|消息频繁/i.test(message)) {
    return { type: 'rate-limit', retcode, message, reason: '疑似 QQ 风控' }
  }
  return { type: 'other', retcode, message, reason: '非禁言/风控发送错误' }
}

function sanitizeForRateLimit(text) {
  return String(text || '')
    .replace(/https?:\/\/[^\s<>"']{1,300}/gi, '[链接]')
    .replace(/([!！?？。~～])\1{1,}/g, '$1')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/(?:\r?\n){3,}/g, '\n\n')
    .trim()
}

function computeBackoffMs(attempt = 0) {
  const rawBase = process.env.DONGXUELIAN_SEND_GUARD_RETRY_DELAY_MS
  const rawMax = process.env.DONGXUELIAN_SEND_GUARD_RETRY_MAX_MS
  const base = rawBase !== undefined ? Math.max(0, Number(rawBase) || 0) : 2000
  const max = rawMax !== undefined ? Math.max(base, Number(rawMax) || base) : 10000
  return Math.min(base * Math.pow(2, Math.max(0, Number(attempt) || 0)), max)
}

function sleepForRateLimitRetry(ctx, attempt = 0) {
  const delay = computeBackoffMs(attempt)
  if (delay <= 0) return Promise.resolve()
  return new Promise(resolve => {
    const setTimer = typeof ctx?.setTimeout === 'function' ? ctx.setTimeout.bind(ctx) : setTimeout
    setTimer(resolve, delay)
  })
}

function getCachedPlatformMuteStatus(session, now = Date.now()) {
  if (!isGroupSession(session)) return { muted: false, skipped: true, reason: '非群聊' }
  const key = getSendChannelKey(session)
  const cached = platformMuteCache.get(key)
  if (!cached) return { muted: false }
  if (cached.until > now) return { muted: true, until: cached.until, reason: cached.reason || '平台禁言缓存', source: cached.source || 'cache' }
  platformMuteCache.delete(key)
  return { muted: false }
}

function markPlatformMute(session, info = {}, now = Date.now()) {
  if (!isGroupSession(session)) return { muted: false, skipped: true, reason: '非群聊' }
  const key = getSendChannelKey(session)
  const until = Number(info.until) > now ? Number(info.until) : now + (Number(info.durationMs) || PLATFORM_MUTE_ERROR_CACHE_MS)
  const value = { until, reason: info.reason || '平台禁言', source: info.source || 'send-error' }
  platformMuteCache.set(key, value)
  return { muted: true, ...value }
}

function clearPlatformMute(session) {
  platformMuteCache.delete(getSendChannelKey(session))
}

function getInternalQuery(session, camelName, actionName, kind) {
  const internal = session?.bot?.internal
  if (!internal) return null
  if (typeof internal[camelName] === 'function') {
    if (kind === 'member') return (groupId, userId) => internal[camelName](groupId, userId, false)
    return groupId => internal[camelName](groupId, false)
  }
  if (typeof internal[actionName] === 'function') {
    if (kind === 'member') return (groupId, userId) => internal[actionName]({ group_id: Number(groupId), user_id: Number(userId), no_cache: false })
    return groupId => internal[actionName]({ group_id: Number(groupId), no_cache: false })
  }
  return null
}

async function querySafely(fn, args) {
  if (typeof fn !== 'function') return null
  try { return await fn(...args) } catch { return null }
}

function inspectMemberMute(memberInfo, now) {
  if (!memberInfo || typeof memberInfo !== 'object') return null
  const until = normalizeTimestampMs(memberInfo.shut_up_timestamp ?? memberInfo.shutUpTimestamp ?? memberInfo.shut_up_time)
  if (until > now) return { muted: true, until, reason: 'Bot 当前处于群成员禁言状态', source: 'member' }
  return null
}

function inspectGroupAllMute(groupInfo, now) {
  if (!groupInfo || typeof groupInfo !== 'object') return null
  const allMuted = groupInfo.group_all_shut === true || groupInfo.groupAllShut === true || groupInfo.all_muted === true
  const adminCanSpeak = groupInfo.admin_can_speak === true || groupInfo.adminCanSpeak === true
  if (allMuted && !adminCanSpeak) return { muted: true, until: now + GROUP_ALL_MUTE_CACHE_MS, reason: '群处于全员禁言状态', source: 'group' }
  return null
}

async function checkPlatformMuteStatus(session, options = {}) {
  const now = typeof options.now === 'number' ? options.now : Date.now()
  if (!isGroupSession(session)) return { muted: false, skipped: true, reason: '非群聊' }
  const groupId = String(session.guildId || session.channelId || '')
  const userId = getBotSelfId(session)
  if (!groupId || !userId) return { muted: false, uncertain: true, reason: '缺少群号或 Bot QQ' }

  const memberGetter = options.getGroupMemberInfo || getInternalQuery(session, 'getGroupMemberInfo', 'get_group_member_info', 'member') || (process.env.DONGXUELIAN_ONEBOT_WS_MUTE_QUERY === '1' ? getGroupMemberInfo : null)
  const groupGetter = options.getGroupInfo || getInternalQuery(session, 'getGroupInfo', 'get_group_info', 'group') || (process.env.DONGXUELIAN_ONEBOT_WS_MUTE_QUERY === '1' ? getGroupInfo : null)
  if (!memberGetter && !groupGetter) return { muted: false, uncertain: true, reason: '没有可用的 OneBot 禁言查询接口' }

  const [memberInfo, groupInfo] = await Promise.all([
    querySafely(memberGetter, [groupId, userId]),
    querySafely(groupGetter, [groupId]),
  ])
  const memberMute = inspectMemberMute(memberInfo, now)
  if (memberMute) return memberMute
  const groupMute = inspectGroupAllMute(groupInfo, now)
  if (groupMute) return groupMute
  return { muted: false, uncertain: !memberInfo && !groupInfo, reason: memberInfo || groupInfo ? '未检测到平台禁言' : '禁言查询无结果' }
}

module.exports = {
  classifySendError,
  sanitizeForRateLimit,
  computeBackoffMs,
  sleepForRateLimitRetry,
  getSendChannelKey,
  getCachedPlatformMuteStatus,
  markPlatformMute,
  clearPlatformMute,
  checkPlatformMuteStatus,
}