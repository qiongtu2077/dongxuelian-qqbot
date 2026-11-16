const path = require('path')
const { OneBot } = require('koishi-plugin-adapter-onebot')
const { withScenario } = require('./_setup')
const { AI_ROOT } = require('../fake/file')
const { mockFetch } = require('../fake/fetch')

// 记录实际请求的转发资源 ID，并返回固定协议响应。
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

// 构造含原始文本的 OneBot 转发节点。
function textNode(nickname, text) {
  return { sender: { nickname }, raw_message: text }
}

// 验证两种协议共用的正文解析、引用材料和失败隔离。
async function run(t) {
  t.section('scenario: forward summary resolution')

  await withScenario({}, async ({ harness, makeSession }) => {
    const { resolveForwardSummary } = require(path.join(AI_ROOT, 'lib', 'message', 'forward.js'))
    const conversation = require(path.join(AI_ROOT, 'lib', 'conversation.js'))
    const mocked = makeForwardMock({})
    const session = makeSession({ guildId: '10000', channelId: '10000', content: 'plain message without forward id' })
    const summary = await resolveForwardSummary(session, session.content, harness.ctx, mocked)
    t.check('scenario forward plain message returns empty summary', summary === '', JSON.stringify(summary))
    t.check('scenario forward plain message does not call API', mocked.calls.length === 0, mocked.calls.join(','))
    t.check('scenario forward plain message does not write cache', !conversation.lastForwardSummaryCache.has('10000'), conversation.lastForwardSummaryCache.get('10000') || '')
  })

  await withScenario({}, async ({ harness, makeSession }) => {
    const { resolveForwardSummary } = require(path.join(AI_ROOT, 'lib', 'message', 'forward.js'))
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
    const { resolveForwardSummary } = require(path.join(AI_ROOT, 'lib', 'message', 'forward.js'))
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
    const { resolveForwardSummary } = require(path.join(AI_ROOT, 'lib', 'message', 'forward.js'))
    const { createChatPromptForwardSummaryMessage } = require(path.join(AI_ROOT, 'lib', 'chat', 'chat-prompt-builder.js'))
    // NapCat 同时提供 raw_message 和 message；线上 SL 2.4.2 的 raw_message 为空。
    // 往返使用不同正文，确保共用解析不会串用前一个协议或前一条记录的缓存。
    for (const [index, protocol] of ['napcat', 'sl', 'napcat'].entries()) {
      const forwardId = `quoted-${protocol}-${index}`
      const text = `record-body-${protocol}-${index}`
      const mocked = makeForwardMock({ [forwardId]: { messages: [{
        sender: { nickname: '材料作者' },
        raw_message: protocol === 'napcat' ? text : '',
        message: [{ type: 'text', data: { text } }],
      }] } })
      const source = {
        message_id: -1662063498, group_id: 10001, time: 1700000000,
        sender: { user_id: 10002, nickname: '转发者' },
        message: [{ type: 'forward', data: { id: forwardId } }],
      }
      const bot = { config: { advanced: { splitMixedContent: false } } }
      const quote = await OneBot.adaptMessage(bot, source)
      const quoteReads = []
      bot.getMessage = async (channelId, messageId) => { quoteReads.push(messageId); return quote }
      const current = await OneBot.adaptMessage(bot, {
        ...source, message_id: -243707512,
        message: [
          { type: 'reply', data: { id: String(source.message_id) } },
          { type: 'at', data: { qq: '90000' } },
          { type: 'text', data: { text: ' 总结这条消息记录' } },
        ],
      })
      const session = makeSession({ messageId: current.id, content: current.content, quote: current.quote })
      const summary = await resolveForwardSummary(session, session.content, harness.ctx, mocked)
      const prompt = createChatPromptForwardSummaryMessage(summary)
      t.check(`scenario forward ${protocol} roundtrip ${index} adapter separates quote`, !current.content.includes('forward') && quoteReads.join(',') === '-1662063498', current.content)
      t.check(`scenario forward ${protocol} roundtrip ${index} fetches quoted resource`, mocked.calls.join(',') === forwardId, mocked.calls.join(','))
      t.check(`scenario forward ${protocol} roundtrip ${index} includes exact quoted body`, summary === `[对话] 材料作者：${text}`, summary)
      t.check(`scenario forward ${protocol} roundtrip ${index} keeps quoted body as external material`, prompt?.content.includes('<forward_material>') && prompt.content.includes(text), JSON.stringify(prompt))
    }
    const noForward = makeForwardMock({})
    const plainQuote = makeSession({ content: '总结这句话', quote: { content: '普通引用文本' } })
    t.check('scenario forward plain quote never reuses a previous forward summary', await resolveForwardSummary(plainQuote, plainQuote.content, harness.ctx, noForward) === '' && noForward.calls.length === 0)
  })

  await withScenario({}, async ({ harness, makeSession }) => {
    const { resolveForwardSummary } = require(path.join(AI_ROOT, 'lib', 'message', 'forward.js'))
    const mocked = makeForwardMock({
      current: [textNode('Current', 'current forward body')],
      quoted: [textNode('Quoted', 'unrelated quoted body')],
    })
    const session = makeSession({ content: '<forward id="current"/>', quote: { content: '<forward id="quoted"/>' } })
    const summary = await resolveForwardSummary(session, session.content, harness.ctx, mocked)
    t.check('scenario forward current material takes precedence over quote', summary.includes('current forward body') && !summary.includes('unrelated quoted body'), summary)
    t.check('scenario forward current material does not fetch unrelated quote', mocked.calls.join(',') === 'current', mocked.calls.join(','))

    const missing = makeSession({ content: '总结这条消息记录', quote: { content: '<forward id="missing-quote"/>' } })
    const missingSummary = await resolveForwardSummary(missing, missing.content, harness.ctx, mocked)
    t.check('scenario forward unavailable quote does not reuse a previous summary', missingSummary === '' && mocked.calls.join(',') === 'current,missing-quote', JSON.stringify({ missingSummary, calls: mocked.calls }))
  })

  for (const protocol of ['napcat', 'sl']) {
    await withScenario({}, async ({ harness, makeSession }) => {
      const { resolveForwardSummary } = require(path.join(AI_ROOT, 'lib', 'message', 'forward.js'))
      const { chat } = require(path.join(AI_ROOT, 'lib', 'chat.js'))
      const mocked = mockFetch([{ json: { choices: [{ message: { content: '已读引用记录' } }] } }])
      const originalFetch = global.fetch
      global.fetch = mocked.fetch
      try {
        const session = makeSession({ content: '总结这条消息记录', quote: { content: `<forward id="model-${protocol}"/>` } })
        const text = '大学本质类魂啊，考试要背板'
        const response = makeForwardMock({ [`model-${protocol}`]: [{
          sender: { nickname: '材料作者' }, raw_message: protocol === 'napcat' ? text : '',
          message: [{ type: 'text', data: { text } }],
        }] })
        const summary = await resolveForwardSummary(session, session.content, harness.ctx, response)
        const reply = await chat(session, session.content, harness.ctx, { forwardSummaryText: summary })
        const messages = mocked.calls[0]?.requestBody?.messages || []
        t.check(`scenario forward ${protocol} quoted body reaches actual model request`, messages.some(item => item.role === 'system' && String(item.content).includes('<forward_material>') && String(item.content).includes(text)), JSON.stringify(messages))
        t.check(`scenario forward ${protocol} inner speaker stays outside current user speech`, !messages.some(item => item.role === 'user' && String(item.content).includes(text)), JSON.stringify(messages))
        t.check(`scenario forward ${protocol} quoted request produces chat reply`, String(reply).includes('已读引用记录'), String(reply))
      } finally { global.fetch = originalFetch }
    })
  }

  await withScenario({}, async ({ harness, makeSession }) => {
    const { resolveForwardSummary } = require(path.join(AI_ROOT, 'lib', 'message', 'forward.js'))
    const conversation = require(path.join(AI_ROOT, 'lib', 'conversation.js'))
    const mocked = makeForwardMock({
      objectRoot: { messages: [textNode('ObjectShape', 'hello from object messages')] },
    })
    const session = makeSession({ guildId: '10004', channelId: '10004', content: '[CQ:forward,id=objectRoot]' })
    const summary = await resolveForwardSummary(session, session.content, harness.ctx, mocked)
    t.check('scenario forward object messages summary includes sender', summary.includes('ObjectShape'), summary)
    t.check('scenario forward object messages summary includes text', summary.includes('hello from object messages'), summary)
    t.check('scenario forward object messages writes cache', (conversation.lastForwardSummaryCache.get('10004') || '').includes('hello from object messages'), conversation.lastForwardSummaryCache.get('10004') || '')
  })

  await withScenario({}, async ({ harness, makeSession }) => {
    const { resolveForwardSummary } = require(path.join(AI_ROOT, 'lib', 'message', 'forward.js'))
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
    const { resolveForwardSummary } = require(path.join(AI_ROOT, 'lib', 'message', 'forward.js'))
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
    const { resolveForwardSummary } = require(path.join(AI_ROOT, 'lib', 'message', 'forward.js'))
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
    t.check('scenario forward segment message includes face label', summary.includes('【表情】'), summary)
    t.check('scenario forward segment message includes image label', summary.includes('【图片】'), summary)
  })

  await withScenario({}, async ({ harness, makeSession }) => {
    const { resolveForwardSummary } = require(path.join(AI_ROOT, 'lib', 'message', 'forward.js'))
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
    t.check('scenario forward empty array returns empty summary', emptySummary === '', JSON.stringify(emptySummary))
    t.check('scenario forward empty array does not write cache', !conversation.lastForwardSummaryCache.has('10003'), conversation.lastForwardSummaryCache.get('10003') || '')
  })
}

module.exports = { run }
