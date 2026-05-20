const fs = require('fs')
const path = require('path')
const { spawn } = require('child_process')
const puppeteer = require('puppeteer-core')

const ROOT = path.resolve(__dirname, '..')
const FRONTEND_DIR = path.join(ROOT, 'packages', 'koishi-plugin-dashboard', 'frontend')
const PORT = Number(process.env.DASHBOARD_SMOKE_PORT || 5177)
const BASE_URL = `http://127.0.0.1:${PORT}/`
const LIVE_URL = process.env.DASHBOARD_SMOKE_LIVE_URL || ''
const LIVE_PASSWORD = process.env.DASHBOARD_SMOKE_PASSWORD || ''
const LIVE_ADMIN_PASSWORD = process.env.DASHBOARD_SMOKE_ADMIN_PASSWORD || ''

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
  const viteBin = path.join(FRONTEND_DIR, 'node_modules', 'vite', 'bin', 'vite.js')
  const child = spawn(process.execPath, [viteBin, '--host', '127.0.0.1', '--port', String(PORT), '--strictPort'], {
    cwd: FRONTEND_DIR,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  child.stdout.on('data', chunk => process.stdout.write('[vite] ' + chunk.toString()))
  child.stderr.on('data', chunk => process.stderr.write('[vite] ' + chunk.toString()))
  return child
}

async function waitForServer(child) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < 60000) {
    if (child.exitCode !== null) throw new Error(`vite exited with code ${child.exitCode}`)
    try {
      const res = await fetch(BASE_URL)
      if (res.ok) return
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  throw new Error('vite server did not become ready')
}

function svgDataUri() {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="240"><rect width="320" height="240" fill="#182033"/><text x="24" y="126" fill="#f4c430" font-size="28">LianBoard</text></svg>'
  return 'data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64')
}

function jsonResponse(data, status = 200) {
  return {
    status,
    contentType: 'application/json; charset=utf-8',
    body: JSON.stringify(data),
  }
}

const mockState = {
  voiceEnabled: false,
  voiceAssetId: '',
  clonedVoice: {
    id: 'voice_asset_a',
    personaName: '测试人格',
    displayName: '测试音色',
    description: '本地烟测样本',
    filename: 'voice_asset_a.wav',
    size: 4096,
    mtime: Date.now(),
    sampleText: '你好，这是克隆音色测试。',
  },
}

