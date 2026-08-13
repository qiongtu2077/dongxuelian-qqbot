const fs = require('fs')
const path = require('path')
const { withScenario } = require('./_setup')
const { mockFetch } = require('../fake/fetch')
const { AI_ROOT } = require('../fake/file')
const {
  checkSentIncludes,
  checkSentExcludes,
  checkNoLeak,
  checkNextCalled,
  formatResult,
} = require('../helpers/assert')

function atBot(session, content = '你好') {
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

function writeRunningLock(data, meta) {
  const file = data.pathFor('resource-gate', 'lock', 'meta.json')
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(meta), 'utf8')
}

function findQueuedFileAnalysis(channelKey, messageId) {
  const mediaQueue = require(path.join(AI_ROOT, 'lib', 'media', 'backpressure', 'media-queue.js'))
  const pending = mediaQueue.listPendingMediaTasks('media_file_analysis', 20)
  const running = (mediaQueue.getMediaBackpressureStatus().running || [])
    .filter(task => task && task.kind === 'media_file_analysis')
  return [...pending, ...running]
    .find(task => task && task.channelKey === channelKey && task.messageId === messageId)
}

function findQueuedVoiceTranscription(channelKey, messageId) {
  const mediaQueue = require(path.join(AI_ROOT, 'lib', 'media', 'backpressure', 'media-queue.js'))
  const pending = mediaQueue.listPendingMediaTasks('media_voice_transcription', 20)
  const running = (mediaQueue.getMediaBackpressureStatus().running || [])
    .filter(task => task && task.kind === 'media_voice_transcription')
  return [...pending, ...running]
    .find(task => task && task.channelKey === channelKey && task.messageId === messageId)
}

async function withMemOverride(availableMb, totalMb, fn) {
  const previousAvailable = process.env.RESOURCE_SCHEDULER_MEM_AVAILABLE_MB_OVERRIDE
  const previousTotal = process.env.RESOURCE_SCHEDULER_MEM_TOTAL_MB_OVERRIDE
  process.env.RESOURCE_SCHEDULER_MEM_AVAILABLE_MB_OVERRIDE = String(availableMb)
  process.env.RESOURCE_SCHEDULER_MEM_TOTAL_MB_OVERRIDE = String(totalMb)
  try {
    return await fn()
  } finally {
    if (previousAvailable === undefined) delete process.env.RESOURCE_SCHEDULER_MEM_AVAILABLE_MB_OVERRIDE
    else process.env.RESOURCE_SCHEDULER_MEM_AVAILABLE_MB_OVERRIDE = previousAvailable
    if (previousTotal === undefined) delete process.env.RESOURCE_SCHEDULER_MEM_TOTAL_MB_OVERRIDE
    else process.env.RESOURCE_SCHEDULER_MEM_TOTAL_MB_OVERRIDE = previousTotal
  }
}

