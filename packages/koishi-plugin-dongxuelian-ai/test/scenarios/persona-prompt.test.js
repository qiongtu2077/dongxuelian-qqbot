const fs = require('fs')
const { withScenario } = require('./_setup')
const { mockFetch } = require('../fake/fetch')

const MARKERS = {
  core: 'CORE_SAFETY_MARKER',
  default: 'DEFAULT_DONGXUELIAN_MARKER',
  theresa: 'THERESA_PERSONA_MARKER',
  changli: 'CHANGLI_PERSONA_MARKER',
  terra: 'TERRA_LORE_MARKER',
  wuwa: 'WUWA_LORE_MARKER',
  customLore: 'CUSTOM_LORE_MARKER',
  forcedAbusive: 'FORCED_ROAST_MODE_MARKER',
}

const TEXT = {
  theresa: '\u7279\u857e\u897f\u5a05',
  changli: '\u957f\u79bb',
  hello: '\u4f60\u597d',
  switchPersona: '\u4e1c\u96ea\u83b2\u4eba\u683c\u5207\u6362 ',
  switchGroupPersona: '\u4e1c\u96ea\u83b2\u7fa4\u4eba\u683c\u5207\u6362 ',
  resetPersona: '\u4e1c\u96ea\u83b2\u4eba\u683c\u91cd\u7f6e',
  terraQuestion: '\u77ff\u77f3\u75c5\u662f\u4ec0\u4e48',
  wuwaQuestion: '\u4eca\u5dde\u662f\u4ec0\u4e48',
  customLoreQuestion: '\u661f\u70ac\u5b66\u9662\u662f\u4ec0\u4e48',
}

function writePromptMarkerSkills(data) {
  data.writeText('ai-skills/core/SKILL.persona-core.md', [
    '---',
    'name: persona-core',
    '---',
    MARKERS.core,
  ].join('\n'))
  data.writeText('ai-skills/modes/SKILL.persona-friendly.md', [
    '---',
    'name: persona-friendly',
    '---',
    MARKERS.default,
  ].join('\n'))
  data.writeText('ai-skills/modes/SKILL.persona-abusive.md', [
    '---',
    'name: persona-abusive',
    '---',
    'ABUSIVE_MODE_MARKER',
  ].join('\n'))
  data.writeText('ai-skills/modes/SKILL.persona-test.md', [
    '---',
    'name: persona-test',
    '---',
    'TEST_MODE_MARKER',
  ].join('\n'))
  data.writeText('ai-skills/modes/SKILL.persona-forced-abusive.md', [
    '---',
    'name: 嘴臭莲莲',
    'lore: none',
    'voice_style: FORCED_ABUSIVE_VOICE_MARKER',
    '---',
    MARKERS.forcedAbusive,
  ].join('\n'))
  data.writeText('ai-skills/modes/SKILL.persona-yinyang.md', 'YINYANG_MODE_MARKER')
  data.writeText('ai-skills/personas/SKILL.theresa.md', [
    '---',
    `name: ${TEXT.theresa}`,
    'description: test Theresa persona',
    '---',
    MARKERS.theresa,
  ].join('\n'))
  data.writeText('ai-skills/personas/SKILL.changli.md', [
    '---',
    `name: ${TEXT.changli}`,
    'description: test Changli persona',
    'lore: custom-lore',
    '---',
    MARKERS.changli,
  ].join('\n'))
  data.writeText('ai-skills/lore/SKILL.terra-lore.md', [
    '---',
    'name: terra-lore',
    '---',
    MARKERS.terra,
  ].join('\n'))
  data.writeText('ai-skills/lore/SKILL.wuwa-lore.md', [
    '---',
    'name: wuwa-lore',
    '---',
    MARKERS.wuwa,
  ].join('\n'))
  data.writeText('ai-skills/lore/SKILL.custom-lore.md', [
    '---',
    'name: custom-lore',
    'description: test custom lore',
    'keywords: 星炬学院, 拉海洛',
    'max_chars: 600',
    '---',
    MARKERS.customLore,
  ].join('\n'))
}

