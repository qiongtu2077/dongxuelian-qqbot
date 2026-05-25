const fs = require('fs')
const path = require('path')
const { withScenario } = require('./_setup')
const { checkSentNonEmpty, checkNoLeak, checkNextCalled } = require('../helpers/assert')

async function run(t) {
  t.section('scenario: command middleware')

  await withScenario({}, async ({ data, harness, makeSession, run }) => {
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

    const agentRouteOff = await run(makeSession({ content: '\u5de5\u5177\u81ea\u52a8\u8def\u7531 \u5173' }))
    checkSentNonEmpty(t, 'scenario agent auto route switch replies', agentRouteOff)
    t.check('scenario agent auto route writes config', data.readJson('ai-tool-config.json').autoRoute.qq.enabled === false)

    const beforeToolConfig = JSON.stringify(data.readJson('ai-tool-config.json'))
    const nonAdminToolSwitch = await run(makeSession({
      userId: '12345',
      author: { id: '12345', name: 'member' },
      content: '\u5de5\u5177\u5f00\u5173 qq web_search \u5f00',
    }))
    checkSentNonEmpty(t, 'scenario non-admin tool switch rejected', nonAdminToolSwitch)
    t.check('scenario non-admin tool switch does not write enabled tool', JSON.stringify(data.readJson('ai-tool-config.json')) === beforeToolConfig)

    const adminToolSwitch = await run(makeSession({ content: '\u5de5\u5177\u5f00\u5173 qq web_search \u5f00' }))
    checkSentNonEmpty(t, 'scenario admin tool switch accepted', adminToolSwitch)
    t.check('scenario admin tool switch writes enabled tool', data.readJson('ai-tool-config.json').channels.qq.tools.web_search === true)

    const blockedQqShell = await run(makeSession({ content: '\u5de5\u5177\u5f00\u5173 qq execute_shell \u5f00' }))
    checkSentNonEmpty(t, 'scenario qq high-risk tool switch replies', blockedQqShell)
    t.check('scenario qq shell switch stays disabled', data.readJson('ai-tool-config.json').channels.qq.tools.execute_shell === false)

    const qqSkillReader = await run(makeSession({ content: '\u5de5\u5177\u5f00\u5173 qq read_agent_skill \u5f00' }))
    checkSentNonEmpty(t, 'scenario qq read_agent_skill switch accepted', qqSkillReader)
    t.check('scenario qq read_agent_skill switch writes enabled tool', data.readJson('ai-tool-config.json').channels.qq.tools.read_agent_skill === true)

    const agentSkillList = await run(makeSession({ content: '\u5de5\u5177Skill \u5217\u8868' }))
    checkSentNonEmpty(t, 'scenario agent skill list replies', agentSkillList)
    t.check('scenario agent skill list excludes fixture persona', !agentSkillList.sent.join('\n').includes('\u6d4b\u8bd5\u4eba\u683c'), JSON.stringify(agentSkillList.sent))
    t.check('scenario agent skill list shows real skill fixture', agentSkillList.sent.join('\n').includes('wuwa-lore'), JSON.stringify(agentSkillList.sent))

    const nonAdminSkillSwitch = await run(makeSession({
      userId: '12345',
      author: { id: '12345', name: 'member' },
      content: '\u5de5\u5177Skill \u5f00 wuwa-lore',
    }))
    checkSentNonEmpty(t, 'scenario non-admin agent skill switch rejected', nonAdminSkillSwitch)
    t.check('scenario non-admin agent skill switch does not write enabled skill', !data.readJson('ai-tool-config.json').enabledSkills.includes('wuwa-lore'))

    const personaSkillSwitch = await run(makeSession({ content: '\u5de5\u5177Skill \u5f00 \u6d4b\u8bd5\u4eba\u683c' }))
    checkSentNonEmpty(t, 'scenario persona cannot be enabled as skill replies', personaSkillSwitch)
    t.check('scenario persona cannot be enabled as skill', !data.readJson('ai-tool-config.json').enabledSkills.includes('\u6d4b\u8bd5\u4eba\u683c'))

    const adminSkillSwitch = await run(makeSession({ content: '\u5de5\u5177Skill \u5f00 wuwa-lore' }))
    checkSentNonEmpty(t, 'scenario admin agent skill switch accepted', adminSkillSwitch)
    t.check('scenario admin agent skill switch writes enabled skill', data.readJson('ai-tool-config.json').enabledSkills.includes('wuwa-lore'))

    const emotion = await run(makeSession({ content: '\u4eca\u65e5\u60c5\u7eea' }))
    checkSentNonEmpty(t, 'scenario today emotion empty cache replies', emotion)

    const handler = require('../../lib/handler')
    const { todayCst, todayCstMinusDays } = require('../../lib/utils')
    const today = todayCst()
    data.writeJson('emotion-history-10001.json', [{ date: todayCstMinusDays(1), score: 42, summary: '旧格式摘要' }])
    const emotionCache = new Map([['10001', {
      date: today,
      messages: [
        { time: '10:00:01', ts: Date.now(), user: 'Alice', userId: 'u1', content: '今天活动很热闹' },
        { time: '10:01:02', ts: Date.now(), user: 'Bob', userId: 'u2', content: '大家都在聊新版本' },
        { time: '10:02:03', ts: Date.now(), user: 'Alice', userId: 'u1', content: '气氛还不错' },
      ],
    }]])
    let modelCalls = 0
    let imageRenderCalls = 0
    let promptLimitSeen = false
    const state = {
      plain: '\u4eca\u65e5\u60c5\u7eea',
      inGuild: true,
      channelKey: '10001',
      currentUserId: '100000000',
      channelTodayCache: emotionCache,
      lastEmotionCache: new Map(),
      async loadConfig() {},
      async callOpenAI(messages) {
        modelCalls += 1
        const prompt = messages.map(item => item.content).join('\n')
        if (prompt.includes('只输出 JSON')) {
          promptLimitSeen = prompt.includes('不得超过1500字') && prompt.includes('每条300字以内')
          return JSON.stringify({ score: 76, confidence: 84, mood: '偏乐观', summary: '讨论热度高，整体偏积极。', reasons: ['成员围绕新版本持续互动', '负面表达很少'], keywords: ['新版本', '活动'] })
        }
        return '新版本讨论多，互动热度高，整体偏积极。'
      },
      async renderEmotionImage(analysis, stats, history) {
        imageRenderCalls += 1
        t.check('scenario today emotion image gets real sample stats', stats.messageCount === 3 && stats.userCount === 2, JSON.stringify(stats))
        t.check('scenario today emotion image reads old history format', history.some(item => item.summary === '旧格式摘要'), JSON.stringify(history))
        t.check('scenario today emotion image gets bounded analysis', analysis.summary.length <= 80 && analysis.reasons.every(reason => reason.length <= 300), JSON.stringify(analysis))
        return Buffer.from('emotion-image-ok')
      },
    }
    const structuredEmotionSession = makeSession({ content: '\u4eca\u65e5\u60c5\u7eea' })
    const structuredEmotion = await handler.handleCommand(structuredEmotionSession, harness.ctx, state)
    const emotionImage = String(structuredEmotion.response || '')
    t.check('scenario today emotion sends thinking immediately', structuredEmotionSession.sent.includes('Thinking......'), JSON.stringify(structuredEmotionSession.sent))
    t.check('scenario today emotion returns image', emotionImage.includes('data:image/png;base64,ZW1vdGlvbi1pbWFnZS1vaw=='), emotionImage)
    t.check('scenario today emotion prompt caps display text', promptLimitSeen)
    t.check('scenario today emotion renders image once', imageRenderCalls === 1, String(imageRenderCalls))
    const cachedEmotion = await handler.handleCommand(makeSession({ content: '\u4eca\u65e5\u60c5\u7eea' }), harness.ctx, state)
    t.check('scenario today emotion cache reuses image response', cachedEmotion.response === structuredEmotion.response && modelCalls === 2, JSON.stringify({ cached: String(cachedEmotion.response), modelCalls }))

    let fallbackModelCalls = 0
    let fallbackRenderCalls = 0
    let fallbackPromptSeen = false
    const fallbackState = {
      plain: '\u4eca\u65e5\u60c5\u7eea',
      inGuild: true,
      channelKey: '10001',
      currentUserId: '100000000',
      channelTodayCache: emotionCache,
      lastEmotionCache: new Map(),
      async loadConfig() {},
      async callOpenAI(messages) {
        fallbackModelCalls += 1
        const prompt = messages.map(item => item.content).join('\n')
        if (prompt.includes('500字以内')) {
          fallbackPromptSeen = true
          return '图片生成失败后的短文本回退。'.repeat(80)
        }
        if (prompt.includes('只输出 JSON')) return JSON.stringify({ score: 68, confidence: 77, mood: '偏乐观', summary: '互动稳定，气氛偏积极。', reasons: ['成员仍在围绕版本交流', '整体反馈比较轻松'], keywords: ['版本', '互动'] })
        return '版本讨论稳定，整体偏积极。'
      },
      async renderEmotionImage() {
        fallbackRenderCalls += 1
        throw new Error('forced image failure')
      },
    }
    const fallbackEmotionSession = makeSession({ content: '\u4eca\u65e5\u60c5\u7eea' })
    const fallbackEmotion = await handler.handleCommand(fallbackEmotionSession, harness.ctx, fallbackState)
    const fallbackText = String(fallbackEmotion.response || '')
    t.check('scenario today emotion fallback sends thinking immediately', fallbackEmotionSession.sent.includes('Thinking......'), JSON.stringify(fallbackEmotionSession.sent))
    t.check('scenario today emotion retries image twice', fallbackRenderCalls === 2, String(fallbackRenderCalls))
    t.check('scenario today emotion regenerates fallback text', fallbackPromptSeen && fallbackModelCalls === 3, JSON.stringify({ fallbackPromptSeen, fallbackModelCalls }))
    t.check('scenario today emotion fallback text capped at 500', fallbackText.length <= 500 && !fallbackText.includes('data:image/png'), JSON.stringify({ length: fallbackText.length, fallbackText }))

    const personaList = await run(makeSession({ content: '\u4e1c\u96ea\u83b2\u4eba\u683c\u5217\u8868' }))
    t.check('scenario persona list command is handled', personaList.sent.length > 0, JSON.stringify(personaList.sent))

    const personaListSendFailsSession = makeSession({
      content: '\u4e1c\u96ea\u83b2\u4eba\u683c\u5217\u8868',
      async send() {
        throw new Error('session send should not be called by persona commands')
      },
    })
    const personaListSendFails = await run(personaListSendFailsSession)
    t.check('scenario persona command returns through unified command result', personaListSendFails.sent.some(item => String(item).includes('\u53ef\u7528\u4eba\u683c')), JSON.stringify(personaListSendFails.sent))

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

    data.writeJson('ai-random-rate.json', { 10001: 0.42 })
    const nonAdminRandomRateReset = await run(makeSession({
      userId: '12345',
      author: { id: '12345', name: 'member' },
      content: '东雪莲群聊AI概率重置',
      event: { sender: { role: 'member' }, message: [] },
    }))
    checkSentNonEmpty(t, 'scenario non-admin random rate reset rejected with reply', nonAdminRandomRateReset)
    t.check('scenario non-admin random rate reset is denied by permission', nonAdminRandomRateReset.sent.some(item => String(item).includes('只有群主、群管理员或bot管理员才能管理概率')), JSON.stringify(nonAdminRandomRateReset.sent))
    t.check('scenario non-admin random rate reset does not write file', data.readJson('ai-random-rate.json')['10001'] === 0.42, JSON.stringify(data.readJson('ai-random-rate.json')))

    const nonAdminRandomRateInvalid = await run(makeSession({
      userId: '12345',
      author: { id: '12345', name: 'member' },
      content: '东雪莲群聊AI概率设置 abc',
      event: { sender: { role: 'member' }, message: [] },
    }))
    t.check('scenario non-admin random rate invalid format is permission-gated first', nonAdminRandomRateInvalid.sent.some(item => String(item).includes('只有群主、群管理员或bot管理员才能管理概率')), JSON.stringify(nonAdminRandomRateInvalid.sent))
    t.check('scenario non-admin random rate invalid does not write file', data.readJson('ai-random-rate.json')['10001'] === 0.42, JSON.stringify(data.readJson('ai-random-rate.json')))

    const groupAdminRandomRateReset = await run(makeSession({
      userId: '12345',
      author: { id: '12345', name: 'member' },
      content: '东雪莲群聊AI概率重置',
      event: { sender: { role: 'admin' }, message: [] },
    }))
    checkSentNonEmpty(t, 'scenario group admin random rate reset accepted', groupAdminRandomRateReset)
    t.check('scenario group admin random rate reset removes current group', data.readJson('ai-random-rate.json')['10001'] === undefined, JSON.stringify(data.readJson('ai-random-rate.json')))

    const voiceRateNonAdmin = await run(makeSession({
      userId: '12345',
      author: { id: '12345', name: 'member' },
      content: '东雪莲群聊语音概率设置 40%',
      event: { sender: { role: 'member' }, message: [] },
    }))
    checkSentNonEmpty(t, 'scenario non-admin voice rate switch rejected with reply', voiceRateNonAdmin)
    t.check('scenario non-admin voice rate switch does not write file', Object.keys(data.readJson('ai-random-voice-rate.json')).length === 0, JSON.stringify(data.readJson('ai-random-voice-rate.json')))

    const groupAdminVoiceRate = await run(makeSession({
      userId: '12345',
      author: { id: '12345', name: 'member' },
      content: '东雪莲群聊语音概率设置 40%',
      event: { sender: { role: 'admin' }, message: [] },
    }))
    checkSentNonEmpty(t, 'scenario group admin voice rate switch accepted', groupAdminVoiceRate)
    t.check('scenario group admin voice rate writes current group', data.readJson('ai-random-voice-rate.json')['10001'] === 0.4, JSON.stringify(data.readJson('ai-random-voice-rate.json')))
    const tts = require('../../lib/tts')
    t.check('scenario group admin voice rate is used by random voice trigger', tts.shouldTriggerRandomVoice('10001', () => 0.399) && !tts.shouldTriggerRandomVoice('10001', () => 0.4))

    const currentVoiceRateView = await run(makeSession({ content: '东雪莲群聊语音概率查看' }))
    t.check('scenario voice rate view shows current group value', currentVoiceRateView.sent.some(item => String(item).includes('40%')), JSON.stringify(currentVoiceRateView.sent))

    const directTargetVoiceRate = await run(makeSession({
      isDirect: true,
      guildId: '',
      channelId: 'private-1',
      content: '东雪莲群聊语音概率设置 20002 25%',
    }))
    checkSentNonEmpty(t, 'scenario bot admin target voice rate switch accepted', directTargetVoiceRate)
    t.check('scenario bot admin target voice rate writes requested group', data.readJson('ai-random-voice-rate.json')['20002'] === 0.25, JSON.stringify(data.readJson('ai-random-voice-rate.json')))

    const directTargetVoiceRateView = await run(makeSession({
      isDirect: true,
      guildId: '',
      channelId: 'private-1',
      content: '东雪莲群聊语音概率查看 20002',
    }))
    t.check('scenario target voice rate view shows requested group value', directTargetVoiceRateView.sent.some(item => String(item).includes('25%')), JSON.stringify(directTargetVoiceRateView.sent))

    const targetVoiceRateReset = await run(makeSession({
      isDirect: true,
      guildId: '',
      channelId: 'private-1',
      content: '东雪莲群聊语音概率重置 20002',
    }))
    checkSentNonEmpty(t, 'scenario target voice rate reset accepted', targetVoiceRateReset)
    t.check('scenario target voice rate reset removes requested group', data.readJson('ai-random-voice-rate.json')['20002'] === undefined, JSON.stringify(data.readJson('ai-random-voice-rate.json')))

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
