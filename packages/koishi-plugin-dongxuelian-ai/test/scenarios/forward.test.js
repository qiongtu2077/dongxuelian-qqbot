const path = require('path')
const { withScenario } = require('./_setup')
const { AI_ROOT } = require('../fake/file')

function makeForwardMock(fixtures) {
  const calls = []
  return {
    calls,
    async callGetForwardMsg(id) {
      calls.push(String(id))
      return fixtures[String(id)] || null
    },
  }
}

function textNode(nickname, text) {
  return { sender: { nickname }, raw_message: text }
}

async function run(t) {
  t.section('scenario: forward summary resolution')

  await withScenario({}, async ({ harness, makeSession }) => {
    const { resolveForwardSummary } = require(path.join(AI_ROOT, 'lib', 'forward.js'))
    const conversation = require(path.join(AI_ROOT, 'lib', 'conversation.js'))
    const mocked = makeForwardMock({})
    const session = makeSession({ guildId: '10000', channelId: '10000', content: 'plain message without forward id' })
    const summary = await resolveForwardSummary(session, session.content, harness.ctx, mocked)
    t.check('scenario forward plain message returns empty summary', summary === '', JSON.stringify(summary))
    t.check('scenario forward plain message does not call API', mocked.calls.length === 0, mocked.calls.join(','))
    t.check('scenario forward plain message does not write cache', !conversation.lastForwardSummaryCache.has('10000'), conversation.lastForwardSummaryCache.get('10000') || '')
  })

  await withScenario({}, async ({ harness, makeSession }) => {
    const { resolveForwardSummary } = require(path.join(AI_ROOT, 'lib', 'forward.js'))
    const conversation = require(path.join(AI_ROOT, 'lib', 'conversation.js'))
    const mocked = makeForwardMock({
      cqroot: [textNode('Alice', 'hello from cq forward')],
    })
    const session = makeSession({ content: '[CQ:forward,id=cqroot]' })
    const summary = await resolveForwardSummary(session, session.content, harness.ctx, mocked)
    t.check('scenario forward CQ summary includes sender', summary.includes('Alice'), summary)
    t.check('scenario forward CQ summary includes text', summary.includes('hello from cq forward'), summary)
    t.check('scenario forward CQ writes lastForwardSummaryCache', (conversation.lastForwardSummaryCache.get('10001') || '').includes('hello from cq forward'), conversation.lastForwardSummaryCache.get('10001') || '')
    t.check('scenario forward CQ calls expected id', mocked.calls.join(',') === 'cqroot', mocked.calls.join(','))
  })

  await withScenario({}, async ({ harness, makeSession }) => {
    const { resolveForwardSummary } = require(path.join(AI_ROOT, 'lib', 'forward.js'))
    const mocked = makeForwardMock({
      htmlroot: [textNode('Bob', 'hello from html forward')],
    })
    const session = makeSession({ content: '<forward id="htmlroot"/>' })
    const summary = await resolveForwardSummary(session, session.content, harness.ctx, mocked)
    t.check('scenario forward HTML summary includes sender', summary.includes('Bob'), summary)
    t.check('scenario forward HTML summary includes text', summary.includes('hello from html forward'), summary)
    t.check('scenario forward HTML calls expected id', mocked.calls.join(',') === 'htmlroot', mocked.calls.join(','))
  })

  await withScenario({}, async ({ harness, makeSession }) => {
    const { resolveForwardSummary } = require(path.join(AI_ROOT, 'lib', 'forward.js'))
    const mocked = makeForwardMock({
      root: [textNode('Outer', '[CQ:forward,id=12345]')],
      12345: [textNode('Inner', 'nested cq forward text')],
    })
    const session = makeSession({ content: '[CQ:forward,id=root]' })
    const summary = await resolveForwardSummary(session, session.content, harness.ctx, mocked)
    t.check('scenario forward nested CQ calls inner id', mocked.calls.join(',') === 'root,12345', mocked.calls.join(','))
    t.check('scenario forward nested CQ includes inner text', summary.includes('nested cq forward text'), summary)
  })

  await withScenario({}, async ({ harness, makeSession }) => {
    const { resolveForwardSummary } = require(path.join(AI_ROOT, 'lib', 'forward.js'))
    const mocked = makeForwardMock({
      root: [{
        sender: { nickname: 'Outer2' },
        message: [
          { type: 'text', data: { text: 'before' } },
          { type: 'forward', data: { id: 'nested' } },
        ],
      }],
      nested: [textNode('Inner2', 'structured nested text')],
    })
    const session = makeSession({ content: '[CQ:forward,id=root]' })
    const summary = await resolveForwardSummary(session, session.content, harness.ctx, mocked)
    t.check('scenario forward structured nested calls inner id', mocked.calls.join(',') === 'root,nested', mocked.calls.join(','))
    t.check('scenario forward structured nested includes inner text', summary.includes('structured nested text'), summary)
  })

  await withScenario({}, async ({ harness, makeSession }) => {
    const { resolveForwardSummary } = require(path.join(AI_ROOT, 'lib', 'forward.js'))
    const mocked = makeForwardMock({
      root: [{
        sender: { nickname: 'Segments' },
        message: [
          { type: 'text', data: { text: 'segment text' } },
          { type: 'face', data: { id: '76' } },
          { type: 'at', data: { qq: '42' } },
          { type: 'image', data: { file: 'x.png' } },
        ],
      }],
    })
    const session = makeSession({ content: '[CQ:forward,id=root]' })
    const summary = await resolveForwardSummary(session, session.content, harness.ctx, mocked)
    t.check('scenario forward segment message includes text', summary.includes('segment text'), summary)
    t.check('scenario forward segment message includes at target', summary.includes('@42'), summary)
    t.check('scenario forward segment message includes face label', summary.includes('銆愯〃鎯呫€?'), summary)
    t.check('scenario forward segment message includes image label', summary.includes('銆愬浘鐗囥€?'), summary)
  })

  await withScenario({}, async ({ harness, makeSession }) => {
    const { resolveForwardSummary } = require(path.join(AI_ROOT, 'lib', 'forward.js'))
    const conversation = require(path.join(AI_ROOT, 'lib', 'conversation.js'))
    const mocked = makeForwardMock({
      empty: [],
    })
    const missingSession = makeSession({ guildId: '10002', channelId: '10002', content: '[CQ:forward,id=missing]' })
    const missingSummary = await resolveForwardSummary(missingSession, missingSession.content, harness.ctx, mocked)
    t.check('scenario forward missing id returns empty summary', missingSummary === '', JSON.stringify(missingSummary))
    t.check('scenario forward missing id does not write cache', !conversation.lastForwardSummaryCache.has('10002'), conversation.lastForwardSummaryCache.get('10002') || '')

    const emptySession = makeSession({ guildId: '10003', channelId: '10003', content: '[CQ:forward,id=empty]' })
    const emptySummary = await resolveForwardSummary(emptySession, emptySession.content, harness.ctx, mocked)
    t.check('scenario forward empty array keeps current summary behavior', typeof emptySummary === 'string' && emptySummary.length > 0, JSON.stringify(emptySummary))
    t.check('scenario forward empty array writes current cache behavior', conversation.lastForwardSummaryCache.get('10003') === emptySummary, conversation.lastForwardSummaryCache.get('10003') || '')
  })
}

module.exports = { run }
