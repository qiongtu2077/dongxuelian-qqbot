// 受控浏览器工具：提供最小浏览器动作，默认关闭且按危险工具策略确认。
const fs = require('fs')
const path = require('path')
const dns = require('dns/promises')
const net = require('net')
const { DATA_DIR } = require('../../constants')
const { assertExistingAgentPathInsideRoots } = require('../path-guard')
const { rankSearchCandidates, formatSearchResults, buildSearchFailureText } = require('../search-results')

let browser = null
let page = null
let currentUrl = ''
let cleanupRegistered = false
let idleTimer = null
let launchPromise = null
let closePromise = null
let actionQueue = Promise.resolve()
let screenshotCounter = 0
let networkLog = []
let consoleLog = []
const IDLE_CLOSE_MS = parseBrowserPositiveInt(process.env.DONGXUELIAN_BROWSER_IDLE_MS, 60 * 1000, 10 * 1000, 5 * 60 * 1000)
const BROWSER_MIN_AVAILABLE_MB = parseBrowserPositiveInt(process.env.DONGXUELIAN_BROWSER_MIN_MEM_MB, 900, 256, 8192)
const SEARCH_NAVIGATION_TIMEOUT_MS = 12000
const SEARCH_SELECTOR_TIMEOUT_MS = 3000
const MAX_BROWSER_UPLOAD_FILE_BYTES = parseBrowserPositiveInt(process.env.DONGXUELIAN_BROWSER_UPLOAD_MAX_MB, 16, 1, 256) * 1024 * 1024
const MAX_BROWSER_OUTPUT_FILE_BYTES = parseBrowserPositiveInt(process.env.DONGXUELIAN_BROWSER_OUTPUT_MAX_MB, 24, 1, 256) * 1024 * 1024
const BLOCKED_RESOURCE_TYPES = new Set(['image', 'media', 'font'])
const BLOCKED_HOST_RE = /(?:doubleclick|googlesyndication|google-analytics|googletagmanager|adservice|adsystem|bat\.bing|clarity\.ms|facebook\.net|scorecardresearch|cnzz|hm\.baidu|pos\.baidu)/i
const PRIVATE_IP_RE = /^(127\.|10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|0\.|169\.254\.|::1$|fc|fd|fe80)/

function parseBrowserPositiveInt(value, fallback, min, max) {
  const parsed = parseInt(value, 10)
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(min, Math.min(max, parsed))
}

function readLinuxMemAvailableMb() {
  if (process.platform !== 'linux') return null
  try {
    const raw = fs.readFileSync('/proc/meminfo', 'utf8')
    const match = /^MemAvailable:\s+(\d+)\s+kB/m.exec(raw)
    return match ? Math.floor(Number(match[1]) / 1024) : null
  } catch {
    return null
  }
}

function assertEnoughMemoryForBrowser() {
  if (/^(1|true|yes|on)$/i.test(String(process.env.DONGXUELIAN_BROWSER_FORCE || '').trim())) return
  const availableMb = readLinuxMemAvailableMb()
  if (availableMb === null || availableMb >= BROWSER_MIN_AVAILABLE_MB) return
  throw new Error(`可用内存不足（约 ${availableMb}MB），已拒绝启动 Chromium；需要至少 ${BROWSER_MIN_AVAILABLE_MB}MB。可先释放内存，或确认风险后设置 DONGXUELIAN_BROWSER_FORCE=1。`)
}

async function enableBrowserRequestGuards(targetPage) {
  if (!targetPage || typeof targetPage.setRequestInterception !== 'function' || typeof targetPage.on !== 'function') return
  await targetPage.setRequestInterception(true).catch(() => {})
  targetPage.on('request', req => {
    try {
      const url = req.url()
      const type = req.resourceType()
      if (BLOCKED_RESOURCE_TYPES.has(type) || BLOCKED_HOST_RE.test(url)) return req.abort()
      return req.continue()
    } catch {
      try { req.continue() } catch {}
    }
  })
  await targetPage.evaluate(() => {
    delete window.fetch
    delete window.XMLHttpRequest
    delete window.WebSocket
    delete window.EventSource
    delete window.sendBeacon
    Object.defineProperty(navigator, 'sendBeacon', { value: () => false, configurable: false })
  }).catch(() => {})
}

