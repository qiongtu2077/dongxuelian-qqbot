const { withScenario } = require('./_setup')
const { checkSentIncludes } = require('../helpers/assert')

async function run(t) {
  t.section('scenario: sensitive detection middleware')

  await withScenario({}, async ({ data, makeSession, run }) => {
    const nonAdmin = await run(makeSession({
      userId: '12345',
      author: { id: '12345', name: 'member' },
      content: '敏感话题检测开',
      event: { sender: { role: 'member' }, message: [] },
    }))
    checkSentIncludes(t, 'scenario sensitive non-admin rejected', nonAdmin, '管理员')
    t.check('scenario sensitive non-admin leaves detect file empty', data.readJson('political-detect-enabled.json').length === 0)

    const addHandler = await run(makeSession({
      content: '敏感话题处理者添加 99999',
      event: { sender: { role: 'admin' }, message: [] },
    }))
    checkSentIncludes(t, 'scenario sensitive handler add replies', addHandler, '已添加')
    t.check('scenario sensitive handler file written', data.readJson('political-handlers/10001.json').includes('99999'))

    const enable = await run(makeSession({
      content: '敏感话题检测开',
      event: { sender: { role: 'admin' }, message: [] },
    }))
    checkSentIncludes(t, 'scenario sensitive detect enables', enable, '已开启')
    t.check('scenario sensitive detect list includes channel', data.readJson('political-detect-enabled.json').includes('10001'))

    const trigger = await run(makeSession({
      userId: '20001',
      author: { id: '20001', name: 'member' },
      content: '台湾 这个话题别聊了',
      event: { sender: { role: 'member' }, message: [] },
    }))
    checkSentIncludes(t, 'scenario sensitive keyword notifies handler', trigger, '<at id="99999"/>')

    const close = await run(makeSession({
      content: '敏感话题检测关',
      event: { sender: { role: 'admin' }, message: [] },
    }))
    checkSentIncludes(t, 'scenario sensitive detect closes', close, '已关闭')
    t.check('scenario sensitive detect list removes channel', !data.readJson('political-detect-enabled.json').includes('10001'))

    const afterClose = await run(makeSession({
      userId: '20002',
      author: { id: '20002', name: 'member2' },
      content: '台湾 关闭后不应通知',
      event: { sender: { role: 'member' }, message: [] },
    }))
    t.check('scenario sensitive close prevents later notification', !afterClose.sent.some(item => String(item).includes('管理员快来')), JSON.stringify(afterClose.sent))

    const view = await run(makeSession({ content: '敏感话题检测查看' }))
    checkSentIncludes(t, 'scenario sensitive view sees disabled state', view, '关')
  })
}

module.exports = { run }
