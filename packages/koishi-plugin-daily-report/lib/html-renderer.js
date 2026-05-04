/**
 * MODULE: HTML渲染器（完整版）。
 * 职责: 在JS中直接生成HTML，然后用Puppeteer截图。
 * 对标原图效果：24小时柱状图、详细话题、聊天气泡圣经、渐变锐评。
 */

function esc(str) {
  return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function buildBarChart(hourlyActivity) {
  const max = Math.max(...hourlyActivity, 1)
  const barW = 28
  const chartH = 120
  const gap = 4
  const totalW = 24 * (barW + gap)
  let bars = ''

  const colors = ['#39C5BB', '#39C5BB', '#39C5BB', '#39C5BB', '#39C5BB', '#39C5BB',
    '#5EEAD4', '#5EEAD4', '#A7E7E3', '#A7E7E3', '#FCD34D', '#FCD34D',
    '#F472B6', '#F472B6', '#FCD34D', '#FCD34D', '#A7E7E3', '#A7E7E3',
    '#5EEAD4', '#5EEAD4', '#39C5BB', '#39C5BB', '#39C5BB', '#39C5BB']

  for (let i = 0; i < 24; i++) {
    const h = Math.max((hourlyActivity[i] / max) * chartH, 2)
    const x = i * (barW + gap)
    const y = chartH - h
    const c = hourlyActivity[i] === max ? '#F472B6' : colors[i]
    bars += `<rect x="${x}" y="${y}" width="${barW}" height="${h}" rx="3" fill="${c}"/>`
    if (hourlyActivity[i] > 0) {
      bars += `<text x="${x + barW/2}" y="${y - 4}" text-anchor="middle" font-size="9" fill="#7F8C8D" font-family="Arial">${hourlyActivity[i]}</text>`
    }
  }

  let labels = ''
  for (let i = 0; i < 24; i += 2) {
    labels += `<text x="${i * (barW + gap) + barW/2}" y="${chartH + 14}" text-anchor="middle" font-size="10" fill="#7F8C8D" font-family="Arial">${String(i).padStart(2,'0')}时</text>`
  }

  return `<svg width="${totalW}" height="${chartH + 20}" viewBox="0 0 ${totalW} ${chartH + 20}" style="display:block;margin:0 auto">
    <g transform="translate(0,0)">${bars}</g>${labels}</svg>`
}

function buildHtml(data, analysis) {
  const topics = analysis.topics || []
  const userTitles = analysis.userTitles || []
  const goldenQuotes = analysis.goldenQuotes || []
  const qr = analysis.qualityReview

  // 柱状图
  const chartHtml = buildBarChart(data.hourlyActivity || new Array(24).fill(0))

  // 话题卡片
  let topicsHtml = ''
  for (let i = 0; i < topics.length; i++) {
    const t = topics[i]
    const participants = (t.participants || []).map(p => `<span class="ptag">👤 ${esc(p)}</span>`).join('')
    topicsHtml += `
      <div class="topic-card">
        <div class="topic-num">#${String(i+1).padStart(2,'0')}</div>
        <div class="topic-body">
          <div class="topic-title">${esc(t.title)}</div>
          <div class="topic-detail">${esc(t.summary)}</div>
          <div class="topic-tags">${participants}</div>
        </div>
        <div class="topic-deco">💬</div>
      </div>`
  }

  // 群友画像（QQ头像URL）
  let profilesHtml = ''
  for (const t of userTitles) {
    const mbti = t.mbti ? `<span class="mbti-tag">${esc(t.mbti)}</span>` : ''
    const avatarUrl = t.userId ? `https://q1.qlogo.cn/g?b=qq&nk=${esc(t.userId)}&s=100` : ''
    const avatarStyle = avatarUrl
      ? `background-image:url('${avatarUrl}');background-size:cover;background-position:center`
      : `background:#39C5BB`
    const avatarContent = avatarUrl ? '' : esc((t.name || '?')[0])
    profilesHtml += `
      <div class="profile-card">
        <div class="profile-head">
          <div class="avatar" style="${avatarStyle}">${avatarContent}</div>
          <div class="profile-info">
            <div class="profile-name">${esc(t.name)} ${mbti}</div>
            <div class="profile-role">${esc(t.title)}</div>
          </div>
        </div>
        <div class="profile-desc">${esc(t.reason)}</div>
      </div>`
  }

  // 今日圣经（聊天气泡样式）
  let quotesHtml = ''
  for (const q of goldenQuotes) {
    const colors2 = ['#39C5BB','#A7E7E3','#F8BBD0','#e0f2f1']
    const ci = Math.abs((q.sender||'').charCodeAt(0) || 0) % colors2.length
    quotesHtml += `
      <div class="quote-block">
        <div class="quote-user">
          <div class="avatar-small" style="background:${colors2[ci]}">${esc((q.sender||'?')[0])}</div>
          <span class="quote-name">${esc(q.sender)}</span>
        </div>
        <div class="quote-bubble">${esc(q.content)}</div>
        <div class="quote-comment">💬 莲莲锐评</div>
        <div class="quote-comment-text">${esc(q.reason)}</div>
      </div>`
  }

  // 群聊锐评
  let qualityHtml = ''
  if (qr) {
    let dimsHtml = ''
    if (qr.dimensions && qr.dimensions.length) {
      dimsHtml = '<div class="qr-dims">'
      for (const d of qr.dimensions) {
        dimsHtml += `
          <div class="qr-dim">
            <div class="qr-dim-head">
              <span class="qr-dot" style="background:${d.color || '#39C5BB'}"></span>
              <span class="qr-dim-name">${esc(d.name)} (${d.percentage}%)</span>
            </div>
            <div class="qr-dim-comment">${esc(d.comment)}</div>
          </div>`
      }
      dimsHtml += '</div>'
    }

    // 渐变进度条
    let gradientBar = '<div class="qr-gradient-bar">'
    if (qr.dimensions && qr.dimensions.length) {
      for (const d of qr.dimensions) {
        gradientBar += `<div style="flex:${d.percentage};background:${d.color || '#39C5BB'};height:100%;border-radius:4px"></div>`
      }
    }
    gradientBar += '</div>'

    // token消耗显示
    const tokenDisplay = analysis.tokenUsage && analysis.tokenUsage.totalTokens
      ? `<span style="font-family:monospace;font-size:0.75rem;color:#7F8C8D;margin-left:auto">Token: ${analysis.tokenUsage.totalTokens}</span>`
      : ''

    qualityHtml = `
      <div class="qr-card">
        <div class="qr-header-row">
          <div>
            <div class="qr-title">${esc(qr.title)}</div>
            <div class="qr-subtitle">${esc(qr.subtitle)}</div>
          </div>
          <div style="display:flex;align-items:center;gap:8px">
            ${tokenDisplay}
            <div class="qr-deco-icon">💬</div>
          </div>
        </div>
        ${gradientBar}
        ${dimsHtml}
        <div class="qr-summary">
          <span class="qr-summary-label">🔊 莲莲点评</span>
          ${esc(qr.summary)}
        </div>
      </div>`
  }

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<style>
:root{--mb:#39C5BB;--ml:#A7E7E3;--md:#2A9D95;--mp:#F8BBD0;--my:#fff9c4;--bg:#f0fafa;--bc:rgba(255,255,255,0.98);--tm:#2c3e50;--ts:#7F8C8D;--bl:rgba(57,197,187,0.15);--r:12px}
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:'Microsoft YaHei','PingFang SC','Noto Sans SC',sans-serif;color:var(--tm);background:var(--bg);padding:0}
.wrap{max-width:800px;margin:0 auto;background:rgba(255,255,255,0.95);padding:40px;border:1px solid var(--bl);background-image:radial-gradient(rgba(57,197,187,0.05) 1px,transparent 1px);background-size:20px 20px}
.hd{display:flex;justify-content:space-between;align-items:flex-end;margin-bottom:30px;padding-bottom:12px;border-bottom:2px solid var(--mb)}
.hd h1{font-size:2rem;font-weight:800;color:var(--md)}
.hd-date{font-family:'Courier New',monospace;color:var(--md);font-weight:bold;font-size:.9rem}
.stats{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:20px}
.st{background:var(--bc);border-radius:var(--r);padding:16px;border:1px solid var(--bl);text-align:center}
.st-icon{font-size:1.1rem;margin-bottom:4px}
.st-num{font-family:Arial;font-size:1.8rem;font-weight:800}
.st-txt{font-size:.75rem;color:var(--ts);font-weight:bold}
.peak{background:linear-gradient(135deg,var(--mb),var(--ml));color:#fff;border-radius:var(--r);padding:22px 30px;margin-bottom:25px;position:relative;overflow:hidden}
.peak::after{content:"MIKU";position:absolute;right:20px;top:50%;transform:translateY(-50%);font-family:'Arial Black';font-size:110px;font-weight:900;color:rgba(255,255,255,0.15)}
.peak-lbl{font-size:.9rem;font-weight:bold}
.peak-time{font-family:'Arial Black';font-size:2.2rem;font-weight:900;margin-top:4px}
.sec{display:flex;align-items:center;margin:28px 0 16px;padding-bottom:8px;border-bottom:1px solid var(--bl)}
.bar{width:5px;height:18px;background:var(--mb);border-radius:3px;margin-right:10px}
.bar.pk{background:var(--mp)}
.sec-t{font-weight:800;font-size:1.2rem;color:var(--md)}
.chart-wrap{background:var(--bc);border-radius:var(--r);border:1px solid var(--bl);padding:20px 10px;margin-bottom:8px}
.topic-card{background:var(--bc);border-radius:var(--r);border:1px solid var(--bl);padding:18px 20px;margin-bottom:14px;display:flex;gap:14px}
.topic-num{font-family:'Arial Black';font-size:1.3rem;font-weight:900;color:var(--mb);min-width:44px}
.topic-body{flex:1}
.topic-title{font-weight:700;font-size:1rem;margin-bottom:6px}
.topic-detail{font-size:.85rem;color:var(--ts);line-height:1.6;margin-bottom:10px}
.topic-tags{display:flex;flex-wrap:wrap;gap:6px}
.ptag{background:var(--ml);color:var(--md);padding:3px 9px;border-radius:12px;font-size:.7rem;font-weight:bold}
.topic-deco{font-size:1.5rem;align-self:center;opacity:.3}
.profiles{display:grid;grid-template-columns:repeat(2,1fr);gap:12px}
.profile-card{background:var(--bc);border-radius:var(--r);border:1px solid var(--bl);padding:14px}
.profile-head{display:flex;gap:10px;align-items:center;margin-bottom:8px}
.avatar{width:36px;height:36px;border-radius:50%;display:flex;align-items:center;justify-content:center;color:#fff;font-weight:700;font-size:.9rem;flex-shrink:0}
.avatar-small{width:28px;height:28px;border-radius:50%;display:flex;align-items:center;justify-content:center;color:#fff;font-weight:700;font-size:.7rem;flex-shrink:0}
.profile-info{min-width:0}
.profile-name{font-weight:700;font-size:.9rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.mbti-tag{font-family:'Courier New',monospace;font-size:.65rem;color:var(--mb);font-weight:bold;margin-left:4px}
.profile-role{display:inline-block;background:var(--mp);color:#fff;padding:2px 8px;border-radius:8px;font-size:.65rem;font-weight:bold;margin-top:2px}
.profile-desc{font-size:.8rem;color:var(--ts);line-height:1.4}
.quote-block{background:var(--bc);border-radius:var(--r);border:1px solid var(--bl);padding:16px;margin-bottom:14px;border-left:3px solid var(--mb)}
.quote-user{display:flex;align-items:center;gap:8px;margin-bottom:8px}
.quote-name{font-weight:700;color:var(--md);font-size:.9rem}
.quote-bubble{background:#f8f9fa;border-radius:8px;padding:12px;font-size:.9rem;line-height:1.6;margin-bottom:8px}
.quote-comment{font-size:.75rem;color:var(--mb);font-weight:bold;margin-bottom:2px}
.quote-comment-text{font-size:.8rem;color:var(--mp);font-style:italic}
.qr-card{background:var(--bc);border-radius:var(--r);border:1px solid var(--bl);padding:22px}
.qr-header-row{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:16px}
.qr-title{font-weight:800;font-size:1.1rem;margin-bottom:4px}
.qr-subtitle{font-size:.85rem;color:var(--ts)}
.qr-deco-icon{font-size:2rem;opacity:.2}
.qr-gradient-bar{display:flex;height:10px;border-radius:5px;overflow:hidden;margin-bottom:18px;gap:2px}
.qr-dims{display:grid;grid-template-columns:repeat(2,1fr);gap:12px;margin-bottom:18px}
.qr-dim{background:#f8f9fa;border-radius:8px;padding:12px}
.qr-dim-head{display:flex;align-items:center;gap:6px;margin-bottom:6px}
.qr-dot{width:8px;height:8px;border-radius:50%;flex-shrink:0}
.qr-dim-name{font-weight:700;font-size:.85rem}
.qr-dim-comment{font-size:.8rem;color:var(--ts);line-height:1.4}
.qr-summary{background:var(--mb);color:#fff;padding:14px 18px;border-radius:8px;font-size:.9rem;line-height:1.6}
.qr-summary-label{display:block;font-weight:bold;margin-bottom:6px}
.ft{margin-top:30px;padding-top:12px;border-top:1px dashed var(--ml);display:flex;justify-content:space-between;font-size:.75rem;color:var(--ts)}
.ft-r{font-family:monospace;color:var(--md)}
</style>
</head>
<body>
<div class="wrap">
  <div class="hd">
    <h1>群聊日常分析看板</h1>
    <div class="hd-date">分析日期 // ${esc(data.date)}</div>
  </div>

  <div class="stats">
    <div class="st"><div class="st-icon">📊</div><div class="st-num">${data.totalMessages}</div><div class="st-txt">今日消息数</div></div>
    <div class="st"><div class="st-icon">👥</div><div class="st-num">${data.activeMembers}</div><div class="st-txt">活跃成员数</div></div>
    <div class="st"><div class="st-icon">😊</div><div class="st-num">${data.emojiCount}</div><div class="st-txt">表情互动</div></div>
    <div class="st"><div class="st-icon">💬</div><div class="st-num">${data.totalChars}</div><div class="st-txt">今日字数累计</div></div>
  </div>

  <div class="peak">
    <div class="peak-lbl">🔥 峰值活跃时间段</div>
    <div class="peak-time">${esc(data.peakHour)}</div>
  </div>

  <div class="sec"><div class="bar"></div><div class="sec-t">📈 24小时活动</div></div>
  <div class="chart-wrap">${chartHtml}</div>

  ${topicsHtml ? `<div class="sec"><div class="bar"></div><div class="sec-t">📌 话题总结</div></div><div>${topicsHtml}</div>` : ''}
  ${profilesHtml ? `<div class="sec"><div class="bar"></div><div class="sec-t">👤 群友画像</div></div><div class="profiles">${profilesHtml}</div>` : ''}
  ${quotesHtml ? `<div class="sec"><div class="bar pk"></div><div class="sec-t">✝ 今日圣经</div></div><div>${quotesHtml}</div>` : ''}
  ${qualityHtml ? `<div class="sec"><div class="bar"></div><div class="sec-t">💬 群聊锐评</div></div><div>${qualityHtml}</div>` : ''}

  <div class="ft">
    <div class="ft-r">koishi-plugin-daily-report</div>
    <div>Generated at ${new Date().toLocaleString('zh-CN')}</div>
  </div>
</div>
</body>
</html>`
}

function findBrowser() {
  const fs = require('fs')
  const candidates = process.platform === 'win32'
    ? [
        'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
        'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
      ]
    : [
        '/snap/bin/chromium',
        '/usr/bin/chromium-browser',
        '/usr/bin/chromium',
        '/usr/bin/google-chrome',
        '/usr/bin/google-chrome-stable',
      ]
  for (const p of candidates) {
    if (fs.existsSync(p)) return p
  }
  return null
}

// 信号量：限制并发Puppeteer实例（最多2个）
let activeRenderers = 0
const MAX_RENDERERS = 2
const RENDER_TIMEOUT = 30000 // 30秒超时

async function renderHtmlToImage(htmlContent) {
  // 等待信号量
  while (activeRenderers >= MAX_RENDERERS) {
    await new Promise(r => setTimeout(r, 500))
  }
  activeRenderers++

  const puppeteer = require('puppeteer-core')
  const browserPath = findBrowser()
  if (!browserPath) {
    activeRenderers--
    throw new Error('未找到Chrome/Chromium浏览器，请安装: apt install chromium-browser')
  }

  let browser = null
  try {
    browser = await puppeteer.launch({
      executablePath: browserPath, headless: 'new',
      args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage','--disable-gpu'],
    })

    // 超时保护
    const timeoutId = setTimeout(async () => {
      if (browser) {
        try { await browser.close() } catch {}
        browser = null
      }
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
    // 确保浏览器被关闭
    if (browser) {
      try { await browser.close() } catch {}
    }
    throw err
  } finally {
    if (browser) {
      try { await browser.close() } catch {}
    }
    activeRenderers--
  }
}

async function renderReport(data, analysis) {
  return renderHtmlToImage(buildHtml(data, analysis))
}

module.exports = { renderReport }
