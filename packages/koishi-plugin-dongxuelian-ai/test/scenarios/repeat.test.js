const { withScenario } = require('./_setup')
const { checkSentIncludes, checkSentNonEmpty } = require('../helpers/assert')

function userSession(makeSession, userId, content, extra = {}) {
  return makeSession({
    userId,
    author: { id: userId, name: `u${userId}` },
    content,
    ...extra,
  })
}

async function run(t) {
  t.section('scenario: repeat middleware')

  await withScenario({}, async ({ data, clock, makeSession, run }) => {
    const enable = await run(makeSession({ content: '\u4e1c\u96ea\u83b2\u590d\u8bfb\u5f00' }))
    checkSentNonEmpty(t, 'scenario repeat switch enables in middleware', enable)
    t.check('scenario repeat switch writes enabled state', data.readJson('ai-repeat-enabled.json')['10001'] === true)

    await run(userSession(makeSession, '1001', '\u8349'))
    const textRepeat = await run(userSession(makeSession, '1002', '\u8349'))
    checkSentIncludes(t, 'scenario text repeat triggers for two users', textRepeat, '\u8349')

    await run(userSession(makeSession, '1001', '\u540c\u4e00\u4e2a\u4eba'))
    const sameUser = await run(userSession(makeSession, '1001', '\u540c\u4e00\u4e2a\u4eba'))
    t.check('scenario same user repeat does not trigger', sameUser.sent.length === 0, JSON.stringify(sameUser.sent))

    await run(userSession(makeSession, '1003', '\u51b7\u5374A'))
    const cooldownBlocked = await run(userSession(makeSession, '1004', '\u51b7\u5374A'))
    t.check('scenario repeat cooldown blocks trigger', cooldownBlocked.sent.length === 0, JSON.stringify(cooldownBlocked.sent))

    await clock.tick(31000)
    await run(userSession(makeSession, '1005', '\u51b7\u5374B'))
    const cooldownExpired = await run(userSession(makeSession, '1006', '\u51b7\u5374B'))
    checkSentIncludes(t, 'scenario repeat triggers after cooldown', cooldownExpired, '\u51b7\u5374B')

    await clock.tick(31000)
    await run(userSession(makeSession, '1007', '[CQ:face,id=76]'))
    const faceRepeat = await run(userSession(makeSession, '1008', '[CQ:face,id=76]'))
    checkSentIncludes(t, 'scenario QQ face repeat triggers', faceRepeat, '<face id="76"/>')

    await clock.tick(31000)
    await run(userSession(makeSession, '1009', '[CQ:face,id=76]\u54c8\u54c8\u54c8'))
    const mixedFace = await run(userSession(makeSession, '1010', '[CQ:face,id=76]\u54c8\u54c8\u54c8'))
    t.check('scenario mixed face text is not sent as pure face', !mixedFace.sent.some(item => String(item).includes('<face id="76"/>')), JSON.stringify(mixedFace.sent))

    await clock.tick(31000)
    await run(userSession(makeSession, '1011', '[CQ:image,file=a.jpg]', {
      event: { sender: { role: 'member' }, message: [{ type: 'image', data: { file: 'a.jpg' } }] },
    }))
    const imageRepeat = await run(userSession(makeSession, '1012', '[CQ:image,file=a.jpg]', {
      event: { sender: { role: 'member' }, message: [{ type: 'image', data: { file: 'a.jpg' } }] },
    }))
    t.check('scenario image repeat unsupported', imageRepeat.sent.length === 0, JSON.stringify(imageRepeat.sent))

    await clock.tick(31000)
    await run(userSession(makeSession, '1013', '\u7a97\u53e3\u8fc7\u671f'))
    await clock.tick(121000)
    const expiredWindow = await run(userSession(makeSession, '1014', '\u7a97\u53e3\u8fc7\u671f'))
    t.check('scenario repeat window expiry blocks old message', expiredWindow.sent.length === 0, JSON.stringify(expiredWindow.sent))

    const disable = await run(makeSession({ content: '\u4e1c\u96ea\u83b2\u590d\u8bfb\u5173' }))
    checkSentNonEmpty(t, 'scenario repeat switch disables in middleware', disable)
    t.check('scenario repeat switch writes disabled state', data.readJson('ai-repeat-enabled.json')['10001'] === false)
  })
}

module.exports = { run }
