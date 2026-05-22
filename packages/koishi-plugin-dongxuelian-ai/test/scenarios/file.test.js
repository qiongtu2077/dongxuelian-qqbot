const path = require('path')
const fs = require('fs')
const { withScenario } = require('./_setup')
const { AI_ROOT } = require('../fake/file')
const { mockFetch } = require('../fake/fetch')
const { checkSentExcludes, checkSentIncludes } = require('../helpers/assert')

function atBot(session, content = '') {
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

async function run(t) {
  t.section('scenario: file history and natural reading')

  await withScenario({}, async ({ makeSession, run, data }) => {
    const session = makeSession({
      content: '',
      messageId: 'file-empty-1',
      event: {
        sender: { role: 'member' },
        message: [{ type: 'file', data: { name: 'notes.txt', file: 'file-token-1', size: 12, mime: 'text/plain' } }],
      },
    })
    const result = await run(session, { flushTicks: 20 })
    const store = require(path.join(AI_ROOT, 'lib', 'file-store.js'))
    const entry = await store.getFileEntry(session.guildId, 'file-empty-1')
    t.check('scenario empty group file stores metadata before early return', entry && entry.fileName === 'notes.txt' && entry.fileId === 'file-token-1', JSON.stringify(entry))
    const conversation = require(path.join(AI_ROOT, 'lib', 'conversation.js'))
    const shared = conversation.channelSharedCache.get(session.guildId) || []
    t.check('scenario empty group file enters shared context anchor', shared.some(item => String(item.content || '').includes('[文件: notes.txt')), JSON.stringify(shared))
    const sceneIndex = require(path.join(AI_ROOT, 'lib', 'group-scene-index.js'))
    const note = sceneIndex.buildActiveGroupSceneNote(session.guildId, shared, session.userId, { currentText: '太大了' })
    t.check('scenario file anchor appears in active group scene', note.includes('notes.txt') && note.includes('当前群聊现场'), note)
    t.check('scenario empty group file does not send proactive reply', result.sent.length === 0, JSON.stringify(result.sent))
    t.check('scenario file history file created', fs.existsSync(data.pathFor('file-history', `${session.guildId}.json`)), data.dataDir)
  })

  await withScenario({}, async ({ makeSession, run }) => {
    const fileSession = makeSession({
      content: '',
      messageId: 'file-read-1',
      event: {
        sender: { role: 'member' },
        message: [{ type: 'file', data: { name: 'plan.txt', file: 'file-token-2', size: 20, mime: 'text/plain' } }],
      },
    })
    await run(fileSession, { flushTicks: 20 })
    const store = require(path.join(AI_ROOT, 'lib', 'file-store.js'))
    await store.markFileAnalyzed(fileSession.guildId, 'file-read-1', '[用户上传文件: plan.txt]\n---文件内容开始---\n第一行计划\n第二行细节\n---文件内容结束---')

    const readerSession = makeSession({
      content: atBot(fileSession, '读文件'),
      messageId: 'file-read-command',
    })
    const result = await run(readerSession, { flushTicks: 80 })
    await readerSession.waitForSend(message => String(message).includes('plan.txt'))
    checkSentIncludes(t, 'scenario read file command sends natural summary', result, 'plan.txt 的内容大致是')
    checkSentExcludes(t, 'scenario read file command hides wrapper start', result, '---文件内容开始---')
    checkSentExcludes(t, 'scenario read file command hides wrapper label', result, '[用户上传文件:')
  })

  await withScenario({}, async ({ makeSession, run }) => {
    const mocked = mockFetch([
      { json: { choices: [{ message: { content: '文件里主要是两行计划：先做 A，再补 B。' } }] } },
    ])
    await withFetch(mocked, async () => {
      const session = makeSession({
        content: atBot(makeSession(), '刚才那个文件总结一下'),
        messageId: 'file-agent-ask',
      })
      const store = require(path.join(AI_ROOT, 'lib', 'file-store.js'))
      await store.storeFile(session.guildId, 'file-agent-1', {
        fileName: 'plan.txt',
        fileSize: 20,
        mimeType: 'text/plain',
        ext: 'txt',
        url: '',
        fileId: 'file-token-3',
        conversationKey: `${session.guildId}:${session.userId}`,
        userId: session.userId,
        skipped: false,
      })
      await store.markFileAnalyzed(session.guildId, 'file-agent-1', '[用户上传文件: plan.txt]\n---文件内容开始---\n先做 A\n再补 B\n---文件内容结束---')
      const result = await run(session, { flushTicks: 120 })
      await session.waitForSend(message => String(message).includes('文件里主要'))
      checkSentIncludes(t, 'scenario file follow-up can be answered by chat', result, '文件里主要')
      checkSentExcludes(t, 'scenario file follow-up hides wrapper', result, '---文件内容开始---')
    })
  })

  await withScenario({}, async ({ makeSession, run }) => {
    const mocked = mockFetch([
      { json: { choices: [{ message: { content: '', tool_calls: [{ id: 'tc-context', type: 'function', function: { name: 'read_group_context', arguments: '{"query":"8.52MB 太大 生成 卡死","maxAgeMinutes":30}' } }] } }] } },
      { json: { choices: [{ message: { content: '8.52MB 那个文件确实偏大，刚才你们是在担心生成会卡。' } }] } },
    ])
    await withFetch(mocked, async () => {
      const conversation = require(path.join(AI_ROOT, 'lib', 'conversation.js'))
      const base = { guildId: '10001', channelId: '10001', selfId: '90000' }
      conversation.saveSharedChannelTurn({ ...base, userId: 'u-a', author: { id: 'u-a' } }, 'ㅤ', '[文件: voice.zip 8.52MB]', 'user', { messageId: 'ctx-file-1' })
      conversation.saveSharedChannelTurn({ ...base, userId: 'u-b', author: { id: 'u-b' } }, '水落烟雨', '希望能生成吧', 'user', { messageId: 'ctx-file-2' })
      conversation.saveSharedChannelTurn({ ...base, userId: 'u-b', author: { id: 'u-b' } }, '水落烟雨', '感觉很大概率卡死', 'user', { messageId: 'ctx-file-3' })
      await new Promise(resolve => setImmediate(resolve))
      const session = makeSession({
        content: atBot(makeSession(), '那个会卡吗'),
        messageId: 'file-context-ask',
      })
      const result = await run(session, { flushTicks: 160 })
      await session.waitForSend(message => String(message).includes('8.52MB'))
      checkSentIncludes(t, 'scenario read_group_context tool answers old file follow-up', result, '8.52MB')
      const calls = mocked.calls
      t.check('scenario read_group_context is exposed to chat model', calls[0]?.requestBody?.tools?.some(item => item.function?.name === 'read_group_context'), JSON.stringify(calls[0]?.requestBody?.tools || []))
      const toolMessages = calls[1]?.requestBody?.messages?.filter(item => item.role === 'tool') || []
      t.check('scenario read_group_context returns old file scene as tool result', toolMessages.some(item => String(item.content || '').includes('voice.zip') && String(item.content || '').includes('卡死')), JSON.stringify(toolMessages))
    })
  })
}

module.exports = { run }
