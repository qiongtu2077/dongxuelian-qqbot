const path = require('path')
const { withScenario } = require('./_setup')
const { mockFetch } = require('../fake/fetch')
const { AI_ROOT } = require('../fake/file')
const { flushAsync } = require('../fake/koishi')

function withFetch(mocked, fn) {
  const originalFetch = global.fetch
  global.fetch = mocked.fetch
  return Promise.resolve()
    .then(fn)
    .finally(() => { global.fetch = originalFetch })
}

async function run(t) {
  t.section('scenario: random reply trigger')

  await withScenario({
    data: {
      randomWhitelist: ['10001'],
      randomRate: { 10001: 1 },
    },
  }, async ({ ready, makeSession, run }) => {
    await ready()
    const mocked = mockFetch([
      { json: { choices: [{ message: { content: 'random-visible-reply' } }] } },
    ])
    await withFetch(mocked, async () => {
      const session = makeSession({
        userId: '2001',
        author: { id: '2001', name: 'member' },
        content: 'hello group',
      })
      await run(session, { flushTicks: 120 })
      await session.waitForSend(message => String(message).includes('random-visible-reply'))
      t.check('scenario random whitelisted rate 100 sends reply', session.sent.some(item => String(item).includes('random-visible-reply')), JSON.stringify(session.sent))
      t.check('scenario random trigger calls model once', mocked.calls.length === 1, JSON.stringify(mocked.calls.map(call => call.requestBody && call.requestBody.model)))
    })
  })

  await withScenario({
    data: {
      randomWhitelist: [],
      randomRate: { 10001: 1 },
    },
  }, async ({ ready, makeSession, run }) => {
    await ready()
    const mocked = mockFetch()
    await withFetch(mocked, async () => {
      const result = await run(makeSession({
        userId: '2002',
        author: { id: '2002', name: 'member' },
        content: 'hello group',
      }), { flushTicks: 120 })
      t.check('scenario empty random whitelist calls next', result.nextCalled, JSON.stringify(result))
      t.check('scenario empty random whitelist sends nothing', result.sent.length === 0, JSON.stringify(result.sent))
      t.check('scenario empty random whitelist does not call model', mocked.calls.length === 0, JSON.stringify(mocked.calls))
    })
  })

  await withScenario({
    fakeTimers: true,
    data: {
      randomWhitelist: ['10001'],
      randomRate: { 10001: 1 },
    },
  }, async ({ ready, makeSession, run, clock }) => {
    await ready()
    const conversation = require(path.join(AI_ROOT, 'lib', 'conversation.js'))
    conversation.channelSharedCache.set('10001', [
      { userId: '2003', role: 'user', speakerName: 'member', content: '今天又卡了', messageId: 'm1', replyToId: '', mentionUserIds: [], ts: Date.now() - 5000 },
      { userId: '2003', role: 'user', speakerName: 'member', content: '真服了', messageId: 'm2', replyToId: 'm1', mentionUserIds: [], ts: Date.now() },
    ])
    const mocked = mockFetch([
      { json: { choices: [{ message: { content: 'delayed-random-visible' } }] } },
    ])
    await withFetch(mocked, async () => {
      const session = makeSession({
        userId: '2003',
        author: { id: '2003', name: 'member' },
        content: '真服了',
      })
      const result = await run(session, { flushTicks: 20 })
      t.check('scenario delayed random scheduling returns through next', result.nextCalled, JSON.stringify(result))
      await clock.tick(15000)
      await flushAsync(120)
      await session.waitForSend(message => String(message).includes('delayed-random-visible'))
      t.check('scenario delayed random timer sends reply without TDZ crash', session.sent.some(item => String(item).includes('delayed-random-visible')), JSON.stringify(session.sent))
      t.check('scenario delayed random calls model after timer', mocked.calls.length === 1, JSON.stringify(mocked.calls))
    })
  })
}

module.exports = { run }
