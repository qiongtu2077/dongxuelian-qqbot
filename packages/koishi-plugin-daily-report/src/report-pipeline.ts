/**
 * MODULE: 日报生成管线。
 * 职责: 生成日报文字、可选图片和结构化结果，不直接发送 QQ 消息。
 * 边界: 不管理 S2 任务状态，不获取 S0 锁，调用方负责准入、锁和通知。
 */
const fs = require('fs')
const path = require('path')
const { collectReportData } = require('./data-collector') as typeof import('./data-collector')
const { analyzeWithAI } = require('./ai-analyzer') as typeof import('./ai-analyzer')
const { renderReport } = require('./html-renderer') as typeof import('./html-renderer')

interface DailyReportPipelineOptions {
  taskId?: string
  channelKey: unknown
  detail?: boolean
  outputDir: string
  renderImage?: boolean
  onStep?: (step: string) => unknown
}

interface DailyReportPipelineResult extends Record<string, unknown> {
  ok: boolean
  taskId: string
  kind: string
  level: string
  mode: string
  reason: string
  textPath: string
  imagePath: string | null
  warnings: string[]
}

interface TopMemberLike {
  name?: string
  msgCount?: number
}

interface ReportDataLike {
  date?: string
  totalMessages?: number
  activeMembers?: number
  emojiCount?: number
  totalChars?: number
  peakHour?: string
  topMembers?: TopMemberLike[]
  messages?: unknown[]
  precomputedCoverageRate?: number
}

interface AnalysisLike {
  topics?: Array<{ title?: string; summary?: string }>
  goldenQuotes?: Array<{ sender?: string; content?: string; reason?: string }>
  userTitles?: Array<{ name?: string; title?: string; reason?: string }>
  qualityReview?: { title?: string; summary?: string } | null
  meta?: { warnings?: unknown }
}

// 把未知错误压成稳定字符串，供 result.json 和 worker 日志使用。
function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error || '')
}

// 确保输出目录存在。
function ensureOutputDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true })
}

// 把文本限制到 QQ 可接受的保底长度。
function clampReportText(text: string, maxChars = 3500): string {
  if (text.length <= maxChars) return text
  return `${text.slice(0, Math.max(0, maxChars - 20))}\n...\n内容已截断`
}

// 提取 AI 分析阶段给出的降级或异常提示。
function collectAnalysisWarnings(analysis: AnalysisLike): string[] {
  const warnings = analysis?.meta?.warnings
  return Array.isArray(warnings) ? warnings.map(String).filter(Boolean).slice(0, 20) : []
}

// 生成可直接发送的文字版日报，作为图片失败时的保底结果。
function composeDailyReportText(data: ReportDataLike, analysis: AnalysisLike, options: { detail?: boolean; reason?: string } = {}): string {
  const lines: string[] = []
  const title = options.detail ? '群聊详细日报' : '群聊日报'
  lines.push(`${title} 文字版`)
  if (options.reason) lines.push(`结果说明：${options.reason}`)
  lines.push(`日期：${data.date || '未知'}`)
  lines.push(`消息：${Number(data.totalMessages || 0)} 条`)
  lines.push(`活跃成员：${Number(data.activeMembers || 0)} 人`)
  lines.push(`表情：${Number(data.emojiCount || 0)} 个`)
  lines.push(`总字数：${Number(data.totalChars || 0)} 字`)
  lines.push(`高峰：${data.peakHour || '未知'}`)
  if (Number.isFinite(Number(data.precomputedCoverageRate))) {
    lines.push(`预计算覆盖率：${Number(data.precomputedCoverageRate || 0).toFixed(3)}`)
  }

  const topMembers = Array.isArray(data.topMembers) ? data.topMembers.slice(0, 5) : []
  if (topMembers.length) {
    lines.push('', '活跃群友：')
    for (let i = 0; i < topMembers.length; i++) {
      const member = topMembers[i]
      lines.push(`${i + 1}. ${member.name || '群友'}：${Number(member.msgCount || 0)} 条`)
    }
  }

  const topics = Array.isArray(analysis.topics) ? analysis.topics.slice(0, 5) : []
  if (topics.length) {
    lines.push('', '话题摘要：')
    for (const topic of topics) lines.push(`- ${topic.title || '话题'}：${topic.summary || '暂无摘要'}`)
  }

  const quotes = Array.isArray(analysis.goldenQuotes) ? analysis.goldenQuotes.slice(0, 3) : []
  if (quotes.length) {
    lines.push('', '今日金句：')
    for (const quote of quotes) {
      const reason = quote.reason ? ` (${quote.reason})` : ''
      lines.push(`- ${quote.sender || '群友'}：${quote.content || ''}${reason}`)
    }
  }

  const titles = Array.isArray(analysis.userTitles) ? analysis.userTitles.slice(0, 4) : []
  if (titles.length) {
    lines.push('', '群友画像：')
    for (const item of titles) {
      const reason = item.reason ? `：${item.reason}` : ''
      lines.push(`- ${item.name || '群友'}：${item.title || '活跃群友'}${reason}`)
    }
  }

  if (analysis.qualityReview) {
    lines.push('', '群聊锐评：')
    lines.push(`${analysis.qualityReview.title || '今日群聊'}：${analysis.qualityReview.summary || '暂无总结'}`)
  }

  return clampReportText(lines.join('\n'))
}

