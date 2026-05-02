const fs = require('fs')
const path = require('path')
const { withScenario } = require('./_setup')
const { checkSentIncludes, checkNoLeak, checkNextCalled } = require('../helpers/assert')

async function run(t) {
  t.section('scenario: command middleware')

  await withScenario({}, async ({ data, makeSession, run }) => {
    const status = await run(makeSession({ content: 'AI状态' }))
    checkSentIncludes(t, 'scenario AI status replies', status, 'AI版本')
    checkNoLeak(t, 'scenario AI status does not leak key', status, ['sk-test-secret', 'Bearer'])

    const help = await run(makeSession({ content: '帮助集合' }))
    checkNextCalled(t, 'scenario reserved help command calls next', help)
    t.check('scenario reserved help command does not send', help.sent.length === 0, JSON.stringify(help.sent))

    const nonAdminThinking = await run(makeSession({
      userId: '12345',
      author: { id: '12345', name: 'member' },
      content: '东雪莲思考开',
    }))
    checkSentIncludes(t, 'scenario non-admin thinking switch rejected', nonAdminThinking, '管理员')
    t.check('scenario non-admin thinking switch does not write file', data.readText('ai-enable-thinking.txt').trim() === 'off')

    const adminThinking = await run(makeSession({ content: '东雪莲思考开' }))
    checkSentIncludes(t, 'scenario admin thinking switch accepted', adminThinking, '思考调试模式已开启')
    t.check('scenario admin thinking switch writes file', data.readText('ai-enable-thinking.txt').trim() === 'on')

    const nonAdminRepeat = await run(makeSession({
      userId: '12345',
      author: { id: '12345', name: 'member' },
      content: '东雪莲复读开',
    }))
    checkSentIncludes(t, 'scenario non-admin repeat switch rejected', nonAdminRepeat, '管理员')

    const sensitiveBefore = data.readText('political-detect-enabled.json')
    const nonAdminSensitive = await run(makeSession({
      userId: '12345',
      author: { id: '12345', name: 'member' },
      content: '敏感话题检测开',
      event: { sender: { role: 'member' }, message: [] },
    }))
    checkSentIncludes(t, 'scenario non-admin sensitive switch rejected', nonAdminSensitive, '管理员')
    t.check('scenario non-admin sensitive switch does not write file', data.readText('political-detect-enabled.json') === sensitiveBefore)

    const adminSensitive = await run(makeSession({
      content: '敏感话题检测开',
      event: { sender: { role: 'admin' }, message: [] },
    }))
    checkSentIncludes(t, 'scenario group admin sensitive switch accepted', adminSensitive, '敏感话题检测已开启')
    t.check('scenario sensitive switch writes channel list', data.readJson('political-detect-enabled.json').includes('10001'))

    const sensitiveView = await run(makeSession({ content: '敏感话题检测查看' }))
    checkSentIncludes(t, 'scenario sensitive view sees enabled state', sensitiveView, '开')

    const reload = await run(makeSession({ content: 'AI重载' }))
    checkSentIncludes(t, 'scenario AI reload replies', reload, 'AI配置已重载')

    const emotion = await run(makeSession({ content: '今日情绪' }))
    checkSentIncludes(t, 'scenario today emotion empty cache replies', emotion, '还没有')

    const personaList = await run(makeSession({ content: '东雪莲人格列表' }))
    t.check('scenario persona list command is handled', personaList.sent.length > 0, JSON.stringify(personaList.sent))

    const groupPersona = await run(makeSession({
      userId: '12345',
      author: { id: '12345', name: 'member' },
      content: '东雪莲群人格',
    }))
    checkSentIncludes(t, 'scenario non-admin group persona rejected', groupPersona, '管理员')

    t.check('scenario command temp files stay inside data dir', fs.existsSync(path.join(data.dataDir, 'ai-openai-key.txt')))
  })
}

module.exports = { run }