function registerCleanup() {
  if (cleanupRegistered) return
  cleanupRegistered = true
  process.once('beforeExit', () => { closeBrowser().catch(() => {}) })
  process.once('exit', () => {
    page = null
    browser = null
    currentUrl = ''
  })
}

function refreshIdleTimer() {
  if (idleTimer) clearTimeout(idleTimer)
  if (!browser) return
  idleTimer = setTimeout(() => { closeBrowser().catch(() => {}) }, IDLE_CLOSE_MS)
  if (idleTimer.unref) idleTimer.unref()
}

function findBrowser() {
  const envPath = process.env.DONGXUELIAN_BROWSER_PATH || process.env.CHROME_PATH || process.env.PUPPETEER_EXECUTABLE_PATH
  const candidates = [
    envPath,
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    '/snap/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
  ].filter(Boolean)
  for (const item of candidates) {
    try { if (fs.existsSync(item)) return item } catch {}
  }
  return null
}

function isPrivateHostname(hostname = '') {
  const host = String(hostname || '').toLowerCase()
  return host === 'localhost' || host.endsWith('.localhost') || host === '0.0.0.0'
}

function isPrivateIp(ip = '') {
  if (!ip) return true
  if (ip === '::1' || ip.toLowerCase().startsWith('fe80:') || ip.toLowerCase().startsWith('fc') || ip.toLowerCase().startsWith('fd')) return true
  if (!net.isIP(ip)) return false
  const parts = ip.split('.').map(Number)
  if (parts.length !== 4 || parts.some(n => !Number.isFinite(n))) return false
  const [a, b] = parts
  return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224
}

async function validateUrl(raw) {
  const value = String(raw || '').trim()
  if (!value) throw new Error('url 不能为空')
  const parsed = new URL(value)
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('只允许 http/https URL')
  if (parsed.username || parsed.password) throw new Error('URL 不允许包含用户名或密码')
  if (isPrivateHostname(parsed.hostname) || isPrivateIp(parsed.hostname)) throw new Error('拒绝访问本机、内网或保留地址')
  try {
    const records = await dns.lookup(parsed.hostname, { all: true, verbatim: false })
    if (records.some(item => isPrivateIp(item.address))) throw new Error('拒绝访问解析到内网的地址')
  } catch (e) {
    if (/拒绝访问/.test(e.message)) throw e
  }
  return parsed.toString()
}

async function launchPage() {
  assertEnoughMemoryForBrowser()
  const puppeteer = require('puppeteer-core')
  const executablePath = findBrowser()
  if (!executablePath) throw new Error('未找到 Chrome/Edge/Chromium，请设置 DONGXUELIAN_BROWSER_PATH')
  const launchArgs = [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--disable-gpu',
    '--disable-extensions',
    '--disable-background-networking',
    '--disable-sync',
    '--disable-default-apps',
    '--disable-component-update',
    '--disable-features=Translate,BackForwardCache,AcceptCHFrame,MediaRouter,OptimizationHints',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-renderer-backgrounding',
    '--js-flags=--max-old-space-size=96',
  ]
  if (/^(1|true|yes|on)$/i.test(String(process.env.DONGXUELIAN_BROWSER_SINGLE_PROCESS || '').trim())) launchArgs.push('--single-process')
  browser = await puppeteer.launch({
    executablePath,
    headless: 'new',
    args: launchArgs,
  })
  registerCleanup()
  page = await browser.newPage()
  await enableBrowserRequestGuards(page)
  page.on('console', msg => {
    consoleLog.unshift({ type: msg.type(), text: msg.text().slice(0, 300), at: Date.now() })
    if (consoleLog.length > 80) consoleLog.length = 80
  })
  page.on('requestfinished', req => {
    const res = req.response()
    if (res) {
      const remote = res.remoteAddress()
      if (remote && remote.ip && PRIVATE_IP_RE.test(remote.ip)) {
        page.goto('about:blank').catch(() => {})
        return
      }
    }
    networkLog.unshift({ method: req.method(), url: req.url().slice(0, 300), status: res ? res.status() : 0, at: Date.now() })
    if (networkLog.length > 120) networkLog.length = 120
  })
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36')
  await page.setViewport({ width: 1024, height: 700 })
  page.setDefaultTimeout(12000)
  page.setDefaultNavigationTimeout(20000)
  currentUrl = page.url()
  refreshIdleTimer()
  return page
}

