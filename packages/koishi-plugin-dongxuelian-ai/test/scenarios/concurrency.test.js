const { withScenario } = require('./_setup')
const { checkSentIncludes } = require('../helpers/assert')

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

async function run(t) {
  t.section('scenario: business concurrency')

  await withScenario({}, async ({ makeSession, run }) => {
    const enable = await run(makeSession({ content: '\u4e1c\u96ea\u83b2\u590d\u8bfb\u5f00' }))
    checkSentIncludes(t, 'scenario concurrent repeat setup enables repeat', enable, '\u590d\u8bfb\u5df2\u5f00\u542f')

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
    t.check('scenario concurrent repeat cooldown blocks immediate third echo', !third.sent.some(item => String(item).includes('\u5e76\u53d1\u590d\u8bfb')), JSON.stringify(third.sent))
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
    const sensitive = userSession(makeSession, '4001', '\u53f0\u6e7e \u5e76\u53d1\u5f00\u542f\u7ade\u901f', {
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

    const follow = userSession(makeSession, '4002', '\u53f0\u6e7e \u5e76\u53d1\u540e\u7eed\u68c0\u67e5', {
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
}

module.exports = { run }