function apiMock(method, pathname, body) {
  const ok = data => jsonResponse(data)
  const writeOk = message => ok({ ok: true, message })

  if (method === 'GET' && pathname === '/status') return ok({ provider: 'deepseek', model: 'deepseek-chat' })
  if (method === 'GET' && pathname === '/providers') return ok({
    deepseek: { name: 'DeepSeek', models: [{ id: 'deepseek-chat', name: 'DeepSeek Chat' }] },
    dashscope: { name: 'DashScope', models: [{ id: 'qwen-plus', name: 'Qwen Plus', vision: false }, { id: 'qwen-vl-plus', name: 'Qwen VL', vision: true }] },
  })
  if (method === 'GET' && pathname === '/config') return ok({ provider: 'deepseek', model: 'deepseek-chat', baseUrl: '' })
  if (method === 'PUT' && pathname === '/config') return writeOk('config saved')
  if (method === 'GET' && pathname === '/fallback') return ok({
    chains: {
      chat: [{ provider: 'deepseek', model: 'deepseek-chat' }],
      vision: [{ provider: 'dashscope', model: 'qwen-vl-plus' }],
      lightweight: [],
    },
    default: {
      chat: [{ provider: 'deepseek', model: 'deepseek-chat' }],
      vision: [{ provider: 'dashscope', model: 'qwen-vl-plus' }],
      lightweight: [],
    },
  })
  if (method === 'PUT' && pathname === '/fallback') return writeOk('fallback saved')
  if (method === 'GET' && pathname === '/providers/custom') return ok([
    { id: 'mock', name: 'Mock Provider', baseURL: 'https://mock.invalid/v1', keyFile: 'mock-key.txt', models: [{ id: 'mock-chat', vision: false }] },
  ])
  if (method === 'PUT' && pathname === '/providers/custom') return writeOk('custom providers saved')

  if (method === 'GET' && pathname === '/features') return ok([
    { id: 'chat', title: '聊天', summary: '普通聊天功能', detail: '模拟功能详情', usage: '莲莲 你好', related: [] },
  ])
  if (method === 'GET' && pathname === '/commands') return ok([
    { category: '基础', commands: [{ cmd: '/help', desc: '查看帮助' }] },
  ])

  if (method === 'GET' && pathname === '/personas') {
    if (body.searchParams.get('name')) {
      return ok({ name: body.searchParams.get('name'), description: '测试详情', content: '测试人格内容', lore: 'lore-a', will: 1.2, nsfw: 'none' })
    }
    return ok([
      { name: '核心规则', type: 'core', description: '核心规则描述' },
      { name: '默认模式', type: 'mode', description: '默认模式描述' },
      { name: '测试人格', type: 'persona', description: '测试人格描述' },
    ])
  }
  if (method === 'POST' && pathname === '/personas') return writeOk('persona created')
  if (method === 'PUT' && pathname === '/personas') return writeOk('persona updated')
  if (method === 'DELETE' && pathname === '/personas') return writeOk('persona deleted')
  if (method === 'GET' && pathname === '/lore-list') return ok([{ id: 'none', description: '无' }, { id: 'lore-a', description: '测试世界观' }])
  if (method === 'GET' && pathname === '/lores') return ok([{ name: 'lore-a', description: '测试世界观', content: '世界观内容' }])
  if (method === 'POST' && pathname === '/lores') return writeOk('lore created')
  if (method === 'PUT' && pathname === '/lores') return writeOk('lore updated')
  if (method === 'DELETE' && pathname === '/lores') return writeOk('lore deleted')
  if (method === 'GET' && pathname === '/agent/tts/voices') return ok({
    builtin: ['冰糖', '茉莉'],
    personas: [
      { name: '测试人格', voice: mockState.voiceEnabled ? '__cloned__' : '冰糖', voiceAssetId: mockState.voiceEnabled ? mockState.voiceAssetId : '', style: '温柔', hasSample: true },
    ],
    clonedVoices: [{
      ...mockState.clonedVoice,
      referencedBy: mockState.voiceEnabled ? ['测试人格'] : [],
      isCurrent: mockState.voiceEnabled,
    }],
  })
  if (method === 'POST' && pathname === '/agent/tts/preview') return ok({ audio: Buffer.from('mock audio').toString('base64') })
  if (method === 'POST' && pathname === '/agent/tts/clone/rename') return writeOk('voice asset saved')
  if (method === 'POST' && pathname === '/agent/tts/clone/delete') return writeOk('voice asset deleted')
  if (method === 'PUT' && pathname === '/agent/persona/voice') {
    mockState.voiceEnabled = body.body?.voiceId === '__cloned__'
    mockState.voiceAssetId = body.body?.voiceAssetId || ''
    return writeOk('voice saved')
  }

  if (method === 'GET' && pathname === '/keys') return ok([{ file: 'ai-deepseek-key.txt', label: 'DeepSeek', exists: true, prefix: 'sk-***' }])
  if (method === 'PUT' && pathname === '/keys') return writeOk('key saved')
  if (method === 'GET' && pathname === '/keys/usage') return ok({ providers: ['deepseek'], days: [{ date: '2026-05-20', deepseek: 1234 }] })

  if (method === 'GET' && pathname === '/whitelist') return ok({
    aiWhitelist: { label: '群聊 AI 白名单', data: ['10001'] },
    userBlacklist: { label: '用户黑名单', data: [] },
    groupUserWhitelist: { label: '混合白名单', data: { groups: ['10001'], users: ['20002'] } },
  })
  if (method === 'PUT' && pathname === '/whitelist') return writeOk('whitelist saved')

  if (method === 'GET' && pathname === '/bot/status') return ok({ running: true, workers: 1, qq: '123456' })
  if (method === 'GET' && pathname === '/maintenance') return ok({ enabled: false })
  if (method === 'GET' && pathname === '/qq/token') return ok({ token: 'mock-token' })
  if (method === 'GET' && pathname === '/qq/ssh-info') return ok({ host: '127.0.0.1', user: 'root' })
  if (method === 'GET' && pathname === '/qq/selfid') return ok({ selfId: '123456' })
  if (method === 'GET' && pathname === '/throttle') return ok({ maxPerMinute: 20 })

  if (method === 'GET' && pathname === '/logging') return ok({ config: { enabled: false } })
  if (method === 'PUT' && pathname === '/logging') return writeOk('logging saved')
  if (method === 'GET' && pathname === '/bot/activity') return ok({
    entries: [{ id: 1, level: 'I', time: '12:00:00', module: 'dashboard', message: 'mock log line' }],
    total: 1,
  })

  if (method === 'GET' && pathname === '/gallery') return ok([{ id: 'img-1', name: 'mock image', url: svgDataUri(), foilStyle: '' }])
  if (method === 'PUT' && pathname === '/gallery/style') return writeOk('gallery style saved')
  if (method === 'DELETE' && pathname === '/gallery') return writeOk('gallery deleted')

  if (method === 'PUT' && pathname === '/auth/password') return writeOk('password changed')
  if (method === 'GET' && pathname === '/admin-ids') return ok({ ids: ['10000'] })

  return ok({ ok: true, message: `mocked ${method} ${pathname}` })
}

