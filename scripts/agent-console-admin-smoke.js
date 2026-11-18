const fs = require('fs')
const assert = require('node:assert/strict')
const path = require('path')
const { spawn } = require('child_process')
const puppeteer = require('puppeteer-core')

const ROOT = path.resolve(__dirname, '..')
const AGENT_DIR = path.join(ROOT, 'packages', 'agent-console')
const PORT = Number(process.env.AGENT_CONSOLE_SMOKE_PORT || 5178)
const BASE_URL = `http://127.0.0.1:${PORT}/agent/`

function findBrowserExecutable() {
  const candidates = [
    process.env.PUPPETEER_EXECUTABLE_PATH,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
    '/usr/bin/microsoft-edge',
  ].filter(Boolean)
  return candidates.find(item => fs.existsSync(item))
}

function startVite() {
  const viteBin = path.join(AGENT_DIR, 'node_modules', 'vite', 'bin', 'vite.js')
  const child = spawn(process.execPath, [viteBin, '--host', '127.0.0.1', '--port', String(PORT), '--strictPort'], {
    cwd: AGENT_DIR,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  child.stdout.on('data', chunk => process.stdout.write('[agent-vite] ' + chunk.toString()))
  child.stderr.on('data', chunk => process.stderr.write('[agent-vite] ' + chunk.toString()))
  return child
}

async function waitForServer(child) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < 60000) {
    if (child.exitCode !== null) throw new Error(`agent console vite exited with code ${child.exitCode}`)
    try {
      const res = await fetch(BASE_URL)
      if (res.ok) return
    } catch { /* non-critical: dev server may still be starting */ }
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  throw new Error('agent console vite server did not become ready')
}

function jsonResponse(data, status = 200) {
  return {
    status,
    contentType: 'application/json; charset=utf-8',
    body: JSON.stringify(data),
  }
}

function ok(data) {
  return jsonResponse({ ok: true, ...data })
}

function mockAgentConfig() {
  return ok({
    mode: 'confirm',
    config: {
      version: 'smoke',
      dangerousPolicy: 'confirm',
      channels: {
        qq: { enabled: false, tools: {} },
        dashboard: { enabled: true, tools: { calculator: true } },
      },
      autoRoute: { qq: { enabled: false }, dashboard: { enabled: false } },
      enabledSkills: [],
      readFileRoots: ['mock-workspace'],
      persona: { dashboardPersona: '测试人格', qqInheritChatPersona: true },
      queue: { maxGlobal: 2, maxPerChannel: 1, maxPendingPerUser: 1, timeoutMs: 30000 },
      planMode: { enabled: true },
      cron: { enabled: false },
      push: { enabled: false, dailyLimit: 0 },
      memory: { adminOnly: true },
    },
    tools: [{ name: 'calculator', description: '计算器', dangerous: false, external: false, defaultChannels: ['dashboard'], qqEnabled: false, dashboardEnabled: true }],
    stats: { total: 0, byChannel: {}, recent: [], byToolDetail: {}, successRate: 100, avgDurationMs: 0, totalTokens: 0 },
    skills: [],
    personas: [{ name: '测试人格', description: 'smoke persona' }],
    effectiveReadRoots: ['mock-workspace'],
  })
}

/** Mocks access/admin gates while enforcing the backend's access-token contract. */
async function installApiMock(page, state) {
  await page.setRequestInterception(true)
  page.on('request', async request => {
    const url = new URL(request.url())
    if (!url.pathname.startsWith('/dashboard/api')) return request.continue()
    const pathname = url.pathname.replace('/dashboard/api', '') || '/'
    const method = request.method()
    state.requests.push(`${method} ${pathname}`)
    let response
    if (method === 'GET' && pathname === '/agent/config') {
      state.configRequests += 1
      response = state.accessRequired
        ? jsonResponse({ ok: false, code: 'AUTH_REQUIRED', message: 'login required' }, 401)
        : state.configRequests === 1 || state.adminExpired
        ? jsonResponse({ ok: false, code: 'ADMIN_REQUIRED', message: '需要管理员密码' }, 403)
        : mockAgentConfig()
    } else if (method === 'POST' && pathname === '/admin/verify') {
      state.adminVerifyRequests += 1
      state.adminExpired = false
      response = request.headers().authorization === 'Bearer smoke-access-token'
        ? ok({ token: 'smoke-admin-token' })
        : jsonResponse({ ok: false, code: 'AUTH_REQUIRED', message: 'login required' }, 401)
    } else if (method === 'POST' && pathname === '/agent/chat') {
      state.chatPayloads.push(JSON.parse(request.postData()))
      response = ok({ async: true, taskId: 'smoke-task', status: 'accepted', message: '后台处理中' })
    } else if (method === 'GET' && pathname === '/agent/tasks/smoke-task') {
      state.taskPollRequests += 1
      const done = !state.taskNeverCompletes && state.taskPollRequests >= 2
      response = ok({ task: { id: 'smoke-task', status: done ? 'done' : 'running', result: { ok: true, reply: done ? '703' : '', pendingId: null, toolCalls: done ? 1 : 0, warnings: [] } } })
    } else if (method === 'GET' && pathname === '/tools/pending') {
      response = ok({ pending: state.approvalPending ? [{ id: 'approval-smoke', toolName: 'calculator', argsSummary: '隔离审批', channel: 'dashboard', channelKey: 'dashboard', userId: 'smoke' }] : [] })
    } else if (method === 'POST' && pathname === '/agent/confirm') {
      state.approvalPending = false
      response = ok({ reply: '隔离审批已执行' })
    } else if (method === 'GET' && pathname === '/agent/sessions') {
      response = ok({ sessions: [] })
    } else if (method === 'GET' && pathname === '/agent/stats') {
      response = state.adminExpired ? jsonResponse({ ok: false, code: 'ADMIN_REQUIRED' }, 403)
        : ok({ stats: { total: 0, byToolDetail: {}, successRate: 100, avgDurationMs: 0, totalTokens: 0 } })
      if (state.holdStats) {
        state.holdStats = false
        state.releaseStats = () => request.respond(response)
        return
      }
    } else if (method === 'GET' && pathname === '/agent/queue') {
      response = ok({ queue: { activeCount: 0, waitingCount: 0, timeoutCount: 0 } })
    } else if (method === 'GET' && pathname === '/agent/shell-guard') {
      response = ok({ ruleCount: 0, categories: [] })
    } else if (method === 'GET' && pathname === '/agent/plans') {
      response = ok({ plans: [] })
    } else if (method === 'POST' && pathname === '/agent/plans') {
      response = ok({ plan: { id: 'smoke-plan' } })
    } else if (method === 'POST' && pathname === '/agent/plans/smoke-plan/resume') {
      response = ok({ reply: '隔离计划已启动' })
    } else if (method === 'GET' && pathname === '/agent/crons') {
      response = ok({ crons: [], history: [] })
    } else if (method === 'GET' && pathname === '/agent/push-log') {
      response = ok({ log: [] })
    } else if (method === 'GET' && pathname === '/agent/env') {
      response = ok({ runtime: { provider: 'mock', model: state.envModel, apiKeyConfigured: true, searchEnabled: false }, env: [] })
      if (state.holdEnv) {
        state.holdEnv = false
        // Keep the mocked response pending without blocking Puppeteer's request listeners.
        state.releaseEnv = () => request.respond(response).catch(() => { /* The old fetch was cancelled on session change. */ })
        return
      }
    } else if (method === 'GET' && pathname === '/agent/personas') {
      response = ok({ personas: [{ name: '测试人格', description: 'smoke persona' }], persona: { dashboardPersona: '测试人格', qqInheritChatPersona: true } })
    } else {
      response = ok({})
    }
    await request.respond(response)
  })
}

async function waitForText(page, text, timeout = 8000) {
  await page.waitForFunction(value => document.body && document.body.innerText.includes(value), { timeout }, text)
}

/** Navigates the visible workspace without bypassing a page's effects. */
async function selectTab(page, label) {
  await page.evaluate(value => [...document.querySelectorAll('nav button')].find(button => button.textContent.trim() === value).click(), label)
}

/** Bounds the request set of a user interaction once the local fixture is idle. */
async function assertPageRequests(page, state, expected, operate) {
  const start = state.requests.length
  await operate()
  await page.waitForNetworkIdle({ idleTime: 120 })
  assert.deepEqual(state.requests.slice(start).sort(), expected.slice().sort())
}

/** Checks page entry, manual refresh and write-specific request fan-out. */
async function testScopedWorkspaceReads(page, state) {
  const statistics = ['GET /agent/sessions', 'GET /agent/stats', 'GET /agent/queue']
  await assertPageRequests(page, state, statistics, () => selectTab(page, '智能体统计'))
  await assertPageRequests(page, state, ['GET /agent/config', ...statistics], () => page.click('.top-actions button:last-child'))
  await selectTab(page, '安全')
  await page.waitForNetworkIdle({ idleTime: 120 })
  const initialStats = state.requests.filter(entry => entry === 'GET /agent/stats').length
  state.holdStats = true
  const slowStats = page.waitForRequest(request => new URL(request.url()).pathname === '/dashboard/api/agent/stats')
  await selectTab(page, '智能体统计')
  await slowStats
  await selectTab(page, '安全')
  await selectTab(page, '智能体统计')
  await page.waitForFunction(() => document.querySelector('.workspace h2')?.textContent === '智能体统计')
  assert.equal(state.requests.filter(entry => entry === 'GET /agent/stats').length, initialStats + 1)
  await state.releaseStats()
  await page.waitForNetworkIdle({ idleTime: 120 })
  await assertPageRequests(page, state, ['GET /agent/plans'], () => selectTab(page, '计划'))
  await page.type('input[placeholder="多步骤目标"]', '隔离计划')
  await assertPageRequests(page, state, ['POST /agent/plans', 'POST /agent/plans/smoke-plan/resume', 'GET /agent/plans'], async () => {
    await page.click('.inline-form button')
    await waitForText(page, '隔离计划已启动')
  })
  state.approvalPending = true
  await assertPageRequests(page, state, ['GET /tools/pending', 'GET /agent/push-log'], () => selectTab(page, '收件箱'))
  await assertPageRequests(page, state, ['POST /agent/confirm', 'GET /tools/pending', 'GET /agent/push-log', 'GET /agent/queue'], async () => {
    await page.click('.approval-card button')
    await waitForText(page, '隔离审批已执行')
  })
  state.adminExpired = true
  const before = state.configRequests
  await selectTab(page, '智能体统计')
  await waitForText(page, '管理员密码已过期')
  assert.equal(state.configRequests, before + 1)
  await page.type('input[placeholder="管理员密码"]', 'smoke-admin-password')
  await page.click('.admin-dialog-card button[type="submit"]')
  await page.waitForSelector('.metric-grid')
  await page.waitForNetworkIdle({ idleTime: 120 })
  assert.equal(state.adminExpired, false)
}

/** Delivers a delayed old-account response after an authenticated session switch. */
async function testStaleWorkspaceResponse(page, state) {
  state.envModel = 'stale-model'
  state.holdEnv = true
  const oldRequest = page.waitForRequest(request => new URL(request.url()).pathname === '/dashboard/api/agent/env')
  await selectTab(page, '环境变量')
  await oldRequest
  assert.equal(typeof state.releaseEnv, 'function')
  state.envModel = 'current-model'
  await page.evaluate(() => {
    localStorage.setItem('dashboard_server_token', JSON.stringify({ token: 'next-smoke-admin', expires: Date.now() + 3600000 }))
    window.dispatchEvent(new StorageEvent('storage', { key: 'dashboard_server_token' }))
  })
  await waitForText(page, 'current-model')
  await state.releaseEnv()
  await page.waitForNetworkIdle({ idleTime: 120 })
  assert.equal(await page.evaluate(() => document.body.innerText.includes('stale-model')), false)
  await selectTab(page, '聊天')
  await page.waitForSelector('textarea')
}

// --- Clipboard images ---

/** Sends a Ctrl chord through Puppeteer's separate modifier/key APIs. */
async function controlKey(page, key) {
  await page.keyboard.down('Control')
  try { await page.keyboard.press(key) } finally { await page.keyboard.up('Control') }
}

/** Dispatches file clipboard events to exercise mixed and invalid batches in the real composer. */
async function pasteFiles(page, { count = 1, type = 'image/png', text = '', size = 0 } = {}) {
  await page.evaluate(({ count, type, text, size }) => {
    const clipboard = new DataTransfer()
    const bytes = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII='), c => c.charCodeAt(0))
    for (let i = 0; i < count; i++) clipboard.items.add(new File([size ? new Uint8Array(size) : bytes], `paste-${i}.png`, { type }))
    if (text) clipboard.setData('text/plain', text)
    document.querySelector('textarea').dispatchEvent(new ClipboardEvent('paste', { clipboardData: clipboard, bubbles: true, cancelable: true }))
  }, { count, type, text, size })
}

/** Verifies native Ctrl+V, previews/removal, validation, image-only send and safe remembered history. */
async function testImageClipboard(page, state) {
  await page.evaluate(() => {
    const label = [...document.querySelectorAll('.thinking-toggle')].find(item => item.textContent.includes('记住本机历史'))
    if (!label.querySelector('input').checked) label.click()
  })
  await page.waitForFunction(() => localStorage.getItem('agent_console_remember_history') === '1')
  await page.evaluate(() => navigator.clipboard.writeText('普通文字粘贴'))
  await page.click('textarea')
  await controlKey(page, 'v')
  await page.waitForFunction(() => document.querySelector('textarea').value === '普通文字粘贴')
  await controlKey(page, 'a')
  await page.keyboard.press('Backspace')
  await page.evaluate(async () => {
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = 64
    const ctx = canvas.getContext('2d')
    ctx.fillStyle = '#f97316'
    ctx.fillRect(0, 0, 64, 64)
    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'))
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })])
  })
  await controlKey(page, 'v')
  await page.waitForFunction(() => document.querySelectorAll('.composer-image img').length === 1 && document.querySelector('.composer-image img').naturalWidth === 64)
  await pasteFiles(page, { text: '图片说明' })
  await page.waitForFunction(() => document.querySelectorAll('.composer-image').length === 2 && document.querySelector('textarea').value === '图片说明')
  await page.click('button[aria-label="移除图片 2"]')
  await page.waitForFunction(() => document.querySelectorAll('.composer-image').length === 1)
  const outDir = path.join(ROOT, 'tmp', 'workspace', 'agent-console-images')
  fs.mkdirSync(outDir, { recursive: true })
  await page.screenshot({ path: path.join(outDir, 'paste-preview.png'), fullPage: true })
  await pasteFiles(page, { count: 4 })
  await waitForText(page, '最多可附带 4 张图片')
  await pasteFiles(page, { type: 'image/svg+xml' })
  await waitForText(page, '仅支持 PNG、JPEG、WebP 和 GIF 图片')
  await pasteFiles(page, { size: 5 * 1024 * 1024 })
  await waitForText(page, '图片总大小不能超过 4 MB')
  if (await page.$$eval('.composer-image', items => items.length) !== 1) throw new Error('invalid image batch changed the existing draft')
  await page.click('textarea')
  await controlKey(page, 'a')
  await page.keyboard.press('Backspace')
  if (await page.$eval('.composer-actions button', button => button.disabled)) throw new Error('image-only send is disabled')
  await page.click('.composer-actions button')
  await page.waitForFunction(() => document.querySelectorAll('.message.user .message-images img').length === 1 && document.querySelector('.composer-actions button').textContent === '发送')
  const sent = state.chatPayloads.at(-1)
  if (sent.message !== '请查看图片。' || sent.images?.length !== 1 || !sent.images[0].startsWith('data:image/png;base64,')) throw new Error('clipboard image did not reach the chat request')
  // Remembered history keeps attachment counts without exhausting Web Storage with binary data.
  await page.waitForFunction(() => localStorage.getItem('agent_console_history:测试人格')?.includes('imageCount'))
  if (await page.evaluate(() => localStorage.getItem('agent_console_history:测试人格').includes('data:image/'))) throw new Error('image bytes leaked into localStorage history')
  await page.screenshot({ path: path.join(outDir, 'sent-image.png'), fullPage: true })
  await page.type('textarea', '继续看图')
  await page.click('.composer-actions button')
  await page.waitForFunction(() => document.querySelector('.composer-actions button').textContent === '发送')
  const followup = state.chatPayloads.at(-1)
  if (!followup.history.some(item => item.images?.[0] === sent.images[0])) throw new Error('follow-up omitted the recent image context')
}

