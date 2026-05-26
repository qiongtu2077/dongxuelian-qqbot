/**
 * MODULE: 发送安全层。
 * 职责: 统一安全发送、发送失败限流/禁言处理、复读发送、罕见固定语音发送。
 * 边界: 不决定随机触发，不写 conversation，由调用方负责随机/历史上下文。
 * 状态: sendFailState 为进程内风控状态，重启后重建。
 */
const { sendReply } = require('./reply')
const { readRareVoiceAudioBuffer } = require('./rare-voice')
const {
  classifySendError,
  sanitizeForRateLimit,
  sleepForRateLimitRetry,
  getCachedPlatformMuteStatus,
  markPlatformMute,
  clearPlatformMute,
  checkPlatformMuteStatus,
} = require('./send-guard')
const { getAdminUserIds } = require('./core/runtime-config')
const { createBotResolver } = require('./lifecycle/bot-resolver')
const { hasAdminPermission, isDirectAtBot } = require('./utils')

const sendFailState = {
  streak: 0,
  lastFailAt: 0,
  lastNotifyAt: 0,
  restrictedUntil: 0,
  maxStreak: 2,
  cooldownMs: 5 * 60 * 1000,
  restrictDurationMs: 60 * 60 * 1000,
  notifyIntervalMs: 30 * 1000,
  notifyScheduled: false,
}

function logStaleRandomSkip(ctx, stage, options = {}) {
  try {
    const info = options.randomFreshness || {}
    ctx.logger('dongxuelian-ai').info(`random reply stale skipped at ${stage}: channel=${info.channelKey || ''}`)
  } catch {}
}

async function notifyAdminsSendFailure(ctx, bot) {
  const admins = getAdminUserIds(true)
  const msg = '⚠️ 连续发送失败，已进入消息受限状态'
  await Promise.allSettled(
    [...admins].map(async (id) => {
      try {
        if (typeof bot?.sendPrivateMessage === 'function') {
          await bot.sendPrivateMessage(id, msg)
        } else if (bot?.internal?.sendPrivateMsg) {
          await bot.internal.sendPrivateMsg(id, msg)
        }
      } catch (error) {
        ctx.logger('dongxuelian-ai').warn('notify admin send failure: ' + error.message)
      }
    })
  )
}

function resetSendFailState() {
  sendFailState.streak = 0
  sendFailState.lastFailAt = 0
}

function logPlatformMute(ctx, status, prefix = 'safeSendReply') {
  const until = status?.until ? new Date(status.until).toISOString() : 'unknown'
  ctx.logger('dongxuelian-ai').warn(`${prefix}: platform muted, skipping reply (${status?.reason || '平台禁言'}, until=${until})`)
}

async function handleRateLimitedSendFailure(ctx, session, error, now, resolveBot = null) {
  const getBot = typeof resolveBot === 'function' ? resolveBot : createBotResolver(ctx, session)
  sendFailState.streak++
  sendFailState.lastFailAt = now
  ctx.logger('dongxuelian-ai').error(`safeSendReply: rate limited (streak=${sendFailState.streak}): ${error.message}`)
  if (sendFailState.streak <= 2) {
    sendFailState.lastNotifyAt = now
    notifyAdminsSendFailure(ctx, getBot()).catch(() => {})
  } else if (now - sendFailState.lastNotifyAt > sendFailState.notifyIntervalMs) {
    sendFailState.lastNotifyAt = now
    notifyAdminsSendFailure(ctx, getBot()).catch(() => {})
  }
  if (sendFailState.streak >= sendFailState.maxStreak) {
    if (now >= sendFailState.restrictedUntil) {
      sendFailState.restrictedUntil = now + sendFailState.restrictDurationMs
      ctx.logger('dongxuelian-ai').warn(`safeSendReply: restricted for 1 hour due to ${sendFailState.streak} consecutive rate-limit failures`)
    }
    if (!sendFailState.notifyScheduled) {
      sendFailState.notifyScheduled = true
      setTimeout(function() {
        const bot = getBot()
        const admins = getAdminUserIds(true)
        const unlockMsg = '🔓 30 分钟已过，风控可能已解除。BOT 冻结期还剩约 30 分钟，届时自动恢复。急需使用可重启 BOT。'
        Promise.allSettled([...admins].map(function(id) {
          try {
            if (typeof bot?.sendPrivateMessage === 'function') {
              return bot.sendPrivateMessage(id, unlockMsg)
            }
          } catch {}
        }))
      }, 30 * 60 * 1000)
    }
  }
}

