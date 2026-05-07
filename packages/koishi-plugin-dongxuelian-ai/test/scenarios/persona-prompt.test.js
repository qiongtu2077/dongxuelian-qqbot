const { withScenario } = require('./_setup')
const { mockFetch } = require('../fake/fetch')

const MARKERS = {
  core: 'CORE_SAFETY_MARKER',
  default: 'DEFAULT_DONGXUELIAN_MARKER',
  theresa: 'THERESA_PERSONA_MARKER',
  changli: 'CHANGLI_PERSONA_MARKER',
  terra: 'TERRA_LORE_MARKER',
  wuwa: 'WUWA_LORE_MARKER',
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
  data.writeText('ai-skills/personas/SKILL.theresa.md', [
    '---',
    `name: ${TEXT.theresa}`,
    'description: test Theresa persona',
    'lore: terra-lore',
    '---',
    MARKERS.theresa,
  ].join('\n'))
  data.writeText('ai-skills/personas/SKILL.changli.md', [
    '---',
    `name: ${TEXT.changli}`,
    'description: test Changli persona',
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
}

function userSession(makeSession, userId, content = '') {
  return makeSession({
    userId,
    author: { id: userId, name: `u${userId}` },
    content,
  })
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

function isMainChatPromptCall(call, marker) {
  return getSystemPrompt(call).includes(MARKERS.core) && callHasCaptureMarker(call, marker)
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

async function withPromptScenario(fn) {
  const originalFetch = global.fetch
  await withScenario({}, async ({ data, makeSession, run, ready }) => {
    writePromptMarkerSkills(data)
    await ready()
    const mocked = mockFetch()
    global.fetch = mocked.fetch
    let captureCounter = 0
    try {
      async function capturePrompt(t, userId, input) {
        captureCounter += 1
        const captureMarker = `PROMPT_CAPTURE_${captureCounter}_${Date.now()}`
        const markedInput = `${input} ${captureMarker}`
        const session = userSession(makeSession, userId)
        session.content = `<at id="${session.selfId}"/> ${markedInput}`
        const before = mocked.calls.length
        await run(session, { flushTicks: 120 })
        await session.waitForSend()
        const newCalls = mocked.calls.slice(before)
        const matches = newCalls.filter(call => isMainChatPromptCall(call, captureMarker))
        t.check(
          'scenario persona prompt captures main chat request',
          matches.length > 0,
          describeCalls(newCalls, captureMarker)
        )
        if (matches.length === 0) return ''
        return getSystemPrompt(matches[matches.length - 1])
      }
      await fn({ capturePrompt, makeSession, run, mocked })
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
    const prompt = await capturePrompt(t, '532701045', TEXT.hello)
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
    const prompt = await capturePrompt(t, '532701045', TEXT.hello)
    checkIncludes(t, 'scenario persona reset returns to default persona', prompt, MARKERS.default)
    checkExcludes(t, 'scenario persona reset removes Theresa persona', prompt, MARKERS.theresa)
  })

  await withPromptScenario(async ({ capturePrompt, makeSession, run }) => {
    const defaultTerraPrompt = await capturePrompt(t, '2004', TEXT.terraQuestion)
    checkExcludes(t, 'scenario Terra lore does not inject for default persona', defaultTerraPrompt, MARKERS.terra)

    await run(makeSession({ content: TEXT.switchPersona + TEXT.theresa }))
    const theresaTerraPrompt = await capturePrompt(t, '532701045', TEXT.terraQuestion)
    checkIncludes(t, 'scenario Terra lore injects for Theresa trigger', theresaTerraPrompt, MARKERS.terra)
    checkIncludes(t, 'scenario Terra lore keeps Theresa persona marker', theresaTerraPrompt, MARKERS.theresa)
  })

  await withPromptScenario(async ({ capturePrompt }) => {
    const prompt = await capturePrompt(t, '2005', TEXT.wuwaQuestion)
    checkIncludes(t, 'scenario Wuwa lore injects for Wuwa trigger', prompt, MARKERS.wuwa)
    checkIncludes(t, 'scenario Wuwa lore keeps default persona marker', prompt, MARKERS.default)
    checkExcludes(t, 'scenario Wuwa lore does not imply Theresa persona', prompt, MARKERS.theresa)
  })
}

module.exports = { run }