async function installApiMock(page) {
  await page.setRequestInterception(true)
  page.on('request', async request => {
    const url = new URL(request.url())
    if (!url.pathname.startsWith('/dashboard/api')) return request.continue()
    const pathname = url.pathname.replace('/dashboard/api', '') || '/'
    const method = request.method()
    let parsedBody = null
    try { parsedBody = request.postData() ? JSON.parse(request.postData()) : null } catch {}
    try {
      const response = apiMock(method, pathname, { searchParams: url.searchParams, body: parsedBody })
      const isWrite = method !== 'GET'
      if (isWrite) await new Promise(resolve => setTimeout(resolve, 80))
      await request.respond(response)
    } catch (error) {
      await request.respond(jsonResponse({ ok: false, message: error.message }, 500))
    }
  })
}

async function waitForText(page, text, timeout = 8000) {
  await page.waitForFunction(value => document.body && document.body.innerText.includes(value), { timeout }, text)
}

async function hasText(page, text) {
  return page.evaluate(value => !!(document.body && document.body.innerText.includes(value)), text)
}

async function waitForFieldValue(page, text, timeout = 8000) {
  await page.waitForFunction(value => {
    return [...document.querySelectorAll('input,textarea,select')].some(el => String(el.value || '').includes(value))
  }, { timeout }, text)
}

async function clickText(page, text, selector = 'button,a') {
  await page.waitForFunction((value, sel) => {
    return [...document.querySelectorAll(sel)].some(el => {
      const rect = el.getBoundingClientRect()
      return rect.width > 0 && rect.height > 0 && el.textContent.includes(value)
    })
  }, { timeout: 8000 }, text, selector)
  const rect = await page.evaluate((value, sel) => {
    const el = [...document.querySelectorAll(sel)].find(item => {
      const box = item.getBoundingClientRect()
      return box.width > 0 && box.height > 0 && item.textContent.includes(value)
    })
    el.scrollIntoView({ block: 'center', inline: 'center' })
    const scrolledBox = el.getBoundingClientRect()
    return { x: scrolledBox.left + scrolledBox.width / 2, y: scrolledBox.top + scrolledBox.height / 2 }
  }, text, selector)
  await new Promise(resolve => setTimeout(resolve, 80))
  await page.mouse.click(rect.x, rect.y)
}

async function ensureSidebarExpanded(page) {
  const hasExpandedNav = await page.$('.sidebar-nav .sidebar-item')
  if (hasExpandedNav) return
  await page.waitForSelector('.sidebar-toggle', { timeout: 8000 })
  await page.click('.sidebar-toggle')
  await page.waitForSelector('.sidebar-nav .sidebar-item', { timeout: 8000 })
}

async function clickSidebarTab(page, label) {
  await ensureSidebarExpanded(page)
  await page.waitForFunction(value => {
    return [...document.querySelectorAll('.sidebar-nav .sidebar-item')].some(el => {
      const rect = el.getBoundingClientRect()
      return rect.width > 0 && rect.height > 0 && el.textContent.includes(value)
    })
  }, { timeout: 8000 }, label)
  const clickTarget = value => {
    const el = [...document.querySelectorAll('.sidebar-nav .sidebar-item')].find(item => item.textContent.includes(value))
    if (!el) return false
    el.click()
    return true
  }
  const clicked = await page.evaluate(clickTarget, label)
  if (!clicked) throw new Error(`sidebar tab not found: ${label}`)
  await new Promise(resolve => setTimeout(resolve, 250))
  const active = await page.evaluate(value => {
    const labelEl = document.querySelector('.active-view-label')
    return !!(labelEl && labelEl.textContent.includes(value))
  }, label)
  if (!active) await page.evaluate(clickTarget, label)
  await page.waitForFunction(value => {
    const labelEl = document.querySelector('.active-view-label')
    return labelEl && labelEl.textContent.includes(value)
  }, { timeout: 8000 }, label)
}

