const path = require('path')
const { withScenario } = require('./_setup')
const { AI_ROOT } = require('../fake/file')
const { mockFetch } = require('../fake/fetch')
const { checkSentIncludes, checkSentNonEmpty, checkSentExcludes, checkNoLeak } = require('../helpers/assert')

const INCIDENT_SAMPLE = [
  '\u597d\u7684\uff0c\u7528\u6237A\u53d1\u4e86\u4e2a\u6d88\u606f\u8bf4\u201c\u5efa\u8bae\u795e\u5361\u201d\uff0c\u8fd9\u5e94\u8be5\u662f\u5728\u56de\u5e94\u4e0a\u4e00\u53e5',
  '\u6211\u5f97\u770b\u770b\u73b0\u5728\u662f\u4ec0\u4e48\u60c5\u51b5',
  '\u6211\u8bb0\u5f97\u6027\u683c\u8bbe\u5b9a\u662f\u5e73\u65f6\u6b63\u5e38\u804a\u5929',
  '\u8fd9\u4e2a\u573a\u666f\u770b\u8d77\u6765\u662f\u7fa4\u53cb\u5728\u8ba8\u8bba\u6e38\u620f\u89d2\u8272\uff0c\u6211\u5e94\u8be5\u7528\u8f7b\u677e\u7684\u6001\u5ea6\u6765\u56de\u5e94',
  '\u6211\u5f97\u63a5\u4e0a\u8fd9\u4e2a\u8bdd\u832c',
].join('\n')

function atBot(session, content = '\u4f60\u597d') {
  return `<at id="${session.selfId}"/> ${content}`
}

async function withFetch(mocked, fn) {
  const originalFetch = global.fetch
  const originalWarn = console.warn
  global.fetch = mocked.fetch
  console.warn = () => {}
  try {
    return await fn()
  } finally {
    global.fetch = originalFetch
    console.warn = originalWarn
  }
}

async function runChatCase(t, label, fetchQueue, assertions, options = {}) {
  await withScenario({}, async ({ harness, makeSession, run, data }) => {
    const mocked = mockFetch(fetchQueue)
    await withFetch(mocked, async () => {
      const session = makeSession(options.session || {})
      if (options.autoRoute) data.writeJson('ai-tool-config.json', { channels: { qq: { enabled: true, tools: { get_current_time: true, calculate: true } }, dashboard: { enabled: true, tools: {} } }, autoRoute: { qq: { enabled: true }, dashboard: { enabled: false } }, dangerousPolicy: 'confirm', enabledSkills: [], readFileRoots: [] })
      if (typeof options.setup === 'function') await options.setup(session, { harness, mocked, data })
      session.content = atBot(session, options.input || '\u4f60\u597d')
      const beforeCalls = mocked.calls.length
      let result = await run(session, { flushTicks: 120 })
      await session.waitForSend(options.waitFor || (() => true))
      await new Promise(resolve => setImmediate(resolve))
      result = {
        ...result,
        sent: session.sent,
        internalCalls: session.internalCalls,
        timeline: session.timeline,
        logs: harness.logs,
      }
      await assertions(result, mocked, session, mocked.calls.slice(beforeCalls))
    })
  }).catch(error => {
    throw new Error(`${label}: ${error && error.stack || error}`)
  })
}

