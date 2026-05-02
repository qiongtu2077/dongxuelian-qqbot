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

async function run(t) {
  t.section('scenario: repeat middleware')

  await withScenario({}, async ({ clock, makeSession, run }) => {
    const enable = await run(makeSession({ content: '东雪莲复读开' }))
    checkSentIncludes(t, 'scenario repeat switch enables in middleware', enable, '复读已开启')

    await run(userSession(makeSession, '1001', '草'))
    const textRepeat = await run(userSession(makeSession, '1002', '草'))
    checkSentIncludes(t, 'scenario text repeat triggers for two users', textRepeat, '草')

    await run(userSession(makeSession, '1001', '同一个人'))
    const sameUser = await run(userSession(makeSession, '1001', '同一个人'))
    t.check('scenario same user repeat does not trigger', sameUser.sent.length === 0, JSON.stringify(sameUser.sent))

    await run(userSession(makeSession, '1003', '冷却A'))
    const cooldownBlocked = await run(userSession(makeSession, '1004', '冷却A'))
    t.check('scenario repeat cooldown blocks trigger', cooldownBlocked.sent.length === 0, JSON.stringify(cooldownBlocked.sent))

    await clock.tick(31000)
    await run(userSession(makeSession, '1005', '冷却B'))
    const cooldownExpired = await run(userSession(makeSession, '1006', '冷却B'))
    checkSentIncludes(t, 'scenario repeat triggers after cooldown', cooldownExpired, '冷却B')

    await clock.tick(31000)
    await run(userSession(makeSession, '1007', '[CQ:face,id=76]'))
    const faceRepeat = await run(userSession(makeSession, '1008', '[CQ:face,id=76]'))
    checkSentIncludes(t, 'scenario QQ face repeat triggers', faceRepeat, '<face id="76"/>')

    await clock.tick(31000)
    await run(userSession(makeSession, '1009', '[CQ:face,id=76]哈哈哈'))
    const mixedFace = await run(userSession(makeSession, '1010', '[CQ:face,id=76]哈哈哈'))
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
    await run(userSession(makeSession, '1013', '窗口过期'))
    await clock.tick(121000)
    const expiredWindow = await run(userSession(makeSession, '1014', '窗口过期'))
    t.check('scenario repeat window expiry blocks old message', expiredWindow.sent.length === 0, JSON.stringify(expiredWindow.sent))

    const disable = await run(makeSession({ content: '东雪莲复读关' }))
    checkSentIncludes(t, 'scenario repeat switch disables in middleware', disable, '复读已关闭')
  })
}

module.exports = { run }