async function run(t) {
  t.section('scenario: bot resource gate regression')

  await withScenario({}, async ({ data, makeSession, run }) => {
    const mocked = mockFetch([
      { json: { choices: [{ message: { content: '日报运行中也该正常聊天' } }] } },
    ])
    await withFetch(mocked, async () => {
      await withMemOverride(1200, 1600, async () => {
        writeRunningLock(data, {
          taskId: 'daily-running-1',
          kind: 'daily_report',
          owner: 'test',
          pid: process.pid,
          channelKey: '10001',
          userId: '100000000',
          startedAt: '2026-06-11T00:00:00.000Z',
          heartbeatAt: '2026-06-11T00:00:01.000Z',
          step: 'rendering',
          memAvailableMb: 1200,
          timeoutMs: 600000,
          ticketId: 'daily-ticket-1',
        })
        const session = makeSession()
        session.content = atBot(session, '你还在吗')
        let result = await run(session, { flushTicks: 120 })
        await session.waitForSend(() => true)
        result = { ...result, sent: session.sent, internalCalls: session.internalCalls, timeline: session.timeline }
        t.check('scenario daily report running does not globally mute explicit chat', result.sent.length > 0 && !result.nextCalled, formatResult(result))
        t.check('scenario daily report running still reaches model path', mocked.calls.length >= 1, `calls=${mocked.calls.length} ${formatResult(result)}`)
        checkNoLeak(t, 'scenario daily report running chat reply does not leak internals', result, ['sk-test-secret', 'Bearer'])
      })
    })
  })

  await withScenario({}, async ({ data, makeSession, run }) => {
    const mocked = mockFetch([
      { json: { choices: [{ message: { content: '引用追问也不该被静默' } }] } },
    ])
    await withFetch(mocked, async () => {
      await withMemOverride(1200, 1600, async () => {
        writeRunningLock(data, {
          taskId: 'daily-running-quote-1',
          kind: 'daily_report',
          owner: 'test',
          pid: process.pid,
          channelKey: '10001',
          userId: '100000000',
          startedAt: '2026-06-11T00:00:00.000Z',
          heartbeatAt: '2026-06-11T00:00:01.000Z',
          step: 'rendering',
          memAvailableMb: 1200,
          timeoutMs: 600000,
          ticketId: 'daily-ticket-quote-1',
        })
        const session = makeSession({
          content: '这是什么意思',
          quote: {
            id: 'bot-quoted-msg-1',
            messageId: 'bot-quoted-msg-1',
            userId: '90000',
            content: '你上一条回复的内容',
          },
        })
        let result = await run(session, { flushTicks: 120 })
        await session.waitForSend(() => true)
        result = { ...result, sent: session.sent, internalCalls: session.internalCalls, timeline: session.timeline }
        checkSentIncludes(t, 'scenario daily report running keeps quote-only explicit follow-up alive', result, '引用追问也不该被静默')
        t.check('scenario daily report quote-only explicit follow-up still reaches model path', mocked.calls.length === 1, `calls=${mocked.calls.length} ${formatResult(result)}`)
        checkNoLeak(t, 'scenario daily report quote-only explicit follow-up does not leak internals', result, ['sk-test-secret', 'Bearer'])
      })
    })
  })

  await withScenario({}, async ({ data, makeSession, run }) => {
    const mocked = mockFetch([
      { json: { choices: [{ message: { content: '独占任务忙时也不该吞掉明确聊天' } }] } },
    ])
    await withFetch(mocked, async () => {
      await withMemOverride(1200, 1600, async () => {
        writeRunningLock(data, {
          taskId: 'browser-running-1',
          kind: 'browser_action',
          owner: 'test',
          pid: process.pid,
          channelKey: '10001',
          userId: '100000000',
          startedAt: '2026-06-11T00:00:00.000Z',
          heartbeatAt: '2026-06-11T00:00:01.000Z',
          step: 'running',
          memAvailableMb: 1200,
          timeoutMs: 600000,
          ticketId: 'browser-ticket-1',
        })
        const session = makeSession()
        session.content = atBot(session, '帮我看下这个情况')
        let result = await run(session, { flushTicks: 120 })
        await session.waitForSend(() => true)
        result = { ...result, sent: session.sent, internalCalls: session.internalCalls, timeline: session.timeline }
        checkSentIncludes(t, 'scenario busy lock does not globally mute explicit chat', result, '独占任务忙时也不该吞掉明确聊天')
        t.check('scenario busy lock still reaches model once', mocked.calls.length === 1, `calls=${mocked.calls.length} ${formatResult(result)}`)
        checkNoLeak(t, 'scenario busy lock chat reply does not leak internals', result, ['sk-test-secret', 'Bearer'])
      })
    })
  })

  await withScenario({}, async ({ makeSession, run }) => {
    const mocked = mockFetch([
      { json: { choices: [{ message: { content: '这句不该被看到' } }] } },
    ])
    await withFetch(mocked, async () => {
      await withMemOverride(299, 1600, async () => {
        const session = makeSession()
        session.content = atBot(session, '现在回我一句')
        const result = await run(session, { flushTicks: 120 })
        t.check('scenario critical mode returns fixed notice for explicit chat', result.sent.some(item => String(item).includes('可用内存低于 300 MB')) && !result.nextCalled, formatResult(result))
        t.check('scenario critical mode does not call model for resource notice', mocked.calls.length === 0, `calls=${mocked.calls.length} ${formatResult(result)}`)
        checkSentExcludes(t, 'scenario critical mode does not accidentally send fake model reply', result, '这句不该被看到')
      })
    })
  })

  await withScenario({}, async ({ makeSession, run }) => {
    await withMemOverride(299, 1600, async () => {
      const session = makeSession({
        content: atBot(makeSession(), '读文件'),
        messageId: 'critical-file-read-1',
        event: {
          sender: { role: 'member' },
          message: [{ type: 'file', data: { name: 'critical-file.txt', file: 'critical-file-token', size: 12, mime: 'text/plain' } }],
        },
      })
      const result = await run(session, { flushTicks: 80 })
      const queued = findQueuedFileAnalysis('10001', 'critical-file-read-1')
      t.check(
        'scenario critical mode returns notice instead of recovering explicit file quick read',
        result.sent.some(item => String(item).includes('可用内存低于 300 MB')) && !result.nextCalled,
        formatResult(result)
      )
      t.check(
        'scenario critical mode does not enqueue file quick read media task',
        !queued,
        JSON.stringify({ result: formatResult(result), queued })
      )
      checkNoLeak(t, 'scenario critical file quick read does not leak internals', result, ['sk-test-secret', 'Bearer'])
    })
  })

  await withScenario({}, async ({ data, makeSession, run }) => {
    writeRunningLock(data, {
      taskId: 'daily-running-agent-1',
      kind: 'daily_report',
      owner: 'test',
      pid: process.pid,
      channelKey: '10001',
      userId: '100000000',
      startedAt: '2026-06-11T00:00:00.000Z',
      heartbeatAt: '2026-06-11T00:00:01.000Z',
      step: 'rendering',
      memAvailableMb: 1200,
      timeoutMs: 600000,
      ticketId: 'daily-ticket-agent-1',
    })
    const session = makeSession({ content: '莲莲 工具 查一下今天时间' })
    const result = await withMemOverride(1200, 1600, () => run(session, { flushTicks: 40 }))
    t.check(
      'scenario daily report running does not hard-block explicit agent command at entry',
      result.sent.length > 0 &&
        !result.sent.some(item => String(item).includes('当前资源正忙，Agent 和工具暂时暂停。')) &&
        result.sent.some(item => {
          const text = String(item)
          return text.includes('Agent 已提交后台执行') ||
            text.includes('Agent 已加入资源队列') ||
            text.includes('当前资源紧张，Agent 任务已记录为延期任务') ||
            text.includes('当前资源不足，Agent 暂时不能执行')
        }),
      formatResult(result)
    )
    checkNoLeak(t, 'scenario daily report agent command reply does not leak secrets', result, ['sk-test-secret', 'Bearer'])
  })

  await withScenario({}, async ({ data, makeSession, run }) => {
    writeRunningLock(data, {
      taskId: 'daily-running-status-1',
      kind: 'daily_report',
      owner: 'test',
      pid: process.pid,
      channelKey: '10001',
      userId: '100000000',
      startedAt: '2026-06-11T00:00:00.000Z',
      heartbeatAt: '2026-06-11T00:00:01.000Z',
      step: 'rendering',
      memAvailableMb: 1200,
      timeoutMs: 600000,
      ticketId: 'daily-ticket-status-1',
    })
    const session = makeSession({ content: '资源状态' })
    const result = await withMemOverride(1200, 1600, () => run(session, { flushTicks: 40 }))
    t.check(
      'scenario daily report running still keeps status command alive',
      result.sent.some(item => {
        const text = String(item)
        return text.includes('模式：report_silent')
          && text.includes('资源档位：green')
          && text.includes('服务器模式：')
          && text.includes('模式来源：')
          && text.includes('tool_active：')
          && text.includes('render_active：')
          && text.includes('background_allowed：')
      }),
      formatResult(result)
    )
    t.check('scenario daily report status command stays low cost without next', result.sent.length > 0 && !result.nextCalled, formatResult(result))
    checkNoLeak(t, 'scenario daily report status command does not leak secrets', result, ['sk-test-secret', 'Bearer'])
  })

  await withScenario({}, async ({ data, makeSession, run }) => {
    writeRunningLock(data, {
      taskId: 'daily-running-file-1',
      kind: 'daily_report',
      owner: 'test',
      pid: process.pid,
      channelKey: '10001',
      userId: '100000000',
      startedAt: '2026-06-11T00:00:00.000Z',
      heartbeatAt: '2026-06-11T00:00:01.000Z',
      step: 'rendering',
      memAvailableMb: 1200,
      timeoutMs: 600000,
      ticketId: 'daily-ticket-file-1',
    })
    const session = makeSession({
      content: atBot(makeSession(), '读文件'),
      messageId: 'report-file-read-1',
      event: {
        sender: { role: 'member' },
        message: [{ type: 'file', data: { name: '日报期间文件.txt', file: 'report-file-token', size: 12, mime: 'text/plain' } }],
      },
    })
    const result = await withMemOverride(1200, 1600, () => run(session, { flushTicks: 80 }))
    t.check(
      'scenario daily report running keeps explicit file quick read recoverable',
      result.sent.some(item => String(item).includes('媒体分析队列')) &&
        result.sent.some(item => String(item).includes('稍后再读取')),
      formatResult(result)
    )
    checkNoLeak(t, 'scenario daily report explicit file quick read does not leak secrets', result, ['sk-test-secret', 'Bearer'])
  })

  await withScenario({}, async ({ data, makeSession, run }) => {
    writeRunningLock(data, {
      taskId: 'daily-running-file-anchor-1',
      kind: 'daily_report',
      owner: 'test',
      pid: process.pid,
      channelKey: '10001',
      userId: '100000000',
      startedAt: '2026-06-11T00:00:00.000Z',
      heartbeatAt: '2026-06-11T00:00:01.000Z',
      step: 'rendering',
      memAvailableMb: 1200,
      timeoutMs: 600000,
      ticketId: 'daily-ticket-file-anchor-1',
    })
    const store = require(path.join(AI_ROOT, 'lib', 'media', 'file', 'file-store.js'))
    const ownAnalyzedId = 'report-file-quick-own-analyzed'
    const otherRecentId = 'report-file-quick-other-recent'
    const currentSkippedId = 'report-file-quick-current'
    await store.storeFile('10001', ownAnalyzedId, {
      fileName: '自己的可读文件.txt',
      fileSize: 20,
      mimeType: 'text/plain',
      ext: 'txt',
      url: '',
      fileId: 'report-quick-own-file-token',
      conversationKey: '10001',
      userId: '100000000',
      skipped: false,
    })
    await store.storeFile('10001', otherRecentId, {
      fileName: '别人更新的最近文件.txt',
      fileSize: 20,
      mimeType: 'text/plain',
      ext: 'txt',
      url: '',
      fileId: 'report-quick-other-file-token',
      conversationKey: '10001',
      userId: '200000000',
      skipped: false,
    })
    const session = makeSession({
      content: atBot(makeSession(), '读文件'),
      messageId: currentSkippedId,
      event: {
        sender: { role: 'member' },
        message: [{ type: 'file', data: { name: '当前压缩包.zip', file: 'report-quick-current-file-token', size: 12, mime: 'application/zip' } }],
      },
    })
    const result = await withMemOverride(1200, 1600, () => run(session, { flushTicks: 80 }))
    t.check(
      'scenario daily report explicit file quick read keeps queued reply when current file is skipped',
      result.sent.some(item => String(item).includes('媒体分析队列')) &&
        result.sent.some(item => String(item).includes('稍后再读取')),
      formatResult(result)
    )
    const queuedOwn = findQueuedFileAnalysis('10001', ownAnalyzedId)
    const queuedOther = findQueuedFileAnalysis('10001', otherRecentId)
    const queuedCurrent = findQueuedFileAnalysis('10001', currentSkippedId)
    t.check(
      'scenario daily report explicit file quick read queues guard-selected own file instead of newer cross-user file',
      !!queuedOwn && !queuedOther && !queuedCurrent,
      JSON.stringify({
        queuedOwn,
        queuedOther,
        queuedCurrent,
      })
    )
    checkNoLeak(t, 'scenario daily report explicit file quick read anchor recovery does not leak secrets', result, ['sk-test-secret', 'Bearer'])
  })

  await withScenario({}, async ({ data, makeSession, run }) => {
    writeRunningLock(data, {
      taskId: 'daily-running-file-natural-1',
      kind: 'daily_report',
      owner: 'test',
      pid: process.pid,
      channelKey: '10001',
      userId: '100000000',
      startedAt: '2026-06-11T00:00:00.000Z',
      heartbeatAt: '2026-06-11T00:00:01.000Z',
      step: 'rendering',
      memAvailableMb: 1200,
      timeoutMs: 600000,
      ticketId: 'daily-ticket-file-natural-1',
    })
    const session = makeSession({
      content: atBot(makeSession(), '这个文件里讲了什么'),
      messageId: 'report-file-natural-read-1',
      event: {
        sender: { role: 'member' },
        message: [{ type: 'file', data: { name: '日报期间自然追问文件.txt', file: 'report-file-natural-token', size: 12, mime: 'text/plain' } }],
      },
    })
    const result = await withMemOverride(1200, 1600, () => run(session, { flushTicks: 80 }))
    t.check(
      'scenario daily report running keeps explicit natural file follow-up recoverable',
      result.sent.some(item => String(item).includes('媒体分析队列')) &&
        result.sent.some(item => String(item).includes('稍后再读取')),
      formatResult(result)
    )
    checkNoLeak(t, 'scenario daily report explicit natural file follow-up does not leak secrets', result, ['sk-test-secret', 'Bearer'])
  })

  await withScenario({}, async ({ data, makeSession, run }) => {
    writeRunningLock(data, {
      taskId: 'daily-running-file-natural-anchor-1',
      kind: 'daily_report',
      owner: 'test',
      pid: process.pid,
      channelKey: '10001',
      userId: '100000000',
      startedAt: '2026-06-11T00:00:00.000Z',
      heartbeatAt: '2026-06-11T00:00:01.000Z',
      step: 'rendering',
      memAvailableMb: 1200,
      timeoutMs: 600000,
      ticketId: 'daily-ticket-file-natural-anchor-1',
    })
    const store = require(path.join(AI_ROOT, 'lib', 'media', 'file', 'file-store.js'))
    const ownAnalyzedId = 'report-file-own-analyzed'
    const otherRecentId = 'report-file-other-recent'
    const currentSkippedId = 'report-file-natural-anchor-current'
    await store.storeFile('10001', ownAnalyzedId, {
      fileName: '自己的旧文件.txt',
      fileSize: 20,
      mimeType: 'text/plain',
      ext: 'txt',
      url: '',
      fileId: 'report-own-file-token',
      conversationKey: '10001',
      userId: '100000000',
      skipped: false,
    })
    await store.storeFile('10001', otherRecentId, {
      fileName: '别人更新的文件.txt',
      fileSize: 20,
      mimeType: 'text/plain',
      ext: 'txt',
      url: '',
      fileId: 'report-other-file-token',
      conversationKey: '10001',
      userId: '200000000',
      skipped: false,
    })
    const session = makeSession({
      content: atBot(makeSession(), '这个文件里讲了什么'),
      messageId: currentSkippedId,
      event: {
        sender: { role: 'member' },
        message: [{ type: 'file', data: { name: '当前压缩包.zip', file: 'report-current-file-token', size: 12, mime: 'application/zip' } }],
      },
    })
    const result = await withMemOverride(1200, 1600, () => run(session, { flushTicks: 80 }))
    t.check(
      'scenario daily report natural file follow-up keeps queued reply when current file is skipped',
      result.sent.some(item => String(item).includes('媒体分析队列')) &&
        result.sent.some(item => String(item).includes('稍后再读取')),
      formatResult(result)
    )
    const queuedOwn = findQueuedFileAnalysis('10001', ownAnalyzedId)
    const queuedOther = findQueuedFileAnalysis('10001', otherRecentId)
    const queuedCurrent = findQueuedFileAnalysis('10001', currentSkippedId)
    t.check(
      'scenario daily report natural file follow-up queues guard-selected own file instead of newer cross-user file',
      !!queuedOwn && !queuedOther && !queuedCurrent,
      JSON.stringify({
        queuedOwn,
        queuedOther,
        queuedCurrent,
      })
    )
    checkNoLeak(t, 'scenario daily report natural file follow-up anchor recovery does not leak secrets', result, ['sk-test-secret', 'Bearer'])
  })

  await withScenario({}, async ({ data, makeSession, run }) => {
    writeRunningLock(data, {
      taskId: 'daily-running-image-1',
      kind: 'daily_report',
      owner: 'test',
      pid: process.pid,
      channelKey: '10001',
      userId: '100000000',
      startedAt: '2026-06-11T00:00:00.000Z',
      heartbeatAt: '2026-06-11T00:00:01.000Z',
      step: 'rendering',
      memAvailableMb: 1200,
      timeoutMs: 600000,
      ticketId: 'daily-ticket-image-1',
    })
    const session = makeSession({
      content: atBot(makeSession(), '这张图是什么'),
      messageId: 'report-image-read-1',
      event: {
        sender: { role: 'member' },
        message: [{ type: 'image', data: { url: 'http://example.test/report-image.jpg', file: 'report-image-file' } }],
      },
    })
    const mocked = mockFetch([
      { json: { choices: [{ message: { content: '这句不该被看到' } }] } },
    ])
    await withFetch(mocked, async () => {
      const result = await withMemOverride(1200, 1600, () => run(session, { flushTicks: 80 }))
      t.check(
        'scenario daily report running keeps explicit image follow-up recoverable',
        result.sent.some(item => String(item).includes('图片已加入媒体分析队列')) &&
          result.sent.some(item => String(item).includes('read_image_history')),
        formatResult(result)
      )
      t.check(
        'scenario daily report explicit image follow-up stays off frontstage vision model',
        mocked.calls.length === 0,
        `calls=${JSON.stringify(mocked.calls)} ${formatResult(result)}`
      )
      checkNoLeak(t, 'scenario daily report explicit image follow-up does not leak secrets', result, ['sk-test-secret', 'Bearer'])
    })
  })

  await withScenario({}, async ({ makeSession, run }) => {
    const session = makeSession({
      content: '',
      messageId: 'yellow-passive-image-1',
      event: {
        sender: { role: 'member' },
        message: [{ type: 'image', data: { url: 'http://example.test/yellow-passive-image.jpg', file: 'yellow-passive-image-file' } }],
      },
    })
    const result = await withMemOverride(700, 1600, () => run(session, { flushTicks: 40 }))
    const mediaQueue = require(path.join(AI_ROOT, 'lib', 'media', 'backpressure', 'media-queue.js'))
    const imageStore = require(path.join(AI_ROOT, 'lib', 'media', 'image', 'image-store.js'))
    const queued = mediaQueue.listPendingMediaTasks('media_image_analysis', 20)
      .find(task => task && task.channelKey === '10001' && task.messageId === 'yellow-passive-image-1')
    const entry = await imageStore.getImageEntry('10001', 'yellow-passive-image-1')
    t.check(
      'scenario yellow passive image ingest queues work when its memory budget is met',
      result.sent.length === 0 &&
        !!queued &&
        entry && entry.file === 'yellow-passive-image-file',
      JSON.stringify({ result: formatResult(result), queued, entry })
    )
  })

  await withScenario({}, async ({ makeSession, run }) => {
    const session = makeSession({
      content: '',
      messageId: 'yellow-passive-file-1',
      event: {
        sender: { role: 'member' },
        message: [{ type: 'file', data: { name: 'yellow-passive-file.txt', file: 'yellow-passive-file-token', size: 12, mime: 'text/plain' } }],
      },
    })
    const result = await withMemOverride(700, 1600, () => run(session, { flushTicks: 40 }))
    const queued = findQueuedFileAnalysis('10001', 'yellow-passive-file-1')
    const fileStore = require(path.join(AI_ROOT, 'lib', 'media', 'file', 'file-store.js'))
    const entry = await fileStore.getFileEntry('10001', 'yellow-passive-file-1')
    t.check(
      'scenario yellow passive file ingest queues work when its memory budget is met',
      result.sent.length === 0 &&
        !!queued &&
        entry && entry.fileName === 'yellow-passive-file.txt' && entry.fileId === 'yellow-passive-file-token',
      JSON.stringify({ result: formatResult(result), queued, entry })
    )
  })

  await withScenario({}, async ({ makeSession, run }) => {
    const session = makeSession({
      content: '',
      messageId: 'yellow-passive-voice-1',
      event: {
        sender: { role: 'member' },
        message: [{ type: 'record', data: { file: 'yellow-passive-voice-file' } }],
      },
    })
    const result = await withMemOverride(700, 1600, () => run(session, { flushTicks: 40 }))
    const queued = findQueuedVoiceTranscription('10001', 'yellow-passive-voice-1')
    const voiceStore = require(path.join(AI_ROOT, 'lib', 'media', 'voice', 'voice-store.js'))
    const entry = await voiceStore.getVoiceEntry('10001', 'yellow-passive-voice-1')
    t.check(
      'scenario yellow passive voice ingest keeps metadata but stops background media enqueue',
      result.sent.length === 0 &&
        !queued &&
        entry && entry.file === 'yellow-passive-voice-file',
      JSON.stringify({ result: formatResult(result), queued, entry })
    )
  })

  await withScenario({}, async ({ data, makeSession, run }) => {
    writeRunningLock(data, {
      taskId: 'daily-running-voice-1',
      kind: 'daily_report',
      owner: 'test',
      pid: process.pid,
      channelKey: '10001',
      userId: '100000000',
      startedAt: '2026-06-11T00:00:00.000Z',
      heartbeatAt: '2026-06-11T00:00:01.000Z',
      step: 'rendering',
      memAvailableMb: 1200,
      timeoutMs: 600000,
      ticketId: 'daily-ticket-voice-1',
    })
    const session = makeSession({
      content: '',
      messageId: 'report-voice-read-1',
      event: {
        sender: { role: 'member' },
        message: [{ type: 'record', data: { file: 'report-voice-file' } }],
      },
    })
    session.content = atBot(session, '这段语音说了什么')
    const mocked = mockFetch([
      { json: { choices: [{ message: { content: '这句不该被看到' } }] } },
    ])
    await withFetch(mocked, async () => {
      const result = await withMemOverride(1200, 1600, () => run(session, { flushTicks: 80 }))
      const queued = findQueuedVoiceTranscription('10001', 'report-voice-read-1')
      t.check(
        'scenario daily report running keeps explicit voice follow-up recoverable',
        result.sent.some(item => String(item).includes('转写队列')) &&
          result.sent.some(item => String(item).includes('稍后')) &&
          queued && queued.kind === 'media_voice_transcription' && queued.status === 'pending',
        JSON.stringify({ result: formatResult(result), queued })
      )
      t.check(
        'scenario daily report explicit voice follow-up stays off frontstage model path',
        mocked.calls.length === 0,
        `calls=${mocked.calls.length} ${formatResult(result)}`
      )
      checkNoLeak(t, 'scenario daily report explicit voice follow-up does not leak secrets', result, ['sk-test-secret', 'Bearer'])
    })
  })
}

module.exports = { run }
