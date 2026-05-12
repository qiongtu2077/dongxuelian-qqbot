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
  await withScenario({}, async ({ harness, makeSession, run }) => {
    const mocked = mockFetch(fetchQueue)
    await withFetch(mocked, async () => {
      const session = makeSession(options.session || {})
      if (typeof options.setup === 'function') await options.setup(session, { harness, mocked })
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