async function run(t) {
  t.section('scenario: chat middleware and thinking guard')

  await runChatCase(t, 'visible content over reasoning middleware', [
    { json: { choices: [{ message: { content: 'final-visible', reasoning_content: 'reasoning-secret' } }] } },
  ], async (result) => {
    checkSentIncludes(t, 'scenario chat sends visible content', result, 'final-visible')
    checkSentExcludes(t, 'scenario chat does not send reasoning content', result, 'reasoning-secret')
    checkNoLeak(t, 'scenario chat visible content logs do not leak key', result, ['sk-test-secret', 'Bearer', 'reasoning-secret'])
  }, {
    waitFor: message => String(message).includes('final-visible'),
  })

  await runChatCase(t, 'agent auto route stays off by default', [
    { json: { choices: [{ message: { content: 'normal-time-answer' } }] } },
  ], async (result, mocked) => {
    checkSentIncludes(t, 'scenario agent auto route default off uses normal chat', result, 'normal-time-answer')
    t.check('scenario agent auto route default off uses single call', mocked.calls.length === 1, `calls=${mocked.calls.length}`)
  }, {
    input: '现在几点了',
    waitFor: message => String(message).includes('normal-time-answer'),
  })

  await runChatCase(t, 'agent auto route ignores casual greeting', [
    { json: { choices: [{ message: { content: 'greeting-ok' } }] } },
  ], async (result, mocked) => {
    checkSentIncludes(t, 'scenario agent auto route ignores casual greeting', result, 'greeting-ok')
    t.check('scenario casual greeting uses normal chat only', mocked.calls.length === 1, `calls=${mocked.calls.length}`)
  }, {
    input: '你好',
    waitFor: message => String(message).includes('greeting-ok'),
  })

  await runChatCase(t, 'agent auto route handles time question', [
    { json: { choices: [{ message: { content: '', tool_calls: [{ id: 'tc-time', type: 'function', function: { name: 'get_current_time', arguments: '{}' } }] } }] } },
    { json: { choices: [{ message: { content: 'agent-time-ok' } }] } },
  ], async (result, mocked, session, calls) => {
    checkSentIncludes(t, 'scenario agent auto route sends tool answer', result, 'agent-time-ok')
    t.check('scenario agent auto route used tool request', calls.length === 2 && Array.isArray(calls[0].requestBody.tools), JSON.stringify(calls.map(call => Object.keys(call.requestBody))))
    t.check('scenario agent auto route exposed time tool', calls[0].requestBody.tools.some(item => item.function && item.function.name === 'get_current_time'), JSON.stringify(calls[0].requestBody.tools))
  }, {
    input: '现在几点了',
    autoRoute: true,
    waitFor: message => String(message).includes('agent-time-ok'),
  })

  await runChatCase(t, 'explicit web_search request routes to Agent even when auto route disabled', [
    { json: { choices: [{ message: { content: '### Agent raw report\n**secret raw**\n- item' } }] } },
    { json: { choices: [{ message: { content: 'agent-search-retold' } }] } },
  ], async (result, mocked, session, calls) => {
    checkSentIncludes(t, 'scenario explicit web_search request sends chat reply', result, 'agent-search-retold')
    t.check('scenario explicit web_search sends one final QQ message', result.sent.length === 1, `sent=${JSON.stringify(result.sent)}`)
    checkSentExcludes(t, 'scenario explicit web_search does not send raw markdown heading', result, '### Agent raw report')
    checkSentExcludes(t, 'scenario explicit web_search does not send raw markdown body', result, '**secret raw**')
    t.check('scenario explicit web_search uses agent then chat (2 calls)', calls.length === 2, `calls=${calls.length}`)
    const agentPrompt = JSON.stringify(calls[0]?.requestBody?.messages || [])
    t.check('scenario explicit web_search agent prompt has search instruction', agentPrompt.includes('必须先调用 web_search'), agentPrompt.slice(0, 300))
    t.check('scenario explicit web_search request exposes web_search', calls[0].requestBody.tools.some(item => item.function && item.function.name === 'web_search'), JSON.stringify(calls[0].requestBody.tools))
    t.check('scenario explicit web_search chat call has agent context', JSON.stringify(calls[1].requestBody.messages || []).includes('工具查到的信息'), JSON.stringify(calls[1].requestBody.messages))
  }, {
    input: '调用web_search查鸣潮最新角色是谁',
    setup(session) {
      const webSearch = require(path.join(AI_ROOT, 'lib', 'agent', 'tools', 'web-search.js'))
      webSearch.__scenarioOriginalExecute = webSearch.execute
      webSearch.execute = async () => '已搜索：鸣潮 最新角色\n搜索结果：绯雪与达妮娅'
    },
    waitFor: message => String(message).includes('agent-search-retold'),
  })
  try {
    const webSearch = require(path.join(AI_ROOT, 'lib', 'agent', 'tools', 'web-search.js'))
    if (webSearch.__scenarioOriginalExecute) {
      webSearch.execute = webSearch.__scenarioOriginalExecute
      delete webSearch.__scenarioOriginalExecute
    }
  } catch {}

  await runChatCase(t, 'chat heavy web_search routes through Agent then persona chat once', [
    { json: { choices: [{ message: { content: '', tool_calls: [{ id: 'tc-heavy', type: 'function', function: { name: 'web_search', arguments: '{"query":"鸣潮最新角色"}' } }] } }] } },
    { json: { choices: [{ message: { content: '让我看看…' } }] } },
    { json: { choices: [{ message: { content: '### Agent raw report\n**secret heavy raw**\n- item' } }] } },
    { json: { choices: [{ message: { content: 'heavy-persona-retold' } }] } },
  ], async (result, mocked, session, calls) => {
    checkSentIncludes(t, 'scenario heavy web_search sends persona retell', result, 'heavy-persona-retold')
    t.check('scenario heavy web_search sends one final QQ message', result.sent.length === 1, `sent=${JSON.stringify(result.sent)}`)
    checkSentExcludes(t, 'scenario heavy web_search does not send progress text', result, '让我看看')
    checkSentExcludes(t, 'scenario heavy web_search does not send raw agent report', result, '### Agent raw report')
    checkSentExcludes(t, 'scenario heavy web_search does not send raw markdown body', result, '**secret heavy raw**')
    t.check('scenario heavy web_search uses chat, follow-up, agent, retell calls', calls.length === 4, `calls=${calls.length}`)
    const retellPrompt = JSON.stringify(calls[3]?.requestBody?.messages || [])
    t.check('scenario heavy web_search retell prompt treats report as internal', retellPrompt.includes('当前 chat 人格') && retellPrompt.includes('不要照抄原文'), retellPrompt)
  }, {
    input: '鸣潮这次角色情况咋样',
    setup(session) {
      const webSearch = require(path.join(AI_ROOT, 'lib', 'agent', 'tools', 'web-search.js'))
      webSearch.__scenarioOriginalExecute = webSearch.execute
      webSearch.execute = async () => '已搜索：鸣潮 最新角色\n搜索结果：绯雪与达妮娅'
    },
    waitFor: message => String(message).includes('heavy-persona-retold'),
  })
  try {
    const webSearch = require(path.join(AI_ROOT, 'lib', 'agent', 'tools', 'web-search.js'))
    if (webSearch.__scenarioOriginalExecute) {
      webSearch.execute = webSearch.__scenarioOriginalExecute
      delete webSearch.__scenarioOriginalExecute
    }
  } catch {}

  await runChatCase(t, 'QQ Agent runs in direct mode and chat retells with minimal prompt', [
    { json: { choices: [{ message: { content: 'agent-direct-raw' } }] } },
    { json: { choices: [{ message: { content: 'agent-persona-retold' } }] } },
  ], async (result, mocked, session, calls) => {
    checkSentIncludes(t, 'scenario QQ Agent direct mode sends persona reply', result, 'agent-persona-retold')
    const agentPrompt = JSON.stringify(calls[0]?.requestBody?.messages || [])
    t.check('scenario QQ Agent prompt includes direct mode marker', agentPrompt.includes('Agent 直连模式'), agentPrompt)
    const chatPrompt = JSON.stringify(calls[1]?.requestBody?.messages || [])
    t.check('scenario QQ Agent chat call includes agent context', chatPrompt.includes('工具查到的信息'), chatPrompt)
    t.check('scenario QQ Agent chat call includes core persona', chatPrompt.includes('简短转述'), chatPrompt)
    t.check('scenario QQ Agent chat call includes chat persona prompt', chatPrompt.includes('AGENT_CORE_MARKER') && chatPrompt.includes('AGENT_PERSONA_MARKER'), chatPrompt)
  }, {
    input: '搜一下现在最新的天气是什么',
    async setup(session, { data }) {
      data.writeText('ai-skills/core/SKILL.persona-core.md', [
        '---',
        'name: persona-core',
        '---',
        'AGENT_CORE_MARKER',
      ].join('\n'))
      data.writeText('ai-skills/personas/SKILL.agent-marker.md', [
        '---',
        'name: Agent测试人格',
        'description: agent persona test',
        '---',
        'AGENT_PERSONA_MARKER',
      ].join('\n'))
      data.writeJson('ai-persona-users.json', { [session.userId]: 'Agent测试人格' })
      const persona = require(path.join(AI_ROOT, 'lib', 'persona.js'))
      persona.loadPersonaUsers()
      const chatModule = require(path.join(AI_ROOT, 'lib', 'chat.js'))
      await chatModule.loadSkillsContentCache()
    },
    waitFor: message => String(message).includes('agent-persona-retold'),
  })

  await runChatCase(t, 'QQ Agent direct mode skips persona, chat applies it', [
    { json: { choices: [{ message: { content: 'agent-no-persona-raw' } }] } },
    { json: { choices: [{ message: { content: 'agent-chat-persona-ok' } }] } },
  ], async (result, mocked, session, calls) => {
    checkSentIncludes(t, 'scenario QQ Agent chat persona reply', result, 'agent-chat-persona-ok')
    const agentPrompt = JSON.stringify(calls[0]?.requestBody?.messages || [])
    t.check('scenario QQ Agent direct mode excludes user persona in agent call', !agentPrompt.includes('AMIS_AGENT_MARKER') && !agentPrompt.includes('当前人格：爱弥斯'), agentPrompt)
    t.check('scenario QQ Agent direct mode uses direct prompt', agentPrompt.includes('Agent 直连模式') && agentPrompt.includes('不需要角色扮演'), agentPrompt)
  }, {
    input: '帮我查一下最新的鸣潮角色是谁',
    setup(session, { data }) {
      data.writeText('ai-skills/personas/SKILL.amis.md', [
        '---',
        'name: 爱弥斯',
        'description: personal persona test',
        '---',
        'AMIS_AGENT_MARKER',
      ].join('\n'))
      data.writeText('ai-skills/personas/SKILL.changli.md', [
        '---',
        'name: 长离',
        'description: group persona test',
        '---',
        'CHANG_LI_AGENT_MARKER',
      ].join('\n'))
      data.writeJson('ai-persona-users.json', { [session.userId]: '爱弥斯' })
      data.writeJson('ai-persona-groups.json', { [session.guildId]: { persona: '长离' } })
      const persona = require(path.join(AI_ROOT, 'lib', 'persona.js'))
      persona.loadPersonaUsers()
      persona.loadPersonaGroups()
    },
    waitFor: message => String(message).includes('agent-chat-persona-ok'),
  })

  await runChatCase(t, 'QQ Agent skill prompt uses compact index', [
    { json: { choices: [{ message: { content: 'agent-skill-index-raw' } }] } },
    { json: { choices: [{ message: { content: 'agent-skill-index-ok' } }] } },
  ], async (result, mocked, session, calls) => {
    checkSentIncludes(t, 'scenario QQ Agent compact skill prompt reply', result, 'agent-skill-index-ok')
    const prompt = JSON.stringify(calls[0]?.requestBody?.messages || [])
    t.check('scenario QQ Agent prompt includes compact skill index', prompt.includes('轻量索引') && prompt.includes('read_agent_skill'), prompt)
    t.check('scenario QQ Agent prompt does not inject full skill body', !prompt.includes('LONG_SKILL_BODY_SHOULD_NOT_BE_IN_PROMPT'), prompt)
    t.check('scenario QQ Agent exposes read_agent_skill but not read_file', calls[0].requestBody.tools.some(item => item.function?.name === 'read_agent_skill') && !calls[0].requestBody.tools.some(item => item.function?.name === 'read_file'), JSON.stringify(calls[0].requestBody.tools))
  }, {
    input: '搜一下最新的 pptx 技能资料是什么',
    setup(session, { data }) {
      data.writeText('ai-skills/docs/pptx/SKILL.md', [
        '---',
        'name: pptx',
        'description: compact prompt test',
        '---',
        'LONG_SKILL_BODY_SHOULD_NOT_BE_IN_PROMPT',
      ].join('\n'))
      data.writeJson('ai-tool-config.json', {
        channels: {
          qq: { enabled: true, tools: { get_current_time: true, calculate: true, web_search: true, read_agent_skill: true } },
          dashboard: { enabled: true, tools: {} },
        },
        autoRoute: { qq: { enabled: false }, dashboard: { enabled: false } },
        dangerousPolicy: 'confirm',
        enabledSkills: ['pptx'],
        readFileRoots: [],
      })
    },
    waitFor: message => String(message).includes('agent-skill-index-ok'),
  })

  await runChatCase(t, 'reasoning-only fallback', [
    { json: { choices: [{ message: { content: '', reasoning_content: 'reasoning-secret' } }] } },
    { json: { choices: [{ message: { content: 'fallback-visible' } }] } },
  ], async (result, mocked) => {
    checkSentIncludes(t, 'scenario reasoning-only response falls back', result, 'fallback-visible')
    checkSentExcludes(t, 'scenario reasoning-only is never sent', result, 'reasoning-secret')
    t.check('scenario reasoning-only used fallback request', mocked.calls.length >= 2, `calls=${mocked.calls.length}`)
  }, {
    waitFor: message => String(message).includes('fallback-visible'),
  })

  await runChatCase(t, 'thinking leak retry', [
    { json: { choices: [{ message: { content: INCIDENT_SAMPLE } }] } },
    { json: { choices: [{ message: { content: '\u5efa\u8bae\u795e\u5361' } }] } },
  ], async (result) => {
    checkSentIncludes(t, 'scenario thinking leak retries to clean reply', result, '\u5efa\u8bae\u795e\u5361')
    checkSentExcludes(t, 'scenario thinking leak sample is not sent', result, '\u6211\u5f97\u770b\u770b\u73b0\u5728\u662f\u4ec0\u4e48\u60c5\u51b5')
    checkNoLeak(t, 'scenario thinking retry logs do not include leak body', result, ['\u6211\u5f97\u770b\u770b\u73b0\u5728\u662f\u4ec0\u4e48\u60c5\u51b5', 'reasoning-secret', 'sk-test-secret'])
  }, {
    waitFor: message => String(message).includes('\u5efa\u8bae\u795e\u5361'),
  })

  await runChatCase(t, 'internal cache prompt leak retries', [
    { json: { choices: [{ message: { content: '这是你在本群的发言： 昵称：你 发言：要是机械臂就算了 [群聊刷到]' } }] } },
    { json: { choices: [{ message: { content: '机器人动作确实挺流畅' } }] } },
  ], async (result) => {
    checkSentIncludes(t, 'scenario internal prompt leak retries to clean reply', result, '机器人动作确实挺流畅')
    checkSentExcludes(t, 'scenario internal prompt leak does not send profile marker', result, '这是你在本群的发言')
    checkSentExcludes(t, 'scenario internal prompt leak does not send nickname marker', result, '昵称：')
  }, {
    input: '这个机器人怎么这么流畅',
    waitFor: message => String(message).includes('机器人动作确实挺流畅'),
  })

  await runChatCase(t, 'user profile prompt is internal system context', [
    { json: { choices: [{ message: { content: 'profile-context-ok' } }] } },
  ], async (result, mocked, session, calls) => {
    checkSentIncludes(t, 'scenario user profile internal context sends reply', result, 'profile-context-ok')
    const messages = calls[0]?.requestBody?.messages || []
    const profileMessage = messages.find(item => String(item.content || '').includes('[内部参考-用户近期发言风格]'))
    t.check('scenario user profile context uses system role', profileMessage && profileMessage.role === 'system', JSON.stringify(messages))
    t.check('scenario user profile context is not user role', !messages.some(item => item.role === 'user' && String(item.content || '').includes('这是tester在本群的发言')), JSON.stringify(messages))
  }, {
    input: '继续说',
    setup(session, { data }) {
      data.writeJson(`user-profiles/${session.guildId}/${session.userId}.json`, {
        userId: session.userId,
        names: ['tester'],
        messages: [{ content: '要是机械臂就算了' }],
      })
    },
    waitFor: message => String(message).includes('profile-context-ok'),
  })

  await runChatCase(t, 'quoted bot message is marked as self quote', [
    { json: { choices: [{ message: { content: 'self-quote-ok' } }] } },
  ], async (result, mocked, session, calls) => {
    checkSentIncludes(t, 'scenario quoted self message sends reply', result, 'self-quote-ok')
    const prompt = JSON.stringify(calls[0]?.requestBody?.messages || [])
    t.check('scenario quoted self prompt marks own reply', prompt.includes('引用你自己历史回复') && prompt.includes('不要攻击自己'), prompt)
  }, {
    input: '？',
    session: {
      quote: { content: '这都能联想到核废水，你这脑回路也是没谁了', userId: '90000' },
    },
    waitFor: message => String(message).includes('self-quote-ok'),
  })

  await runChatCase(t, 'persistent thinking leak fallback', Array.from({ length: 7 }, () => ({
    json: { choices: [{ message: { content: INCIDENT_SAMPLE } }] },
  })), async (result) => {
    t.check('scenario persistent thinking leak produces fallback reply', result.sent.length > 0, JSON.stringify(result.sent))
    checkSentExcludes(t, 'scenario persistent thinking leak not sent', result, '\u6211\u5f97\u770b\u770b\u73b0\u5728\u662f\u4ec0\u4e48\u60c5\u51b5')
  })

  await runChatCase(t, 'API 500 middleware fallback', [
    { status: 500, text: 'server exploded' },
  ], async (result) => {
    checkSentNonEmpty(t, 'scenario API 500 chat sends safe fallback', result)
    t.check(
      'scenario API 500 fallback does not require send debug log',
      !result.logs.some(item => item.name === 'dongxuelian-ai' && item.msg.includes('reply sent:') && item.msg.includes('server exploded')),
      JSON.stringify(result.logs.slice(-8))
    )
    checkSentExcludes(t, 'scenario API 500 does not send raw server error', result, 'server exploded')
    checkSentExcludes(t, 'scenario API 500 does not send reasoning marker', result, 'reasoning-secret')
    checkNoLeak(t, 'scenario API 500 logs do not leak key', result, ['sk-test-secret', 'Bearer'])
  })

  await runChatCase(t, 'normal look phrase is not thinking leak', [
    { json: { choices: [{ message: { content: '\u4f60\u770b\u770b\u8fd9\u4e2a\u4e5f\u6ca1\u95ee\u9898' } }] } },
  ], async (result, mocked, session) => {
    checkSentIncludes(t, 'scenario normal look phrase is not thinking leak', result, '\u4f60\u770b\u770b\u8fd9\u4e2a\u4e5f\u6ca1\u95ee\u9898')
    const conversation = require(path.join(AI_ROOT, 'lib', 'conversation.js'))
    const history = conversation.getConversationHistory(session)
    t.check('scenario conversation stores visible reply only', history.some(item => item.content && item.content.includes('\u4f60\u770b\u770b\u8fd9\u4e2a\u4e5f\u6ca1\u95ee\u9898')), JSON.stringify(history))
    t.check('scenario conversation does not store reasoning text', !history.some(item => item.content && item.content.includes('reasoning-secret')), JSON.stringify(history))
    const userTurn = history.find(item => item.role === 'user')
    t.check('scenario conversation stores user turn in isolated envelope', userTurn && /^<user>\n/.test(userTurn.content) && userTurn.content.includes('\n\u53d1\u8a00\uff1a\u4f60\u770b\u770b\u8fd9\u4e2a\n</user>'), JSON.stringify(history))
  }, {
    input: '\u4f60\u770b\u770b\u8fd9\u4e2a',
    waitFor: message => String(message).includes('\u4f60\u770b\u770b\u8fd9\u4e2a\u4e5f\u6ca1\u95ee\u9898'),
  })

  await runChatCase(t, 'QQ Agent search context bridges into normal chat follow-up', [
    { json: { choices: [{ message: { content: 'NO' } }] } },
    { json: { choices: [{ message: { content: 'normal follow-up answer' } }] } },
  ], async (result, mocked, session, calls) => {
    checkSentIncludes(t, 'scenario agent bridge sends follow-up reply', result, 'normal follow-up answer')
    const followUpCall = calls.find(call => JSON.stringify(call.requestBody?.messages || []).includes('最近 Agent 工具上下文'))
    const prompt = JSON.stringify(followUpCall?.requestBody?.messages || [])
    t.check('scenario normal chat sees recent agent search summary', prompt.includes('已搜索：鸣潮 最新角色') && prompt.includes('不要说自己没搜索'), prompt)
    const conversation = require(path.join(AI_ROOT, 'lib', 'conversation.js'))
    const history = conversation.getConversationHistory(session)
    t.check('scenario agent bridge stores agent reply in conversation history', history.some(item => item.role === 'assistant' && item.content.includes('agent searched answer')), JSON.stringify(history))
  }, {
    input: '你刚刚搜到哪些东西',
    setup(session) {
      const bridge = require(path.join(AI_ROOT, 'lib', 'agent-chat-bridge.js'))
      bridge.clearAgentChatBridge()
      bridge.recordAgentChatResult({
        session,
        userMessage: '调用web_search查鸣潮最新角色',
        userName: 'tester',
        userId: session.userId,
        channelKey: session.guildId,
        agentResult: {
          reply: 'agent searched answer',
          toolCalls: 1,
          toolResults: [{ name: 'web_search', result: '已搜索：鸣潮 最新角色\n搜索结果：\n1. 官方公告\n   https://wutheringwaves.kurogames.com/news/mock\n   库洛官方公告公开新共鸣者。' }],
        },
      })
    },
    waitFor: message => String(message).includes('normal follow-up answer'),
  })

  await runChatCase(t, 'legacy user history is isolated before model request', [
    { json: { choices: [{ message: { content: 'NO' } }] } },
    { json: { choices: [{ message: { content: 'legacy-ok' } }] } },
  ], async (result, mocked, session, calls) => {
    checkSentIncludes(t, 'scenario legacy history sends reply', result, 'legacy-ok')
    const chatCall = calls.find(call => {
      const body = call && call.requestBody || {}
      const messages = Array.isArray(body.messages) ? body.messages : []
      return messages.some(item => item.role === 'assistant' && item.content === 'old reply')
    })
    const body = chatCall && chatCall.requestBody || {}
    const messages = Array.isArray(body.messages) ? body.messages : []
    const legacyTurn = messages.find(item => item.role === 'user' && String(item.content || '').includes('Alice') && String(item.content || '').includes('\u4f60\u597d\uff1a\u6d4b\u8bd5'))
    t.check('scenario legacy history user turn wrapped for prompt', legacyTurn && legacyTurn.content === '<user>\n\u6635\u79f0\uff1aAlice\n\u53d1\u8a00\uff1a\u4f60\u597d\uff1a\u6d4b\u8bd5\n</user>', JSON.stringify(messages))
    const conversation = require(path.join(AI_ROOT, 'lib', 'conversation.js'))
    const stripped = [
      conversation.getUserMessageContent('\u7528\u6237(Alice)\uff1a\u4f60\u597d\uff1a\u6d4b\u8bd5'),
      conversation.getUserMessageContent('<user>\n\u6635\u79f0\uff1aBob\n\u53d1\u8a00\uff1a\u591a\u884c\u7b2c\u4e00\u884c\n\u591a\u884c\u7b2c\u4e8c\u884c\n</user>'),
    ]
    t.check('scenario recent user messages strip legacy and new envelopes', stripped.includes('\u4f60\u597d\uff1a\u6d4b\u8bd5') && stripped.includes('\u591a\u884c\u7b2c\u4e00\u884c\n\u591a\u884c\u7b2c\u4e8c\u884c'), JSON.stringify(stripped))
  }, {
    input: '\u7ee7\u7eed',
    session: {
      userId: 'legacy-user',
      author: { id: 'legacy-user', name: 'Bob', nick: 'Bob' },
    },
    setup(session) {
      const conversation = require(path.join(AI_ROOT, 'lib', 'conversation.js'))
      conversation.saveConversationTurn(session, '\u7528\u6237(Alice)\uff1a\u4f60\u597d\uff1a\u6d4b\u8bd5', 'old reply')
      conversation.writeConversationDisk(conversation.getConversationKey(session), {
        summary: '',
        summaryTotal: 0,
        totalCount: 1,
        messages: conversation.getConversationHistory(session),
      })
    },
    waitFor: message => String(message).includes('legacy-ok'),
  })
}

module.exports = { run }
