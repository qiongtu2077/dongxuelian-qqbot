/**
 * MODULE: HTML渲染器。
 * 职责: 加载模板、替换变量、随机选择主题、Puppeteer截图。
 * 边界: 不做数据分析，只负责渲染。
 */
const fs = require('fs')
const path = require('path')

const TEMPLATES_DIR = path.join(__dirname, '..', 'templates')

// 信号量：限制并发Puppeteer实例
let activeRenderers = 0
const MAX_RENDERERS = 2
const RENDER_TIMEOUT = 30000

function esc(str) {
  return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

// 加载所有模板
function loadTemplates() {
  const files = fs.readdirSync(TEMPLATES_DIR).filter(f => f.endsWith('.html'))
  return files.map(f => ({
    name: f,
    content: fs.readFileSync(path.join(TEMPLATES_DIR, f), 'utf8'),
  }))
}

// 随机选择模板
function selectTemplate() {
  const templates = loadTemplates()
  if (templates.length === 0) throw new Error('没有可用模板')
  return templates[Math.floor(Math.random() * templates.length)]
}

// 构建24小时柱状图SVG
function buildBarChart(hourlyActivity) {
  const max = Math.max(...hourlyActivity, 1)
  const barW = 28, chartH = 120, gap = 4
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

// 构建话题HTML
function buildTopicsHtml(topics) {
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
function buildProfilesHtml(userTitles) {
  if (!userTitles || !userTitles.length) return ''
  let html = `<div class="sec"><div class="bar"></div><div class="sec-t">👤 群友画像</div></div><div class="profiles">`
  for (const t of userTitles) {
    const mbti = t.mbti ? `<span class="mbti-tag">${esc(t.mbti)}</span>` : ''
    const avatarUrl = t.userId ? `https://q1.qlogo.cn/g?b=qq&nk=${esc(t.userId)}&s=100` : ''
    const avatarStyle = avatarUrl
      ? `background-image:url('${avatarUrl}');background-size:cover;background-position:center`
      : `background:#39C5BB`
    const avatarContent = avatarUrl ? '' : esc((t.name||'?')[0])
    html += `<div class="profile-card"><div class="profile-head"><div class="avatar" style="${avatarStyle}">${avatarContent}</div><div class="profile-info"><div class="profile-name">${esc(t.name)} ${mbti}</div><div class="profile-role">${esc(t.title)}</div></div></div><div class="profile-desc">${esc(t.reason)}</div></div>`
  }
  return html + '</div>'
}

// 构建今日圣经HTML
function buildQuotesHtml(goldenQuotes) {
  if (!goldenQuotes || !goldenQuotes.length) return ''
  let html = `<div class="sec"><div class="bar pk"></div><div class="sec-t">✝ 今日圣经</div></div>`
  for (const q of goldenQuotes) {
    const colors = ['#39C5BB','#A7E7E3','#F8BBD0','#e0f2f1']
    const ci = Math.abs((q.sender||'').charCodeAt(0)||0) % colors.length
    html += `<div class="quote-block"><div class="quote-user"><div class="avatar" style="width:28px;height:28px;font-size:.7rem;background:${colors[ci]}">${esc((q.sender||'?')[0])}</div><span class="quote-name">${esc(q.sender)}</span></div><div class="quote-bubble">${esc(q.content)}</div><div class="quote-comment">💬 莲莲锐评</div><div class="quote-comment-text">${esc(q.reason)}</div></div>`
  }
  return html
}

// 构建群聊锐评HTML
function buildQualityHtml(qr, tokenUsage) {
  if (!qr) return ''
  let dimsHtml = ''
  if (qr.dimensions && qr.dimensions.length) {
    dimsHtml = '<div class="qr-dims">'
    for (const d of qr.dimensions) {
      dimsHtml += `<div class="qr-dim"><div class="qr-dim-head"><span class="qr-dot" style="background:${d.color||'#39C5BB'}"></span><span class="qr-dim-name">${esc(d.name)} (${d.percentage}%)</span></div><div class="qr-dim-comment">${esc(d.comment)}</div></div>`
    }
    dimsHtml += '</div>'
  }
  let gradientBar = '<div class="qr-gradient-bar">'
  if (qr.dimensions && qr.dimensions.length) {
    for (const d of qr.dimensions) {
      gradientBar += `<div style="flex:${d.percentage};background:${d.color||'#39C5BB'};height:100%;border-radius:4px"></div>`
    }
  }
  gradientBar += '</div>'

  const tokenDisplay = tokenUsage && tokenUsage.totalTokens
    ? `<span class="qr-token">Token: ${tokenUsage.totalTokens}</span>`
    : ''

  return `<div class="sec"><div class="bar"></div><div class="sec-t">💬 群聊锐评</div></div><div class="qr-card"><div class="qr-header-row"><div><div class="qr-title">${esc(qr.title)}</div><div class="qr-subtitle">${esc(qr.subtitle)}</div></div><div style="display:flex;align-items:center;gap:8px">${tokenDisplay}<div class="qr-deco-icon" style="font-size:2rem;opacity:.2">💬</div></div></div>${gradientBar}${dimsHtml}<div class="qr-summary"><span class="qr-summary-label">🔊 莲莲点评</span>${esc(qr.summary)}</div></div>`
}

// 替换模板变量
function renderTemplate(template, data, analysis) {
  const topicsHtml = buildTopicsHtml(analysis.topics)
  const profilesHtml = buildProfilesHtml(analysis.userTitles)
  const quotesHtml = buildQuotesHtml(analysis.goldenQuotes)
  const qualityHtml = buildQualityHtml(analysis.qualityReview, analysis.tokenUsage)
  const chartHtml = buildBarChart(data.hourlyActivity || new Array(24).fill(0))

  const placeholders = {
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
function findBrowser() {
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
async function renderHtmlToImage(htmlContent) {
  while (activeRenderers >= MAX_RENDERERS) {
    await new Promise(r => setTimeout(r, 500))
  }
  activeRenderers++

  const puppeteer = require('puppeteer-core')
  const browserPath = findBrowser()
  if (!browserPath) {
    activeRenderers--
    throw new Error('未找到Chrome/Chromium浏览器')
  }

  let browser = null
  try {
    browser = await puppeteer.launch({
      executablePath: browserPath, headless: 'new',
      args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage','--disable-gpu'],
    })
    const timeoutId = setTimeout(async () => {
      if (browser) { try { await browser.close() } catch {} browser = null }
    }, RENDER_TIMEOUT)

    const page = await browser.newPage()
    await page.setViewport({ width: 880, height: 800 })
    await page.setContent(htmlContent, { waitUntil: 'networkidle0', timeout: 15000 })
    await page.evaluateHandle('document.fonts.ready')
    const bodyH = await page.evaluate(() => document.body.scrollHeight)
    await page.setViewport({ width: 880, height: bodyH + 40 })
    const screenshot = await page.screenshot({ type: 'png', clip: { x: 0, y: 0, width: 880, height: bodyH + 40 } })
    clearTimeout(timeoutId)
    return screenshot
  } catch (err) {
    if (browser) { try { await browser.close() } catch {} }
    throw err
  } finally {
    if (browser) { try { await browser.close() } catch {} }
    activeRenderers--
  }
}

// 主入口：随机选模板 + 渲染 + 截图
async function renderReport(data, analysis) {
  const template = selectTemplate()
  const html = renderTemplate(template.content, data, analysis)
  return renderHtmlToImage(html)
}

module.exports = { renderReport }