async function clickButtonInCard(page, cardHeading, buttonText) {
  await page.waitForFunction((heading, text) => {
    const cards = [...document.querySelectorAll('.card')]
    return cards.some(card =>
      card.innerText.includes(heading) &&
      [...card.querySelectorAll('button')].some(button => button.textContent.includes(text))
    )
  }, { timeout: 8000 }, cardHeading, buttonText)
  const clicked = await page.evaluate((heading, text) => {
    const card = [...document.querySelectorAll('.card')].find(item => item.innerText.includes(heading))
    if (!card) return false
    const button = [...card.querySelectorAll('button')].find(item => item.textContent.includes(text))
    if (!button) return false
    button.scrollIntoView({ block: 'center', inline: 'center' })
    button.click()
    return true
  }, cardHeading, buttonText)
  if (!clicked) throw new Error(`button not found: ${cardHeading} / ${buttonText}`)
}

async function clickButtonNearText(page, blockText, buttonText) {
  await page.waitForFunction((needle, text) => {
    return [...document.querySelectorAll('button')].some(button => {
      if (!button.textContent.includes(text)) return false
      let node = button.parentElement
      while (node && node !== document.body) {
        if (node.innerText && node.innerText.includes(needle)) return true
        node = node.parentElement
      }
      return false
    })
  }, { timeout: 8000 }, blockText, buttonText)
  const clicked = await page.evaluate((needle, text) => {
    const button = [...document.querySelectorAll('button')].find(item => {
      if (!item.textContent.includes(text)) return false
      let node = item.parentElement
      while (node && node !== document.body) {
        if (node.innerText && node.innerText.includes(needle)) return true
        node = node.parentElement
      }
      return false
    })
    if (!button) return false
    button.scrollIntoView({ block: 'center', inline: 'center' })
    button.click()
    return true
  }, blockText, buttonText)
  if (!clicked) throw new Error(`button near text not found: ${blockText} / ${buttonText}`)
}

async function clickButtonByLabel(page, label) {
  await page.waitForFunction(value => {
    return [...document.querySelectorAll('button')].some(button =>
      button.getAttribute('aria-label') === value || button.getAttribute('title') === value
    )
  }, { timeout: 8000 }, label)
  const clicked = await page.evaluate(value => {
    const button = [...document.querySelectorAll('button')].find(item =>
      item.getAttribute('aria-label') === value || item.getAttribute('title') === value
    )
    if (!button) return false
    button.scrollIntoView({ block: 'center', inline: 'center' })
    button.click()
    return true
  }, label)
  if (!clicked) throw new Error(`button label not found: ${label}`)
}

async function verifyAdminIfVisible(page) {
  const visible = await hasText(page, '请输入管理员密码')
  if (!visible) return
  if (!LIVE_ADMIN_PASSWORD) throw new Error('admin dialog is visible but DASHBOARD_SMOKE_ADMIN_PASSWORD is not set')
  const inputHandle = await page.evaluateHandle(() => {
    const inputs = [...document.querySelectorAll('input')]
    return inputs.find(input => input.offsetParent && (input.placeholder || '').includes('管理员')) ||
      inputs.find(input => input.offsetParent && input.type === 'password') ||
      inputs.find(input => input.offsetParent)
  })
  const input = inputHandle.asElement()
  if (!input) throw new Error('admin password input not found')
  await input.click({ clickCount: 3 })
  await input.type(LIVE_ADMIN_PASSWORD)
  await clickText(page, '确认')
  await page.waitForFunction(() => !document.body.innerText.includes('请输入管理员密码'), { timeout: 10000 })
}

async function typePlaceholder(page, placeholder, value) {
  await page.waitForSelector(`input[placeholder="${placeholder}"], textarea[placeholder="${placeholder}"]`, { timeout: 8000 })
  const selector = `input[placeholder="${placeholder}"], textarea[placeholder="${placeholder}"]`
  await page.click(selector, { clickCount: 3 })
  await page.type(selector, value)
}

async function selectOptionValue(page, optionValue) {
  const changed = await page.evaluate(value => {
    const select = [...document.querySelectorAll('select')].find(item =>
      [...item.options].some(option => option.value === value)
    )
    if (!select) return false
    select.value = value
    select.dispatchEvent(new Event('change', { bubbles: true }))
    return true
  }, optionValue)
  if (!changed) throw new Error(`select option not found: ${optionValue}`)
}

