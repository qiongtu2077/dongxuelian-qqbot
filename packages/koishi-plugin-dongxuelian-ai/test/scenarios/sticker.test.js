const { withScenario } = require('./_setup')
const { mockFetch } = require('../fake/fetch')
const { checkInternalCall, checkNoInternalCall, checkSentIncludes } = require('../helpers/assert')

const TEXT = {
  normal: '\u666e\u901a\u6587\u672c',
  seeHappy: '\u770b\u8fd9\u4e2a[\u56fe:\u5f00\u5fc3]',
  firstHappy: 'alpha-one[\u56fe:\u5f00\u5fc3]',
  secondHappy: 'beta-two[\u56fe:\u5f00\u5fc3]',
  thirdHappy: 'gamma-three[\u56fe:\u5f00\u5fc3]',
  funny: 'funny-one[\u56fe:\u641e\u7b11]',
  unknown: '\u672a\u77e5[\u56fe:\u4e0d\u5b58\u5728]',
}

function atBot(session, content = '\u4f60\u597d') {
  return `<at id="${session.selfId}"/> ${content}`
}

function resultFor(session, harness) {
  return {
    sent: session.sent,
    internalCalls: session.internalCalls,
    timeline: session.timeline,
    logs: harness.logs,
  }
}

function timelineIndex(result, type, predicate = () => true) {
  return (result.timeline || []).findIndex(item => item.type === type && predicate(item))
}

async function withFetch(mocked, fn) {
  const originalFetch = global.fetch
  global.fetch = mocked.fetch
  try {
    return await fn()
  } finally {
    global.fetch = originalFetch
  }
}

async function triggerBotReply(makeSession, run, replyText, overrides = {}) {
  const session = makeSession(overrides)
  session.content = atBot(session, 'sticker test')
  await run(session, { flushTicks: 120 })
  await session.waitForSend()
  return session
}

