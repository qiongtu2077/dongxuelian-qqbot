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
    '../../lib/constants',
    '../../lib/api',
    '../../lib/runtime-config',
    '../../lib/agent/memory',
    '../../lib/agent/auto-memory',
    '../../lib/agent/dream',
  ]
  for (const mod of modulesToReload) {
    delete require.cache[require.resolve(mod)]
  }

  let mockLLMResponse = { type: 'text', content: '用户喜欢深色主题\n用户是前端开发者' }
  const originalFetch = global.fetch
  global.fetch = async () => ({
    ok: true,
    json: async () => ({
      choices: [{ message: { content: mockLLMResponse.content } }],
      usage: { total_tokens: 100 },
    }),
  })

  try {
    const autoMemory = require('../../lib/agent/auto-memory')
    const dream = require('../../lib/agent/dream')

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
    let dailyExists = false
    try { dailyExists = fs.existsSync(dailyDir) && fs.readdirSync(dailyDir).length > 0 } catch {}
    t.check('auto-memory: qq channel does not write daily file', !dailyExists)

    // Test 3: onAgentReplyComplete writes for dashboard after 8 messages
    autoMemory.resetAutoMemoryCounter('dashuser')
    for (let i = 0; i < 7; i++) autoMemory.shouldTrigger('dashuser')

    const fakeMessages = []
    for (let i = 0; i < 8; i++) {
      fakeMessages.push({ role: 'user', content: `用户消息 ${i}` })
      fakeMessages.push({ role: 'assistant', content: `助手回复 ${i}` })
    }

    await autoMemory.onAgentReplyComplete({ userId: 'dashuser', channel: 'dashboard', messages: fakeMessages })
    await new Promise(r => setTimeout(r, 100))

    let dailyFiles = []
    try { dailyFiles = fs.readdirSync(dailyDir).filter(f => f.startsWith('dashuser')) } catch {}
    t.check('auto-memory: dashboard writes daily file', dailyFiles.length > 0, 'files: ' + dailyFiles.join(', '))

    if (dailyFiles.length > 0) {
      const content = fs.readFileSync(path.join(dailyDir, dailyFiles[0]), 'utf8')
      t.check('auto-memory: daily file contains extracted content', content.includes('深色主题') || content.includes('前端开发'))
    }

    // Test 4: Dream does not trigger when daily size < 20KB
    const status = await dream.getDreamStatus('dashuser')
    t.check('dream: small daily file does not need dream', !status.needsDream)

    // Test 5: Dream triggers when daily size > 20KB
    const bigDailyFile = path.join(dailyDir, 'dashuser.2026-01-01.md')
    fs.writeFileSync(bigDailyFile, 'x'.repeat(21 * 1024), 'utf8')
    const statusBig = await dream.getDreamStatus('dashuser')
    t.check('dream: large daily file needs dream', statusBig.needsDream)

    // Test 6: runDream consolidates and deletes daily files
    mockLLMResponse = { type: 'text', content: '用户是前端开发者，喜欢深色主题，使用 VS Code。' }
    const dreamResult = await dream.runDream('dashuser')
    t.check('dream: runDream succeeds', dreamResult.success === true, JSON.stringify(dreamResult))

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
    fs.writeFileSync(path.join(dailyDir, 'dashuser.2026-02-01.md'), 'y'.repeat(21 * 1024), 'utf8')
    mockLLMResponse = { type: 'text', content: '更新后的记忆内容。' }
    await dream.runDream('dashuser')
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

    // Test 11: model failure silently skipped (no crash, no new file)
    const dailyFilesBefore = fs.existsSync(dailyDir) ? fs.readdirSync(dailyDir) : []
    global.fetch = async () => { throw new Error('network timeout') }
    autoMemory.resetAutoMemoryCounter('failuser')
    for (let i = 0; i < 7; i++) autoMemory.shouldTrigger('failuser')
    let threw = false
    try {
      await autoMemory.onAgentReplyComplete({ userId: 'failuser', channel: 'dashboard', messages: fakeMessages })
      await new Promise(r => setTimeout(r, 100))
    } catch { threw = true }
    t.check('auto-memory: model failure does not throw', !threw)
    const dailyFilesAfter = fs.existsSync(dailyDir) ? fs.readdirSync(dailyDir) : []
    const newFailFiles = dailyFilesAfter.filter(f => f.startsWith('failuser'))
    t.check('auto-memory: model failure writes no daily file', newFailFiles.length === 0)

  } finally {
    global.fetch = originalFetch
    process.env.DONGXUELIAN_AI_DATA_DIR = originalDataDir
    for (const mod of modulesToReload) {
      delete require.cache[require.resolve(mod)]
    }
    try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch {}
  }
}

module.exports = { run }
