/**
 * MODULE: Agent 调用统计。
 * 职责: 记录工具调用次数、耗时、渠道。
 * 边界: 只计数，不持久化。
 * 状态: calls (Array，最多 500 条)。
 */
const calls = []
const MAX_CALLS = 200

function recordCall(toolName, channel = 'unknown', meta = {}) {
  const durationMs = Number(meta.durationMs || 0)
  const tokens = Number(meta.tokens || 0)
  calls.unshift({
    tool: toolName,
    channel,
    at: Date.now(),
    ok: meta.ok !== false,
    durationMs: Number.isFinite(durationMs) && durationMs > 0 ? Math.round(durationMs) : 0,
    tokens: Number.isFinite(tokens) && tokens > 0 ? Math.round(tokens) : 0,
  })
  if (calls.length > MAX_CALLS) calls.length = MAX_CALLS
}

function average(total, count) {
  return count > 0 ? Math.round(total / count) : 0
}

function getStats() {
  const total = calls.length
  const byTool = {}
  const byToolDetail = {}
  const byChannel = {}
  let success = 0
  let durationTotal = 0
  let tokenTotal = 0
  for (const c of calls) {
    byTool[c.tool] = (byTool[c.tool] || 0) + 1
    if (!byToolDetail[c.tool]) byToolDetail[c.tool] = { total: 0, success: 0, failed: 0, durationMs: 0, tokens: 0 }
    byToolDetail[c.tool].total++
    byToolDetail[c.tool].durationMs += c.durationMs || 0
    byToolDetail[c.tool].tokens += c.tokens || 0
    byChannel[c.channel] = (byChannel[c.channel] || 0) + 1
    if (c.ok) { success++; byToolDetail[c.tool].success++ } else byToolDetail[c.tool].failed++
    durationTotal += c.durationMs || 0
    tokenTotal += c.tokens || 0
  }
  for (const detail of Object.values(byToolDetail)) {
    detail.avgDurationMs = average(detail.durationMs, detail.total)
    detail.avgTokens = average(detail.tokens, detail.total)
    detail.successRate = detail.total ? Math.round((detail.success / detail.total) * 1000) / 10 : 0
  }
  return {
    total,
    success,
    failed: total - success,
    successRate: total ? Math.round((success / total) * 1000) / 10 : 0,
    totalTokens: tokenTotal,
    avgDurationMs: average(durationTotal, total),
    avgTokens: average(tokenTotal, total),
    recent: calls.slice(0, 10),
    byTool,
    byToolDetail,
    byChannel: {
      qq: byChannel.qq || 0,
      dashboard: byChannel.dashboard || 0,
      ...byChannel,
    },
  }
}

module.exports = { recordCall, getStats }