async function run(t) {
  t.section('scenario: sticker sendReply')

  await withScenario({}, async ({ harness, makeSession, run, ready }) => {
    await ready()
    const mocked = mockFetch([{ json: { choices: [{ message: { content: TEXT.normal } }] } }])
    await withFetch(mocked, async () => {
      const session = await triggerBotReply(makeSession, run, TEXT.normal)
      const result = resultFor(session, harness)
      checkSentIncludes(t, 'scenario ordinary text sends normally', result, TEXT.normal)
      checkNoInternalCall(t, 'scenario ordinary text does not use sticker internal path', result, 'sendGroupMsg')
      t.check('scenario ordinary text records only session send', result.timeline.length === 1 && result.timeline[0].type === 'send', JSON.stringify(result.timeline))
    })
  })

  await withScenario({}, async ({ harness, makeSession, run, ready }) => {
    await ready()
    const mocked = mockFetch([{ json: { choices: [{ message: { content: TEXT.seeHappy } }] } }])
    await withFetch(mocked, async () => {
      const session = await triggerBotReply(makeSession, run, TEXT.seeHappy)
      await session.waitForInternalCall(call => call.method === 'sendGroupMsg')
      const result = resultFor(session, harness)
      checkSentIncludes(t, 'scenario sticker text part sends once', result, '\u770b\u8fd9\u4e2a')
      checkInternalCall(t, 'scenario sticker internal send succeeds', result, 'sendGroupMsg')
      t.check('scenario sticker success does not fallback image to session.send', result.sent.length === 1, JSON.stringify(result.sent))
      const textSendIndex = timelineIndex(result, 'send')
      const stickerInternalIndex = timelineIndex(result, 'internal', item => item.method === 'sendGroupMsg')
      t.check('scenario sticker sends text before internal image', textSendIndex >= 0 && stickerInternalIndex > textSendIndex, JSON.stringify(result.timeline))
    })
  })

  await withScenario({}, async ({ harness, makeSession, run, ready }) => {
    await ready()
    const mocked = mockFetch([{ json: { choices: [{ message: { content: TEXT.seeHappy } }] } }])
    const originalWarn = console.warn
    console.warn = () => {}
    await withFetch(mocked, async () => {
      try {
        const session = await triggerBotReply(makeSession, run, TEXT.seeHappy, { internalShouldFail: true })
        await session.waitForInternalCall(call => call.method === 'sendGroupMsg')
        await session.waitForSend(message => String(message).includes('base64://'))
        const result = resultFor(session, harness)
        checkInternalCall(t, 'scenario sticker internal failure attempted', result, 'sendGroupMsg')
        t.check('scenario sticker internal failure falls back to session image', result.sent.length >= 2 && result.sent.some(item => String(item).includes('base64://')), JSON.stringify(result.sent))
        const textSendIndex = timelineIndex(result, 'send', item => !String(item.message).includes('base64://'))
        const stickerInternalIndex = timelineIndex(result, 'internal', item => item.method === 'sendGroupMsg')
        const fallbackImageIndex = timelineIndex(result, 'send', item => String(item.message).includes('base64://'))
        t.check('scenario sticker fallback happens after text and failed internal image', textSendIndex >= 0 && stickerInternalIndex > textSendIndex && fallbackImageIndex > stickerInternalIndex, JSON.stringify(result.timeline))
      } finally {
        console.warn = originalWarn
      }
    })
  })

  await withScenario({}, async ({ harness, makeSession, run, ready, clock }) => {
    await ready()
    const mocked = mockFetch()
    const queueReply = (text) => {
      mocked.queue.length = 0
      mocked.push(...Array.from({ length: 5 }, () => ({ json: { choices: [{ message: { content: text } }] } })))
    }
    await withFetch(mocked, async () => {
      queueReply(TEXT.firstHappy)
      const first = await triggerBotReply(makeSession, run, TEXT.firstHappy)
      await first.waitForInternalCall(call => call.method === 'sendGroupMsg')
      queueReply(TEXT.secondHappy)
      const second = await triggerBotReply(makeSession, run, TEXT.secondHappy)
      const result = resultFor(second, harness)
      checkSentIncludes(t, 'scenario sticker cooldown still sends text', result, 'beta-two')
      t.check('scenario sticker cooldown skips image', second.internalCalls.length === 0, JSON.stringify(second.internalCalls))
      await clock.tick(121000)
      queueReply(TEXT.thirdHappy)
      const third = await triggerBotReply(makeSession, run, TEXT.thirdHappy)
      await third.waitForInternalCall(call => call.method === 'sendGroupMsg')
      t.check('scenario sticker sends again after cooldowns', third.internalCalls.length === 1, JSON.stringify(third.internalCalls))
    })
  })

  await withScenario({}, async ({ harness, makeSession, run, ready }) => {
    await ready()
    const mocked = mockFetch([{ json: { choices: [{ message: { content: TEXT.funny } }] } }])
    await withFetch(mocked, async () => {
      const session = await triggerBotReply(makeSession, run, TEXT.funny)
      await session.waitForInternalCall(call => call.method === 'sendGroupMsg')
      const result = resultFor(session, harness)
      checkSentIncludes(t, 'scenario second sticker file text sends', result, 'funny-one')
      t.check('scenario second sticker file sends image', session.internalCalls.length >= 1, JSON.stringify(session.internalCalls))
    })
  })

  await withScenario({}, async ({ harness, makeSession, run, ready }) => {
    await ready()
    const mocked = mockFetch([{ json: { choices: [{ message: { content: TEXT.unknown } }] } }])
    await withFetch(mocked, async () => {
      const session = await triggerBotReply(makeSession, run, TEXT.unknown)
      const result = resultFor(session, harness)
      checkSentIncludes(t, 'scenario unknown sticker keeps current text behavior', result, '\u672a\u77e5')
      checkNoInternalCall(t, 'scenario unknown sticker does not send image', result, 'sendGroupMsg')
    })
  })
}

module.exports = { run }
