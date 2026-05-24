const path = require('path')
const fs = require('fs')
const { setTimeout: realSetTimeout } = require('timers')
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

function realSleep(ms) {
  return new Promise(resolve => realSetTimeout(resolve, ms))
}

async function waitForMockCalls(mocked, count, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs
  while (mocked.calls.length < count && Date.now() < deadline) {
    await flushAsync(4)
    await realSleep(10)
  }
}

async function run(t) {
  t.section('scenario: random reply trigger')

  await withScenario({
    data: {
      randomWhitelist: ['10001'],
      randomRate: { 10001: 1 },
      randomVoiceRate: { 10001: 0 },
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
      const prompt = JSON.stringify(mocked.calls[0]?.requestBody?.messages || [])
      t.check('scenario random prompt includes active group scene window', prompt.includes('当前群聊现场-最高优先级') && prompt.includes('随机主动插话内部模式'), prompt)
    })
  })

  await withScenario({
    data: {
      randomWhitelist: ['10001'],
      randomRate: { 10001: 1 },
      randomVoiceRate: { 10001: 0 },
    },
  }, async ({ ready, makeSession, run }) => {
    await ready()
    const mocked = mockFetch([
      { json: { choices: [{ message: { content: '{"mode":"no_send","reply":""}' } }] } },
    ])
    await withFetch(mocked, async () => {
      const conversation = require(path.join(AI_ROOT, 'lib', 'conversation.js'))
      conversation.saveSharedChannelTurn({
        guildId: '10001',
        channelId: '10001',
        userId: '2030',
        author: { id: '2030', name: 'member' },
      }, 'ㅤ', '[图片]', 'user', { messageId: 'ratio-image-anchor' })

      const ratioSession = makeSession({
        userId: '2030',
        author: { id: '2030', name: 'member' },
        content: '比例还是高了，其实是300＞100w',
        messageId: 'ratio-sarcasm-trigger',
      })
      const result = await run(ratioSession, { flushTicks: 140 })
      await waitForMockCalls(mocked, 1)
      t.check('scenario random ambiguous media follow-up can stay silent', result.sent.length === 0, JSON.stringify(result.sent))
      const prompt = JSON.stringify(mocked.calls[0]?.requestBody?.messages || [])
      t.check('scenario random ambiguous media prompt stays intent-generic', prompt.includes('主语、意图或与你的关系不清时优先 no_send') && prompt.includes('禁止把普通评价理解成用户让你接管任务'), prompt)
    })
  })

  await withScenario({
    data: {
      randomWhitelist: ['10001'],
      randomRate: { 10001: 1 },
      randomVoiceRate: { 10001: 0 },
    },
  }, async ({ ready, makeSession, run }) => {
    await ready()
    const mocked = mockFetch([
      { delayMs: 80, json: { choices: [{ message: { content: 'stale-random-should-not-send' } }] } },
    ])
    await withFetch(mocked, async () => {
      const triggerSession = makeSession({
        userId: '2090',
        author: { id: '2090', name: 'member' },
        content: '慢一点的随机触发',
        messageId: 'stale-random-trigger',
      })
      const triggerRun = run(triggerSession, { flush: false })
      await waitForMockCalls(mocked, 1)
      const interleavingSession = makeSession({
        userId: '2091',
        author: { id: '2091', name: 'other' },
        content: '中间已经有人继续聊了',
        messageId: 'stale-random-interleave',
      })
      await run(interleavingSession, { flushTicks: 20 })
      await triggerRun
      await flushAsync(160)
      t.check('scenario ordinary random skips stale model reply after newer group message', !triggerSession.sent.some(item => String(item).includes('stale-random-should-not-send')), JSON.stringify(triggerSession.sent))
    })
  })

  await withScenario({
    data: {
      randomWhitelist: ['10001'],
      randomRate: { 10001: 1 },
      randomVoiceRate: { 10001: 0 },
    },
  }, async ({ ready, makeSession, run }) => {
    await ready()
    const mocked = mockFetch([
      { json: { choices: [{ message: { content: '{"mode":"ambient_water","reply":"先看一眼怎么收场"}' } }] } },
    ])
    await withFetch(mocked, async () => {
      const session = makeSession({
        userId: '2020',
        author: { id: '2020', name: 'member' },
        content: '6',
        messageId: 'ambient-trigger',
      })
      await run(session, { flushTicks: 120 })
      await session.waitForSend(message => String(message).includes('先看一眼'))
      t.check('scenario random ambient JSON sends only visible reply', session.sent.some(item => String(item) === '先看一眼怎么收场'), JSON.stringify(session.sent))
      t.check('scenario random ambient JSON does not send raw mode', session.sent.every(item => !String(item).includes('"mode"') && !String(item).includes('ambient_water')), JSON.stringify(session.sent))
      t.check('scenario random ambient water does not quote trigger', session.sent.every(item => !String(item).includes('<quote')), JSON.stringify(session.sent))
    })
  })

  await withScenario({
    data: {
      randomWhitelist: ['10001'],
      randomRate: { 10001: 1 },
      randomVoiceRate: { 10001: 0 },
    },
  }, async ({ ready, makeSession, run }) => {
    await ready()
    const mocked = mockFetch([
      { json: { choices: [{ message: { content: '{"mode":"no_send","reply":""}' } }] } },
    ])
    await withFetch(mocked, async () => {
      const session = makeSession({
        userId: '2021',
        author: { id: '2021', name: 'member' },
        content: '先这样吧',
        messageId: 'nosend-trigger',
      })
      const result = await run(session, { flushTicks: 120 })
      await waitForMockCalls(mocked, 1)
      t.check('scenario random no_send sends nothing', result.sent.length === 0, JSON.stringify(result.sent))
      t.check('scenario random no_send still called model once', mocked.calls.length === 1, JSON.stringify(mocked.calls))
    })
  })

  await withScenario({
    data: {
      randomWhitelist: ['10001'],
      randomRate: { 10001: 1 },
      randomVoiceRate: { 10001: 0 },
    },
  }, async ({ ready, makeSession, run, data }) => {
    data.writeJson('debug-log-config.json', { enabled: true, modules: { 'reply-timing': true }, updatedAt: Date.now() })
    await ready()
    const mocked = mockFetch([
      { json: { choices: [{ message: { content: 'timing-diagnostic-visible' } }] } },
    ])
    await withFetch(mocked, async () => {
      const session = makeSession({
        userId: '2013',
        author: { id: '2013', name: 'member' },
        content: 'reply timing diagnostic source',
        messageId: 'timing-diagnostic-message',
      })
      const result = await run(session, { flushTicks: 120 })
      await session.waitForSend(message => String(message).includes('timing-diagnostic-visible'))
      const timingLogs = result.logs.filter(item => String(item.msg).includes('[D] [reply-timing]'))
      t.check('scenario reply timing diagnostic log is generated', timingLogs.some(item => String(item.msg).includes('decision=may_reply') && String(item.msg).includes('triggered=true')), JSON.stringify(timingLogs))
      t.check('scenario reply timing diagnostic log does not expose raw channel id', timingLogs.every(item => !String(item.msg).includes('10001')), JSON.stringify(timingLogs))
      t.check('scenario reply timing diagnostic does not change random send', session.sent.some(item => String(item).includes('timing-diagnostic-visible')), JSON.stringify(session.sent))
    })
  })

  await withScenario({
    data: {
      randomWhitelist: ['10001'],
      randomRate: { 10001: 1 },
      randomVoiceRate: { 10001: 0 },
    },
  }, async ({ ready, makeSession, run, data }) => {
    data.writeJson('debug-log-config.json', { enabled: true, modules: { 'affect-router': true }, updatedAt: Date.now() })
    await ready()
    const mocked = mockFetch([
      { json: { choices: [{ message: { content: 'affect-diagnostic-visible' } }] } },
    ])
    await withFetch(mocked, async () => {
      const session = makeSession({
        userId: '2014',
        author: { id: '2014', name: 'member' },
        content: 'affect diagnostic raw source text',
        messageId: 'affect-diagnostic-message',
      })
      const result = await run(session, { flushTicks: 120 })
      await session.waitForSend(message => String(message).includes('affect-diagnostic-visible'))
      const affectLogs = result.logs.filter(item => String(item.msg).includes('[D] [affect-router]'))
      t.check('scenario affect router diagnostic log is generated', affectLogs.some(item => String(item.msg).includes('mood=') && String(item.msg).includes('outputs=')), JSON.stringify(affectLogs))
      t.check('scenario affect router diagnostic log omits raw channel and text', affectLogs.every(item => !String(item.msg).includes('10001') && !String(item.msg).includes('affect diagnostic raw source text') && !String(item.msg).includes('affect-diagnostic-visible')), JSON.stringify(affectLogs))
      t.check('scenario affect router diagnostic does not change random send', session.sent.some(item => String(item).includes('affect-diagnostic-visible')), JSON.stringify(session.sent))
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

  await withScenario({
    fakeTimers: true,
    data: {
      randomWhitelist: ['10001'],
      randomRate: { 10001: 1 },
    },
  }, async ({ ready, makeSession, run, clock, harness }) => {
    await ready()
    const conversation = require(path.join(AI_ROOT, 'lib', 'conversation.js'))
    conversation.channelSharedCache.set('10001', [
      { userId: '2004', role: 'user', speakerName: 'member', content: '今天又卡了', messageId: 'm1', replyToId: '', mentionUserIds: [], ts: Date.now() - 5000 },
      { userId: '2004', role: 'user', speakerName: 'member', content: '真服了', messageId: 'm2', replyToId: 'm1', mentionUserIds: [], ts: Date.now() },
    ])
    const mocked = mockFetch([
      { json: { choices: [{ message: { content: 'delayed-current-bot-visible' } }] } },
    ])
    await withFetch(mocked, async () => {
      const liveCalls = []
      const staleCalls = []
      const makeInternal = () => ({
        async getGroupMemberInfo() { return { shut_up_timestamp: 0 } },
        async getGroupInfo() { return { group_all_shut: false } },
      })
      const liveBot = {
        selfId: '90000',
        internal: makeInternal(),
        async sendMessage(channelId, message, guildId) {
          liveCalls.push({ channelId: String(channelId), message: String(message), guildId: String(guildId || '') })
          return message
        },
      }
      const staleBot = {
        selfId: '90000',
        internal: makeInternal(),
        async sendMessage(channelId, message, guildId) {
          staleCalls.push({ channelId: String(channelId), message: String(message), guildId: String(guildId || '') })
          throw new Error('stale bot used')
        },
      }
      harness.ctx.bots = [liveBot]
      const session = makeSession({
        userId: '2004',
        author: { id: '2004', name: 'member' },
        content: '真服了',
        bot: staleBot,
      })
      const originalSend = session.send.bind(session)
      session.send = async function(message) {
        await this.bot.sendMessage(this.channelId, message, this.guildId)
        return originalSend(message)
      }
      const result = await run(session, { flushTicks: 20 })
      t.check('scenario delayed random current bot scheduling returns through next', result.nextCalled, JSON.stringify(result))
      await clock.tick(15000)
      await flushAsync(120)
      await session.waitForSend(message => String(message).includes('delayed-current-bot-visible'))
      t.check('scenario delayed random uses current ctx bot', liveCalls.some(call => call.message.includes('delayed-current-bot-visible')), JSON.stringify({ liveCalls, staleCalls, sent: session.sent }))
      t.check('scenario delayed random avoids stale session bot', staleCalls.length === 0, JSON.stringify(staleCalls))
    })
  })

  await withScenario({
    fakeTimers: true,
    data: {
      randomWhitelist: ['10001'],
      randomRate: { 10001: 0 },
    },
  }, async ({ ready, makeSession, run, clock, data }) => {
    data.writeText('ai-skills/personas/SKILL.random-high-risk.md', [
      '---',
      'name: 随机高风险人格',
      'description: random quote fixture',
      'will: 1',
      '---',
      'random quote fixture',
    ].join('\n'))
    data.writeJson('ai-persona-groups.json', { 10001: { persona: '群人格' } })
    data.writeJson('ai-persona-users.json', { 2005: '随机高风险人格' })
    await ready()
    const conversation = require(path.join(AI_ROOT, 'lib', 'conversation.js'))
    conversation.channelSharedCache.set('10001', [
      { userId: '2005', role: 'user', speakerName: 'member', content: '第一句', messageId: 'zero-m1', replyToId: '', mentionUserIds: [], ts: Date.now() - 5000 },
      { userId: '2005', role: 'user', speakerName: 'member', content: '第二句', messageId: 'zero-m2', replyToId: 'zero-m1', mentionUserIds: [], ts: Date.now() },
    ])
    const mocked = mockFetch([
      { json: { choices: [{ message: { content: 'must-not-send' } }] } },
    ])
    await withFetch(mocked, async () => {
      const session = makeSession({
        userId: '2005',
        author: { id: '2005', name: 'member' },
        content: '第二句',
        messageId: 'zero-trigger',
      })
      const result = await run(session, { flushTicks: 20 })
      await clock.tick(15000)
      await flushAsync(120)
      t.check('scenario random rate zero still calls next', result.nextCalled, JSON.stringify(result))
      t.check('scenario random rate zero sends nothing even when quote risk exists', session.sent.length === 0, JSON.stringify(session.sent))
      t.check('scenario random rate zero does not call model', mocked.calls.length === 0, JSON.stringify(mocked.calls))
    })
  })

  await withScenario({
    fakeTimers: true,
    data: {
      randomWhitelist: ['10001'],
      randomRate: { 10001: 1 },
    },
  }, async ({ ready, makeSession, run, clock, data }) => {
    data.writeText('ai-skills/personas/SKILL.random-high-risk.md', [
      '---',
      'name: 随机高风险人格',
      'description: random quote fixture',
      'will: 1',
      '---',
      'random quote fixture',
    ].join('\n'))
    data.writeJson('ai-persona-groups.json', { 10001: { persona: '群人格' } })
    data.writeJson('ai-persona-users.json', { 2006: '随机高风险人格' })
    await ready()
    const conversation = require(path.join(AI_ROOT, 'lib', 'conversation.js'))
    conversation.channelSharedCache.set('10001', [
      { userId: '2006', role: 'user', speakerName: 'member', content: '连续第一句', messageId: 'risk-m1', replyToId: '', mentionUserIds: [], ts: Date.now() - 5000 },
      { userId: '2006', role: 'user', speakerName: 'member', content: '连续第二句', messageId: 'risk-m2', replyToId: 'risk-m1', mentionUserIds: [], ts: Date.now() },
    ])
    const mocked = mockFetch([
      { json: { choices: [{ message: { content: 'high-risk-delayed-visible' } }] } },
    ])
    await withFetch(mocked, async () => {
      const triggerSession = makeSession({
        userId: '2006',
        author: { id: '2006', name: 'member' },
        content: '连续第二句',
        messageId: 'risk-trigger',
      })
      const triggerResult = await run(triggerSession, { flushTicks: 20 })
      t.check('scenario high risk delayed random scheduling calls next', triggerResult.nextCalled, JSON.stringify(triggerResult))
      const interleavingSession = makeSession({
        userId: '2010',
        author: { id: '2010', name: 'other' },
        content: 'https://example.com/interleave',
        messageId: 'risk-interleave',
      })
      await run(interleavingSession, { flushTicks: 20 })
      await clock.tick(15000)
      await flushAsync(120)
      t.check('scenario high risk delayed random expires after newer group message', !triggerSession.sent.some(item => String(item).includes('high-risk-delayed-visible')), JSON.stringify(triggerSession.sent))
      t.check('scenario expired delayed random does not call model', mocked.calls.length === 0, JSON.stringify(mocked.calls))
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
      { userId: '2007', role: 'user', speakerName: 'member', content: '排队第一句', messageId: 'cancel-m1', replyToId: '', mentionUserIds: [], ts: Date.now() - 5000 },
      { userId: '2007', role: 'user', speakerName: 'member', content: '排队第二句', messageId: 'cancel-m2', replyToId: 'cancel-m1', mentionUserIds: [], ts: Date.now() },
    ])
    const mocked = mockFetch([
      { json: { choices: [{ message: { content: 'direct-at-visible' } }] } },
      { json: { choices: [{ message: { content: 'pending-should-not-send' } }] } },
    ])
    await withFetch(mocked, async () => {
      const pendingSession = makeSession({
        userId: '2007',
        author: { id: '2007', name: 'member' },
        content: '排队第二句',
        messageId: 'cancel-trigger',
      })
      await run(pendingSession, { flushTicks: 20 })
      const directSession = makeSession({
        userId: '2011',
        author: { id: '2011', name: 'other' },
        content: '<at id="90000"/> 评价一下韩信',
        messageId: 'cancel-direct',
      })
      await run(directSession, { flushTicks: 120 })
      await directSession.waitForSend(message => String(message).includes('direct-at-visible'))
      await clock.tick(15000)
      await flushAsync(120)
      t.check('scenario explicit at cancels pending random reply', !pendingSession.sent.some(item => String(item).includes('pending-should-not-send')), JSON.stringify({ pending: pendingSession.sent, direct: directSession.sent }))
      t.check('scenario explicit at cancellation preserves direct reply only model call', mocked.calls.length === 1, JSON.stringify(mocked.calls.map(call => call.requestBody && call.requestBody.messages && call.requestBody.messages.slice(-1))))
    })
  })

  await withScenario({
    data: {
      adminUserIds: ['9001'],
      randomWhitelist: ['10001'],
      randomRate: { 10001: 0 },
    },
  }, async ({ ready, makeSession, run, data }) => {
    await ready()
    const viewBefore = await run(makeSession({
      userId: '9001',
      author: { id: '9001', name: 'admin' },
      content: '东雪莲群聊AI概率查看',
    }), { flushTicks: 40 })
    t.check('scenario random rate zero is read as configured zero', viewBefore.sent.some(item => String(item).includes('0%')), JSON.stringify(viewBefore.sent))
    const setRate = await run(makeSession({
      userId: '9001',
      author: { id: '9001', name: 'admin' },
      content: '东雪莲群聊AI概率设置 100%',
      event: { sender: { role: 'admin' }, message: [] },
    }), { flushTicks: 40 })
    t.check('scenario random rate command sets one hundred percent', setRate.sent.some(item => String(item).includes('100%')), JSON.stringify(setRate.sent))
    const savedRate = data.readJson('ai-random-rate.json')
    t.check('scenario random rate command writes updated group probability', savedRate['10001'] === 1, JSON.stringify(savedRate))

    const mocked = mockFetch([
      { json: { choices: [{ message: { content: 'rate-command-random-visible' } }] } },
    ])
    await withFetch(mocked, async () => {
      const randomSession = makeSession({
        userId: '2012',
        author: { id: '2012', name: 'member' },
        content: '命令之后普通随机',
        messageId: 'rate-command-message',
      })
      await run(randomSession, { flushTicks: 120 })
      await randomSession.waitForSend(message => String(message).includes('rate-command-random-visible'))
      t.check('scenario random reply reads probability set by command', randomSession.sent.some(item => String(item).includes('rate-command-random-visible')), JSON.stringify(randomSession.sent))
    })

    t.check('scenario random test does not create tracked filesystem dependency', fs.existsSync(data.pathFor('ai-random-rate.json')), data.pathFor('ai-random-rate.json'))
  })

  await withScenario({
    data: {
      randomWhitelist: ['10001'],
      randomRate: { 10001: 0 },
      randomVoiceRate: { 10001: 0 },
    },
  }, async ({ ready, makeSession, run }) => {
    await ready()
    const mocked = mockFetch([
      { json: { choices: [{ message: { content: 'image-random-should-not-send' } }] } },
    ])
    await withFetch(mocked, async () => {
      const session = makeSession({
        userId: '2099',
        author: { id: '2099', name: 'member' },
        content: '[CQ:image,file=random-zero.jpg]',
        messageId: 'random-image-rate-zero',
        event: { sender: { role: 'member' }, message: [{ type: 'image', data: { file: 'random-zero.jpg' } }] },
      })
      const result = await run(session, { flushTicks: 100 })
      t.check('scenario pure image respects random rate zero', result.sent.length === 0, JSON.stringify(result.sent))
      t.check('scenario pure image rate zero does not call model through media branch', mocked.calls.length === 0, JSON.stringify(mocked.calls))
    })
  })
}

module.exports = { run }
