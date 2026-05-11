/**
 * MODULE: 今日情绪图片渲染。
 * 边界: 只把已解析的情绪分析渲染为 HTML 图片，不调用 AI，不读写历史。
 */
const { renderHtmlToImage } = require('../../koishi-plugin-daily-report/lib/html-renderer')

function esc(value) {
  return String(value || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function scoreTone(score) {
  if (score >= 65) return { name: 'warm', label: '偏乐观', color: '#f59e0b', soft: '#fff7ed' }
  if (score <= 40) return { name: 'cool', label: '偏悲观', color: '#0ea5e9', soft: '#eff6ff' }
  return { name: 'calm', label: '中性', color: '#14b8a6', soft: '#ecfdf5' }
}

function buildHistoryHtml(history) {
  if (!history || !history.length) {
    return '<div class="empty-history">暂无可对比的历史数据</div>'
  }
  return history.map(item => {
    const tone = scoreTone(item.score)
    const summary = item.summary ? `<div class="history-summary">${esc(item.summary)}</div>` : ''
    return `<div class="history-row"><div class="history-date">${esc(item.date)}</div><div class="history-bar"><span style="width:${Math.max(4, Math.min(100, item.score))}%;background:${tone.color}"></span></div><div class="history-score">${item.score}/100</div>${summary}</div>`
  }).join('')
}

function buildReasonsHtml(reasons) {
  return (reasons || []).map((reason, index) => `<div class="reason-card"><div class="reason-index">${index + 1}</div><div class="reason-text">${esc(reason)}</div></div>`).join('')
}

function buildKeywordsHtml(keywords) {
  if (!keywords || !keywords.length) return ''
  return `<div class="keywords">${keywords.map(keyword => `<span>${esc(keyword)}</span>`).join('')}</div>`
}

function renderEmotionHtml(analysis, stats, history = []) {
  const tone = scoreTone(analysis.score)
  const now = new Date().toLocaleString('zh-CN', { hour12: false })
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <style>
    * { box-sizing: border-box; }
    body {
      margin: 0;
      width: 880px;
      background: #f5f7fb;
      color: #172033;
      font-family: -apple-system, BlinkMacSystemFont, "Microsoft YaHei", "PingFang SC", sans-serif;
    }
    .page {
      width: 880px;
      padding: 34px;
      background:
        linear-gradient(135deg, rgba(255,255,255,.96), rgba(244,247,255,.96)),
        radial-gradient(circle at 12% 8%, ${tone.soft}, transparent 34%);
    }
    .hero {
      display: grid;
      grid-template-columns: 220px 1fr;
      gap: 22px;
      align-items: stretch;
      border: 1px solid rgba(15, 23, 42, .08);
      border-radius: 18px;
      background: rgba(255,255,255,.88);
      box-shadow: 0 18px 46px rgba(15, 23, 42, .12);
      overflow: hidden;
    }
    .score-panel {
      padding: 26px 22px;
      background: linear-gradient(180deg, ${tone.color}, #111827);
      color: #fff;
      display: flex;
      flex-direction: column;
      justify-content: space-between;
      min-height: 250px;
    }
    .score-label { font-size: 18px; font-weight: 800; letter-spacing: 0; }
    .score-value { font-size: 76px; line-height: 1; font-weight: 900; margin: 20px 0 8px; }
    .score-sub { font-size: 16px; opacity: .88; }
    .confidence { font-size: 14px; opacity: .82; }
    .summary-panel { padding: 28px 28px 24px 0; }
    .kicker { color: ${tone.color}; font-size: 13px; font-weight: 900; margin-bottom: 8px; }
    h1 { margin: 0 0 14px; font-size: 28px; line-height: 1.2; letter-spacing: 0; }
    .summary { font-size: 18px; line-height: 1.75; color: #334155; margin-bottom: 18px; }
    .stats { display: flex; gap: 10px; flex-wrap: wrap; }
    .stat { border: 1px solid rgba(15,23,42,.08); border-radius: 10px; padding: 8px 12px; background: #f8fafc; font-size: 14px; color: #475569; }
    .section { margin-top: 22px; }
    .section-title { font-size: 18px; font-weight: 900; margin-bottom: 12px; color: #0f172a; }
    .history { display: grid; gap: 8px; }
    .history-row {
      display: grid;
      grid-template-columns: 98px 1fr 74px;
      gap: 10px;
      align-items: center;
      border: 1px solid rgba(15,23,42,.07);
      border-radius: 12px;
      background: rgba(255,255,255,.74);
      padding: 10px 12px;
      font-size: 13px;
    }
    .history-date { font-weight: 800; color: #334155; }
    .history-bar { height: 8px; border-radius: 999px; background: #e2e8f0; overflow: hidden; }
    .history-bar span { display: block; height: 100%; border-radius: 999px; }
    .history-score { color: #475569; text-align: right; font-weight: 800; }
    .history-summary { grid-column: 1 / -1; color: #64748b; line-height: 1.45; }
    .empty-history { border: 1px dashed rgba(15,23,42,.16); border-radius: 12px; padding: 14px; color: #64748b; background: rgba(255,255,255,.58); }
    .reasons { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
    .reason-card { display: grid; grid-template-columns: 34px 1fr; gap: 10px; min-height: 86px; padding: 14px; border-radius: 14px; background: #fff; border: 1px solid rgba(15,23,42,.08); box-shadow: 0 8px 24px rgba(15,23,42,.06); }
    .reason-index { width: 34px; height: 34px; border-radius: 10px; display: grid; place-items: center; color: #fff; font-weight: 900; background: ${tone.color}; }
    .reason-text { color: #334155; line-height: 1.62; font-size: 15px; }
    .keywords { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 14px; }
    .keywords span { padding: 7px 11px; border-radius: 999px; background: ${tone.soft}; color: ${tone.color}; border: 1px solid rgba(15,23,42,.06); font-weight: 800; font-size: 13px; }
    .footer { margin-top: 22px; color: #94a3b8; font-size: 12px; text-align: right; }
  </style>
</head>
<body>
  <main class="page">
    <section class="hero">
      <div class="score-panel">
        <div>
          <div class="score-label">群聊情绪指数</div>
          <div class="score-value">${analysis.score}</div>
          <div class="score-sub">${esc(analysis.mood || tone.label)}</div>
        </div>
        <div class="confidence">置信度 ${analysis.confidence}%</div>
      </div>
      <div class="summary-panel">
        <div class="kicker">TODAY EMOTION</div>
        <h1>今日情绪分析</h1>
        <div class="summary">${esc(analysis.summary)}</div>
        <div class="stats">
          <div class="stat">文本消息 ${stats.messageCount} 条</div>
          <div class="stat">活跃成员 ${stats.userCount} 位</div>
          <div class="stat">状态 ${esc(analysis.mood || tone.label)}</div>
        </div>
        ${buildKeywordsHtml(analysis.keywords)}
      </div>
    </section>

    <section class="section">
      <div class="section-title">近5日对比</div>
      <div class="history">${buildHistoryHtml(history)}</div>
    </section>

    <section class="section">
      <div class="section-title">判断依据</div>
      <div class="reasons">${buildReasonsHtml(analysis.reasons)}</div>
    </section>

    <div class="footer">生成时间 ${esc(now)}</div>
  </main>
</body>
</html>`
}

async function renderEmotionImage(analysis, stats, history = []) {
  return renderHtmlToImage(renderEmotionHtml(analysis, stats, history))
}

module.exports = { renderEmotionHtml, renderEmotionImage }