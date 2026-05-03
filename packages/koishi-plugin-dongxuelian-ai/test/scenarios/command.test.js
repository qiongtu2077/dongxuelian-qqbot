const fs = require('fs')
const path = require('path')
const { withScenario } = require('./_setup')
const { checkSentNonEmpty, checkNoLeak, checkNextCalled } = require('../helpers/assert')

async function run(t) {
  t.section('scenario: command middleware')

  await withScenario({}, async ({ data, makeSession, run }) => {
    const status = await run(makeSession({ content: 'AI\u72b6\u6001' }))
    checkSentNonEmpty(t, 'scenario AI status replies', status)
    checkNoLeak(t, 'scenario AI status does not leak key', status, ['sk-test-secret', 'Bearer'])

    const help = await run(makeSession({ content: '\u5e2e\u52a9\u96c6\u5408' }))
    checkNextCalled(t, 'scenario reserved help command calls next', help)
    t.check('scenario reserved help command does not send', help.sent.length === 0, JSON.stringify(help.sent))

    const nonAdminThinking = await run(makeSession({
      userId: '12345',
      author: { id: '12345', name: 'member' },
      content: '\u4e1c\u96ea\u83b2\u601d\u8003\u5f00',
    }))
    checkSentNonEmpty(t, 'scenario non-admin thinking switch rejected with reply', nonAdminThinking)
    t.check('scenario non-admin thinking switch does not write file', data.readText('ai-enable-thinking.txt').trim() === 'off')

    const adminThinking = await run(makeSession({ content: '\u4e1c\u96ea\u83b2\u601d\u8003\u5f00' }))
    checkSentNonEmpty(t, 'scenario admin thinking switch accepted', adminThinking)
    t.check('scenario admin thinking switch writes file', data.readText('ai-enable-thinking.txt').trim() === 'on')

    const repeatBefore = data.readText('ai-repeat-enabled.json')
    const nonAdminRepeat = await run(makeSession({
      userId: '12345',
      author: { id: '12345', name: 'member' },
      content: '\u4e1c\u96ea\u83b2\u590d\u8bfb\u5f00',
    }))
    checkSentNonEmpty(t, 'scenario non-admin repeat switch rejected with reply', nonAdminRepeat)
    t.check('scenario non-admin repeat switch does not write file', data.readText('ai-repeat-enabled.json') === repeatBefore)

    const sensitiveBefore = data.readText('political-detect-enabled.json')
    const nonAdminSensitive = await run(makeSession({
      userId: '12345',
      author: { id: '12345', name: 'member' },
      content: '\u654f\u611f\u8bdd\u9898\u68c0\u6d4b\u5f00',
      event: { sender: { role: 'member' }, message: [] },
    }))
    checkSentNonEmpty(t, 'scenario non-admin sensitive switch rejected with reply', nonAdminSensitive)
    t.check('scenario non-admin sensitive switch does not write file', data.readText('political-detect-enabled.json') === sensitiveBefore)

    const adminSensitive = await run(makeSession({
      content: '\u654f\u611f\u8bdd\u9898\u68c0\u6d4b\u5f00',
      event: { sender: { role: 'admin' }, message: [] },
    }))
    checkSentNonEmpty(t, 'scenario group admin sensitive switch accepted', adminSensitive)
    t.check('scenario sensitive switch writes channel list', data.readJson('political-detect-enabled.json').includes('10001'))

    const sensitiveView = await run(makeSession({ content: '\u654f\u611f\u8bdd\u9898\u68c0\u6d4b\u67e5\u770b' }))
    checkSentNonEmpty(t, 'scenario sensitive view replies', sensitiveView)
    t.check('scenario sensitive view observes enabled file state', data.readJson('political-detect-enabled.json').includes('10001'))

    const reload = await run(makeSession({ content: 'AI\u91cd\u8f7d' }))
    checkSentNonEmpty(t, 'scenario AI reload replies', reload)

    const emotion = await run(makeSession({ content: '\u4eca\u65e5\u60c5\u7eea' }))
    checkSentNonEmpty(t, 'scenario today emotion empty cache replies', emotion)

    const personaList = await run(makeSession({ content: '\u4e1c\u96ea\u83b2\u4eba\u683c\u5217\u8868' }))
    t.check('scenario persona list command is handled', personaList.sent.length > 0, JSON.stringify(personaList.sent))

    const groupPersonaFile = path.join(data.dataDir, 'ai-persona-groups.json')
    const groupPersonaBefore = fs.existsSync(groupPersonaFile) ? fs.readFileSync(groupPersonaFile, 'utf8') : null
    const groupPersona = await run(makeSession({
      userId: '12345',
      author: { id: '12345', name: 'member' },
      content: '\u4e1c\u96ea\u83b2\u7fa4\u4eba\u683c',
    }))
    checkSentNonEmpty(t, 'scenario non-admin group persona rejected with reply', groupPersona)
    const groupPersonaAfter = fs.existsSync(groupPersonaFile) ? fs.readFileSync(groupPersonaFile, 'utf8') : null
    t.check('scenario non-admin group persona does not write file', groupPersonaAfter === groupPersonaBefore, JSON.stringify({ before: groupPersonaBefore, after: groupPersonaAfter }))

    t.check('scenario command temp files stay inside data dir', fs.existsSync(path.join(data.dataDir, 'ai-openai-key.txt')))
  })

  await withScenario({ data: { adminUserIds: ['999001'] } }, async ({ data, makeSession, run }) => {
    const oldDefaultAdmin = await run(makeSession({ content: '\u4e1c\u96ea\u83b2\u601d\u8003\u5f00' }))
    checkSentNonEmpty(t, 'scenario custom admin config rejects old default admin', oldDefaultAdmin)
    t.check('scenario custom admin config leaves thinking disabled for old default admin', data.readText('ai-enable-thinking.txt').trim() === 'off')

    const customAdmin = await run(makeSession({
      userId: '999001',
      author: { id: '999001', name: 'custom-admin', nick: 'custom-admin' },
      content: '\u4e1c\u96ea\u83b2\u601d\u8003\u5f00',
    }))
    checkSentNonEmpty(t, 'scenario custom admin config accepts configured admin', customAdmin)
    t.check('scenario custom admin config writes thinking file', data.readText('ai-enable-thinking.txt').trim() === 'on')

    const blacklistConfiguredAdmin = await run(makeSession({ content: '\u7528\u6237\u9ed1\u540d\u5355\u6dfb\u52a0 999001' }))
    checkSentNonEmpty(t, 'scenario user blacklist refuses configured admin id', blacklistConfiguredAdmin)
    t.check('scenario user blacklist does not store configured admin id', !data.readJson('ai-user-blacklist.json').includes('999001'))
  })
}

module.exports = { run }