async function ensurePage() {
  if (closePromise) await closePromise
  if (page && !page.isClosed()) {
    refreshIdleTimer()
    return page
  }
  if (!launchPromise) {
    launchPromise = launchPage().finally(() => { launchPromise = null })
  }
  return launchPromise
}

async function closeBrowser() {
  if (closePromise) return closePromise
  closePromise = (async () => {
    if (launchPromise) {
      try { await launchPromise } catch {}
    }
    const closingPage = page
    const closingBrowser = browser
    if (idleTimer) clearTimeout(idleTimer)
    idleTimer = null
    page = null
    browser = null
    currentUrl = ''
    try {
      if (closingPage) { try { await closingPage.close() } catch {} }
      if (closingBrowser) { try { await closingBrowser.close() } catch {} }
    } finally {
      closePromise = null
    }
  })()
  return closePromise
}

async function openUrl(url) {
  const targetUrl = await validateUrl(url)
  const p = await ensurePage()
  await p.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 20000 })
  currentUrl = p.url()
  const title = await p.title().catch(() => '')
  return `已打开：${currentUrl}\n标题：${title || '(无标题)'}`
}

async function getTitle() {
  const p = await ensurePage()
  const title = await p.title().catch(() => '')
  return `当前页面：${currentUrl || p.url()}\n标题：${title || '(无标题)'}`
}

async function getText() {
  const p = await ensurePage()
  const text = await p.evaluate(() => document.body ? document.body.innerText : '')
  const clean = String(text || '').replace(/\n{3,}/g, '\n\n').trim()
  return `当前页面：${currentUrl || p.url()}\n文本：\n${clean.slice(0, 6000)}${clean.length > 6000 ? '\n...(截断)' : ''}`
}

async function getSnapshot() {
  const p = await ensurePage()
  const snapshot = await p.evaluate(() => {
    const links = Array.from(document.querySelectorAll('a[href]')).slice(0, 40).map((a, index) => ({ index, text: (a.innerText || a.getAttribute('aria-label') || '').trim().slice(0, 120), href: a.href }))
    const buttons = Array.from(document.querySelectorAll('button,input[type="button"],input[type="submit"]')).slice(0, 40).map((el, index) => ({ index, text: (el.innerText || el.value || el.getAttribute('aria-label') || '').trim().slice(0, 120) }))
    const headings = Array.from(document.querySelectorAll('h1,h2,h3')).slice(0, 30).map(el => ({ level: el.tagName.toLowerCase(), text: (el.innerText || '').trim().slice(0, 160) }))
    return { title: document.title || '', url: location.href, headings, links, buttons }
  })
  return JSON.stringify(snapshot, null, 2)
}

function requireSelector(selector) {
  const value = String(selector || '').trim()
  if (!value || value.length > 300) throw new Error('selector 不能为空或过长')
  return value
}

function validateEvaluateCode(code = '') {
  const value = String(code || '').trim()
  if (!value || value.length > 4000) throw new Error('evaluate code 不能为空或过长')
  if (/\b(localStorage|sessionStorage|indexedDB|caches|document\.cookie|navigator\.clipboard)\b/i.test(value)) throw new Error('evaluate 禁止访问浏览器本地隐私存储')
  if (/\b(fetch|XMLHttpRequest|WebSocket|EventSource)\b/i.test(value)) throw new Error('evaluate 禁止发起网络请求')
  if (/\b(document\.write|window\.open|location\s*=|location\.href\s*=|eval|Function)\b/i.test(value)) throw new Error('evaluate 禁止跳转、写文档或动态执行代码')
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)) throw new Error('evaluate code 包含非法控制字符')
  return value
}

async function evaluatePage(code) {
  const p = await ensurePage()
  const value = validateEvaluateCode(code)
  const result = await p.evaluate(source => {
    const fn = new Function('"use strict"; return (async () => { ' + source + '\n})()')
    return fn()
  }, value)
  return JSON.stringify(result === undefined ? null : result, null, 2).slice(0, 8000)
}

async function clickSelector(selector) {
  const p = await ensurePage()
  const value = requireSelector(selector)
  await p.click(value, { delay: 20 })
  currentUrl = p.url()
  return `已点击：${value}\n当前页面：${currentUrl}`
}