async function runClicks(page) {
  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' })
  await page.evaluate(() => {
    localStorage.setItem('dashboard_token', 'mock-token')
    localStorage.removeItem('dashboard_deploy_unlocked')
    localStorage.removeItem('dashboard_active_tab')
    localStorage.setItem('dashboard_sidebar_expanded', 'true')
  })
  await page.reload({ waitUntil: 'networkidle0' })

  await waitForText(page, '先完成部署')
  await clickText(page, '我已部署，解锁')
  await waitForText(page, '功能介绍')

  await clickText(page, '主题：')
  await waitForText(page, '界面风格')
  await clickText(page, '昼白')
  await waitForText(page, '功能介绍')

  await clickSidebarTab(page, '指令速查')
  await waitForText(page, '/help')

  await clickSidebarTab(page, '模型配置')
  await waitForText(page, '供应商和模型')
  await selectOptionValue(page, 'dashscope')
  await clickText(page, '+ 添加供应商')
  await typePlaceholder(page, '标识', 'localmock')
  await typePlaceholder(page, '名称', 'Local Mock')
  await clickText(page, '保存自定义供应商')
  await waitForText(page, '自定义供应商已保存')
  await clickText(page, '+ 添加步骤')
  await clickText(page, '保存 聊天 Fallback')
  await waitForText(page, 'Fallback 链已保存')

  await clickSidebarTab(page, '人格实验室')
  await waitForText(page, '创建/修改人格')
  await clickText(page, '编辑')
  await waitForFieldValue(page, '测试人格内容')
  await clickText(page, '取消')
  await clickText(page, '创建人格')
  await waitForText(page, '请输入名称')
  await typePlaceholder(page, '人格名称，如：新角色', '新测试人格')
  await typePlaceholder(page, '在此编写人格的提示词...', '这是一段模拟人格提示词。')
  await clickText(page, '创建人格')
  await waitForText(page, 'persona created')
  await clickButtonInCard(page, '世界观管理', '编辑')
  await waitForFieldValue(page, '世界观内容')
  await clickText(page, '取消', 'button')
  await clickButtonInCard(page, '世界观管理', '创建')
  await waitForText(page, '请输入标识')
  await selectOptionValue(page, '测试人格')
  await page.waitForFunction(() => [...document.querySelectorAll('input')].some(input => input.value === '温柔'), { timeout: 8000 })
  await clickText(page, '试听')
  await page.waitForSelector('audio[src^="data:audio/wav;base64,"]', { timeout: 8000 })
  await waitForText(page, '已克隆音色')
  await page.waitForFunction(() => [...document.querySelectorAll('input')].some(input => input.value === '测试音色'), { timeout: 8000 })
  await Promise.all([
    page.waitForRequest(req => req.method() === 'PUT' && req.url().includes('/agent/persona/voice'), { timeout: 8000 }),
    clickButtonInCard(page, '已克隆音色', '启用'),
  ])
  await page.waitForFunction(() => [...document.querySelectorAll('select')].some(select => select.value === '__cloned__'), { timeout: 8000 })
  await page.waitForFunction(() => [...document.querySelectorAll('select')].some(select => select.value === 'voice_asset_a'), { timeout: 8000 })
  await waitForText(page, '使用：测试人格')

  await clickSidebarTab(page, 'API Keys')
  await waitForText(page, 'API Key 管理')
  await clickText(page, '编辑')
  await typePlaceholder(page, '输入新的 ai-deepseek-key.txt', 'sk-local-smoke')
  await clickText(page, '保存')
  await waitForText(page, 'Key 已更新并热加载')

  await clickSidebarTab(page, '黑白名单')
  await waitForText(page, '黑白名单管理')
  await clickText(page, '刷新全部')
  await waitForText(page, '已刷新')

  await clickSidebarTab(page, '安全设置')
  await waitForText(page, '访问密码')
  await typePlaceholder(page, '新访问密码', 'abc123')
  await clickText(page, '修改访问密码')
  await waitForText(page, 'password changed')

  await clickSidebarTab(page, '日志中心')
  await waitForText(page, 'mock log line')

  await clickSidebarTab(page, '系统状态')
  await waitForText(page, '当前供应商')
  await waitForText(page, 'deepseek')

  await clickSidebarTab(page, '莲莲图集')
  await waitForText(page, '莲莲图集')
  await clickButtonByLabel(page, '批量删除')
  await waitForText(page, '点击图片选择要删除的项目')
}

