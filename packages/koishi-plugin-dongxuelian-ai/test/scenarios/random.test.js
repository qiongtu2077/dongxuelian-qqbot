const { withScenario } = require('./_setup')
const { mockFetch } = require('../fake/fetch')

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
    fakeTimers: false,
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
    fakeTimers: false,
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
}

module.exports = { run }