async function typeSelector(selector, text) {
  const p = await ensurePage()
  const value = requireSelector(selector)
  const input = String(text || '')
  if (input.length > 1000) throw new Error('输入文本过长')
  await p.click(value, { delay: 20 })
  await p.keyboard.type(input, { delay: 5 })
  return `已输入到：${value}`
}

async function extractSearchResults(query) {
  const p = await ensurePage()
  const candidates = await p.evaluate(() => {
    function cleanText(value) {
      return String(value || '').replace(/\s+/g, ' ').trim()
    }
    function pickSnippet(item, titleText) {
      const snippetEl = item.querySelector('.b_caption p, .b_snippet, .result__snippet, .c-abstract, .content-right_8Zs40, .compText, .snippet, p')
      const snippet = cleanText(snippetEl && snippetEl.innerText)
      if (snippet) return snippet
      return cleanText(item.innerText).replace(titleText, '').trim().slice(0, 420)
    }
    const selectors = [
      '#b_results li.b_algo',
      '#b_results .b_algo',
      '.result',
      '.result__body',
      '.web-result',
      '.c-container',
      '.result-op',
      '[tpl]',
      '[data-testid="result"]',
      'article',
    ]
    const items = Array.from(document.querySelectorAll(selectors.join(',')))
    const fromContainers = items.map(item => {
      const links = Array.from(item.querySelectorAll('a[href]')).filter(a => {
        const text = (a.innerText || '').trim()
        const href = String(a.href || '')
        return text && href && !href.startsWith('javascript:')
      })
      const titleEl = item.querySelector('h2 a, h3 a, .result__a, .t a') || links.find(a => (a.innerText || '').trim().length > 8) || links[0]
      const title = cleanText(titleEl && titleEl.innerText)
      const snippetEl = item.querySelector('.b_caption p, .b_snippet, .result__snippet, .c-abstract, .content-right_8Zs40, p')
      return {
        title,
        url: (titleEl && titleEl.href || '').trim(),
        snippet: cleanText(snippetEl && snippetEl.innerText) || pickSnippet(item, title),
        text: cleanText(item.innerText),
      }
    })
    const fromLinks = Array.from(document.querySelectorAll('a[href]')).map(a => {
      const title = cleanText(a.innerText || a.getAttribute('aria-label') || a.getAttribute('title'))
      const container = a.closest('li, article, .result, .result__body, .web-result, .c-container, .result-op, [tpl], [data-testid="result"], div')
      return {
        title,
        url: String(a.href || '').trim(),
        snippet: container ? pickSnippet(container, title) : '',
        text: container ? cleanText(container.innerText) : title,
      }
    })
    return fromContainers.concat(fromLinks).filter(item => item.title && item.url).slice(0, 80)
  }).catch(() => [])
  return formatSearchResults(query, rankSearchCandidates(candidates, query))
}

async function searchAndRead(query) {
  const value = String(query || '').trim()
  if (!value || value.length > 200) throw new Error('query 不能为空或过长')
  const p = await ensurePage()
  const urls = [
    'https://www.bing.com/search?q=' + encodeURIComponent(value),
    'https://duckduckgo.com/html/?q=' + encodeURIComponent(value),
  ]
  const failures = []
  for (const searchUrl of urls) {
    try {
      const targetUrl = await validateUrl(searchUrl)
      await p.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: SEARCH_NAVIGATION_TIMEOUT_MS })
      currentUrl = p.url()
      await p.waitForSelector('#b_results li.b_algo, .result, .result__body, .web-result, .c-container, [tpl], a[href]', { timeout: SEARCH_SELECTOR_TIMEOUT_MS }).catch(() => {})
      const extracted = await extractSearchResults(value)
      if (extracted) return extracted
      failures.push(`${new URL(searchUrl).hostname}: 未提取到有效结果`)
    } catch (e) {
      failures.push(`${searchUrl}: ${e.message}`)
    }
  }
  return buildSearchFailureText(value, failures)
}

async function waitForTarget(selector, timeoutMs) {
  const p = await ensurePage()
  const value = requireSelector(selector)
  const timeout = Math.min(30000, Math.max(1000, parseInt(timeoutMs, 10) || 12000))
  await p.waitForSelector(value, { timeout })
  currentUrl = p.url()
  return `已等待到：${value}`
}

