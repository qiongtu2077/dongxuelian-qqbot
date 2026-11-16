const fs = require('fs')
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
    let response
    if (method === 'GET' && pathname === '/agent/config') {
      state.configRequests += 1
      response = state.accessRequired
        ? jsonResponse({ ok: false, code: 'AUTH_REQUIRED', message: 'login required' }, 401)
        : state.configRequests === 1
        ? jsonResponse({ ok: false, code: 'ADMIN_REQUIRED', message: '需要管理员密码' }, 403)
        : mockAgentConfig()
    } else if (method === 'POST' && pathname === '/admin/verify') {
      state.adminVerifyRequests += 1
      response = request.headers().authorization === 'Bearer smoke-access-token'
        ? ok({ token: 'smoke-admin-token' })
        : jsonResponse({ ok: false, code: 'AUTH_REQUIRED', message: 'login required' }, 401)
    } else if (method === 'POST' && pathname === '/agent/chat') {
      response = ok({ async: true, taskId: 'smoke-task', status: 'accepted', message: '后台处理中' })
    } else if (method === 'GET' && pathname === '/agent/tasks/smoke-task') {
      state.taskPollRequests += 1
      const done = !state.taskNeverCompletes && state.taskPollRequests >= 2
      response = ok({ task: { id: 'smoke-task', status: done ? 'done' : 'running', result: { ok: true, reply: done ? '703' : '', pendingId: null, toolCalls: done ? 1 : 0, warnings: [] } } })
    } else if (method === 'GET' && pathname === '/tools/pending') {
      response = ok({ pending: [] })
    } else if (method === 'GET' && pathname === '/agent/sessions') {
      response = ok({ sessions: [] })
    } else if (method === 'GET' && pathname === '/agent/stats') {
      response = ok({ stats: { total: 0, byToolDetail: {}, successRate: 100, avgDurationMs: 0, totalTokens: 0 } })
    } else if (method === 'GET' && pathname === '/agent/queue') {
      response = ok({ queue: { activeCount: 0, waitingCount: 0, timeoutCount: 0 } })
    } else if (method === 'GET' && pathname === '/agent/shell-guard') {
      response = ok({ ruleCount: 0, categories: [] })
    } else if (method === 'GET' && pathname === '/agent/plans') {
      response = ok({ plans: [] })
    } else if (method === 'GET' && pathname === '/agent/crons') {
      response = ok({ crons: [], history: [] })
    } else if (method === 'GET' && pathname === '/agent/push-log') {
      response = ok({ log: [] })
    } else if (method === 'GET' && pathname === '/agent/env') {
      response = ok({ runtime: { provider: 'mock', model: 'mock-model', apiKeyConfigured: true, searchEnabled: false }, env: [] })
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

/** Exercises admin reauthentication and expired-access login guidance in a real browser. */
async function main() {
  const browserPath = findBrowserExecutable()
  if (!browserPath) throw new Error('No Chrome/Edge executable found. Set PUPPETEER_EXECUTABLE_PATH to run agent console smoke.')
  const vite = startVite()
  let browser = null
  const consoleErrors = []
  const responseErrors = []
  const state = { configRequests: 0, adminVerifyRequests: 0, accessRequired: false, taskPollRequests: 0, taskNeverCompletes: false }
  try {
    await waitForServer(vite)
    browser = await puppeteer.launch({
      executablePath: browserPath,
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    })
    const page = await browser.newPage()
    await installApiMock(page, state)
    page.on('response', response => {
      const status = response.status()
      if (status < 400) return
      const pathname = new URL(response.url()).pathname
      if ([401, 403].includes(status) && pathname === '/dashboard/api/agent/config') return
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
    await page.type('input[placeholder="管理员密码"]', 'smoke-admin-password')
    await Promise.all([
      page.waitForFunction(() => !document.querySelector('.admin-dialog-card'), { timeout: 8000 }),
      page.click('.admin-dialog-card button[type="submit"]'),
    ])
    await waitForText(page, '莲莲 Agent')
    await waitForText(page, '聊天')
    await page.waitForFunction(() => !document.querySelector('.admin-dialog-card'), { timeout: 8000 })
    if (state.configRequests < 2) throw new Error(`expected config refresh after admin verify, got ${state.configRequests}`)
    if (state.adminVerifyRequests !== 1) throw new Error(`expected one admin verify request, got ${state.adminVerifyRequests}`)
    await page.type('textarea', '37*19')
    await page.click('.composer-actions button')
    await waitForText(page, '703')
    if (state.taskPollRequests !== 2) throw new Error(`expected task completion polling, got ${state.taskPollRequests}`)
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
    if (browser) {
      const pages = await browser.pages()
      const page = pages[pages.length - 1]
      if (page) {
        const out = path.join(ROOT, 'tmp', 'agent-console-admin-smoke-failure.png')
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
