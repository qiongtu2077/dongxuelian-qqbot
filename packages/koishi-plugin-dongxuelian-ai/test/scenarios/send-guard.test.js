const { withScenario } = require('./_setup')
const { mockFetch } = require('../fake/fetch')
const { checkSentIncludes, checkSentExcludes } = require('../helpers/assert')
const { setTimeout: realSetTimeout } = require('timers')

function atBot(session, content = 'hello') {
  return `<at id="${session.selfId}"/> ${content}`
}

async function withFetch(mocked, fn) {
  const originalFetch = global.fetch
  const originalWarn = console.warn
  global.fetch = mocked.fetch
  console.warn = () => {}
  try {
    return await fn()
  } finally {
    global.fetch = originalFetch
    console.warn = originalWarn
  }
}

function replyQueue(content) {
  return [{ json: { choices: [{ message: { content } }] } }]
}

async function waitForCondition(predicate, timeoutMs = 2000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return true
    await new Promise(resolve => realSetTimeout(resolve, 20))
  }
  return predicate()
}

async function runGuardCase(fetchQueue, setupSession, waitFor) {
  return withScenario({}, async ({ harness, makeSession, run }) => {
    const mocked = mockFetch(fetchQueue)
    return withFetch(mocked, async () => {
      const session = makeSession()
      if (setupSession) setupSession(session)
      session.content = atBot(session, 'ping')
      const result = await run(session, { flushTicks: 120 })
      if (waitFor) await waitForCondition(() => waitFor(session, harness, mocked))
      return {
        ...result,
        sent: session.sent,
        internalCalls: session.internalCalls,
        timeline: session.timeline,
        logs: harness.logs,
        mocked,
        session,
      }
    })
  })
}

async function withRetryDelay(value, fn) {
  const previous = process.env.DONGXUELIAN_SEND_GUARD_RETRY_DELAY_MS
  process.env.DONGXUELIAN_SEND_GUARD_RETRY_DELAY_MS = String(value)
  try {
    return await fn()
  } finally {
    if (previous === undefined) delete process.env.DONGXUELIAN_SEND_GUARD_RETRY_DELAY_MS
    else process.env.DONGXUELIAN_SEND_GUARD_RETRY_DELAY_MS = previous
  }
}

async function run(t) {
  t.section('scenario: send guard platform mute and rate limit')

  const safeSend = require('../../lib/reply/safe-send')
  t.check('scenario safe-send module exports moved send helpers', typeof safeSend.safeSendReply === 'function' && typeof safeSend.safeSendRepeat === 'function' && typeof safeSend.safeSendRareVoice === 'function')

  const freshnessSent = []
  const freshnessLogs = []
  await safeSend.safeSendReply({
    logger() {
      return {
        info: msg => freshnessLogs.push(String(msg)),
        warn: msg => freshnessLogs.push(String(msg)),
        error: msg => freshnessLogs.push(String(msg)),
      }
    },
  }, {
    isDirect: true,
    content: '',
    async send(message) {
      freshnessSent.push(String(message))
      return message
    },
  }, 'stale-random-direct-send', true, null, { randomFreshness: { channelKey: 'freshness-fixture' } }, () => false)
  t.check('scenario safe-send freshness checker can skip stale random reply', freshnessSent.length === 0 && freshnessLogs.some(msg => msg.includes('random reply stale skipped')), JSON.stringify({ freshnessSent, freshnessLogs }))

  const botMuted = await runGuardCase(replyQueue('should-not-send'), (session) => {
    session.bot.internal.getGroupMemberInfo = async () => ({ shut_up_timestamp: Math.floor(Date.now() / 1000) + 60 })
    session.bot.internal.getGroupInfo = async () => ({ group_all_shut: false })
  }, (session, harness) => harness.logs.some(log => /platform muted/.test(log.msg)))
  t.checkEqual('scenario send guard skips bot member mute', botMuted.sent.length, 0)
  t.check('scenario send guard logs member mute', botMuted.logs.some(log => /platform muted/.test(log.msg) && /群成员禁言/.test(log.msg)), JSON.stringify(botMuted.logs.slice(-6)))

  const groupMuted = await runGuardCase(replyQueue('should-not-send'), (session) => {
    session.bot.internal.getGroupMemberInfo = async () => ({ shut_up_timestamp: 0 })
    session.bot.internal.getGroupInfo = async () => ({ group_all_shut: true, admin_can_speak: false })
  }, (session, harness) => harness.logs.some(log => /全员禁言/.test(log.msg)))
  t.checkEqual('scenario send guard skips group all mute', groupMuted.sent.length, 0)
  t.check('scenario send guard logs group all mute', groupMuted.logs.some(log => /全员禁言/.test(log.msg)), JSON.stringify(groupMuted.logs.slice(-6)))

  const queryFailed = await runGuardCase(replyQueue('query failure still sends'), (session) => {
    session.bot.internal.getGroupMemberInfo = async () => { throw new Error('query failed') }
    session.bot.internal.getGroupInfo = async () => { throw new Error('query failed') }
  }, session => session.sent.some(message => String(message).includes('query failure still sends')))
  checkSentIncludes(t, 'scenario send guard allows uncertain mute query', queryFailed, 'query failure still sends')

  const retried = await withRetryDelay(0, () => runGuardCase(replyQueue('visit https://example.com/a/b'), (session) => {
    const originalSend = session.send.bind(session)
    let calls = 0
    session.send = async (message) => {
      calls += 1
      if (calls === 1) {
        const error = new Error('retcode: 1200 risk control')
        error.retcode = 1200
        throw error
      }
      return originalSend(message)
    }
  }, session => session.sent.some(message => String(message).includes('[链接]'))))
  checkSentIncludes(t, 'scenario send guard retries sanitized rate limit reply', retried, '[链接]')
  checkSentExcludes(t, 'scenario send guard sanitized retry removes url', retried, 'https://example.com')
  t.check('scenario send guard logs rate-limit retry', retried.logs.some(log => /retrying once/.test(log.msg)), JSON.stringify(retried.logs.slice(-8)))

  const mutedError = await runGuardCase(replyQueue('will fail with mute'), (session) => {
    session.send = async () => { throw new Error('retcode: 1200 群成员禁言') }
  }, (session, harness) => harness.logs.some(log => /platform muted/.test(log.msg)))
  t.checkEqual('scenario send guard mute error does not send fallback notice', mutedError.sent.length, 0)
  t.check('scenario send guard mute error does not notify admins as rate limit', !(mutedError.internalCalls || []).some(call => call.method === 'sendPrivateMsg'), JSON.stringify(mutedError.internalCalls))

  const notifiedRateLimit = await withRetryDelay(0, () => runGuardCase(replyQueue('rate limit admin notify'), (session) => {
    session.send = async () => {
      const error = new Error('retcode: 1200 risk control')
      error.retcode = 1200
      error.sentParts = 1
      throw error
    }
  }, (session, harness) => harness.logs.some(log => /restricted for 1 hour/.test(log.msg))))
  t.check('scenario safe-send rate limit notifies admins after split', (notifiedRateLimit.internalCalls || []).some(call => call.method === 'sendPrivateMsg' && String(call.userId) === '100000000'), JSON.stringify(notifiedRateLimit.internalCalls))
}

module.exports = { run }