// 构造指定用户的真实聊天测试会话，允许覆盖群聊与私聊上下文。
function userSession(makeSession, userId, content = '', overrides = {}) {
  return makeSession({
    userId,
    author: { id: userId, name: `u${userId}` },
    content,
    ...overrides,
  })
}

function getPromptText(call) {
  const body = call && call.requestBody
  const messages = body && body.messages
  if (!Array.isArray(messages)) return ''
  return messages.filter(item => item && item.role === 'system').map(item => String(item.content || '')).join('\n\n')
}

function getSystemPrompt(call) {
  const body = call && call.requestBody
  const messages = body && body.messages
  if (!Array.isArray(messages)) return ''
  if (!messages[0] || messages[0].role !== 'system') return ''
  return String(messages[0].content || '')
}

function messageContentHasMarker(content, marker) {
  if (typeof content === 'string') return content.includes(marker)
  if (Array.isArray(content)) {
    return content.some(item => {
      if (typeof item === 'string') return item.includes(marker)
      if (!item || typeof item !== 'object') return false
      return String(item.text || item.content || '').includes(marker)
    })
  }
  return false
}

function callHasCaptureMarker(call, marker) {
  if (!marker) return true
  const body = call && call.requestBody
  const messages = body && body.messages
  return Array.isArray(messages) && messages.some(message => messageContentHasMarker(message && message.content, marker))
}

// 通过人格与本轮唯一标记定位正文请求，排除辅助判断调用。
function isMainChatPromptCall(call, marker) {
  const system = getSystemPrompt(call)
  return (system.includes(MARKERS.core) || system.includes(MARKERS.forcedAbusive) || system.includes('TEST_MODE_MARKER')) && callHasCaptureMarker(call, marker)
}

function markerStatus(prompt = '') {
  return Object.entries(MARKERS)
    .map(([key, marker]) => `${key}=${String(prompt).includes(marker)}`)
    .join(' ')
}

function describeCalls(calls, captureMarker) {
  return JSON.stringify(calls.map((call, index) => {
    const body = call.requestBody || {}
    const system = getSystemPrompt(call)
    const messages = Array.isArray(body.messages) ? body.messages : []
    return {
      index,
      url: call.url,
      model: body.model,
      messageCount: messages.length,
      hasCore: system.includes(MARKERS.core),
      hasCaptureMarker: callHasCaptureMarker(call, captureMarker),
      markerStatus: markerStatus(system),
      systemHead: system.slice(0, 300),
    }
  }), null, 2)
}

// 隔离数据和外部 HTTP，保留真实人格解析、提示词组合和聊天实现。
async function withPromptScenario(fn) {
  const originalFetch = global.fetch
  await withScenario({}, async ({ data, makeSession, run, ready, harness }) => {
    writePromptMarkerSkills(data)
    await ready()
    const mocked = mockFetch()
    global.fetch = mocked.fetch
    let captureCounter = 0
    try {
      // 经真实中间件捕获回复；显式选项用于验证随机和工具转述的同一聊天实现。
      async function capturePrompt(t, userId, input, sessionOverrides = {}, chatOptions = null) {
        captureCounter += 1
        const captureMarker = `PROMPT_CAPTURE_${captureCounter}_${Date.now()}`
        const markedInput = `${input} ${captureMarker}`
        const session = userSession(makeSession, userId, '', sessionOverrides)
        session.content = `<at id="${session.selfId}"/> ${markedInput}`
        const before = mocked.calls.length
        if (chatOptions) await require('../../lib/chat').chat(session, markedInput, harness.ctx, chatOptions)
        else {
          await run(session, { flushTicks: 120 })
          await session.waitForSend()
        }
        const newCalls = mocked.calls.slice(before)
        const matches = newCalls.filter(call => isMainChatPromptCall(call, captureMarker))
        t.check(
          'scenario persona prompt captures main chat request',
          matches.length > 0,
          describeCalls(newCalls, captureMarker)
        )
        if (matches.length === 0) return ''
        return getPromptText(matches[matches.length - 1])
      }
      await fn({ capturePrompt, makeSession, run, mocked, data, harness })
    } finally {
      global.fetch = originalFetch
    }
  })
}