async function takeScreenshot(fullPage = false) {
  const p = await ensurePage()
  const dir = path.join(DATA_DIR, 'agent-browser')
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `screenshot-${Date.now()}-${++screenshotCounter}.png`)
  await p.screenshot({ path: file, fullPage: !!fullPage, type: 'png' })
  const stat = await fs.promises.stat(file).catch(() => null)
  if (stat && stat.size > MAX_BROWSER_OUTPUT_FILE_BYTES) {
    await fs.promises.unlink(file).catch(() => {})
    throw new Error(`截图文件过大：${stat.size} bytes`)
  }
  return `截图已保存：${file}`
}

async function navigateHistory(action) {
  const p = await ensurePage()
  if (action === 'reload') await p.reload({ waitUntil: 'domcontentloaded', timeout: 20000 })
  else if (action === 'back' || action === 'navigate_back') await p.goBack({ waitUntil: 'domcontentloaded', timeout: 20000 })
  else if (action === 'forward') await p.goForward({ waitUntil: 'domcontentloaded', timeout: 20000 })
  currentUrl = p.url()
  return `当前页面：${currentUrl}`
}

async function interact(action, params = {}) {
  const p = await ensurePage()
  const selector = requireSelector(params.selector)
  if (action === 'hover') await p.hover(selector)
  else if (action === 'focus') await p.focus(selector)
  else if (action === 'clear') await p.$eval(selector, el => { if ('value' in el) el.value = ''; else el.textContent = '' })
  else if (action === 'select_option') await p.select(selector, String(params.value || params.text || ''))
  else throw new Error(`不支持的交互动作：${action}`)
  return `已执行 ${action}: ${selector}`
}

async function dragElement(params = {}) {
  const p = await ensurePage()
  const selector = requireSelector(params.selector)
  const targetSelector = String(params.targetSelector || '').trim()
  const source = await p.$(selector)
  if (!source) throw new Error(`未找到拖拽源：${selector}`)
  const from = await source.boundingBox()
  if (!from) throw new Error('无法获取拖拽源位置')
  let to
  if (targetSelector) {
    const target = await p.$(requireSelector(targetSelector))
    if (!target) throw new Error(`未找到拖拽目标：${targetSelector}`)
    to = await target.boundingBox()
  } else {
    const x = parseInt(params.x, 10)
    const y = parseInt(params.y, 10)
    if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error('drag 需要 targetSelector 或 x/y')
    to = { x, y, width: 1, height: 1 }
  }
  if (!to) throw new Error('无法获取拖拽目标位置')
  await p.mouse.move(from.x + from.width / 2, from.y + from.height / 2)
  await p.mouse.down()
  await p.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 12 })
  await p.mouse.up()
  return `已拖拽：${selector}${targetSelector ? ` -> ${targetSelector}` : ''}`
}

async function pressKey(key) {
  const p = await ensurePage()
  const value = String(key || '').trim()
  if (!value || value.length > 40) throw new Error('key 不能为空或过长')
  await p.keyboard.press(value)
  return `已按键：${value}`
}

async function scrollPage(params = {}) {
  const p = await ensurePage()
  const x = Math.max(-5000, Math.min(5000, parseInt(params.x, 10) || 0))
  const y = Math.max(-5000, Math.min(5000, parseInt(params.y, 10) || 800))
  await p.evaluate((dx, dy) => window.scrollBy(dx, dy), x, y)
  return `已滚动：x=${x}, y=${y}`
}

async function inspectDom(action, params = {}) {
  const p = await ensurePage()
  const selector = requireSelector(params.selector)
  if (action === 'exists') return (await p.$(selector)) ? `存在：${selector}` : `不存在：${selector}`
  if (action === 'count') return `数量：${(await p.$$(selector)).length}`
  if (action === 'get_attribute') {
    const attr = String(params.attribute || '').trim()
    if (!attr || attr.length > 80) throw new Error('attribute 不能为空或过长')
    const value = await p.$eval(selector, (el, name) => el.getAttribute(name), attr).catch(() => null)
    return `${selector}[${attr}] = ${String(value || '').slice(0, 2000)}`
  }
  if (action === 'extract') {
    const limit = Math.max(1, Math.min(100, parseInt(params.limit, 10) || 20))
    const items = await p.$$eval(selector, (els, max) => els.slice(0, max).map(el => ({ text: (el.innerText || el.textContent || '').trim().slice(0, 500), href: el.href || '', value: el.value || '' })), limit)
    return JSON.stringify(items, null, 2)
  }
  throw new Error(`不支持的 DOM 动作：${action}`)
}

