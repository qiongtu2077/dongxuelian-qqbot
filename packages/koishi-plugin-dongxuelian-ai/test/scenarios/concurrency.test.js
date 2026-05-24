const { withScenario } = require('./_setup')
const { mockFetch } = require('../fake/fetch')
const { flushAsync } = require('../fake/koishi')
const { checkSentIncludes, checkSentNonEmpty } = require('../helpers/assert')
const { setTimeout: realSetTimeout } = require('timers')

function userSession(makeSession, userId, content, extra = {}) {
  return makeSession({
    userId,
    author: { id: userId, name: `u${userId}` },
    content,
    ...extra,
  })
}

function countSentContaining(sessions, needle) {
  return sessions.reduce((count, session) =>
    count + session.sent.filter(item => String(item).includes(needle)).length,
  0)
}

function realSleep(ms) {
  return new Promise(resolve => realSetTimeout(resolve, ms))
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

async function waitForMockCalls(mocked, count, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs
  while (mocked.calls.length < count && Date.now() < deadline) {
    await flushAsync(4)
    await realSleep(10)
  }
}

async function run(t) {
  t.section('scenario: business concurrency')

  await withScenario({}, async ({ data, makeSession, run }) => {
    const enable = await run(makeSession({ content: '\u4e1c\u96ea\u83b2\u590d\u8bfb\u5f00' }))
    checkSentNonEmpty(t, 'scenario concurrent repeat setup enables repeat', enable)
    t.check('scenario concurrent repeat setup writes enabled state', data.readJson('ai-repeat-enabled.json')['10001'] === true)

    const a = userSession(makeSession, '3001', '\u5e76\u53d1\u590d\u8bfb')
    const b = userSession(makeSession, '3002', '\u5e76\u53d1\u590d\u8bfb')
    await Promise.all([
      run(a, { flushTicks: 20 }),
      run(b, { flushTicks: 20 }),
    ])

    const repeatCount = countSentContaining([a, b], '\u5e76\u53d1\u590d\u8bfb')
    t.check('scenario concurrent repeat triggers exactly once', repeatCount === 1, JSON.stringify({ a: a.sent, b: b.sent }))

    const c = userSession(makeSession, '3003', '\u5e76\u53d1\u590d\u8bfb')
    const third = await run(c, { flushTicks: 20 })
    t.check('scenario concurrent repeat group blocks immediate third echo', !third.sent.some(item => String(item).includes('\u5e76\u53d1\u590d\u8bfb')), JSON.stringify(third.sent))
  })

  await withScenario({}, async ({ data, makeSession, run }) => {
    await run(makeSession({
      content: '\u654f\u611f\u8bdd\u9898\u5904\u7406\u8005\u6dfb\u52a0 99999',
      event: { sender: { role: 'admin' }, message: [] },
    }))

    const enable = makeSession({
      content: '\u654f\u611f\u8bdd\u9898\u68c0\u6d4b\u5f00',
      event: { sender: { role: 'admin' }, message: [] },
    })
    const sensitive = userSession(makeSession, '4001', '\u53f0\u6e7e\u95ee\u9898 \u5e76\u53d1\u5f00\u542f\u7ade\u901f', {
      event: { sender: { role: 'member' }, message: [] },
    })
    await Promise.all([
      run(enable, { flushTicks: 20 }),
      run(sensitive, { flushTicks: 20 }),
    ])

    const enabledList = data.readJson('political-detect-enabled.json')
    t.check('scenario sensitive enable race leaves detect file enabled', enabledList.includes('10001'), JSON.stringify(enabledList))

    const initialNotifyCount = countSentContaining([enable, sensitive], '<at id="99999"/>')
    t.check('scenario sensitive enable race does not duplicate notify', initialNotifyCount <= 1, JSON.stringify({ enable: enable.sent, sensitive: sensitive.sent }))

    const follow = userSession(makeSession, '4002', '\u53f0\u6e7e\u95ee\u9898 \u5e76\u53d1\u540e\u7eed\u68c0\u67e5', {
      event: { sender: { role: 'member' }, message: [] },
    })
    const followResult = await run(follow, { flushTicks: 20 })
    if (initialNotifyCount === 0) {
      checkSentIncludes(t, 'scenario sensitive enable race follow-up notifies if race message came first', followResult, '<at id="99999"/>')
    } else {
      t.check('scenario sensitive enable race follow-up respects alert cooldown', !follow.sent.some(item => String(item).includes('<at id="99999"/>')), JSON.stringify(follow.sent))
    }
  })

  await withScenario({}, async ({ data, makeSession, run }) => {
    await run(makeSession({
      content: '\u654f\u611f\u8bdd\u9898\u5904\u7406\u8005\u6dfb\u52a0 99999',
      event: { sender: { role: 'admin' }, message: [] },
    }))
    await run(makeSession({
      content: '\u654f\u611f\u8bdd\u9898\u68c0\u6d4b\u5f00',
      event: { sender: { role: 'admin' }, message: [] },
    }))

    const close = makeSession({
      content: '\u654f\u611f\u8bdd\u9898\u68c0\u6d4b\u5173',
      event: { sender: { role: 'admin' }, message: [] },
    })
    const sensitive = userSession(makeSession, '5001', '\u53f0\u6e7e \u5e76\u53d1\u5173\u95ed\u7ade\u901f', {
      event: { sender: { role: 'member' }, message: [] },
    })
    await Promise.all([
      run(close, { flushTicks: 20 }),
      run(sensitive, { flushTicks: 20 }),
    ])

    const enabledList = data.readJson('political-detect-enabled.json')
    t.check('scenario sensitive close race leaves detect file disabled', !enabledList.includes('10001'), JSON.stringify(enabledList))
    const raceNotifyCount = countSentContaining([close, sensitive], '<at id="99999"/>')
    t.check('scenario sensitive close race does not duplicate notify', raceNotifyCount <= 1, JSON.stringify({ close: close.sent, sensitive: sensitive.sent }))

    const afterClose = userSession(makeSession, '5002', '\u53f0\u6e7e \u5173\u95ed\u540e\u4e0d\u901a\u77e5', {
      event: { sender: { role: 'member' }, message: [] },
    })
    const afterCloseResult = await run(afterClose, { flushTicks: 20 })
    t.check('scenario sensitive close race prevents later notification', !afterCloseResult.sent.some(item => String(item).includes('<at id="99999"/>')), JSON.stringify(afterCloseResult.sent))
  })

  await withScenario({}, async ({ makeSession, run }) => {
    const mocked = mockFetch([
      { delayMs: 120, json: { choices: [{ message: { content: 'private-a-slow-reply' } }] } },
      { json: { choices: [{ message: { content: 'private-b-fast-reply' } }] } },
    ])
    await withFetch(mocked, async () => {
      const slow = makeSession({
        userId: 'private-a',
        author: { id: 'private-a', name: 'A' },
        content: '第一条私聊慢请求',
        messageId: 'private-a-slow',
        isDirect: true,
        guildId: undefined,
        channelId: undefined,
        event: { sender: { role: 'member' }, message: [{ type: 'text', attrs: { content: '第一条私聊慢请求' } }] },
      })
      const fast = makeSession({
        userId: 'private-b',
        author: { id: 'private-b', name: 'B' },
        content: '第二条私聊快请求',
        messageId: 'private-b-fast',
        isDirect: true,
        guildId: undefined,
        channelId: undefined,
        event: { sender: { role: 'member' }, message: [{ type: 'text', attrs: { content: '第二条私聊快请求' } }] },
      })
      const slowRun = run(slow, { flush: false })
      await waitForMockCalls(mocked, 1)
      const fastRun = run(fast, { flush: false })
      await waitForMockCalls(mocked, 2)
      await fast.waitForSend(message => String(message).includes('private-b-fast-reply'), 3000)
      t.check('scenario direct chats without channelId do not share one queue', fast.sent.some(item => String(item).includes('private-b-fast-reply')) && slow.sent.length === 0, JSON.stringify({ slow: slow.sent, fast: fast.sent, calls: mocked.calls.length }))
      await Promise.all([slowRun, fastRun])
      await slow.waitForSend(message => String(message).includes('private-a-slow-reply'), 3000)
      t.check('scenario slow direct chat still finishes later', slow.sent.some(item => String(item).includes('private-a-slow-reply')), JSON.stringify(slow.sent))
    })
  })
}

module.exports = { run }