function promptDiagnostic(prompt) {
  return `${markerStatus(prompt)} prompt=${String(prompt).slice(0, 2000)}`
}

function checkIncludes(t, label, prompt, marker) {
  t.check(label, prompt.includes(marker), promptDiagnostic(prompt))
}

function checkExcludes(t, label, prompt, marker) {
  t.check(label, !prompt.includes(marker), promptDiagnostic(prompt))
}

async function run(t) {
  t.section('scenario: persona prompt composition')

  await withPromptScenario(async ({ capturePrompt }) => {
    const prompt = await capturePrompt(t, '2001', TEXT.hello)
    checkIncludes(t, 'scenario default prompt includes core safety', prompt, MARKERS.core)
    checkIncludes(t, 'scenario default prompt includes default Dongxuelian persona', prompt, MARKERS.default)
    checkExcludes(t, 'scenario default prompt excludes Theresa persona', prompt, MARKERS.theresa)
    checkExcludes(t, 'scenario default prompt excludes Changli persona', prompt, MARKERS.changli)
  })

  await withPromptScenario(async ({ capturePrompt, makeSession, run }) => {
    await run(makeSession({ content: TEXT.switchPersona + TEXT.theresa }))
    const prompt = await capturePrompt(t, '100000000', TEXT.hello)
    checkIncludes(t, 'scenario personal Theresa prompt includes core safety', prompt, MARKERS.core)
    checkIncludes(t, 'scenario personal Theresa prompt includes Theresa persona', prompt, MARKERS.theresa)
    checkExcludes(t, 'scenario personal Theresa prompt excludes default Dongxuelian persona', prompt, MARKERS.default)
    checkExcludes(t, 'scenario personal Theresa prompt excludes Changli persona', prompt, MARKERS.changli)
  })

  await withPromptScenario(async ({ capturePrompt, makeSession, run }) => {
    await run(makeSession({ content: TEXT.switchGroupPersona + TEXT.theresa }))
    const groupPrompt = await capturePrompt(t, '2002', TEXT.hello)
    checkIncludes(t, 'scenario group persona applies to user without personal persona', groupPrompt, MARKERS.theresa)
    checkExcludes(t, 'scenario group persona excludes default persona', groupPrompt, MARKERS.default)

    await run(makeSession({
      userId: '2003',
      author: { id: '2003', name: 'u2003' },
      content: TEXT.switchPersona + TEXT.changli,
    }))
    const personalPrompt = await capturePrompt(t, '2003', TEXT.hello)
    checkIncludes(t, 'scenario personal persona overrides group persona', personalPrompt, MARKERS.changli)
    checkExcludes(t, 'scenario personal override excludes group Theresa persona', personalPrompt, MARKERS.theresa)
  })

  await withPromptScenario(async ({ capturePrompt, makeSession, run }) => {
    await run(makeSession({ content: TEXT.switchPersona + TEXT.theresa }))
    await run(makeSession({ content: TEXT.resetPersona }))
    const prompt = await capturePrompt(t, '100000000', TEXT.hello)
    checkIncludes(t, 'scenario persona reset returns to default persona', prompt, MARKERS.default)
    checkExcludes(t, 'scenario persona reset removes Theresa persona', prompt, MARKERS.theresa)
  })

  await withPromptScenario(async ({ capturePrompt, makeSession, run }) => {
    const defaultTerraPrompt = await capturePrompt(t, '2004', TEXT.terraQuestion)
    checkExcludes(t, 'scenario Terra lore does not inject for default persona', defaultTerraPrompt, MARKERS.terra)

    await run(makeSession({ content: TEXT.switchPersona + TEXT.theresa }))
    const theresaTerraPrompt = await capturePrompt(t, '100000000', TEXT.terraQuestion)
    checkIncludes(t, 'scenario Terra lore injects for Theresa trigger', theresaTerraPrompt, MARKERS.terra)
    checkIncludes(t, 'scenario Terra lore keeps Theresa persona marker', theresaTerraPrompt, MARKERS.theresa)
  })

  await withPromptScenario(async ({ capturePrompt }) => {
    const prompt = await capturePrompt(t, '2005', TEXT.wuwaQuestion)
    checkIncludes(t, 'scenario Wuwa lore injects for Wuwa trigger', prompt, MARKERS.wuwa)
    checkIncludes(t, 'scenario Wuwa lore keeps default persona marker', prompt, MARKERS.default)
    checkExcludes(t, 'scenario Wuwa lore does not imply Theresa persona', prompt, MARKERS.theresa)
  })

  await withPromptScenario(async ({ capturePrompt, makeSession, run }) => {
    await run(makeSession({
      userId: '2006',
      author: { id: '2006', name: 'u2006' },
      content: TEXT.switchPersona + TEXT.changli,
    }))
    const prompt = await capturePrompt(t, '2006', TEXT.customLoreQuestion)
    checkIncludes(t, 'scenario custom lore injects from frontmatter keywords', prompt, MARKERS.customLore)
    checkIncludes(t, 'scenario custom lore keeps bound persona marker', prompt, MARKERS.changli)
    checkExcludes(t, 'scenario custom lore does not inject default Wuwa lore', prompt, MARKERS.wuwa)
  })

  await withPromptScenario(async ({ capturePrompt, makeSession, run, data, harness, mocked }) => {
    const persona = require('../../lib/persona/persona')
    const constants = require('../../lib/core/constants')
    const agent = require('../../lib/agent/persona-context')
    const voice = require('../../lib/media/voice/tts')
    persona.setGroupPersona('10001', TEXT.theresa)
    persona.setUserPersona('100000000', TEXT.changli)
    const originalGroups = data.readText('ai-persona-groups.json')
    const originalUsers = data.readText('ai-persona-users.json')
    // 采用与 Dashboard 相同的原子替换，验证运行中的人格热切换。
    function setAbusive(enabled) {
      data.writeJson('bot-participation.json.next', { version: 1, privateEnabled: true, groups: { 10001: true, 10002: true }, abusiveGroups: { 10001: enabled } })
      fs.renameSync(data.pathFor('bot-participation.json.next'), data.pathFor('bot-participation.json'))
    }
    setAbusive(false)
    const originalPrompt = await capturePrompt(t, '100000000', TEXT.hello)
    checkIncludes(t, 'disabled abusive switch keeps personal persona', originalPrompt, MARKERS.changli)
    setAbusive(true)
    fs.writeFileSync(constants.TEST_MODE_FILE, '1')
    const forcedPrompt = await capturePrompt(t, '100000000', TEXT.hello)
    checkIncludes(t, 'group abusive overrides personal group and admin test personas', forcedPrompt, MARKERS.forcedAbusive)
    for (const marker of [MARKERS.core, MARKERS.default, MARKERS.theresa, MARKERS.changli, 'TEST_MODE_MARKER', 'YINYANG_MODE_MARKER', 'ABUSIVE_MODE_MARKER']) {
      checkExcludes(t, 'forced abusive excludes competing persona ' + marker, forcedPrompt, marker)
    }
    fs.unlinkSync(constants.TEST_MODE_FILE)
    for (const input of ['对不起，刚才是我说错了', '怎么配置这个功能', '今天你好好说话吧']) {
      const prompt = await capturePrompt(t, '100000000', input)
      checkIncludes(t, 'forced abusive does not decay after normal or apologetic input: ' + input, prompt, MARKERS.forcedAbusive)
      checkExcludes(t, 'forced abusive skips friendly serious question rule: ' + input, prompt, '这是一个正经提问')
    }
    const randomPrompt = await capturePrompt(t, '2102', '大家正在讨论一个技术问题', {}, { randomTriggered: true })
    checkIncludes(t, 'forced abusive random reply retains persona', randomPrompt, MARKERS.forcedAbusive)
    checkIncludes(t, 'forced abusive random reply explicitly requires profanity', randomPrompt, '针对当前发言直接带脏话开喷')
    checkExcludes(t, 'forced abusive random reply excludes peaceful override', randomPrompt, '不要怼不要吐槽')
    const retellPrompt = await capturePrompt(t, '2103', '刚才的任务完成了吗', {}, { isAgentResult: true, agentResultText: '任务已经完成，结果可用。' })
    checkIncludes(t, 'forced abusive tool result retell retains persona', retellPrompt, MARKERS.forcedAbusive)
    const otherGroup = await capturePrompt(t, '100000000', TEXT.hello, { guildId: '10002', channelId: '10002' })
    checkIncludes(t, 'group abusive does not leak to another group', otherGroup, MARKERS.changli)
    checkExcludes(t, 'other group excludes forced abusive', otherGroup, MARKERS.forcedAbusive)
    const privatePrompt = await capturePrompt(t, '100000000', TEXT.hello, { isDirect: true, channelId: 'private:100000000' })
    checkIncludes(t, 'temporary private chat keeps personal persona despite source guild', privatePrompt, MARKERS.changli)
    checkExcludes(t, 'private chat excludes forced abusive', privatePrompt, MARKERS.forcedAbusive)
    const agentOptions = { channel: 'qq', channelKey: '10001', userId: '100000000', agentMode: true, config: { persona: { qqInheritChatPersona: false } } }
    const agentPrompt = agent.buildAgentPersonaContext(agentOptions).map(message => message.content).join('\n')
    checkIncludes(t, 'QQ agent forced abusive overrides disabled inheritance and direct mode', agentPrompt, MARKERS.forcedAbusive)
    checkExcludes(t, 'QQ agent forced abusive excludes friendly core', agentPrompt, MARKERS.core)
    t.checkEqual('forced abusive voice uses same resolved persona', voice.resolvePersonaVoice(persona.resolvePersona('10001', '100000000').name).style, 'FORCED_ABUSIVE_VOICE_MARKER')
    data.writeText('ai-skills/personas/SKILL.shadow-abusive.md', '---\nname: 嘴臭莲莲\n---\nSHADOW_PERSONA_MARKER')
    checkExcludes(t, 'same-name custom persona cannot shadow forced mode', persona.loadPersonalSkill('嘴臭莲莲'), 'SHADOW_PERSONA_MARKER')
    const beforeNameCall = mocked.calls.length
    const nameSession = makeSession({ userId: '2104', content: '莲莲，你在干嘛' })
    await run(nameSession, { flushTicks: 120 })
    await nameSession.waitForSend()
    t.check('forced abusive still responds to bot name without @', mocked.calls.slice(beforeNameCall).some(call => getSystemPrompt(call).includes(MARKERS.forcedAbusive)))
    const chat = require('../../lib/chat').chat
    const repeatSession = makeSession({ userId: '2105' })
    await chat(repeatSession, '这句话说了第二遍', harness.ctx)
    const beforeRepeat = mocked.calls.length
    await chat(repeatSession, '这句话说了第二遍', harness.ctx)
    t.check('forced abusive repeated input still invokes persona rather than echoing user', mocked.calls.slice(beforeRepeat).some(call => getSystemPrompt(call).includes(MARKERS.forcedAbusive)))
    setAbusive(false)
    const restoredPersonal = await capturePrompt(t, '100000000', TEXT.hello)
    checkIncludes(t, 'closing abusive restores original personal persona', restoredPersonal, MARKERS.changli)
    checkExcludes(t, 'closing abusive removes forced persona', restoredPersonal, MARKERS.forcedAbusive)
    const restoredGroup = await capturePrompt(t, '2106', TEXT.hello)
    checkIncludes(t, 'closing abusive restores original group persona', restoredGroup, MARKERS.theresa)
    const restoredRandom = await capturePrompt(t, '2107', '大家正在讨论一个技术问题', {}, { randomTriggered: true })
    checkIncludes(t, 'closing abusive restores peaceful random reply rule', restoredRandom, '不要怼不要吐槽')
    checkExcludes(t, 'closing abusive restores agent direct mode', agent.buildAgentPersonaContext(agentOptions).map(message => message.content).join('\n'), MARKERS.forcedAbusive)
    t.checkEqual('abusive switch never mutates original group bindings', data.readText('ai-persona-groups.json'), originalGroups)
    t.checkEqual('abusive switch never mutates original user bindings', data.readText('ai-persona-users.json'), originalUsers)
  })
}

module.exports = { run }
