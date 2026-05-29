/**
 * MODULE: HTML渲染器。
 * 职责: 加载模板、替换变量、随机选择主题、Puppeteer截图。
 * 边界: 不做数据分析，只负责渲染。
 */
const fs = require('fs')
const path = require('path')
const { FORCE_TEMPLATE } = require('./config') as typeof import('./config')
const { getShanghaiHourFromTs } = require('../../koishi-plugin-dongxuelian-ai/lib/core/utils') as typeof import('../../koishi-plugin-dongxuelian-ai/lib/core/utils')

interface Topic {
  title?: string
  summary?: string
  participants?: string[]
}

interface UserTitle {
  name?: string
  userId?: string
  title?: string
  reason?: string
  mbti?: string
}

interface GoldenQuote {
  content?: string
  sender?: string
  reason?: string
  userId?: string
}

interface QualityDimension {
  name?: string
  percentage?: number
  comment?: string
  color?: string
}

interface QualityReview {
  title?: string
  subtitle?: string
  dimensions?: QualityDimension[]
  summary?: string
}

interface TokenUsage {
  totalTokens?: number
}

interface ReportData {
  date?: string
  totalMessages?: number
  activeMembers?: number
  emojiCount?: number
  totalChars?: number
  peakHour?: string
  hourlyActivity?: number[]
}

interface AnalysisResult {
  topics?: Topic[]
  userTitles?: UserTitle[]
  goldenQuotes?: GoldenQuote[]
  qualityReview?: QualityReview | null
  tokenUsage?: TokenUsage
}

interface TemplateEntry {
  name: string
  content: string
}

interface PageRequestLike {
  url(): string
  resourceType(): string
  abort(): unknown
  continue(): unknown
}

interface PageLike {
  setRequestInterception?(value: boolean): Promise<unknown>
  on?(event: 'request', handler: (req: PageRequestLike) => unknown): unknown
  setViewport(options: { width: number, height: number }): Promise<unknown>
  setContent(html: string, options: { waitUntil: string, timeout: number }): Promise<unknown>
  evaluate<T = unknown>(fn: () => T | Promise<T>): Promise<T>
  waitForNetworkIdle?(options: { idleTime: number, timeout: number }): Promise<unknown>
  screenshot(options: { type: 'png', clip: { x: number, y: number, width: number, height: number } }): Promise<Buffer>
}

interface BrowserLike {
  newPage(): Promise<PageLike>
  close(): Promise<unknown>
}

interface PuppeteerLike {
  launch(options: {
    executablePath: string
    headless: string
    args: string[]
  }): Promise<BrowserLike>
}

const TEMPLATES_DIR = path.join(__dirname, '..', 'templates')

// 信号量：限制并发Puppeteer实例
let activeRenderers = 0
const MAX_RENDERERS = parsePositiveInt(process.env.DAILY_REPORT_MAX_RENDERERS, 1, 1, 4)
const RENDER_TIMEOUT = parsePositiveInt(process.env.DAILY_REPORT_RENDER_TIMEOUT_MS, 8 * 60 * 1000, 5000, 10 * 60 * 1000)
const RENDER_QUEUE_TIMEOUT = parsePositiveInt(process.env.DAILY_REPORT_QUEUE_TIMEOUT_MS, 60000, 5000, 180000)
const RENDER_SET_CONTENT_TIMEOUT = parsePositiveInt(process.env.DAILY_REPORT_SET_CONTENT_TIMEOUT_MS, 20000, 5000, 60000)
const RENDER_ASSET_IDLE_TIMEOUT = parsePositiveInt(process.env.DAILY_REPORT_RENDER_ASSET_WAIT_MS, 8000, 1000, 30000)
const RENDER_MIN_AVAILABLE_MB = parsePositiveInt(process.env.DAILY_REPORT_MIN_MEM_MB, 300, 256, 8192)
const MAX_CAPTURE_HEIGHT = parsePositiveInt(process.env.DAILY_REPORT_MAX_CAPTURE_HEIGHT, 6000, 800, 12000)
const MAX_HTML_BYTES = parsePositiveInt(process.env.DAILY_REPORT_MAX_HTML_BYTES, 512 * 1024, 64 * 1024, 2 * 1024 * 1024)
const BLOCKED_RESOURCE_TYPES = new Set(['media'])
const BLOCKED_HOST_RE = /(?:doubleclick|googlesyndication|google-analytics|googletagmanager|adservice|adsystem|bat\.bing|clarity\.ms|facebook\.net|scorecardresearch|cnzz|hm\.baidu|pos\.baidu)/i