async function getHtml(selector = '') {
  const p = await ensurePage()
  const html = selector ? await p.$eval(requireSelector(selector), el => el.outerHTML).catch(() => '') : await p.content()
  return String(html || '').slice(0, 12000)
}

async function setViewport(params = {}) {
  const p = await ensurePage()
  const width = Math.max(320, Math.min(3840, parseInt(params.width, 10) || 1280))
  const height = Math.max(240, Math.min(2160, parseInt(params.height, 10) || 800))
  await p.setViewport({ width, height })
  return `视口已设置：${width}x${height}`
}

async function savePdf(params = {}) {
  const p = await ensurePage()
  const dir = path.join(DATA_DIR, 'agent-browser')
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `page-${Date.now()}-${++screenshotCounter}.pdf`)
  await p.pdf({ path: file, format: 'A4', printBackground: params.printBackground !== false, landscape: !!params.landscape })
  const stat = await fs.promises.stat(file).catch(() => null)
  if (stat && stat.size > MAX_BROWSER_OUTPUT_FILE_BYTES) {
    await fs.promises.unlink(file).catch(() => {})
    throw new Error(`PDF 文件过大：${stat.size} bytes`)
  }
  return `PDF 已保存：${file}`
}

async function manageTabs(action, params = {}) {
  const p = await ensurePage()
  const pages = await browser.pages()
  if (action === 'tabs') return JSON.stringify(await Promise.all(pages.map(async (item, index) => ({ index, current: item === p, url: item.url(), title: await item.title().catch(() => '') }))), null, 2)
  if (action === 'new_tab') {
    page = await browser.newPage()
    await enableBrowserRequestGuards(page)
    await page.setViewport({ width: 1024, height: 700 })
    currentUrl = page.url()
    if (params.url) return openUrl(params.url)
    return '已打开新标签页'
  }
  const index = parseInt(params.index, 10)
  if (!Number.isInteger(index) || index < 0 || index >= pages.length) throw new Error('tab index 无效')
  if (action === 'switch_tab') {
    page = pages[index]
    currentUrl = page.url()
    return `已切换到标签 ${index}: ${currentUrl}`
  }
  if (action === 'close_tab') {
    if (pages.length <= 1) throw new Error('不能关闭最后一个标签，请使用 stop')
    await pages[index].close()
    page = (await browser.pages())[0]
    currentUrl = page.url()
    return `已关闭标签 ${index}`
  }
  throw new Error(`不支持的标签动作：${action}`)
}

async function manageCookies(action, params = {}) {
  const p = await ensurePage()
  if (action === 'cookies_get') {
    const cookies = await p.cookies()
    return JSON.stringify(cookies.slice(0, 80).map(c => ({ name: c.name, domain: c.domain, path: c.path, httpOnly: c.httpOnly, secure: c.secure, sameSite: c.sameSite, valueLength: String(c.value || '').length })), null, 2)
  }
  if (action === 'cookies_clear') {
    const cookies = await p.cookies()
    await p.deleteCookie(...cookies.map(c => ({ name: c.name, domain: c.domain, path: c.path })))
    return `已清理 cookies：${cookies.length} 个`
  }
  if (action === 'cookies_set') {
    const name = String(params.name || '').trim()
    const value = String(params.value || '')
    if (!name || name.length > 120 || value.length > 2000) throw new Error('cookie name/value 无效')
    const url = p.url()
    await p.setCookie({ name, value, url })
    return `已设置 cookie：${name}`
  }
  throw new Error(`不支持的 cookie 动作：${action}`)
}

async function uploadFile(params = {}) {
  const p = await ensurePage()
  const selector = requireSelector(params.selector)
  const files = Array.isArray(params.paths) ? params.paths : [params.path || params.file]
  const targets = []
  for (const item of files.slice(0, 10)) {
    if (!item) continue
    const { abs } = await assertExistingAgentPathInsideRoots(String(item), '上传文件')
    const stat = await fs.promises.stat(abs)
    if (!stat.isFile()) throw new Error(`不是文件：${abs}`)
    if (stat.size > MAX_BROWSER_UPLOAD_FILE_BYTES) throw new Error(`上传文件过大：${stat.size} bytes`)
    targets.push(abs)
  }
  if (!targets.length) throw new Error('file_upload 需要 path 或 paths')
  const input = await p.$(selector)
  if (!input) throw new Error(`未找到文件输入框：${selector}`)
  await input.uploadFile(...targets)
  return `已选择上传文件：${targets.map(item => path.basename(item)).join(', ')}`
}

