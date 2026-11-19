const path = require('path')
const fs = require('node:fs')
const { setTimeout: sleep } = require('node:timers/promises')
const sharp = require('sharp')
const { OneBot } = require('koishi-plugin-adapter-onebot')
const { withScenario } = require('./_setup')
const { AI_ROOT } = require('../fake/file')
const { mockFetch } = require('../fake/fetch')
const { withForwardServer } = require('../fake/forward-server')
const { seedCapabilityConfig } = require('../helpers/ai-capability-fixture')

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

// --- 引用材料的后台交接 --- //

// 等待正常中间件提交后台任务，沿用真实异步调度。
async function waitForQueuedForwardTask() {
  const { listResourceTasks } = require('../../lib/resource-workers/task-store')
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    const task = listResourceTasks({ statuses: ['pending', 'deferred'], limit: 10 }).find(item => item.kind === 'agent_task')
    if (task) return task
    await sleep(10)
  }
  throw new Error('未收到转发问题对应的后台任务')
}

// 重放正常 QQ 入口、视觉请求、文字模型选择工具和持久化后的转述。
async function runForwardTaskHandoff(t, withText) {
  const label = withText ? 'mixed forward' : 'image-only forward'
  await withScenario({}, async ({ data, harness, makeSession, run }) => {
    const textModel = 'deepseek-flash', visionModel = 'qwen3.8-max-0902'
    seedCapabilityConfig(data, {
      text: [{ provider: 'deepseek', model: textModel }],
      vision: [{ provider: 'dashscope', model: visionModel }],
    })
    const { saveConversationTurn } = require('../../lib/conversation')
    const { chat } = require('../../lib/chat')
    const { retellAgentResult } = require('../../lib/chat/chat-result-flow')
    const { runAgentWorkerTask } = require('../../lib/resource-workers/agent-worker')
    const { createAgentTaskSender } = require('../../lib/resource-workers/result-notifier')
    const searchTool = require('../../lib/agent/tools/web-search')
    const originalSearch = searchTool.execute
    const searchQueries = []
    const question = '这是什么意思？'
    const recordText = '群友在讨论两张色卡的顺序'
    const evidence = '第一张是红色色卡，第二张是蓝色色卡'
    const answer = '第一张是红色，第二张是蓝色。'
    const imageFiles = new Map()
    const segments = withText ? [{ type: 'text', data: { text: recordText } }] : []
    for (const color of ['red', 'blue']) {
      const name = color + '.png', file = data.pathFor(name)
      await sharp({ create: { width: 8, height: 8, channels: 3, background: color } }).png().toFile(file)
      imageFiles.set(name, file)
      segments.push({ type: 'image', data: { file: name } })
    }
    const records = [{ type: 'node', data: { nickname: '材料作者', content: segments } }]
    const session = makeSession({ content: '<at id="90000"/> ' + question,
      quote: { messageId: 'original-record', content: '<forward id="root"/>' } })
    await saveConversationTurn(session, question, '你在问我上一句吗？')
    const query = '核对色卡相关公开资料'
    const toolCalls = [{ id: 'search-record', type: 'function', function: { name: 'web_search', arguments: JSON.stringify({ query }) } }]
    const mocked = mockFetch([
      { json: { choices: [{ message: { content: evidence } }] } },
      { json: { choices: [{ message: { tool_calls: toolCalls } }] } },
      { json: { choices: [{ message: { content: '先核对一下。' } }] } },
      { json: { choices: [{ message: { content: '材料里有两张色卡。' } }] } },
      { json: { choices: [{ message: { content: answer } }] } },
    ])
    const topic = mockFetch([{ json: { choices: [{ message: { content: 'NO' } }] } }])
    const originalFetch = global.fetch
    global.fetch = (url, options) => {
      const body = JSON.parse(options.body)
      return (String(body.messages[0]?.content).includes('判断用户是否切换了话题') ? topic : mocked).fetch(url, options)
    }
    // 只替换外部搜索的返回值；worker 正常运行任务文件里的预执行工具。
    searchTool.execute = async args => { searchQueries.push(args.query); return '搜索状态：weak_hit（未读到可用正文）' }
    try {
      await withForwardServer(records, imageFiles, async () => {
        await run(session)
        const task = await waitForQueuedForwardTask()
        const input = task.payload.agentWorker.engineInput
        const note = input.forwardMaterialNote
        const [visionRequest, firstTextRequest] = mocked.calls.map(call => call.requestBody)
        const imageInput = visionRequest.messages.find(message => message.role === 'user').content
        const imageUrls = imageInput.filter(part => part.type === 'image_url').map(part => part.image_url.url)
        const originals = [...imageFiles.values()].map(file => 'data:image/png;base64,' + fs.readFileSync(file).toString('base64'))
        t.check(label + ' sends both original files to the configured vision model', visionRequest.model === visionModel && JSON.stringify(imageUrls) === JSON.stringify(originals))
        const firstPrompt = firstTextRequest.messages.map(message => String(message.content || '')).join('\n')
        t.check(label + ' uses visual output in the initial question', firstTextRequest.model === textModel && firstPrompt.includes(evidence)
          && (!withText || firstPrompt.includes(recordText)) && !firstPrompt.includes('优先理解为对你上一句'))
        t.check(label + ' saves the original question and evidence to the task', task.payload.entry === 'chat-heavy-tool'
          && input.userMessage === question && note?.includes(evidence) && (!withText || note.includes(recordText)))

        const result = await runAgentWorkerTask(task)
        const workerPrompt = mocked.calls.at(-1).requestBody.messages
        t.check(label + ' worker receives the same evidence alongside the executed search', searchQueries.includes(query)
          && workerPrompt.some(message => message.content === note) && workerPrompt.some(message => message.role === 'tool' && String(message.content).includes('weak_hit')))
        const sent = []
        const sender = createAgentTaskSender({ ctx: harness.ctx, chat, retellAgentResult, bot: {
          async sendMessage(_channel, text) { sent.push(text); return ['sent'] },
        } })
        await sender(task, result)
        const finalPrompt = mocked.calls.at(-1).requestBody.messages
        t.check(label + ' final model sees the same evidence and user question', finalPrompt.some(message => message.content === note)
          && finalPrompt.some(message => message.role === 'user' && message.content.includes(question)))
        t.check(label + ' sends one answer and uses the text route after recognition', sent.length === 1 && sent[0].includes(answer)
          && mocked.calls.length === 5 && [...mocked.calls.slice(1), ...topic.calls].every(call => call.requestBody.model === textModel))
      })
    } finally {
      searchTool.execute = originalSearch
      global.fetch = originalFetch
    }
  })
}

