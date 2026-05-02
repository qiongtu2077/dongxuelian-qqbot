const { withScenario } = require('./_setup')
const { checkSentIncludes, checkSentNonEmpty } = require('../helpers/assert')

async function run(t) {
  t.section('scenario: sensitive detection middleware')

  await withScenario({}, async ({ data, makeSession, run }) => {
    const nonAdmin = await run(makeSession({
      userId: '12345',
      author: { id: '12345', name: 'member' },
      content: '\u654f\u611f\u8bdd\u9898\u68c0\u6d4b\u5f00',
      event: { sender: { role: 'member' }, message: [] },
    }))
    checkSentNonEmpty(t, 'scenario sensitive non-admin rejected with reply', nonAdmin)
    t.check('scenario sensitive non-admin leaves detect file empty', data.readJson('political-detect-enabled.json').length === 0)

    const addHandler = await run(makeSession({
      content: '\u654f\u611f\u8bdd\u9898\u5904\u7406\u8005\u6dfb\u52a0 99999',
      event: { sender: { role: 'admin' }, message: [] },
    }))
    checkSentNonEmpty(t, 'scenario sensitive handler add replies', addHandler)
    t.check('scenario sensitive handler file written', data.readJson('political-handlers/10001.json').includes('99999'))

    const enable = await run(makeSession({
      content: '\u654f\u611f\u8bdd\u9898\u68c0\u6d4b\u5f00',
      event: { sender: { role: 'admin' }, message: [] },
    }))
    checkSentNonEmpty(t, 'scenario sensitive detect enables', enable)
    t.check('scenario sensitive detect list includes channel', data.readJson('political-detect-enabled.json').includes('10001'))

    const trigger = await run(makeSession({
      userId: '20001',
      author: { id: '20001', name: 'member' },
      content: '\u53f0\u6e7e \u8fd9\u4e2a\u8bdd\u9898\u522b\u804a\u4e86',
      event: { sender: { role: 'member' }, message: [] },
    }))
    checkSentIncludes(t, 'scenario sensitive keyword notifies handler', trigger, '<at id="99999"/>')

    const close = await run(makeSession({
      content: '\u654f\u611f\u8bdd\u9898\u68c0\u6d4b\u5173',
      event: { sender: { role: 'admin' }, message: [] },
    }))
    checkSentNonEmpty(t, 'scenario sensitive detect closes', close)
    t.check('scenario sensitive detect list removes channel', !data.readJson('political-detect-enabled.json').includes('10001'))

    const afterClose = await run(makeSession({
      userId: '20002',
      author: { id: '20002', name: 'member2' },
      content: '\u53f0\u6e7e \u5173\u95ed\u540e\u4e0d\u5e94\u901a\u77e5',
      event: { sender: { role: 'member' }, message: [] },
    }))
    t.check('scenario sensitive close prevents later notification', !afterClose.sent.some(item => String(item).includes('<at id="99999"/>')), JSON.stringify(afterClose.sent))

    const view = await run(makeSession({ content: '\u654f\u611f\u8bdd\u9898\u68c0\u6d4b\u67e5\u770b' }))
    checkSentNonEmpty(t, 'scenario sensitive view sees disabled state', view)
    t.check('scenario sensitive view observes disabled file state', !data.readJson('political-detect-enabled.json').includes('10001'))
  })
}

module.exports = { run }