async function configureDownload(params = {}) {
  const p = await ensurePage()
  const dir = path.join(DATA_DIR, 'agent-browser', 'downloads')
  fs.mkdirSync(dir, { recursive: true })
  const client = await p.target().createCDPSession()
  await client.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: dir })
  if (params.selector) await clickSelector(params.selector)
  return `下载目录已设置：${dir}`
}

async function clearBrowserCache() {
  const p = await ensurePage()
  const client = await p.target().createCDPSession()
  await client.send('Network.clearBrowserCache').catch(() => {})
  await client.send('Network.clearBrowserCookies').catch(() => {})
  networkLog = []
  consoleLog = []
  return '浏览器缓存、cookies 与运行日志已清理'
}

function getConsoleMessages() {
  return JSON.stringify(consoleLog.slice(0, 50), null, 2)
}

function getNetworkRequests() {
  return JSON.stringify(networkLog.slice(0, 80), null, 2)
}

async function executeSingleAction(params = {}) {
  const action = String(params.action || '').trim().toLowerCase()
  if (action === 'start') { await ensurePage(); return '浏览器已启动' }
  if (action === 'navigate' || action === 'open') return openUrl(params.url)
  if (action === 'url') { const p = await ensurePage(); return p.url() }
  if (action === 'reload' || action === 'back' || action === 'navigate_back' || action === 'forward' || action === 'navigate_forward') return navigateHistory(action === 'navigate_forward' ? 'forward' : action)
  if (action === 'title') return getTitle()
  if (action === 'text') return getText()
  if (action === 'snapshot') return getSnapshot()
  if (action === 'click') return clickSelector(params.selector)
  if (action === 'type') return typeSelector(params.selector, params.text)
  if (action === 'fill_form') return fillForm(params)
  if (action === 'drag') return dragElement(params)
  if (action === 'hover' || action === 'focus' || action === 'clear' || action === 'select_option') return interact(action, params)
  if (action === 'press' || action === 'press_key') return pressKey(params.key || params.text)
  if (action === 'scroll') return scrollPage(params)
  if (action === 'exists' || action === 'count' || action === 'get_attribute' || action === 'extract') return inspectDom(action, params)
  if (action === 'html') return getHtml(params.selector)
  if (action === 'evaluate') return evaluatePage(params.code || params.text)
  if (action === 'search_and_read') return searchAndRead(params.query || params.text)
  if (action === 'wait_for') return waitForTarget(params.selector, params.timeoutMs)
  if (action === 'screenshot') return takeScreenshot(!!params.fullPage)
  if (action === 'set_viewport' || action === 'resize') return setViewport(params)
  if (action === 'pdf') return savePdf(params)
  if (action === 'tabs' || action === 'new_tab' || action === 'switch_tab' || action === 'close_tab') return manageTabs(action, params)
  if (action === 'cookies_get' || action === 'cookies_set' || action === 'cookies_clear') return manageCookies(action, params)
  if (action === 'console_messages') return getConsoleMessages()
  if (action === 'network_requests') return getNetworkRequests()
  if (action === 'file_upload') return uploadFile(params)
  if (action === 'file_download') return configureDownload(params)
  if (action === 'clear_cache') return clearBrowserCache()
  if (action === 'stop' || action === 'close') { await closeBrowser(); return '浏览器已关闭' }
  throw new Error(`不支持的浏览器动作：${action}`)
}

async function runBatch(steps = []) {
  if (!Array.isArray(steps) || !steps.length) throw new Error('batch steps 不能为空')
  if (steps.length > 20) throw new Error('batch steps 最多 20 步')
  const results = []
  for (let index = 0; index < steps.length; index++) {
    const step = steps[index] || {}
    if (String(step.action || '').toLowerCase() === 'batch') {
      results.push({ index, ok: false, error: 'batch 不允许嵌套 batch' })
      continue
    }
    try {
      const text = await executeSingleAction(step)
      results.push({ index, action: step.action, ok: true, text: String(text || '').slice(0, 2000) })
    } catch (error) {
      results.push({ index, action: step.action, ok: false, error: error.message || String(error) })
    }
  }
  return JSON.stringify(results, null, 2)
}