// 显式搜索走快捷入口；卡片不可读时不得发布无材料的任务。
async function runForwardSearchShortcut(t, available) {
  await withScenario({}, async ({ makeSession, run }) => {
    const text = '需核对的原始说法'
    const records = available ? [textNode('发言人', text)] : []
    const question = '调用web_search核对这份聊天记录'
    const session = makeSession({ content: '<at id="90000"/> ' + question, quote: { messageId: 'quoted', content: '<forward id="direct"/>' } })
    const originalFetch = global.fetch, mocked = mockFetch([])
    global.fetch = mocked.fetch
    try {
      await withForwardServer(records, new Map(), async () => {
        await run(session)
        if (available) {
          const task = await waitForQueuedForwardTask()
          const input = task.payload.agentWorker.engineInput
          t.check('explicit search keeps the quoted text and original question on the direct worker route', task.payload.entry === 'qq-auto-route'
            && input.userMessage === question && input.forwardMaterialNote?.includes(text) && input.forceTools.includes('web_search'))
        } else {
          await session.waitForSend(reply => reply.includes('消息记录暂时无法读取'))
          const { listResourceTasks } = require('../../lib/resource-workers/task-store')
          t.check('unreadable quoted search does not enqueue a worker', !listResourceTasks().some(task => task.kind === 'agent_task'))
        }
        t.check('direct search or unavailable record takes no intermediate model call', mocked.calls.length === 0)
      })
    } finally { global.fetch = originalFetch }
  })
}

// --- 转发解析 --- //

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
  for (const withText of [true, false]) await runForwardTaskHandoff(t, withText)
  for (const available of [true, false]) await runForwardSearchShortcut(t, available)
}

module.exports = { run }
