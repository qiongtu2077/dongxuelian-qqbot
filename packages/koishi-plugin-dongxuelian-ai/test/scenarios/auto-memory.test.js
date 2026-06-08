async function run(t) {
  t.section('scenario: auto-memory and dream')

  const fs = require('fs')
  const fsp = require('fs/promises')
  const path = require('path')
  const os = require('os')

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-memory-test-'))
  const originalDataDir = process.env.DONGXUELIAN_AI_DATA_DIR
  process.env.DONGXUELIAN_AI_DATA_DIR = tmpDir

  const modulesToReload = [
    '../../lib/core/constants',
    '../../lib/resource-common/files',
    '../../lib/resource-workers/task-paths',
    '../../lib/resource-workers/task-store',
    '../../lib/resource-scheduler/resource-snapshot',
    '../../lib/resource-scheduler/task-budget',
    '../../lib/resource-scheduler/admission',
    '../../lib/resource-workers/task-client',
    '../../lib/core/api',
    '../../lib/core/runtime-config',
    '../../lib/agent/config',
    '../../lib/resource-workers/memory-worker',
    '../../lib/agent/memory',
    '../../lib/agent/auto-memory',
    '../../lib/agent/dream',
  ]
  for (const mod of modulesToReload) {
    delete require.cache[require.resolve(mod)]
  }

  let mockLLMResponse = { type: 'text', content: '用户喜欢深色主题\n用户是前端开发者' }
  const modelCalls = []
  const originalFetch = global.fetch
  global.fetch = async (url, options = {}) => {
    modelCalls.push({ url, body: options && options.body })
    return {
      ok: true,
      json: async () => ({
        choices: [{ message: { content: mockLLMResponse.content } }],
        usage: { total_tokens: 100 },
      }),
    }
  }

  try {
    const autoMemory = require('../../lib/agent/auto-memory')
    const dream = require('../../lib/agent/dream')
    const memoryWorker = require('../../lib/resource-workers/memory-worker')
    const taskStore = require('../../lib/resource-workers/task-store')

    function listMemoryTasks(kind, userId, statuses = ['pending', 'deferred', 'failed', 'done']) {
      return taskStore.listResourceTasks({ statuses, limit: 100 })
        .filter(task => task.kind === kind && String(task.userId || '') === String(userId || ''))
    }

    // Test 1: shouldTrigger returns false for counts < 8
    for (let i = 0; i < 7; i++) {
      t.check('auto-memory: count ' + (i + 1) + ' does not trigger', !autoMemory.shouldTrigger('testuser'))
    }
    t.check('auto-memory: count 8 triggers', autoMemory.shouldTrigger('testuser'))

    // Test 2: onAgentReplyComplete skips non-dashboard
    autoMemory.resetAutoMemoryCounter('qquser')
    for (let i = 0; i < 8; i++) autoMemory.shouldTrigger('qquser')
    autoMemory.resetAutoMemoryCounter('qquser')
    await autoMemory.onAgentReplyComplete({ userId: 'qquser', channel: 'qq', messages: [] })
    const dailyDir = autoMemory.DAILY_DIR
    t.check('auto-memory: daily dir matches memory worker', dailyDir === memoryWorker.DAILY_DIR)
    let dailyExists = false
    try { dailyExists = fs.existsSync(dailyDir) && fs.readdirSync(dailyDir).length > 0 } catch {}
    t.check('auto-memory: qq channel does not write daily file', !dailyExists)
    t.check('auto-memory: qq channel does not queue memory task', listMemoryTasks('agent_memory', 'qquser').length === 0)

    // Test 3: onAgentReplyComplete queues S2 memory extraction after 8 messages
    autoMemory.resetAutoMemoryCounter('dashuser')
    for (let i = 0; i < 7; i++) autoMemory.shouldTrigger('dashuser')

    const fakeMessages = []
    for (let i = 0; i < 8; i++) {
      fakeMessages.push({ role: 'user', content: `用户消息 ${i}` })
      fakeMessages.push({ role: 'assistant', content: `助手回复 ${i}` })
    }

    await autoMemory.onAgentReplyComplete({ userId: 'dashuser', channel: 'dashboard', messages: fakeMessages })
    await new Promise(r => setTimeout(r, 100))

    const callsAfterMemorySubmit = modelCalls.length
    const memoryTasks = listMemoryTasks('agent_memory', 'dashuser', ['pending', 'deferred', 'failed'])
    const memoryTask = memoryTasks[0] || null
    t.check('auto-memory: dashboard queues S2 memory task',
      callsAfterMemorySubmit === 0 && memoryTasks.length === 1 && memoryTask.payload && Array.isArray(memoryTask.payload.recentMessages) && memoryTask.payload.recentMessages.length >= 2,
      JSON.stringify({ calls: callsAfterMemorySubmit, tasks: memoryTasks }))

    let dailyFiles = []
    try { dailyFiles = fs.readdirSync(dailyDir).filter(f => f.startsWith('dashuser')) } catch {}
    t.check('auto-memory: dashboard submit does not write daily file synchronously', dailyFiles.length === 0, 'files: ' + dailyFiles.join(', '))

    const memoryResult = memoryTask ? await memoryWorker.runMemoryWorkerTask(memoryTask) : {}
    t.check('auto-memory: worker writes daily file', memoryResult.mode === 'agent_memory' && memoryResult.extracted === true, JSON.stringify(memoryResult))
    t.check('auto-memory: worker calls mocked LLM once', modelCalls.length === callsAfterMemorySubmit + 1, JSON.stringify(modelCalls))

    try { dailyFiles = fs.readdirSync(dailyDir).filter(f => f.startsWith('dashuser')) } catch {}
    t.check('auto-memory: dashboard worker creates daily file', dailyFiles.length > 0, 'files: ' + dailyFiles.join(', '))

    if (dailyFiles.length > 0) {
      const content = fs.readFileSync(path.join(dailyDir, dailyFiles[0]), 'utf8')
      t.check('auto-memory: daily file contains extracted content', content.includes('深色主题') || content.includes('前端开发'))
    }

    // Test 4: Dream does not trigger when daily size < 20KB
    const status = await dream.getDreamStatus('dashuser')
    t.check('dream: small daily file does not need dream', !status.needsDream)

    // Test 5: Dream triggers when daily size > 20KB
    const bigDailyFile = path.join(dailyDir, 'dashuser.2026-01-01.md')
    fs.mkdirSync(dailyDir, { recursive: true })
    fs.writeFileSync(bigDailyFile, 'x'.repeat(21 * 1024), 'utf8')
    const statusBig = await dream.getDreamStatus('dashuser')
    t.check('dream: large daily file needs dream', statusBig.needsDream)

    // Test 6: runDream queues compaction, worker direct consolidates and deletes daily files
    mockLLMResponse = { type: 'text', content: '用户是前端开发者，喜欢深色主题，使用 VS Code。' }
    const callsBeforeDreamSubmit = modelCalls.length
    const queuedDreamResult = await dream.runDream('dashuser')
    const compactionTasks = listMemoryTasks('agent_memory_compaction', 'dashuser', ['pending', 'deferred', 'failed'])
    t.check('dream: runDream queues S2 compaction task',
      queuedDreamResult.success === true && queuedDreamResult.queued === true && queuedDreamResult.taskId && compactionTasks.some(task => task.id === queuedDreamResult.taskId),
      JSON.stringify({ queuedDreamResult, compactionTasks }))
    t.check('dream: runDream submit does not call model synchronously', modelCalls.length === callsBeforeDreamSubmit, JSON.stringify(modelCalls))

    const dreamResult = await memoryWorker.runDreamDirect('dashuser')
    t.check('dream: runDreamDirect succeeds', dreamResult.success === true, JSON.stringify(dreamResult))

    const longTermFile = dream.getLongTermFile('dashuser')
    const longTermExists = fs.existsSync(longTermFile)
    t.check('dream: long-term file created', longTermExists)

    if (longTermExists) {
      const ltContent = fs.readFileSync(longTermFile, 'utf8')
      t.check('dream: long-term file has consolidated content', ltContent.includes('前端开发') || ltContent.includes('VS Code'))
    }

    let remainingDaily = []
    try { remainingDaily = fs.readdirSync(dailyDir).filter(f => f.startsWith('dashuser')) } catch {}
    t.check('dream: daily files deleted after consolidation', remainingDaily.length === 0, 'remaining: ' + remainingDaily.join(', '))

    // Test 7: Dream creates backup of existing long-term file
    fs.mkdirSync(dailyDir, { recursive: true })
    fs.writeFileSync(path.join(dailyDir, 'dashuser.2026-02-01.md'), 'y'.repeat(21 * 1024), 'utf8')
    mockLLMResponse = { type: 'text', content: '更新后的记忆内容。' }
    const reDreamResult = await memoryWorker.runDreamDirect('dashuser')
    t.check('dream: runDreamDirect re-dream succeeds', reDreamResult.success === true, JSON.stringify(reDreamResult))
    const backupExists = fs.existsSync(path.join(autoMemory.DASHBOARD_MEMORY_DIR, 'dashuser.md.bak'))
    t.check('dream: backup file created on re-dream', backupExists)

    // Test 8: searchDashboardMemory works
    const memory = require('../../lib/agent/memory')
    const searchResult = await memory.searchDashboardMemory({ userId: 'dashuser', query: '记忆' })
    t.check('memory: searchDashboardMemory returns content', searchResult.length > 0)

    // Test 9: searchDashboardMemory returns empty for non-existent user
    const emptyResult = await memory.searchDashboardMemory({ userId: 'nonexistent', query: 'test' })
    t.check('memory: searchDashboardMemory returns empty for unknown user', emptyResult === '')

    // Test 10: getAutoMemoryStats returns valid data
    const stats = autoMemory.getAutoMemoryStats()
    t.check('auto-memory: stats has interval', stats.interval === 8)
    t.check('auto-memory: stats has memoryDir', stats.memoryDir.includes('agent-memory-dashboard'))

    // Test 11: model failure is isolated to the worker (entry only queues)
    const dailyFilesBefore = fs.existsSync(dailyDir) ? fs.readdirSync(dailyDir) : []
    global.fetch = async (url, options = {}) => { modelCalls.push({ url, body: options && options.body, failed: true }); throw new Error('network timeout') }
    autoMemory.resetAutoMemoryCounter('failuser')
    for (let i = 0; i < 7; i++) autoMemory.shouldTrigger('failuser')
    let threw = false
    const callsBeforeFailSubmit = modelCalls.length
    try {
      await autoMemory.onAgentReplyComplete({ userId: 'failuser', channel: 'dashboard', messages: fakeMessages })
      await new Promise(r => setTimeout(r, 100))
    } catch { threw = true }
    const failTasks = listMemoryTasks('agent_memory', 'failuser', ['pending', 'deferred', 'failed'])
    t.check('auto-memory: model failure submit does not throw', !threw && failTasks.length === 1 && modelCalls.length === callsBeforeFailSubmit, JSON.stringify({ failTasks, calls: modelCalls.length, callsBeforeFailSubmit }))
    let workerFailed = false
    try {
      if (failTasks[0]) await memoryWorker.runMemoryWorkerTask(failTasks[0])
    } catch { workerFailed = true }
    const dailyFilesAfter = fs.existsSync(dailyDir) ? fs.readdirSync(dailyDir) : []
    const newFailFiles = dailyFilesAfter.filter(f => f.startsWith('failuser'))
    t.check('auto-memory: worker model failure writes no daily file', workerFailed && newFailFiles.length === 0, JSON.stringify({ workerFailed, before: dailyFilesBefore, after: dailyFilesAfter }))

    // Test 12 (L33): memory.enabled=false 时自动记忆直接跳过，不写文件、不计数
    global.fetch = async (url, options = {}) => {
      modelCalls.push({ url, body: options && options.body })
      return {
        ok: true,
        json: async () => ({ choices: [{ message: { content: '不该被写入的记忆' } }], usage: { total_tokens: 100 } }),
      }
    }
    const agentConfig = require('../../lib/agent/config')
    await agentConfig.patchAgentConfig({ memory: { enabled: false, adminOnly: false } })
    autoMemory.resetAutoMemoryCounter('disableduser')
    for (let i = 0; i < 7; i++) autoMemory.shouldTrigger('disableduser')
    await autoMemory.onAgentReplyComplete({ userId: 'disableduser', channel: 'dashboard', messages: fakeMessages })
    await new Promise(r => setTimeout(r, 100))
    const disabledFiles = (fs.existsSync(dailyDir) ? fs.readdirSync(dailyDir) : []).filter(f => f.startsWith('disableduser'))
    t.check('L33 auto-memory: disabled memory writes no daily file', disabledFiles.length === 0, 'files: ' + disabledFiles.join(', '))
    t.check('L33 auto-memory: disabled memory queues no task', listMemoryTasks('agent_memory', 'disableduser').length === 0)
    await agentConfig.patchAgentConfig({ memory: { enabled: true, adminOnly: false } })

  } finally {
    global.fetch = originalFetch
    if (originalDataDir === undefined) delete process.env.DONGXUELIAN_AI_DATA_DIR
    else process.env.DONGXUELIAN_AI_DATA_DIR = originalDataDir
    for (const mod of modulesToReload) {
      delete require.cache[require.resolve(mod)]
    }
    try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch {}
  }
}

module.exports = { run }
