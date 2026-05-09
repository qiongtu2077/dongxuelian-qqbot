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

  await withScenario({}, async ({ data, makeSession, run }) => {
    const enable = await run(makeSession({ content: '\u4e1c\u96ea\u83b2\u590d\u8bfb\u5f00' }))
    checkSentNonEmpty(t, 'scenario repeat switch enables in middleware', enable)
    t.check('scenario repeat switch writes enabled state', data.readJson('ai-repeat-enabled.json')['10001'] === true)

    await run(userSession(makeSession, '1001', '\u8349'))
    const textRepeat = await run(userSession(makeSession, '1002', '\u8349'))
    checkSentIncludes(t, 'scenario text repeat triggers for two users', textRepeat, '\u8349')

    await run(userSession(makeSession, '1001', '\u540c\u4e00\u4e2a\u4eba'))
    const sameUser = await run(userSession(makeSession, '1001', '\u540c\u4e00\u4e2a\u4eba'))
    t.check('scenario same user repeat does not trigger', sameUser.sent.length === 0, JSON.stringify(sameUser.sent))

    await run(userSession(makeSession, '1003', '\u540c\u7ec4A'))
    const groupFirst = await run(userSession(makeSession, '1004', '\u540c\u7ec4A'))
    checkSentIncludes(t, 'scenario repeat group triggers first match', groupFirst, '\u540c\u7ec4A')
    const groupDuplicate = await run(userSession(makeSession, '1005', '\u540c\u7ec4A'))
    t.check('scenario repeat group blocks duplicate trigger', groupDuplicate.sent.length === 0, JSON.stringify(groupDuplicate.sent))

    await run(userSession(makeSession, '1006', '\u6362\u4e00\u53e5'))
    const groupReset = await run(userSession(makeSession, '1007', '\u6362\u4e00\u53e5'))
    checkSentIncludes(t, 'scenario repeat new text can trigger after previous group', groupReset, '\u6362\u4e00\u53e5')

    await run(userSession(makeSession, '1008', '\u540c\u7ec4A'))
    const oldTextNewGroup = await run(userSession(makeSession, '1009', '\u540c\u7ec4A'))
    checkSentIncludes(t, 'scenario repeat old text can trigger after group changes', oldTextNewGroup, '\u540c\u7ec4A')

    await run(userSession(makeSession, '1013', '[CQ:face,id=76]'))
    const faceRepeat = await run(userSession(makeSession, '1014', '[CQ:face,id=76]'))
    checkSentIncludes(t, 'scenario QQ face repeat triggers after text group', faceRepeat, '<face id="76"/>')
    const faceDuplicate = await run(userSession(makeSession, '1015', '[CQ:face,id=76]'))
    t.check('scenario QQ face repeat blocks duplicate in same group', faceDuplicate.sent.length === 0, JSON.stringify(faceDuplicate.sent))

    await run(userSession(makeSession, '1016', '[CQ:face,id=76]\u54c8\u54c8\u54c8'))
    const mixedFace = await run(userSession(makeSession, '1017', '[CQ:face,id=76]\u54c8\u54c8\u54c8'))
    t.check('scenario mixed face text is not sent as pure face', !mixedFace.sent.some(item => String(item).includes('<face id="76"/>')), JSON.stringify(mixedFace.sent))

    await run(userSession(makeSession, '1011', '[CQ:image,file=a.jpg]', {
      event: { sender: { role: 'member' }, message: [{ type: 'image', data: { file: 'a.jpg' } }] },
    }))
    const imageRepeat = await run(userSession(makeSession, '1012', '[CQ:image,file=a.jpg]', {
      event: { sender: { role: 'member' }, message: [{ type: 'image', data: { file: 'a.jpg' } }] },
    }))
    t.check('scenario image repeat unsupported', imageRepeat.sent.length === 0, JSON.stringify(imageRepeat.sent))

    const disable = await run(makeSession({ content: '\u4e1c\u96ea\u83b2\u590d\u8bfb\u5173' }))
    checkSentNonEmpty(t, 'scenario repeat switch disables in middleware', disable)
    t.check('scenario repeat switch writes disabled state', data.readJson('ai-repeat-enabled.json')['10001'] === false)
  })

  await withScenario({}, async ({ makeSession }) => {
    const repeat = require('../../lib/repeat')
    const enabled = repeat.getRepeatEnabledCache()
    const candidate = { key: 'text:pure-repeat', reply: 'pure-repeat', kind: 'text', supported: true }

    const cooldownChannel = 'pure-repeat-cooldown'
    enabled[cooldownChannel] = true
    repeat.checkGroupRepeat(userSession(makeSession, '2001', 'pure-repeat'), candidate, cooldownChannel, '2001', 100000)
    const firstTrigger = repeat.checkGroupRepeat(userSession(makeSession, '2002', 'pure-repeat'), candidate, cooldownChannel, '2002', 100100)
    t.check('scenario repeat pure function triggers first match', !!firstTrigger && firstTrigger.reply === 'pure-repeat', JSON.stringify(firstTrigger))
    const duplicateBlocked = repeat.checkGroupRepeat(userSession(makeSession, '2003', 'pure-repeat'), candidate, cooldownChannel, '2003', 101000)
    t.check('scenario repeat pure function blocks duplicate same group', duplicateBlocked === null, JSON.stringify(duplicateBlocked))

    const nextCandidate = { key: 'text:next-repeat', reply: 'next-repeat', kind: 'text', supported: true }
    repeat.checkGroupRepeat(userSession(makeSession, '2004', 'next-repeat'), nextCandidate, cooldownChannel, '2004', 101100)
    const nextTrigger = repeat.checkGroupRepeat(userSession(makeSession, '2005', 'next-repeat'), nextCandidate, cooldownChannel, '2005', 101200)
    t.check('scenario repeat pure function triggers after text changes', !!nextTrigger && nextTrigger.reply === 'next-repeat', JSON.stringify(nextTrigger))

    repeat.checkGroupRepeat(userSession(makeSession, '2006', 'pure-repeat'), candidate, cooldownChannel, '2006', 101300)
    const oldTextNewGroup = repeat.checkGroupRepeat(userSession(makeSession, '2007', 'pure-repeat'), candidate, cooldownChannel, '2007', 101400)
    t.check('scenario repeat pure function allows old text in new group', !!oldTextNewGroup && oldTextNewGroup.reply === 'pure-repeat', JSON.stringify(oldTextNewGroup))

    const windowChannel = 'pure-repeat-window'
    enabled[windowChannel] = true
    repeat.checkGroupRepeat(userSession(makeSession, '2011', 'pure-repeat'), candidate, windowChannel, '2011', 200000)
    const expiredWindow = repeat.checkGroupRepeat(userSession(makeSession, '2012', 'pure-repeat'), candidate, windowChannel, '2012', 321001)
    t.check('scenario repeat window expiry blocks old message', expiredWindow === null, JSON.stringify(expiredWindow))

    const faceCandidate = repeat.buildRepeatCandidate(userSession(makeSession, '2021', '[CQ:face,id=76]'), '', { hasVisual: true })
    t.check('scenario QQ face repeat candidate remains pure face', faceCandidate.reply === '<face id="76"/>', JSON.stringify(faceCandidate))
  })
}

module.exports = { run }
