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

  await withScenario({}, async ({ makeSession, run }) => {
    const session = makeSession({
      content: '',
      messageId: 'file-private-silent-1',
      isDirect: true,
      guildId: undefined,
      channelId: undefined,
      event: { sender: { role: 'member' }, message: [{ type: 'file', data: { name: '私聊文件.txt', file: 'private-file-token', size: 12, mime: 'text/plain' } }] },
    })
    const result = await run(session, { flushTicks: 20 })
    const store = require(path.join(AI_ROOT, 'lib', 'file-store.js'))
    const entry = await store.getFileEntry('private', 'file-private-silent-1')
    t.check('scenario private pure file stores metadata', entry && entry.fileName === '私聊文件.txt' && entry.fileId === 'private-file-token', JSON.stringify(entry))
    t.check('scenario private pure file stays silent', result.sent.length === 0, JSON.stringify(result.sent))
  })

  await withScenario({}, async ({ makeSession, run, data }) => {
    const incidentPath = data.pathFor('incident-files', 'amis-public.txt')
    await fs.promises.mkdir(path.dirname(incidentPath), { recursive: true })
    await fs.promises.writeFile(incidentPath, '真实内容：爱弥斯是联络员，不是星穹铁道角色。\n重点：临时模拟必须读文件，不准按文件名猜。', 'utf8')

    const mocked = mockFetch([
      { json: { choices: [{ message: { content: '呀吼～文件里说了什么呀？我还没看到呢！' } }] } },
      { json: { choices: [{ message: { content: 'NO' } }] } },
      { json: { choices: [{ message: { content: '呀吼～文件里说的是爱弥斯新角色技能介绍。' } }] } },
      { json: { choices: [{ message: { content: '文件实际写的是：爱弥斯是联络员；重点是临时模拟必须读文件，不能按文件名猜。' } }] } },
    ])
    const originalFetch = global.fetch
    const originalWarn = console.warn
    global.fetch = mocked.fetch
    console.warn = () => {}
    try {
      const api = require(path.join(AI_ROOT, 'lib', 'api.js'))
      const originalCallGetFile = api.callGetFile
      api.callGetFile = async id => String(id) === '945276682' ? { file: incidentPath } : null
      try {
        const beforeSession = makeSession({
          content: '这个文件里说了什么',
          messageId: 'incident-0505-before-file',
          isDirect: true,
          guildId: undefined,
          channelId: undefined,
          event: { sender: { role: 'member' }, message: [{ type: 'text', attrs: { content: '这个文件里说了什么' } }] },
        })
        const beforeResult = await run(beforeSession, { flushTicks: 80 })
        await beforeSession.waitForSend(message => String(message).includes('还没看到'), 10000)
        t.check('scenario incident no-file question asks naturally instead of guessing', beforeResult.sent.some(message => String(message).includes('还没看到')), JSON.stringify(beforeResult.sent))

        const fileSession = makeSession({
          content: '',
          messageId: '945276682',
          isDirect: true,
          guildId: undefined,
          channelId: undefined,
          event: { sender: { role: 'member' }, message: [{ type: 'file', data: { name: '3.3版本-爱弥斯-公用.txt', file: '3.3版本-爱弥斯-公用.txt', size: 0, mime: '' } }] },
        })
        const fileResult = await run(fileSession, { flushTicks: 20 })
        t.check('scenario incident pure private file remains silent', fileResult.sent.length === 0, JSON.stringify(fileResult.sent))

        const followSession = makeSession({
          content: '这个文件里面的内容是什么',
          messageId: 'incident-0505-follow-up',
          isDirect: true,
          guildId: undefined,
          channelId: undefined,
          event: { sender: { role: 'member' }, message: [{ type: 'text', attrs: { content: '这个文件里面的内容是什么' } }] },
        })
        const followResult = await run(followSession, { flushTicks: 200 })
        await followSession.waitForSend(message => String(message).includes('爱弥斯是联络员'), 10000)
        t.check('scenario incident follow-up eventually replies', followResult.sent.some(message => String(message).includes('爱弥斯是联络员')), JSON.stringify({ sent: followResult.sent, calls: mocked.calls.map(call => call.requestBody?.messages?.slice(-4)) }))
        checkSentIncludes(t, 'scenario incident file follow-up reads actual file content', followResult, '爱弥斯是联络员')
        checkSentIncludes(t, 'scenario incident file follow-up includes anti-guessing content', followResult, '不能按文件名猜')
        checkSentExcludes(t, 'scenario incident file follow-up does not hallucinate skill intro', followResult, '技能介绍')
        t.check('scenario incident free route first answer tried without tool then guard corrected', mocked.calls.length >= 2, JSON.stringify(mocked.calls.map(call => call.requestBody?.messages?.slice(-3))))
        t.check('scenario incident guard injects actual file evidence', mocked.calls.some(call => call.requestBody?.messages?.some(item => String(item.content || '').includes('临时模拟必须读文件'))), JSON.stringify(mocked.calls.map(call => call.requestBody?.messages || [])))
      } finally {
        api.callGetFile = originalCallGetFile
      }
    } finally {
      global.fetch = originalFetch
      console.warn = originalWarn
    }
  })

  await withScenario({}, async ({ makeSession, run, data }) => {
    const firstPath = data.pathFor('incident-files', 'old-plan.md')
    const latestPath = data.pathFor('incident-files', 'agent-route-plan.md')
    await fs.promises.mkdir(path.dirname(firstPath), { recursive: true })
    await fs.promises.writeFile(firstPath, '旧文件内容：不要读取这一份。', 'utf8')
    await fs.promises.writeFile(latestPath, '真实内容：行动路由要先读取用户上传文件，不准把工具计划当回复发出去。', 'utf8')

    const mocked = mockFetch([
      { json: { choices: [{ message: { content: 'web_fetch url https://example.com/2026-05-24-Agent行动路由文件发送与Cron提醒待审核方案.md' } }] } },
      { json: { choices: [{ message: { content: '这个文件说的是：行动路由要先读取用户上传文件，不能把工具计划当回复发出去。' } }] } },
    ])
    const originalFetch = global.fetch
    const originalWarn = console.warn
    global.fetch = mocked.fetch
    console.warn = () => {}
    try {
      const api = require(path.join(AI_ROOT, 'lib', 'api.js'))
      const originalCallGetFile = api.callGetFile
      const requestedIds = []
      api.callGetFile = async id => {
        requestedIds.push(String(id))
        if (String(id) === 'old-file-id') return { file: firstPath }
        if (String(id) === 'latest-file-id') return { file: latestPath }
        return null
      }
      try {
        await run(makeSession({
          content: '',
          messageId: 'old-file-id',
          isDirect: true,
          guildId: undefined,
          channelId: undefined,
          event: { sender: { role: 'member' }, message: [{ type: 'file', data: { name: '旧计划.md', file: 'old-file-id', size: 0, mime: 'text/markdown' } }] },
        }), { flushTicks: 20 })
        await run(makeSession({
          content: '',
          messageId: 'latest-file-id',
          isDirect: true,
          guildId: undefined,
          channelId: undefined,
          event: { sender: { role: 'member' }, message: [{ type: 'file', data: { name: '2026-05-24-Agent行动路由文件发送与Cron提醒待审核方案.md', file: 'latest-file-id', size: 0, mime: 'text/markdown' } }] },
        }), { flushTicks: 20 })

        const followSession = makeSession({
          content: '这里面说了啥',
          messageId: 'latest-file-follow-up',
          isDirect: true,
          guildId: undefined,
          channelId: undefined,
          event: { sender: { role: 'member' }, message: [{ type: 'text', attrs: { content: '这里面说了啥' } }] },
        })
        const followResult = await run(followSession, { flushTicks: 220 })
        await followSession.waitForSend(message => String(message).includes('行动路由'), 10000)
        checkSentIncludes(t, 'scenario short file follow-up reads latest uploaded file', followResult, '行动路由')
        checkSentExcludes(t, 'scenario short file follow-up never sends web_fetch plan', followResult, 'web_fetch url')
        t.check('scenario short file follow-up downloads latest file id', requestedIds.includes('latest-file-id'), JSON.stringify(requestedIds))
        t.check('scenario short file follow-up avoids older file when latest is active', !requestedIds.includes('old-file-id') || requestedIds.indexOf('latest-file-id') < requestedIds.indexOf('old-file-id'), JSON.stringify(requestedIds))
        t.check('scenario short file follow-up injects actual latest evidence', mocked.calls.some(call => JSON.stringify(call.requestBody?.messages || []).includes('不准把工具计划当回复发出去')), JSON.stringify(mocked.calls.map(call => call.requestBody?.messages || [])))
      } finally {
        api.callGetFile = originalCallGetFile
      }
    } finally {
      global.fetch = originalFetch
      console.warn = originalWarn
    }
  })

  await withScenario({}, async ({ makeSession, run }) => {
    const mocked = mockFetch([
      { json: { choices: [{ message: { content: '这个文件大概是在讲说课流程。' } }] } },
    ])
    await withFetch(mocked, async () => {
      const session = makeSession({
        content: '文件里面说了什么',
        messageId: 'file-text-segment-fallback',
        isDirect: true,
        guildId: undefined,
        channelId: undefined,
        event: { sender: { role: 'member' }, message: [{ type: 'text', data: {}, attrs: { content: '文件里面说了什么' } }] },
      })
      const result = await run(session, { flushTicks: 120 })
      await session.waitForSend(message => String(message).includes('这个文件大概'))
      checkSentIncludes(t, 'scenario text attrs segment still reaches chat', result, '这个文件大概')
      t.check('scenario text attrs segment preserves user content for model', mocked.calls[0]?.requestBody?.messages?.some(item => String(item.content || '').includes('文件里面说了什么')), JSON.stringify(mocked.calls[0]?.requestBody?.messages || []))
    })
  })

  await withScenario({}, async ({ makeSession, run }) => {
    const mocked = mockFetch([
      { json: { choices: [{ message: { content: '', tool_calls: [{ id: 'tc-file', type: 'function', function: { name: 'analyze_file', arguments: '{}' } }] } }] } },
      { json: { choices: [{ message: { content: '文件里主要讲的是说课流程和课堂安排。' } }] } },
    ])
    await withFetch(mocked, async () => {
      const session = makeSession({
        content: '文件里面说了什么',
        messageId: 'file-natural-chat-tool',
        isDirect: true,
        guildId: undefined,
        channelId: undefined,
        event: { sender: { role: 'member' }, message: [{ type: 'text', attrs: { content: '文件里面说了什么' } }] },
      })
      const store = require(path.join(AI_ROOT, 'lib', 'file-store.js'))
      await store.storeFile('private', 'natural-file-1', {
        fileName: '说课.md',
        fileSize: 20,
        mimeType: 'text/markdown',
        ext: 'md',
        url: '',
        fileId: 'file-token-natural',
        conversationKey: 'private',
        userId: session.userId,
        skipped: false,
      })
      await store.markFileAnalyzed('private', 'natural-file-1', '[用户上传文件: 说课.md]\n---文件内容开始---\n说课流程\n课堂安排\n---文件内容结束---')
      const result = await run(session, { flushTicks: 160 })
      await session.waitForSend(message => String(message).includes('说课流程'), 10000)
      checkSentIncludes(t, 'scenario natural file follow-up uses chat analyze_file', result, '说课流程')
      checkSentExcludes(t, 'scenario natural file follow-up hides wrapper', result, '---文件内容开始---')
      const firstTools = mocked.calls[0]?.requestBody?.tools || []
      t.check('scenario natural file follow-up exposes analyze_file tool', firstTools.some(item => item.function?.name === 'analyze_file'), JSON.stringify(firstTools))
      const toolMessages = mocked.calls[1]?.requestBody?.messages?.filter(item => item.role === 'tool') || []
      t.check('scenario natural file follow-up tool returns file content', toolMessages.some(item => String(item.content || '').includes('说课流程')), JSON.stringify(toolMessages))
    })
  })

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
    const session = makeSession({
      content: '[CQ:file,file=lesson.md,name=说课.md,size=18,url=https://example.test/lesson.md]',
      messageId: 'file-cq-only-1',
      event: { sender: { role: 'member' }, message: [] },
    })
    const result = await run(session, { flushTicks: 20 })
    const store = require(path.join(AI_ROOT, 'lib', 'file-store.js'))
    const entry = await store.getFileEntry(session.guildId, 'file-cq-only-1')
    t.check('scenario CQ content-only file stores metadata', entry && entry.fileName === '说课.md' && entry.fileId === 'lesson.md', JSON.stringify(entry))
    t.check('scenario CQ content-only file stays silent in group', result.sent.length === 0, JSON.stringify(result.sent))
  })

  await withScenario({}, async ({ makeSession, run }) => {
    const session = makeSession({
      content: '',
      messageId: 'file-elements-1',
      elements: [{ type: 'file', attrs: { name: '课件.txt', file: 'file-token-elements', size: 20, mime: 'text/plain' } }],
      event: { sender: { role: 'member' }, message: { elements: [{ type: 'file', attrs: { name: '课件.txt', file: 'file-token-elements', size: 20, mime: 'text/plain' } }] } },
    })
    const result = await run(session, { flushTicks: 20 })
    const store = require(path.join(AI_ROOT, 'lib', 'file-store.js'))
    const entry = await store.getFileEntry(session.guildId, 'file-elements-1')
    t.check('scenario Koishi elements file stores metadata', entry && entry.fileName === '课件.txt' && entry.fileId === 'file-token-elements', JSON.stringify(entry))
    t.check('scenario Koishi elements file stays silent in group', result.sent.length === 0, JSON.stringify(result.sent))
  })

  await withScenario({}, async ({ makeSession, run }) => {
    const session = makeSession({
      content: '',
      messageId: 'file-mixed-sources-1',
      elements: [{ type: 'file', attributes: { name: '混合来源.txt', file: 'file-token-mixed', size: 30, mime: 'text/plain' } }],
      event: { sender: { role: 'member' }, message: [{ type: 'text', attrs: { content: '' } }] },
    })
    const result = await run(session, { flushTicks: 20 })
    const store = require(path.join(AI_ROOT, 'lib', 'file-store.js'))
    const entry = await store.getFileEntry(session.guildId, 'file-mixed-sources-1')
    t.check('scenario mixed segment sources file stores metadata', entry && entry.fileName === '混合来源.txt' && entry.fileId === 'file-token-mixed', JSON.stringify(entry))
    t.check('scenario mixed segment sources file stays silent in group', result.sent.length === 0, JSON.stringify(result.sent))
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
      { json: { choices: [{ message: { content: 'NO' } }] } },
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

  await withScenario({}, async ({ makeSession, run, data }) => {
    const sourcePath = data.pathFor('uploaded-files', 'amis-public.txt')
    await fs.promises.mkdir(path.dirname(sourcePath), { recursive: true })
    await fs.promises.writeFile(sourcePath, '爱弥斯文件正文', 'utf8')
    const mocked = mockFetch([
      { json: { choices: [{ message: { content: '', tool_calls: [{ id: 'tc-file-variant', type: 'function', function: { name: 'create_uploaded_file_variant', arguments: '{"name":"1","sendBack":true}' } }] } }] } },
      { json: { choices: [{ message: { content: '已经改名发回去了。' } }] } },
    ])
    await withFetch(mocked, async () => {
      const store = require(path.join(AI_ROOT, 'lib', 'file-store.js'))
      const groupSession = makeSession({
        content: atBot(makeSession(), '把刚刚这个文件标题重命名为1然后发给我'),
        messageId: 'file-variant-ask',
      })
      await store.storeFile(groupSession.guildId, 'file-variant-source', {
        fileName: '3.3版本-爱弥斯-公用.txt',
        fileSize: 24,
        mimeType: 'text/plain',
        ext: 'txt',
        url: '',
        fileId: 'file-variant-token',
        conversationKey: groupSession.guildId,
        userId: groupSession.userId,
        skipped: false,
      })
      await store.setLocalPath(groupSession.guildId, 'file-variant-source', sourcePath)
      const chatTools = require(path.join(AI_ROOT, 'lib', 'chat-tools.js'))
      t.check('scenario uploaded file variant exposes chat tool for rename intent', chatTools.getChatToolDefinitions({ userText: '把刚刚这个文件标题重命名为1然后发给我' }).some(item => item.function?.name === 'create_uploaded_file_variant'))
      t.check('scenario uploaded file variant exposes chat tool without file-word heuristic', chatTools.getChatToolDefinitions({ userText: '把刚才那个 PDF 另存成 1 发回来' }).some(item => item.function?.name === 'create_uploaded_file_variant'))
      t.check('scenario uploaded file variant stays hidden for random replies', !chatTools.getChatToolDefinitions({ userText: '把刚才那个 PDF 另存成 1 发回来', randomTriggered: true }).some(item => item.function?.name === 'create_uploaded_file_variant'))
      const sendFileTool = require(path.join(AI_ROOT, 'lib', 'agent', 'tools', 'send-file-to-user.js'))
      const originalExecute = sendFileTool.execute
      const uploadCalls = []
      sendFileTool.execute = async (params, context = {}) => originalExecute(params, {
        ...context,
        callOneBot: async (action, callParams) => {
          uploadCalls.push({ action, params: callParams })
          return { ok: true }
        },
      })
      try {
        const result = await run(groupSession, { flushTicks: 160 })
        await groupSession.waitForSend(message => String(message).includes('已经改名发回去了'), 10000)
        checkSentIncludes(t, 'scenario uploaded file variant natural reply', result, '已经改名发回去了')
        const toolMessages = mocked.calls[1]?.requestBody?.messages?.filter(item => item.role === 'tool') || []
        t.check('scenario uploaded file variant creates 1.txt copy', toolMessages.some(item => /1\.txt/.test(String(item.content || ''))), JSON.stringify(toolMessages))
        t.check('scenario uploaded file variant infers group upload target', uploadCalls.some(call => call.action === 'upload_group_file' && String(call.params.group_id) === groupSession.guildId && /1\.txt$/.test(String(call.params.name || ''))), JSON.stringify(uploadCalls))
      } finally {
        sendFileTool.execute = originalExecute
      }
    })
  })

  await withScenario({}, async ({ makeSession, run, data }) => {
    const sourcePath = data.pathFor('uploaded-files', 'rename-after-refusal.txt')
    await fs.promises.mkdir(path.dirname(sourcePath), { recursive: true })
    await fs.promises.writeFile(sourcePath, '爱弥斯文件正文', 'utf8')
    const mocked = mockFetch([
      { json: { choices: [{ message: { content: '重命名文件这种事，我帮不了你。' } }] } },
      { json: { choices: [{ message: { content: '', tool_calls: [{ id: 'tc-file-variant-retry', type: 'function', function: { name: 'create_uploaded_file_variant', arguments: '{"name":"1","sendBack":true}' } }] } }] } },
      { json: { choices: [{ message: { content: '已经重命名并发回去了。' } }] } },
    ])
    await withFetch(mocked, async () => {
      const store = require(path.join(AI_ROOT, 'lib', 'file-store.js'))
      const groupSession = makeSession({
        content: atBot(makeSession(), '帮我重命名成1然后发给我'),
        messageId: 'file-variant-refusal-ask',
      })
      await store.storeFile(groupSession.guildId, 'file-variant-refusal-source', {
        fileName: '3.3版本-爱弥斯-公用.txt',
        fileSize: 24,
        mimeType: 'text/plain',
        ext: 'txt',
        url: '',
        fileId: 'file-variant-refusal-token',
        conversationKey: groupSession.guildId,
        userId: groupSession.userId,
        skipped: false,
      })
      await store.setLocalPath(groupSession.guildId, 'file-variant-refusal-source', sourcePath)
      const sendFileTool = require(path.join(AI_ROOT, 'lib', 'agent', 'tools', 'send-file-to-user.js'))
      const originalExecute = sendFileTool.execute
      const uploadCalls = []
      sendFileTool.execute = async (params, context = {}) => originalExecute(params, {
        ...context,
        callOneBot: async (action, callParams) => {
          uploadCalls.push({ action, params: callParams })
          return { ok: true }
        },
      })
      try {
        const result = await run(groupSession, { flushTicks: 180 })
        await groupSession.waitForSend(message => String(message).includes('已经重命名并发回去了'), 10000)
        checkSentIncludes(t, 'scenario uploaded file variant refusal retry sends natural reply', result, '已经重命名并发回去了')
        t.check('scenario uploaded file variant refusal retry calls model again with correction hint', mocked.calls.length >= 3 && (mocked.calls[1]?.requestBody?.messages || []).some(item => String(item.content || '').includes('刚才你拒绝了')), JSON.stringify(mocked.calls.map(call => call.requestBody?.messages?.slice(-3))))
        t.check('scenario uploaded file variant refusal retry uploads group file', uploadCalls.some(call => call.action === 'upload_group_file' && String(call.params.group_id) === groupSession.guildId && /1\.txt$/.test(String(call.params.name || ''))), JSON.stringify(uploadCalls))
      } finally {
        sendFileTool.execute = originalExecute
      }
    })
  })

  await withScenario({}, async ({ makeSession, run, data }) => {
    const sourcePath = data.pathFor('uploaded-files', 'rename-direct-fallback.docx')
    await fs.promises.mkdir(path.dirname(sourcePath), { recursive: true })
    await fs.promises.writeFile(sourcePath, 'fake docx bytes for fallback test')
    const mocked = mockFetch([
      { json: { choices: [{ message: { content: '重命名文件这种事，我帮不了你。' } }] } },
      { json: { choices: [{ message: { content: '我还是不能改名或发文件。' } }] } },
    ])
    await withFetch(mocked, async () => {
      const store = require(path.join(AI_ROOT, 'lib', 'file-store.js'))
      const groupSession = makeSession({
        content: atBot(makeSession(), '帮我重命名成1然后发给我'),
        messageId: 'file-variant-direct-fallback-ask',
      })
      await store.storeFile(groupSession.guildId, 'file-variant-direct-fallback-source', {
        fileName: '简历.docx',
        fileSize: 28,
        mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        ext: 'docx',
        url: '',
        fileId: 'file-variant-direct-fallback-token',
        conversationKey: groupSession.guildId,
        userId: groupSession.userId,
        skipped: false,
      })
      await store.setLocalPath(groupSession.guildId, 'file-variant-direct-fallback-source', sourcePath)
      const sendFileTool = require(path.join(AI_ROOT, 'lib', 'agent', 'tools', 'send-file-to-user.js'))
      const originalExecute = sendFileTool.execute
      const uploadCalls = []
      sendFileTool.execute = async (params, context = {}) => originalExecute(params, {
        ...context,
        callOneBot: async (action, callParams) => {
          uploadCalls.push({ action, params: callParams })
          return { ok: true }
        },
      })
      try {
        const result = await run(groupSession, { flushTicks: 180 })
        await groupSession.waitForSend(message => String(message).includes('已经重命名并发回去了'), 10000)
        checkSentIncludes(t, 'scenario uploaded file variant direct fallback sends natural reply', result, '已经重命名并发回去了')
        t.check('scenario uploaded file variant direct fallback preserves docx extension', uploadCalls.some(call => call.action === 'upload_group_file' && String(call.params.group_id) === groupSession.guildId && /1\.docx$/.test(String(call.params.name || ''))), JSON.stringify(uploadCalls))
        t.check('scenario uploaded file variant direct fallback does not need model tool call', !mocked.calls.some(call => (call.requestBody?.messages || []).some(item => item.role === 'tool')), JSON.stringify(mocked.calls.map(call => call.requestBody?.messages?.slice(-3))))
      } finally {
        sendFileTool.execute = originalExecute
      }
    })
  })
}

module.exports = { run }