async function fillForm(params = {}) {
  const p = await ensurePage()
  const fields = Array.isArray(params.fields) ? params.fields : []
  if (!fields.length) {
    if (params.selector) return typeSelector(params.selector, params.text)
    throw new Error('fill_form 需要 fields 或 selector/text')
  }
  if (fields.length > 30) throw new Error('fill_form fields 最多 30 项')
  for (const field of fields) {
    const selector = requireSelector(field.selector)
    const value = String(field.value ?? field.text ?? '')
    if (value.length > 1000) throw new Error('字段输入文本过长')
    await p.click(selector, { delay: 10 }).catch(() => {})
    await p.$eval(selector, el => { if ('value' in el) el.value = ''; else el.textContent = '' }).catch(() => {})
    await p.type(selector, value, { delay: 2 })
  }
  return `已填写表单字段：${fields.length} 个`
}

function runQueued(action) {
  const next = actionQueue.then(action, action)
  actionQueue = next.catch(() => {})
  return next
}

module.exports = {
  definition: {
    name: 'browser_action',
    description: '受控浏览器动作。支持导航、DOM 读取、交互、截图/PDF、标签页和脱敏 cookies；默认关闭，启用后也按危险工具策略确认。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['start', 'stop', 'navigate', 'snapshot', 'click', 'type', 'screenshot', 'wait_for', 'open', 'title', 'text', 'close', 'url', 'reload', 'back', 'navigate_back', 'forward', 'navigate_forward', 'hover', 'focus', 'press', 'press_key', 'clear', 'scroll', 'select_option', 'drag', 'exists', 'count', 'get_attribute', 'extract', 'html', 'evaluate', 'batch', 'search_and_read', 'set_viewport', 'resize', 'pdf', 'tabs', 'new_tab', 'switch_tab', 'close_tab', 'cookies_get', 'cookies_set', 'cookies_clear', 'clear_cache', 'console_messages', 'network_requests', 'fill_form', 'file_upload', 'file_download'], description: '动作名称' },
        url: { type: 'string', description: 'navigate/open/new_tab 动作的 http/https URL' },
        selector: { type: 'string', description: 'click/type/wait_for/DOM 动作的 CSS 选择器' },
        targetSelector: { type: 'string', description: 'drag 动作的目标 CSS 选择器' },
        text: { type: 'string', description: 'type 动作输入文本' },
        key: { type: 'string', description: 'press_key/press 动作的按键名' },
        attribute: { type: 'string', description: 'get_attribute 动作的属性名' },
        value: { type: 'string', description: 'select_option/cookies_set 的值' },
        name: { type: 'string', description: 'cookies_set 的 cookie 名' },
        index: { type: 'number', description: 'switch_tab/close_tab 标签页序号' },
        width: { type: 'number', description: 'resize/set_viewport 宽度' },
        height: { type: 'number', description: 'resize/set_viewport 高度' },
        x: { type: 'number', description: 'scroll 横向距离' },
        y: { type: 'number', description: 'scroll 纵向距离' },
        query: { type: 'string', description: 'search_and_read 动作的搜索关键词' },
        limit: { type: 'number', description: 'extract 返回数量上限' },
        timeoutMs: { type: 'number', description: 'wait_for 动作等待毫秒数，默认 12000，最大 30000' },
        code: { type: 'string', description: 'evaluate 动作的受限 JS 代码' },
        steps: { type: 'array', description: 'batch 动作的步骤列表' },
        fields: { type: 'array', description: 'fill_form 批量字段，形如 { selector, value }' },
        path: { type: 'string', description: 'file_upload 的单个本地文件路径' },
        paths: { type: 'array', description: 'file_upload 的多个本地文件路径' },
      },
      required: ['action'],
    },
  },
  async execute(params = {}) {
    return runQueued(async () => {
      const action = String(params.action || '').trim().toLowerCase()
      if (action === 'batch') return runBatch(params.steps)
      return executeSingleAction(params)
    })
  },
  dangerous: true,
  defaultChannels: ['dashboard'],
}