async function runLiveClicks(page) {
  if (!LIVE_PASSWORD) throw new Error('DASHBOARD_SMOKE_PASSWORD is required for live smoke')
  await page.goto(LIVE_URL, { waitUntil: 'networkidle0' })
  if (await hasText(page, '请输入访问密码以继续')) {
    await typePlaceholder(page, '密码', LIVE_PASSWORD)
    await clickText(page, '登录')
  }
  await waitForText(page, 'LianBoard 控制中心', 15000)
  if (await hasText(page, '先完成部署')) {
    await clickText(page, '我已部署，解锁')
  }
  await waitForText(page, '功能介绍', 15000)

  await ensureSidebarExpanded(page)
  await clickText(page, '主题：')
  await waitForText(page, '界面风格')
  await clickText(page, '昼白')

  await clickSidebarTab(page, '指令速查')
  await waitForText(page, '指令速查')

  await clickSidebarTab(page, '模型配置')
  await waitForText(page, '供应商和模型')
  await verifyAdminIfVisible(page)
  await selectOptionValue(page, 'dashscope').catch(() => {})
  await clickText(page, '+ 添加供应商').catch(() => {})

  await clickSidebarTab(page, '人格实验室')
  await waitForText(page, '创建/修改人格')
  await clickText(page, '编辑').catch(() => {})
  await waitForText(page, '保存修改').catch(() => {})
  await clickText(page, '取消').catch(() => {})

  await clickSidebarTab(page, 'API Keys')
  await waitForText(page, 'API Key 管理')
  await verifyAdminIfVisible(page)
  await clickText(page, '编辑').catch(() => {})
  await waitForText(page, '编辑').catch(() => {})
  await clickText(page, '取消').catch(() => {})

  await clickSidebarTab(page, '黑白名单')
  await waitForText(page, '黑白名单管理')
  await verifyAdminIfVisible(page)
  await clickText(page, '刷新全部').catch(() => {})

  await clickSidebarTab(page, '安全设置')
  await waitForText(page, '访问密码')

  await clickSidebarTab(page, '日志中心')
  await waitForText(page, '日志中心')
  await clickButtonByLabel(page, '刷新').catch(() => {})

  await clickSidebarTab(page, '系统状态')
  await waitForText(page, '当前状态')

  await clickSidebarTab(page, '莲莲图集')
  await waitForText(page, '莲莲图集')
  await clickButtonByLabel(page, '批量删除').catch(() => {})
}

async function main() {
  const browserPath = findBrowserExecutable()
  if (!browserPath) {
    throw new Error('No Chrome/Edge executable found. Set PUPPETEER_EXECUTABLE_PATH to run dashboard click smoke.')
  }

  const vite = LIVE_URL ? null : startVite()
  let browser = null
  const consoleErrors = []
  try {
    if (vite) await waitForServer(vite)
    browser = await puppeteer.launch({
      executablePath: browserPath,
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    })
    const page = await browser.newPage()
    page.on('console', msg => {
      const text = msg.text()
      if (LIVE_URL && /Failed to load resource: the server responded with a status of 403/.test(text)) return
      if (msg.type() === 'error') consoleErrors.push(text)
    })
    page.on('pageerror', error => consoleErrors.push(error.message))
    await page.setViewport({ width: 1440, height: 1100, deviceScaleFactor: 1 })
    if (LIVE_URL) {
      await runLiveClicks(page)
    } else {
      await installApiMock(page)
      await runClicks(page)
    }
    if (consoleErrors.length) throw new Error('Browser console errors:\n' + consoleErrors.join('\n'))
    console.log(LIVE_URL ? 'dashboard live click smoke passed' : 'dashboard click smoke passed')
  } catch (error) {
    if (browser) {
      const pages = await browser.pages()
      const page = pages[pages.length - 1]
      if (page) {
        const out = path.join(ROOT, 'tmp', 'dashboard-click-smoke-failure.png')
        fs.mkdirSync(path.dirname(out), { recursive: true })
        await page.screenshot({ path: out, fullPage: true }).catch(() => {})
        console.error(`failure screenshot: ${out}`)
      }
    }
    throw error
  } finally {
    if (browser) await browser.close().catch(() => {})
    if (vite) vite.kill()
  }
}

main().catch(error => {
  console.error(error.stack || error.message || error)
  process.exit(1)
})