// 原子写入文本文件。
function writeTextFile(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`
  fs.writeFileSync(temp, text, 'utf8')
  fs.renameSync(temp, file)
}

// 原子写入二进制文件。
function writeBufferFile(file: string, buffer: Buffer): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`
  fs.writeFileSync(temp, buffer)
  fs.renameSync(temp, file)
}

// 原子写入 JSON 文件。
function writeJsonFile(file: string, data: unknown): void {
  writeTextFile(file, JSON.stringify(data, null, 2))
}

// 构造日报结果 JSON 的公共字段。
function buildResultBase(taskId: string, data: ReportDataLike, analysis: AnalysisLike, textPath: string, warnings: string[]): DailyReportPipelineResult {
  return {
    ok: true,
    taskId,
    kind: 'daily_report',
    level: 'L2',
    mode: 'text',
    reason: 'text_ready',
    textPath,
    imagePath: null,
    warnings,
    date: data.date || '',
    totalMessages: Number(data.totalMessages || 0),
    activeMembers: Number(data.activeMembers || 0),
    precomputedCoverageRate: Number(data.precomputedCoverageRate || 0),
    analysisMeta: analysis.meta || null,
  }
}

// 执行日报生成管线并写入 result 目录。
async function generateDailyReportResult(options: DailyReportPipelineOptions): Promise<DailyReportPipelineResult> {
  const taskId = String(options.taskId || `daily-report-${Date.now()}`)
  const outputDir = String(options.outputDir || '')
  if (!outputDir) throw new Error('daily report outputDir is required')
  ensureOutputDir(outputDir)

  const emitStep = (step: string): void => {
    if (typeof options.onStep === 'function') options.onStep(step)
  }

  emitStep('collecting')
  const data = collectReportData(options.channelKey) as ReportDataLike | null
  if (!data || !Array.isArray(data.messages) || data.messages.length === 0) {
    const textPath = path.join(outputDir, 'report.txt')
    writeTextFile(textPath, '今天还没有收录足够消息，稍后再试。')
    const result: DailyReportPipelineResult = {
      ok: true,
      taskId,
      kind: 'daily_report',
      level: 'L3',
      mode: 'summary',
      reason: 'no_report_data',
      textPath,
      imagePath: null,
      warnings: ['no report data'],
    }
    writeJsonFile(path.join(outputDir, 'result.json'), result)
    return result
  }

  emitStep('analyzing')
  const analysis = await analyzeWithAI(data as any, !!options.detail) as AnalysisLike
  const warnings = collectAnalysisWarnings(analysis)

  emitStep('compose_text')
  const textPath = path.join(outputDir, 'report.txt')
  const text = composeDailyReportText(data, analysis, { detail: !!options.detail })
  writeTextFile(textPath, text)

  const result = buildResultBase(taskId, data, analysis, textPath, warnings)
  if (options.renderImage === false) {
    result.reason = 'render_disabled'
    writeJsonFile(path.join(outputDir, 'result.json'), result)
    return result
  }

  emitStep('rendering')
  try {
    const imageBuffer = await renderReport(data as any, analysis as any, { taskId })
    const imagePath = path.join(outputDir, 'report.png')
    writeBufferFile(imagePath, imageBuffer)
    result.level = 'L0'
    result.mode = 'image'
    result.reason = 'completed'
    result.imagePath = imagePath
  } catch (error) {
    result.level = 'L2'
    result.mode = 'text'
    result.reason = `render_failed:${getErrorMessage(error)}`
    result.warnings = [...result.warnings, result.reason]
  }

  emitStep('writing_result')
  writeJsonFile(path.join(outputDir, 'result.json'), result)
  return result
}

export = {
  composeDailyReportText,
  generateDailyReportResult,
}