/** Exercises admin reauthentication and expired-access login guidance in a real browser. */
async function main() {
  const browserPath = findBrowserExecutable()
  if (!browserPath) throw new Error('No Chrome/Edge executable found. Set PUPPETEER_EXECUTABLE_PATH to run agent console smoke.')
  const vite = startVite()
  let browser = null
  const consoleErrors = []
  const responseErrors = []
  const state = { configRequests: 0, adminVerifyRequests: 0, accessRequired: false, taskPollRequests: 0, taskNeverCompletes: false,
    chatPayloads: [], requests: [], envModel: 'mock-model' }
  try {
    await waitForServer(vite)
    browser = await puppeteer.launch({
      executablePath: browserPath,
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    })
    const page = await browser.newPage()
    await browser.defaultBrowserContext().overridePermissions(new URL(BASE_URL).origin, ['clipboard-read', 'clipboard-write', 'clipboard-sanitized-write'])
    await installApiMock(page, state)
    page.on('response', response => {
      const status = response.status()
      if (status < 400) return
      const pathname = new URL(response.url()).pathname
      if ([401, 403].includes(status) && ['/dashboard/api/agent/config', '/dashboard/api/agent/stats'].includes(pathname)) return
      if (status === 404 && pathname.endsWith('/favicon.ico')) return
      responseErrors.push(`${status} ${response.url()}`)
    })
    page.on('console', msg => {
      const text = msg.text()
      if (/Failed to load resource: the server responded with a status of (401|403|404)/.test(text)) return
      if (msg.type() === 'error') consoleErrors.push(text)
    })
    page.on('pageerror', error => consoleErrors.push(error.message))
    await page.setViewport({ width: 1440, height: 1000, deviceScaleFactor: 1 })
    await page.evaluateOnNewDocument(() => {
      localStorage.setItem('dashboard_server_token', JSON.stringify({ token: 'stale-smoke-token', expires: Date.now() + 3600000 }))
      localStorage.setItem('dashboard_token', 'smoke-access-token')
    })
    await page.goto(BASE_URL, { waitUntil: 'networkidle0' })
    await waitForText(page, '管理员密码已过期')
    await waitForText(page, '请重新输入管理员密码以继续操作。')
    assert.deepEqual(state.requests, ['GET /agent/config'])
    await page.type('input[placeholder="管理员密码"]', 'smoke-admin-password')
    await Promise.all([
      page.waitForFunction(() => !document.querySelector('.admin-dialog-card'), { timeout: 8000 }),
      page.click('.admin-dialog-card button[type="submit"]'),
    ])
    await waitForText(page, '莲莲 Agent')
    await waitForText(page, '聊天')
    await page.waitForSelector('textarea')
    await page.waitForNetworkIdle({ idleTime: 120 })
    assert.deepEqual(state.requests, ['GET /agent/config', 'POST /admin/verify', 'GET /agent/config', 'GET /agent/personas'])
    await page.waitForFunction(() => !document.querySelector('.admin-dialog-card'), { timeout: 8000 })
    if (state.configRequests < 2) throw new Error(`expected config refresh after admin verify, got ${state.configRequests}`)
    if (state.adminVerifyRequests !== 1) throw new Error(`expected one admin verify request, got ${state.adminVerifyRequests}`)
    await testScopedWorkspaceReads(page, state)
    await testStaleWorkspaceResponse(page, state)
    await page.waitForNetworkIdle({ idleTime: 120 })
    await assertPageRequests(page, state, ['POST /agent/chat', 'GET /agent/tasks/smoke-task', 'GET /agent/tasks/smoke-task'], async () => {
      await page.type('textarea', '37*19')
      await page.click('.composer-actions button')
      await waitForText(page, '703')
    })
    if (state.taskPollRequests !== 2) throw new Error(`expected task completion polling, got ${state.taskPollRequests}`)
    assert.deepEqual(await page.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith('agent_console_history'))), [])
    await testImageClipboard(page, state)
    state.taskNeverCompletes = true
    await page.type('textarea', '继续计算')
    await page.click('.composer-actions button')
    await page.waitForFunction(() => document.querySelector('.composer-actions button')?.textContent === '发送中')
    await page.waitForResponse(response => response.url().includes('/agent/tasks/smoke-task'))
    await page.evaluate(() => [...document.querySelectorAll('nav button')].find(button => button.textContent.trim() === '环境变量').click())
    await waitForText(page, '环境变量')
    const pollsAfterNavigation = state.taskPollRequests
    await new Promise(resolve => setTimeout(resolve, 1200))
    if (state.taskPollRequests !== pollsAfterNavigation) throw new Error('task polling continued after leaving chat')
    state.accessRequired = true
    await page.reload({ waitUntil: 'networkidle0' })
    await waitForText(page, '请先登录 Dashboard，再进入 Agent 工作台。')
    const loginTarget = await page.$eval('.gate-panel a', link => link.getAttribute('href'))
    if (loginTarget !== '/dashboard/') throw new Error(`unexpected Dashboard login target: ${loginTarget}`)
    if (responseErrors.length) throw new Error('Browser response errors:\n' + responseErrors.join('\n'))
    if (consoleErrors.length) throw new Error('Browser console errors:\n' + consoleErrors.join('\n'))
    console.log('agent console admin smoke passed')
  } catch (error) {
    console.error('Recent mocked Agent requests:', state.requests.slice(-24).join(', '))
    if (browser) {
      const pages = await browser.pages()
      const page = pages[pages.length - 1]
      if (page) {
        const out = path.join(ROOT, 'tmp', 'workspace', 'agent-console-admin-smoke-failure.png')
        fs.mkdirSync(path.dirname(out), { recursive: true })
        await page.screenshot({ path: out, fullPage: true }).catch(() => {})
        console.error(`failure screenshot: ${out}`)
      }
    }
    throw error
  } finally {
    if (browser) await browser.close()
    vite.kill()
  }
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})