async function safeSendRepeat(ctx, session, reply) {
  try {
    await session.send(reply)
    return true
  } catch (error) {
    const classified = classifySendError(error)
    if (classified.type === 'muted') {
      markPlatformMute(session, { reason: classified.reason })
      ctx.logger('dongxuelian-ai').warn(`repeat send muted: ${classified.message.slice(0, 120)}`)
      return false
    }
    if (classified.type === 'rate-limit') {
      ctx.logger('dongxuelian-ai').warn(`repeat send rate-limited: ${classified.message.slice(0, 120)}`)
      return false
    }
    ctx.logger('dongxuelian-ai').warn(`repeat send failed: ${classified.message.slice(0, 120)}`)
    return false
  }
}

async function safeSendReply(ctx, session, reply, isRandom = false, resolveBot = null, sendOptions = {}, freshnessChecker = null) {
  if (typeof freshnessChecker === 'function' && !freshnessChecker(isRandom, sendOptions)) {
    logStaleRandomSkip(ctx, isRandom ? 'text' : 'stale-text', sendOptions)
    return
  }
  const now = Date.now()
  // 冻结到期后重置通知标记
  if (now >= sendFailState.restrictedUntil && sendFailState.notifyScheduled) {
    sendFailState.notifyScheduled = false
  }
  if (sendFailState.streak > 0 && now - sendFailState.lastFailAt > sendFailState.cooldownMs) {
    sendFailState.streak = 0
  }
  if (now < sendFailState.restrictedUntil) {
    if (!hasAdminPermission(session)) {
      if (!isDirectAtBot(session)) {
        ctx.logger('dongxuelian-ai').warn('safeSendReply: restricted, skipping reply')
        return
      }
      try {
        return await session.send('我被盯上了，有内鬼终止交易')
      } catch (error) {
        ctx.logger('dongxuelian-ai').error(`safeSendReply: restricted notice failed: ${error.message}`)
        return
      }
    }
  }
  const cachedMute = getCachedPlatformMuteStatus(session, now)
  if (cachedMute.muted) {
    logPlatformMute(ctx, cachedMute)
    return
  }
  const activeMute = await checkPlatformMuteStatus(session)
  if (activeMute.muted) {
    const marked = markPlatformMute(session, activeMute)
    logPlatformMute(ctx, marked)
    return
  }

  let currentReply = reply
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const sentCount = await sendReply(ctx, session, currentReply, isRandom, sendOptions)
      if (sentCount > 0) {
        resetSendFailState()
        clearPlatformMute(session)
      }
      return
    } catch (error) {
      const classified = classifySendError(error)
      if (classified.type === 'muted') {
        const marked = markPlatformMute(session, { reason: classified.reason })
        logPlatformMute(ctx, marked, 'safeSendReply: send error')
        return
      }
      if (classified.type !== 'rate-limit') {
        ctx.logger('dongxuelian-ai').warn(`safeSendReply: non-rate-limit error skipped: ${classified.message.slice(0, 120)}`)
        throw error
      }
      if (attempt === 0 && Number(error?.sentParts || 0) === 0) {
        const cleaned = sanitizeForRateLimit(currentReply)
        currentReply = cleaned || currentReply
        ctx.logger('dongxuelian-ai').warn('safeSendReply: rate limited, retrying once with sanitized content')
        await sleepForRateLimitRetry(ctx, attempt)
        continue
      }
      await handleRateLimitedSendFailure(ctx, session, error, Date.now(), resolveBot)
      throw error
    }
  }
}

/** 尝试发送罕见固定语音；失败时返回 false 交给文字回复回退。 */
async function safeSendRareVoice(ctx, session) {
  try {
    const { sendVoiceMessage } = require('./tts')
    const audioBuf = await readRareVoiceAudioBuffer()
    if (!audioBuf) {
      try { ctx.logger('dongxuelian-ai').warn('safeSendRareVoice skipped: rare voice audio unavailable') } catch {}
      return false
    }
    const sent = await sendVoiceMessage(session, audioBuf)
    if (!sent) {
      try { ctx.logger('dongxuelian-ai').warn('safeSendRareVoice skipped: sendVoiceMessage returned false') } catch {}
    }
    return sent
  } catch (error) {
    try {
      ctx.logger('dongxuelian-ai').warn(`safeSendRareVoice failed: ${error.message || error}`)
    } catch {}
    return false
  }
}

module.exports = {
  logStaleRandomSkip,
  safeSendRepeat,
  safeSendReply,
  safeSendRareVoice,
  resetSendFailState,
}