function parsePositiveInt(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = parseInt(String(value), 10)
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(min, Math.min(max, parsed))
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function readLinuxMemAvailableMb(): number | null {
  if (process.platform !== 'linux') return null
  try {
    const raw = fs.readFileSync('/proc/meminfo', 'utf8')
    const match = /^MemAvailable:\s+(\d+)\s+kB/m.exec(raw)
    return match ? Math.floor(Number(match[1]) / 1024) : null
  } catch {
    return null
  }
}

function assertEnoughMemoryForRender(): void {
  if (/^(1|true|yes|on)$/i.test(String(process.env.DAILY_REPORT_RENDER_FORCE || '').trim())) return
  const availableMb = readLinuxMemAvailableMb()
  if (availableMb === null || availableMb >= RENDER_MIN_AVAILABLE_MB) return
  throw new Error(`available memory is too low for Chromium render (${availableMb}MB < ${RENDER_MIN_AVAILABLE_MB}MB)`)
}

// 等待并占用一个渲染槽位，返回幂等释放函数。
async function acquireRendererSlot(): Promise<() => void> {
  const startedAt = Date.now()
  while (activeRenderers >= MAX_RENDERERS) {
    if (Date.now() - startedAt > RENDER_QUEUE_TIMEOUT) throw new Error('daily report render queue timeout')
    await new Promise(r => setTimeout(r, 500))
  }
  activeRenderers++
  let released = false
  return () => {
    if (released) return
    released = true
    activeRenderers = Math.max(0, activeRenderers - 1)
  }
}

async function enableRenderRequestGuards(page: PageLike): Promise<void> {
  if (!page || typeof page.setRequestInterception !== 'function' || typeof page.on !== 'function') return
  await page.setRequestInterception(true).catch(() => { /* non-critical: request interception guard is best-effort */
  })
  page.on('request', req => {
    try {
      const url = req.url()
      const type = req.resourceType()
      if (BLOCKED_RESOURCE_TYPES.has(type) || BLOCKED_HOST_RE.test(url)) return req.abort()
      return req.continue()
    } catch {
      try { req.continue() } catch { /* non-critical: request may already be closed */
      }
    }
  })
}

function esc(str: unknown): string {
  return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

// 将 AI 产出的样式和头像字段收敛到渲染层可接受的安全范围。
function safePercent(value: unknown, fallback = 0): number {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(0, Math.min(100, Math.round(parsed)))
}

function safeCssColor(value: unknown, fallback = '#39C5BB'): string {
  const color = String(value || '').trim()
  return /^#[0-9a-fA-F]{3,8}$/.test(color) ? color : fallback
}

function safeAvatarUserId(value: unknown): string {
  const userId = String(value || '').trim()
  return /^\d+$/.test(userId) ? userId : ''
}

// 等待页面远程资源尽量稳定后再截图，减少头像和外链图片的加载抖动。
async function waitForRenderAssets(page: PageLike): Promise<void> {
  if (!page || typeof page.waitForNetworkIdle !== 'function') return
  await page.waitForNetworkIdle({ idleTime: 1000, timeout: RENDER_ASSET_IDLE_TIMEOUT }).catch(() => { /* non-critical: asset idle wait is best-effort */
  })
}

// 加载所有模板
function loadTemplates(): TemplateEntry[] {
  const files = fs.readdirSync(TEMPLATES_DIR).filter((f: string) => f.endsWith('.html'))
  return files.map((f: string) => ({
    name: f,
    content: fs.readFileSync(path.join(TEMPLATES_DIR, f), 'utf8'),
  }))
}

// 时段选择模板：6:00-18:00用light，18:00-6:00用dark（支持FORCE_TEMPLATE调试）
function selectTemplate(): TemplateEntry {
  const templates = loadTemplates()
  if (templates.length === 0) throw new Error('没有可用模板')
  if (FORCE_TEMPLATE) {
    const found = templates.find(t => t.name === FORCE_TEMPLATE)
    if (found) return found
    console.warn(`[daily-report] 强制模板 ${FORCE_TEMPLATE} 不存在，回退时段选择`)
  }
  const hour = getShanghaiHourFromTs(Date.now())
  const preferred = (hour >= 6 && hour < 18) ? 'light.html' : 'dark.html'
  const found = templates.find(t => t.name === preferred)
  if (found) return found
  return templates[0]
}

// 构建24小时柱状图SVG（用于light/dark模板）
function buildBarChart(hourlyActivity: number[]): string {
  const max = Math.max(...hourlyActivity, 1)
  const barW = 22, chartH = 120, gap = 4
  const totalW = 24 * (barW + gap), svgH = chartH + 40
  let bars = ''
  const colors = ['#39C5BB','#39C5BB','#39C5BB','#39C5BB','#39C5BB','#39C5BB',
    '#5EEAD4','#5EEAD4','#A7E7E3','#A7E7E3','#FCD34D','#FCD34D',
    '#F472B6','#F472B6','#FCD34D','#FCD34D','#A7E7E3','#A7E7E3',
    '#5EEAD4','#5EEAD4','#39C5BB','#39C5BB','#39C5BB','#39C5BB']

  for (let i = 0; i < 24; i++) {
    const h = Math.max((hourlyActivity[i] / max) * chartH, 2)
    const x = i * (barW + gap), y = chartH - h
    const c = hourlyActivity[i] === max ? '#F472B6' : colors[i]
    bars += `<rect x="${x}" y="${y}" width="${barW}" height="${h}" rx="3" fill="${c}"/>`
    if (hourlyActivity[i] > 0) {
      bars += `<text x="${x+barW/2}" y="${Math.max(y-6,12)}" text-anchor="middle" font-size="10" font-weight="bold" fill="#7F8C8D" font-family="Arial">${hourlyActivity[i]}</text>`
    }
  }
  let labels = ''
  for (let i = 0; i < 24; i += 2) {
    labels += `<text x="${i*(barW+gap)+barW/2}" y="${chartH+16}" text-anchor="middle" font-size="10" fill="#7F8C8D" font-family="Arial">${String(i).padStart(2,'0')}时</text>`
  }
  return `<svg width="${totalW}" height="${svgH}" viewBox="0 0 ${totalW} ${svgH}" style="display:block;margin:0 auto"><g>${bars}</g>${labels}</svg>`
}

// 构建CSS柱状图（用于paper模板）
function buildCssBarChart(hourlyActivity: number[]): string {
  const max = Math.max(...hourlyActivity, 1)
  let bars = ''
  for (let i = 0; i < 24; i++) {
    const pct = Math.max((hourlyActivity[i] / max) * 100, 3)
    const cls = hourlyActivity[i] === max ? 'hot' : hourlyActivity[i] > max * 0.6 ? 'warm' : hourlyActivity[i] > max * 0.3 ? '' : 'cool'
    bars += `<div class="bar ${cls}" style="height:${pct}%"></div>`
  }
  return bars
}

// 构建话题HTML
function buildTopicsHtml(topics?: Topic[]): string {
  if (!topics || !topics.length) return ''
  let html = `<div class="sec"><div class="bar"></div><div class="sec-t">📌 话题总结</div></div>`
  for (let i = 0; i < topics.length; i++) {
    const t = topics[i]
    const tags = (t.participants || []).map(p => `<span class="ptag">👤 ${esc(p)}</span>`).join('')
    html += `<div class="topic-card"><div class="topic-num">#${String(i+1).padStart(2,'0')}</div><div class="topic-body"><div class="topic-title">${esc(t.title)}</div><div class="topic-detail">${esc(t.summary)}</div><div class="topic-tags">${tags}</div></div><div class="topic-deco">💬</div></div>`
  }
  return html
}

// 构建群友画像HTML
function buildProfilesHtml(userTitles?: UserTitle[]): string {
  if (!userTitles || !userTitles.length) return ''
  let html = `<div class="sec"><div class="bar"></div><div class="sec-t">👤 群友画像</div></div><div class="profiles">`
  for (const t of userTitles) {
    const mbti = t.mbti ? `<span class="mbti-tag">${esc(t.mbti)}</span>` : ''
    const safeUserId = safeAvatarUserId(t.userId)
    const avatarUrl = safeUserId ? `https://q1.qlogo.cn/g?b=qq&nk=${safeUserId}&s=100` : ''
    const avatarStyle = avatarUrl
      ? `background-image:url('${avatarUrl}');background-size:cover;background-position:center`
      : `background:#39C5BB`
    const avatarContent = avatarUrl ? '' : esc((t.name||'?')[0])
    html += `<div class="profile-card"><div class="profile-head"><div class="avatar" style="${avatarStyle}">${avatarContent}</div><div class="profile-info"><div class="profile-name">${esc(t.name)} ${mbti}</div><div class="profile-role">${esc(t.title)}</div></div></div><div class="profile-desc">${esc(t.reason)}</div></div>`
  }
  return html + '</div>'
}

// 构建今日圣经HTML（goldenQuotes已自带userId，无userId的已过滤）
function buildQuotesHtml(goldenQuotes?: GoldenQuote[]): string {
  if (!goldenQuotes || !goldenQuotes.length) return ''

  let html = `<div class="sec"><div class="bar pk"></div><div class="sec-t">✝ 今日圣经</div></div>`
  for (const q of goldenQuotes) {
    const safeUserId = safeAvatarUserId(q.userId)
    const avatarUrl = safeUserId
      ? `https://q1.qlogo.cn/g?b=qq&nk=${safeUserId}&s=100`
      : ''
    const avatarStyle = avatarUrl
      ? `background-image:url('${avatarUrl}');background-size:cover;background-position:center`
      : `background:#39C5BB`
    const avatarContent = avatarUrl ? '' : esc((q.sender||'?')[0])
    html += `<div class="quote-block"><div class="quote-user"><div class="avatar" style="width:28px;height:28px;font-size:.7rem;${avatarStyle}">${avatarContent}</div><span class="quote-name">${esc(q.sender)}</span></div><div class="quote-bubble">${esc(q.content)}</div><div class="quote-comment">💬 莲莲锐评</div><div class="quote-comment-text">${esc(q.reason)}</div></div>`
  }
  return html
}

// 构建群聊锐评HTML
function buildQualityHtml(qr: QualityReview | null | undefined, tokenUsage?: TokenUsage): string {
  if (!qr) return ''
  let dimsHtml = ''
  if (qr.dimensions && qr.dimensions.length) {
    dimsHtml = '<div class="qr-dims">'
    for (const d of qr.dimensions) {
      const percentage = safePercent(d.percentage)
      const color = safeCssColor(d.color)
      dimsHtml += `<div class="qr-dim"><div class="qr-dim-head"><span class="qr-dot" style="background:${color}"></span><span class="qr-dim-name">${esc(d.name)} (${percentage}%)</span></div><div class="qr-dim-comment">${esc(d.comment)}</div></div>`
    }
    dimsHtml += '</div>'
  }
  let gradientBar = '<div class="qr-gradient-bar">'
  if (qr.dimensions && qr.dimensions.length) {
    for (const d of qr.dimensions) {
      const percentage = safePercent(d.percentage)
      const color = safeCssColor(d.color)
      gradientBar += `<div style="flex:${Math.max(1, percentage)};background:${color};height:100%;border-radius:4px"></div>`
    }
  }
  gradientBar += '</div>'

  const tokenDisplay = tokenUsage && tokenUsage.totalTokens
    ? `<span class="qr-token">Token: ${tokenUsage.totalTokens}</span>`
    : ''

  return `<div class="sec"><div class="bar"></div><div class="sec-t">💬 群聊锐评</div></div><div class="qr-card"><div class="qr-header-row"><div><div class="qr-title">${esc(qr.title)}</div><div class="qr-subtitle">${esc(qr.subtitle)}</div></div><div style="display:flex;align-items:center;gap:8px">${tokenDisplay}<div class="qr-deco-icon" style="font-size:2rem;opacity:.2">💬</div></div></div>${gradientBar}${dimsHtml}<div class="qr-summary"><span class="qr-summary-label">🔊 莲莲点评</span>${esc(qr.summary)}</div></div>`
}

// 替换模板变量
function renderTemplate(template: string, data: ReportData, analysis: AnalysisResult, templateName: string): string {
  const topicsHtml = buildTopicsHtml(analysis.topics)
  const profilesHtml = buildProfilesHtml(analysis.userTitles)
  const quotesHtml = buildQuotesHtml(analysis.goldenQuotes)
  const qualityHtml = buildQualityHtml(analysis.qualityReview, analysis.tokenUsage)
  // paper模板用CSS柱状图，其他用SVG
  const chartHtml = templateName === 'paper.html'
    ? buildCssBarChart(data.hourlyActivity || new Array(24).fill(0))
    : buildBarChart(data.hourlyActivity || new Array(24).fill(0))

  const placeholders: Record<string, string> = {
    '{{date}}': esc(data.date),
    '{{totalMessages}}': String(data.totalMessages),
    '{{activeMembers}}': String(data.activeMembers),
    '{{emojiCount}}': String(data.emojiCount),
    '{{totalChars}}': String(data.totalChars),
    '{{peakHour}}': esc(data.peakHour),
    '{{timestamp}}': new Date().toLocaleString('zh-CN'),
    '{{chartHtml}}': chartHtml,
    '{{topicsHtml}}': topicsHtml,
    '{{profilesHtml}}': profilesHtml,
    '{{quotesHtml}}': quotesHtml,
    '{{qualityHtml}}': qualityHtml,
  }

  let result = template
  for (const [key, value] of Object.entries(placeholders)) {
    result = result.split(key).join(value)
  }
  return result
}

// 查找浏览器
function findBrowser(): string | null {
  const candidates = process.platform === 'win32'
    ? ['C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
       'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe']
    : ['/snap/bin/chromium','/usr/bin/chromium-browser','/usr/bin/chromium',
       '/usr/bin/google-chrome','/usr/bin/google-chrome-stable']
  for (const p of candidates) {
    if (fs.existsSync(p)) return p
  }
  return null
}

// Puppeteer截图（带信号量和超时）
async function renderHtmlToImage(htmlContent: string): Promise<Buffer> {
  if (Buffer.byteLength(String(htmlContent || ''), 'utf8') > MAX_HTML_BYTES) throw new Error('render HTML is too large')
  assertEnoughMemoryForRender()
  const releaseRendererSlot = await acquireRendererSlot()

  const puppeteer = require('puppeteer-core') as PuppeteerLike
  const browserPath = findBrowser()
  if (!browserPath) {
    releaseRendererSlot()
    throw new Error('未找到Chrome/Chromium浏览器')
  }

  let browser: BrowserLike | null = null
  let timeoutId: ReturnType<typeof setTimeout> | null = null
  try {
    browser = await puppeteer.launch({
      executablePath: browserPath, headless: 'new',
      args: [
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
      ],
    })
    timeoutId = setTimeout(async () => {
      if (browser) { try { await browser.close() } catch { /* non-critical: timeout cleanup is best-effort */
      } browser = null }
    }, RENDER_TIMEOUT)

    const page = await browser.newPage()
    await enableRenderRequestGuards(page)
    await page.setViewport({ width: 880, height: 800 })
    await page.setContent(htmlContent, { waitUntil: 'domcontentloaded', timeout: RENDER_SET_CONTENT_TIMEOUT })
    await page.evaluate(() => document.fonts && document.fonts.ready ? document.fonts.ready.then(() => true) : true).catch(() => { /* non-critical: fonts readiness may be unavailable */
    })
    await waitForRenderAssets(page)
    const bodyH = await page.evaluate(() => Math.max(document.body ? document.body.scrollHeight : 0, document.documentElement ? document.documentElement.scrollHeight : 0))
    const captureH = Math.min(Math.max(800, Number(bodyH) + 40), MAX_CAPTURE_HEIGHT)
    await page.setViewport({ width: 880, height: captureH })
    const screenshot = await page.screenshot({ type: 'png', clip: { x: 0, y: 0, width: 880, height: captureH } })
    return screenshot
  } catch (err) {
    if (browser) { try { await browser.close() } catch { /* non-critical: error cleanup is best-effort */
    } }
    throw err
  } finally {
    if (timeoutId) clearTimeout(timeoutId)
    if (browser) { try { await browser.close() } catch { /* non-critical: final cleanup is best-effort */
    } }
    releaseRendererSlot()
  }
}

// 主入口：随机选模板 + 渲染 + 截图
async function renderReport(data: ReportData, analysis: AnalysisResult): Promise<Buffer> {
  const template = selectTemplate()
  const html = renderTemplate(template.content, data, analysis, template.name)
  return renderHtmlToImage(html)
}

export = { renderReport, renderHtmlToImage }
