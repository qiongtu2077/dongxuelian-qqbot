/**
 * MODULE: AI分析模块。
 * 职责: 根据模式执行不同深度的分析。
 * 边界: 复用主插件的 runtime-config.js + api.js。
 */
const { loadManagementModule } = require('koishi-plugin-dongxuelian-ai/lib/public/management-runtime') as typeof import('koishi-plugin-dongxuelian-ai/lib/public/management-runtime')
const { loadConfig } = loadManagementModule('core.runtimeConfig')
const { requestChatCompletions } = loadManagementModule('core.api')
const { createDefaultAnalysisResult, createTopic, createGoldenQuote, createUserTitle } = require('./models') as typeof import('./models')
const { getErrorMessage } = require('./error-utils') as typeof import('./error-utils')
const { parseBoundedInt: parsePositiveInt } = require('./config-utils') as typeof import('./config-utils')
const { createReportAnalysisDiagnostics, ReportAnalysisError } = loadManagementModule('daily.reportAnalysis')
const { summarizeCompleteInput, selectRepresentativeMessages, requestAnalysisUnit, createDigestExchange, readExchange, parseExchangeRecords, assertExchangeFields, assertExchangeRef, exchangeInstructions } = require('./complete-input') as typeof import('./complete-input')
type AnalysisRuntime = import('./complete-input').AnalysisRuntime
type SharedSummary = Awaited<ReturnType<typeof summarizeCompleteInput>>

interface AnalysisOptions {
  deadlineMs?: number
  workDeadlineMs?: number
  stageSoftDeadlinesMs?: AnalysisRuntime['stageSoftDeadlinesMs']
  signal?: AbortSignal
  now?: () => number
  onProgress?: AnalysisRuntime['onProgress']
}

interface ReportMessage {
  analysisId?: number
  ts?: number
  time?: string
  user?: string
  sender?: string
  nickname?: string
  userId?: string | number
  content?: string
}

interface TopMember {
  userId?: string | number
  name?: string
  msgCount?: number
}

interface ReportData {
  totalMessages?: number
  activeMembers?: number
  emojiCount?: number
  totalChars?: number
  peakHour?: string
  topMembers?: TopMember[]
  messages?: ReportMessage[]
  precomputedContext?: string
  precomputedCoverageRate?: number
  windowMessageCount?: number
  sourceCompleteness?: AnalysisMeta['sourceCompleteness']
  reportPeriod?: AnalysisMeta['reportPeriod']
  periodBackfilled?: boolean
}

interface TokenUsage {
  promptTokens: number
  completionTokens: number
  totalTokens: number
}

interface Topic {
  id: number
  title: string
  summary: string
  participants: string[]
}

interface GoldenQuote {
  content: string
  sender: string
  reason: string
  userId: string
}

interface UserTitle {
  name: string
  userId: string
  title: string
  reason: string
  mbti: string
}

interface QualityDimension {
  name: string
  percentage: number
  comment: string
  color: string
}

interface QualityReview {
  title: string
  subtitle: string
  dimensions: QualityDimension[]
  summary: string
}

interface AnalysisResult {
  topics: Topic[]
  userTitles: UserTitle[]
  goldenQuotes: GoldenQuote[]
  qualityReview: QualityReview | null
  tokenUsage: TokenUsage
  meta?: AnalysisMeta
}

type AnalysisMeta = ReturnType<typeof createReportAnalysisDiagnostics>

interface BasicAnalysis {
  topics: Topic[]
  goldenQuotes: GoldenQuote[]
}

interface FullAnalysis extends BasicAnalysis {
  userTitles: UserTitle[]
  qualityReview: QualityReview
}

interface FullSectionAnalysis {
  userTitles: UserTitle[]
  qualityReview: QualityReview
}

interface MessageMaps {
  nameToUserId: Map<string, string>
  userIdToName: Map<string, string>
}

type JsonRecord = Record<string, unknown>

const REPORT_AI_TEMPERATURE = parsePositiveFloat(process.env.DAILY_REPORT_AI_TEMPERATURE, 0.2, 0, 1)
const REPORT_ANALYSIS_TIMEOUT_MS = parsePositiveInt(process.env.DAILY_REPORT_AI_TIMEOUT_MS, 60000, 10000, 180000)

// --- Config helpers --- #

// Parses bounded float config values from environment variables.
function parsePositiveFloat(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = parseFloat(String(value))
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(min, Math.min(max, parsed))
}

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === 'object' ? value as JsonRecord : {}
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function getReportMessages(data: ReportData | null | undefined): ReportMessage[] {
  return Array.isArray(data?.messages) ? data.messages : []
}

function getTopMembers(data: ReportData | null | undefined): TopMember[] {
  return Array.isArray(data?.topMembers) ? data.topMembers : []
}

// --- AI call helpers --- #

// Calls the shared AI API with report-specific temperature and timeout options.
async function callAI(systemPrompt: string, userMessage: string, maxTokens = 1500, extraBody: Record<string, unknown> = {}): Promise<string> {
  const config = await loadConfig()
  const result = await requestChatCompletions([
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userMessage },
  ], config, {
    ...extraBody,
    max_tokens: maxTokens,
    temperature: extraBody.temperature !== undefined ? extraBody.temperature : REPORT_AI_TEMPERATURE,
  })
  return extractTextResult(result)
}

// Extracts plain text from the API wrapper's supported response shapes.
function extractTextResult(result: unknown): string {
  if (typeof result === 'string') return result.trim()
  if (!result || typeof result !== 'object') return ''
  const record = result as Record<string, unknown>
  if (typeof record.content === 'string') return record.content.trim()
  if (typeof record.output_text === 'string') return record.output_text.trim()
  if (typeof record.text === 'string') return record.text.trim()
  return ''
}

// --- Normalization helpers --- #

// Converts nullable values to trimmed strings with a fallback.
function normalizeString(value: unknown, fallback = ''): string {
  if (value === null || value === undefined) return fallback
  const text = String(value).trim()
  return text || fallback
}

// Truncates long text for compact quote/topic display.
function truncateText(text: unknown, maxLen = 80): string {
  const value = normalizeString(text)
  if (value.length <= maxLen) return value
  return value.slice(0, Math.max(1, maxLen - 1)).trimEnd() + '…'
}

// Removes CQ codes, URLs, and extra whitespace from source messages.
function cleanMessageContent(content: unknown): string {
  return normalizeString(content)
    .replace(/\[CQ:[^\]]+\]/g, '')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/【[^】]*】/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

// Builds nickname and userId lookup maps from raw messages.
function buildMessageMaps(messages: unknown): MessageMaps {
  const nameToUserId = new Map<string, string>()
  const userIdToName = new Map<string, string>()
  for (const msg of Array.isArray(messages) ? messages : []) {
    const record = asRecord(msg)
    const name = normalizeString(record.user)
    const userId = normalizeString(record.userId)
    if (!name || !userId) continue
    if (!nameToUserId.has(name)) nameToUserId.set(name, userId)
    if (!userIdToName.has(userId)) userIdToName.set(userId, name)
  }
  return { nameToUserId, userIdToName }
}

// Detects placeholders that should not be rendered as real quote speakers.
function isGenericSpeaker(name: string): boolean {
  return !name || /^(?:群友|某人|用户|匿名|unknown|unknown user)$/i.test(name)
}

// Extracts a balanced JSON object or array from AI text, including fenced blocks.
function extractJsonCandidate(text: unknown): string {
  const source = normalizeString(text)
  if (!source) return ''
  const fencedMatch = source.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const candidateSource = fencedMatch ? fencedMatch[1].trim() : source
  const start = candidateSource.search(/[{[]/)
  if (start < 0) return ''
  const open = candidateSource[start]
  const close = open === '{' ? '}' : ']'
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < candidateSource.length; i++) {
    const ch = candidateSource[i]
    if (escaped) {
      escaped = false
      continue
    }
    if (ch === '\\') {
      escaped = true
      continue
    }
    if (ch === '"') {
      inString = !inString
      continue
    }
    if (inString) continue
    if (ch === open) {
      depth++
      continue
    }
    if (ch === close) {
      depth--
      if (depth === 0) return candidateSource.slice(start, i + 1)
    }
  }
  return ''
}

// Parses JSON from direct text or an extracted JSON candidate.
function safeParseJSON(text: unknown): unknown {
  if (text && typeof text === 'object') return text
  const source = normalizeString(text)
  if (!source) return null
  try {
    return JSON.parse(source)
  } catch {
    /* non-critical: direct parse failed, try extracted JSON candidate */
  }
  const candidate = extractJsonCandidate(source)
  if (!candidate) return null
  try {
    return JSON.parse(candidate)
  } catch {
    /* non-critical: malformed AI JSON falls back to deterministic data */
  }
  return null
}

// Normalizes an AI-provided array of labels or participant names.
function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const result: string[] = []
  for (const item of value) {
    const text = normalizeString(item)
    if (text) result.push(text)
  }
  return result
}

// Normalizes topic objects into the renderer's expected model shape.
function normalizeTopics(topics: unknown): Topic[] {
  if (!Array.isArray(topics)) return []
  const result: Topic[] = []
  for (let i = 0; i < topics.length; i++) {
    const item = asRecord(topics[i])
    if (!Object.keys(item).length) continue
    result.push(createTopic(
      Number.isFinite(Number(item.id)) ? Number(item.id) : i + 1,
      normalizeString(item.title, `话题${i + 1}`),
      normalizeString(item.summary, '本段群聊内容还可以继续细化。'),
      normalizeStringArray(item.participants),
    ))
  }
  return result
}

// Normalizes quote objects and keeps only quotes with resolvable speakers.
function normalizeGoldenQuotes(quotes: unknown, messages: unknown): GoldenQuote[] {
  if (!Array.isArray(quotes) || !quotes.length) return []
  const { nameToUserId, userIdToName } = buildMessageMaps(messages)
  const result: GoldenQuote[] = []
  for (const raw of quotes) {
    const item = asRecord(raw)
    if (!Object.keys(item).length) continue
    const content = cleanMessageContent(item.content || item.quote || '')
    if (!content) continue
    let sender = normalizeString(item.sender || item.name || item.user)
    let userId = normalizeString(item.userId || item.uid)
    if (!userId && sender && nameToUserId.has(sender)) userId = nameToUserId.get(sender) || ''
    if (userId && userIdToName.has(userId)) sender = userIdToName.get(userId) || sender
    if (!sender || isGenericSpeaker(sender)) continue
    result.push(createGoldenQuote(
      truncateText(content, 90),
      sender,
      normalizeString(item.reason, '这句很有代表性，适合当作今日金句。'),
      userId,
    ))
  }
  return result
}

// Normalizes member portrait objects into the renderer's expected model shape.
function normalizeUserTitles(userTitles: unknown, messages: unknown): UserTitle[] {
  if (!Array.isArray(userTitles) || !userTitles.length) return []
  const { nameToUserId, userIdToName } = buildMessageMaps(messages)
  const result: UserTitle[] = []
  for (const raw of userTitles) {
    const item = asRecord(raw)
    if (!Object.keys(item).length) continue
    const rawName = normalizeString(item.name || item.sender || item.user)
    const userId = normalizeString(item.userId || item.uid)
    const resolvedName = (userId && userIdToName.get(userId)) || rawName
    const resolvedUserId = userId || (rawName && nameToUserId.get(rawName)) || ''
    if (!resolvedName && !resolvedUserId) continue
    result.push(createUserTitle(
      resolvedName || '群友',
      resolvedUserId,
      normalizeString(item.title, '活跃群友'),
      normalizeString(item.reason, '今天的发言记录还能继续细化。'),
      normalizeString(item.mbti),
    ))
  }
  return result
}

// Normalizes the quality review block and rejects unusable dimension payloads.
function normalizeQualityReview(review: unknown): QualityReview | null {
  const record = asRecord(review)
  if (!Object.keys(record).length) return null
  const dimensions = Array.isArray(record.dimensions)
    ? record.dimensions.map((raw, index): QualityDimension | null => {
      const item = asRecord(raw)
      if (!Object.keys(item).length) return null
      const percentage = Number(item.percentage)
      return {
        name: normalizeString(item.name, `维度${index + 1}`),
        percentage: Number.isFinite(percentage) ? Math.max(0, Math.min(100, percentage)) : 0,
        comment: normalizeString(item.comment, '暂无点评'),
        color: normalizeString(item.color, ['#39C5BB', '#A7E7E3', '#FCD34D', '#F472B6'][index % 4]),
      }
    }).filter((item): item is QualityDimension => Boolean(item))
    : []
  if (!dimensions.length) return null
  return {
    title: normalizeString(record.title, '今日群聊热度在线'),
    subtitle: normalizeString(record.subtitle, '群聊内容可继续细化。'),
    dimensions,
    summary: normalizeString(record.summary, '整体来看，今天的群聊有稳定的活跃节奏。'),
  }
}

// --- Fallback builders --- #

// Builds quote cards from raw messages when AI quote extraction fails.
function buildFallbackGoldenQuotes(data: ReportData | null | undefined): GoldenQuote[] {
  const messages = getReportMessages(data)
  const topIds = new Set(getTopMembers(data)
    .map(member => normalizeString(member.userId))
    .filter(Boolean))
  const { nameToUserId, userIdToName } = buildMessageMaps(messages)
  const scored: Array<{ content: string, sender: string, userId: string, score: number, index: number }> = []
  for (let index = 0; index < messages.length; index++) {
    const msg = messages[index] || {}
    const content = cleanMessageContent(msg.content)
    if (!content) continue
    const sender = normalizeString(msg.user || msg.sender || msg.nickname)
    const userId = normalizeString(msg.userId)
    let score = content.length
    if (content.length >= 24) score += 8
    if (content.length >= 48) score += 8
    if (/[！？!?]/.test(content)) score += 15
    if (/哈哈|笑|233|乐|绷|绝了|有点东西/.test(content)) score += 12
    if (topIds.has(userId)) score += 6
    scored.push({ content, sender, userId, score, index })
  }
  scored.sort((a, b) => b.score - a.score || a.index - b.index)

  const result: GoldenQuote[] = []
  const seen = new Set<string>()
  for (const item of scored) {
    let sender = item.sender
    let userId = item.userId
    if (!userId && sender && nameToUserId.has(sender)) userId = nameToUserId.get(sender) || ''
    if (userId && userIdToName.has(userId)) sender = userIdToName.get(userId) || sender
    if (!sender || isGenericSpeaker(sender)) continue
    const key = `${sender}::${item.content}`
    if (seen.has(key)) continue
    seen.add(key)
    result.push(createGoldenQuote(
      truncateText(item.content, 90),
      sender,
      '这句很有代表性，适合当作今日金句。',
      userId,
    ))
    if (result.length >= 3) break
  }

  if (!result.length) {
    const fallbackMember = getTopMembers(data)[0] || null
    result.push(createGoldenQuote(
      '今天群里暂时没有抓到特别典型的金句。',
      normalizeString(fallbackMember && fallbackMember.name, '群友'),
      '兜底生成的说明句。',
      normalizeString(fallbackMember && fallbackMember.userId),
    ))
  }

  return result
}

// Builds the minimal topic and quote analysis needed by detailed reports.
function buildFallbackBasicAnalysis(data: ReportData | null | undefined): BasicAnalysis {
  const topMembers = getTopMembers(data).slice(0, 4)
  const participantNames = topMembers.map(member => normalizeString(member.name)).filter(Boolean)
  const participants = participantNames.length ? participantNames : ['群友']
  const totalMessages = Number(data && data.totalMessages || 0)
  const activeMembers = Number(data && data.activeMembers || 0)
  const emojiCount = Number(data && data.emojiCount || 0)
  const totalChars = Number(data && data.totalChars || 0)
  const peakHour = normalizeString(data && data.peakHour, '未知时段')

  return {
    topics: [
      createTopic(1, '发言主力盘点', `今天共有 ${totalMessages} 条消息、${activeMembers} 位成员参与，${participants.join('、')} 等人构成了主要发言层。`, participants),
      createTopic(2, `${peakHour} 活跃波峰`, `群聊的最高活跃段落出现在 ${peakHour}，这段时间更容易连续接话和推进话题。`, participants.slice(0, 3)),
      createTopic(3, '表情互动节奏', `今天共有 ${emojiCount} 次表情互动，说明群里的情绪表达和轻松互动都比较明显。`, participants.slice(0, 3)),
      createTopic(4, '文本信息密度', `累计文本约 ${totalChars} 字，群聊内容并不只是刷屏，也保留了一定的信息密度。`, participants.slice(0, 3)),
    ],
    goldenQuotes: buildFallbackGoldenQuotes(data),
  }
}

// Builds member portrait cards from active-member statistics.
function buildFallbackUserTitles(data: ReportData | null | undefined): UserTitle[] {
  const members = getTopMembers(data).slice(0, 6)
  const titles = ['高频发言担当', '话题推进器', '稳定插话人', '气氛补给站', '边角料捕手', '潜在节奏点']
  const result = members.map((member, index) => {
    const msgCount = Number(member && member.msgCount || 0)
    const percent = data && data.totalMessages ? Math.round(msgCount * 100 / data.totalMessages) : 0
    const name = normalizeString(member && member.name, '群友')
    const reason = `今天发言 ${msgCount} 条，约占全群 ${percent}%，是本群可见度较高的活跃成员。`
    return createUserTitle(name, normalizeString(member && member.userId), titles[index] || '活跃群友', reason, '')
  })
  if (result.length) return result
  return [createUserTitle('群友', '', '活跃群友', '今天的发言记录还不够多，但已经能看到基本活跃度。', '')]
}

// Builds a deterministic quality review from report statistics.
function buildFallbackQualityReview(data: ReportData | null | undefined): QualityReview {
  const totalMessages = Number(data && data.totalMessages || 0)
  const activeMembers = Number(data && data.activeMembers || 0)
  const emojiCount = Number(data && data.emojiCount || 0)
  const emojiRate = totalMessages ? Math.round(emojiCount * 100 / totalMessages) : 0
  return {
    title: '今日群聊热度在线',
    subtitle: `${totalMessages} 条消息，${activeMembers} 位成员参与，峰值出现在 ${normalizeString(data && data.peakHour, '未知时段')}`,
    dimensions: [
      {
        name: '聊天活跃度',
        percentage: 40,
        comment: `全天累计 ${totalMessages} 条消息，峰值时段清晰，群聊热度不低。`,
        color: '#39C5BB',
      },
      {
        name: '成员参与度',
        percentage: 25,
        comment: `${activeMembers} 位成员参与发言，核心发言者撑起了主要讨论。`,
        color: '#A7E7E3',
      },
      {
        name: '信息密度',
        percentage: 20,
        comment: `累计文字约 ${Number(data && data.totalChars || 0)} 字，适合提炼成话题和金句。`,
        color: '#FCD34D',
      },
      {
        name: '表情浓度',
        percentage: 15,
        comment: `表情互动 ${emojiCount} 次，约占消息量 ${emojiRate}%，气氛有明显波动。`,
        color: '#F472B6',
      },
    ],
    summary: '整体来看，今天的群聊有明确活跃高峰和核心发言成员，内容足够支撑日报复盘；如果话题再集中一点，阅读价值还能继续上升。',
  }
}

// Builds the full fallback analysis payload for detailed reports.
function buildFallbackFullAnalysis(data: ReportData | null | undefined): FullAnalysis {
  return {
    ...buildFallbackBasicAnalysis(data),
    userTitles: buildFallbackUserTitles(data),
    qualityReview: buildFallbackQualityReview(data),
  }
}

// --- 正式分析校验 --- #

// 必要文字字段必须真实返回，不能用默认标题或点评掩盖缺失。
function requiredText(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`日报分析缺少必要文字：${field}`)
  return value.trim()
}

// 话题引用必须来自最终共同摘要；金句只通过可信来源恢复完整原话。
function readBasicAnalysis(text: string, summary: SharedSummary, messages: ReportMessage[], full: boolean): BasicAnalysis {
  const context = createDigestExchange(summary.topics, summary.quoteRefs, messages)
  const result = readExchange(text, context)
  if (result.topics.length < (full ? 5 : 1) || result.topics.length > (full ? 10 : 5)) {
    throw new Error(full ? `详细日报需要5—10个有来源依据的话题，实际返回${result.topics.length}个；请将摘要中相互独立的具体讨论拆开，可沿用同一条目的ref，不能编造` : '普通日报话题数量无效')
  }
  const titles = new Set<string>()
  const memberNames = new Map(messages.map(message => [String(message.userId || ''), String(message.user || '')]))
  const topics = result.topics.map((item, index) => {
    const normalizedTitle = item.title.toLowerCase()
    if (titles.has(normalizedTitle)) throw new Error('日报话题重复，不能凑数')
    titles.add(normalizedTitle)
    return createTopic(index + 1, item.title, item.summary, item.participants.map(id => memberNames.get(id) || id))
  })
  const goldenQuotes = result.quoteRefs.map(item => {
    const source = messages[item.sourceId - 1]
    return createGoldenQuote(requiredText(source.content, '金句原始正文'), requiredText(source.user, '金句实际昵称'),
      item.reason, requiredText(String(source.userId || ''), '金句成员标识'))
  })
  return { topics, goldenQuotes }
}

// 校验全部必要成员画像和锐评，不允许空字段变成默认统计画像。
function readFullAnalysis(text: string, members: Array<{ ref: string; userId: string; name: string }>): FullSectionAnalysis {
  const records = parseExchangeRecords(text)
  const value: { userTitles: JsonRecord[]; qualityReview?: JsonRecord } = { userTitles: [] }
  for (const record of records) {
    const { kind, ...item } = record
    if (kind === 'portrait' && !value.qualityReview) value.userTitles.push(item)
    else if (kind === 'review' && !value.qualityReview) value.qualityReview = item
    else throw new Error('[RECORD_ORDER] 详细分析必须先输出全部portrait，随后输出唯一review')
  }
  const expected = new Map(members.map(member => [member.ref, member]))
  if (value.userTitles.length !== expected.size) throw new Error(`详细日报成员画像不完整：需要${expected.size}条，实际${value.userTitles.length}条`)
  const seen = new Set<string>()
  const userTitles = value.userTitles.map(raw => {
    const item = raw
    assertExchangeFields(item, ['ref', 'title', 'mbti', 'reason'], '成员画像')
    const ref = assertExchangeRef(item.ref, expected, 'userTitles.ref')
    if (seen.has(ref)) throw new Error('[REF_DUPLICATE] 详细日报画像重复引用' + ref)
    seen.add(ref)
    if (item.mbti !== undefined && typeof item.mbti !== 'string') throw new Error('详细日报画像性格字段无效')
    return createUserTitle(expected.get(ref)!.name, expected.get(ref)!.userId, requiredText(item.title, '成员角色'),
      requiredText(item.reason, '成员画像说明'), item.mbti as string || '')
  })
  if (!value.qualityReview) throw new Error('详细日报缺少群聊锐评')
  const review = value.qualityReview as JsonRecord
  assertExchangeFields(review, ['title', 'subtitle', 'dimensions', 'summary'], 'qualityReview')
  if (!Array.isArray(review.dimensions) || review.dimensions.length < 4 || review.dimensions.length > 5) throw new Error('详细日报锐评需要4—5个有效维度')
  const colors = ['#39C5BB', '#A7E7E3', '#FCD34D', '#F472B6', '#60A5FA']
  const dimensionNames = new Set<string>()
  const dimensions = review.dimensions.map((raw, index) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('详细日报锐评维度结构无效')
    const item = raw as JsonRecord
    assertExchangeFields(item, ['name', 'percentage', 'comment'], `qualityReview.dimensions[${index}]`)
    const name = requiredText(item.name, '锐评维度名称')
    if (dimensionNames.has(name)) throw new Error('详细日报锐评维度重复')
    dimensionNames.add(name)
    if (typeof item.percentage !== 'number' || !Number.isFinite(item.percentage) || item.percentage < 0 || item.percentage > 100) {
      throw new Error('详细日报锐评维度占比无效')
    }
    return { name, percentage: item.percentage,
      comment: requiredText(item.comment, '锐评维度点评'), color: colors[index] }
  })
  if (dimensions.reduce((total, item) => total + item.percentage, 0) <= 0) throw new Error('详细日报锐评维度占比全部为零')
  return { userTitles, qualityReview: { title: requiredText(review.title, '锐评标题'), subtitle: requiredText(review.subtitle, '锐评副标题'),
    summary: requiredText(review.summary, '锐评总结'), dimensions } }
}

// --- 正式模型分析阶段 --- #

// 完整共同摘要进入最终话题请求，真实提交后才记录话题输入覆盖。
async function analyzeBasic(summary: SharedSummary, messages: ReportMessage[], full: boolean, meta: AnalysisMeta, runtime: AnalysisRuntime): Promise<BasicAnalysis> {
  meta.stages.basic = 'processing'
  const system = '你是群聊分析师。完整阅读items，完善' + (full ? '5—10' : '4—5') + '个有依据、彼此不同的主要话题。逐个完善已有条目的具体讨论，不能再次把独立话题合成生活、技术等大类。一个输入条目确实涵盖多个讨论时可根据summary拆分并沿用其ref。真实内容不足时不要编造，普通版可返回实际话题数。金句只能选择quotes的ref。\n' + exchangeInstructions(full ? 6000 : 4000) + '\n必须归组的完整ref清单：' + summary.topics.map((_, index) => 'r' + (index + 1)).join(',')
  const result = await requestAnalysisUnit(runtime, meta, { id: 'topics', stage: 'basic', sourceIds: [...summary.sourceIds], timestamps: [],
    onSubmitted: () => {
      meta.topicInputMessageCount = summary.sourceIds.size
      meta.omittedMessageCount = meta.selectedMessageCount - summary.sourceIds.size
      meta.coverageRate = meta.selectedMessageCount ? 100 * summary.sourceIds.size / meta.selectedMessageCount : null
    } }, system, summary.digest, full ? 4000 : 2500, REPORT_ANALYSIS_TIMEOUT_MS,
    text => readBasicAnalysis(text, summary, messages, full))
  meta.stages.basic = 'complete'
  runtime.onProgress?.(meta)
  return result
}

// 用同一共同摘要及全天代表性例句生成详细画像与锐评，原消息仍完整经过摘要。
async function analyzeFull(summary: SharedSummary, messages: ReportMessage[], topMembers: TopMember[], meta: AnalysisMeta, runtime: AnalysisRuntime): Promise<FullSectionAnalysis> {
  const selectedIds = new Set(messages.map(message => String(message.userId || '')))
  const memberData = topMembers.slice(0, 8).filter(member => selectedIds.has(String(member.userId || ''))).map((member, index) => ({
    ref: 'p' + (index + 1),
    name: String(member.name || ''),
    userId: String(member.userId || ''),
    msgCount: Number(member.msgCount || 0),
    samples: selectRepresentativeMessages(messages, String(member.userId || '')).map(message => ({
      time: message.time || '',
      excerpt: Array.from(String(message.content || '')).slice(0, 200).join(''),
    })),
  }))
  if (memberData.some(member => !member.userId || !member.name) || new Set(memberData.map(member => member.userId)).size !== memberData.length) {
    throw new ReportAnalysisError('详细日报活跃成员数据无效', 'generation_failed', 'full', meta)
  }
  meta.stages.full = 'processing'
  const system = `你是群聊分析师。完整阅读用户输入的共同摘要和成员数据，为成员数据中每个ref生成有依据的画像，并完成群聊质量锐评；不要新增成员或用统计模板填充缺失结果。
成员例句来自本次入选消息的不同时段，是辅助摘录；全体入选正文已进入共同摘要。
只输出逐条JSON对象，不写外层数组或userTitles/qualityReview包装。每位成员一条portrait记录：{"kind":"portrait","ref":"输入成员的ref","title":"角色标签","mbti":"","reason":"发言特点和依据"}。
全部portrait之后输出唯一review记录：{"kind":"review","title":"标题","subtitle":"副标题","dimensions":[{"name":"维度","percentage":25,"comment":"实际点评"}],"summary":"总结"}。最后必须输出{"kind":"end"}。记录间可用换行或单个逗号分隔，全部数组及对象必须闭合，end之后不能添加逗号。
portrait恰好覆盖所有输入成员，mbti可以为空；review需要4—5个不同维度，percentage为0到100的数值，所有必要说明不能为空。`
  const result = await requestAnalysisUnit(runtime, meta, { id: 'portraits', stage: 'full', sourceIds: [...summary.sourceIds], timestamps: [] },
    system, JSON.stringify({ digest: JSON.parse(summary.digest), members: memberData.map(({ userId, ...member }) => member) }), 4500, REPORT_ANALYSIS_TIMEOUT_MS,
    text => readFullAnalysis(text, memberData))
  meta.stages.full = 'complete'
  runtime.onProgress?.(meta)
  return result
}

// 记录每个最终分析阶段的实际耗时；并行阶段各自计时且共享硬截止。
async function measureAnalysisStage<T>(stage: string, meta: AnalysisMeta, runtime: AnalysisRuntime, run: () => Promise<T>): Promise<T> {
  const now = runtime.now || Date.now
  const start = now()
  try { return await run() } finally { meta.stageDurationsMs[stage] = Math.max(0, now() - start) }
}

// 全部入选来源完整摘要后才分析，任何必要结果失败都向任务管线传播。
async function analyzeWithAI(data: ReportData, full = false, options: AnalysisOptions = {}): Promise<AnalysisResult> {
  const messages = getReportMessages(data)
  const meta = createReportAnalysisDiagnostics({
    windowMessageCount: data.windowMessageCount ?? data.totalMessages ?? messages.length,
    selectedMessageCount: messages.length, sourceCompleteness: data.sourceCompleteness || 'legacy_unknown',
    reportPeriod: data.reportPeriod, periodBackfilled: data.periodBackfilled,
  })
  const now = options.now || Date.now
  const runtime: AnalysisRuntime = { deadlineMs: options.deadlineMs ?? now() + 600000, signal: options.signal, now,
    workDeadlineMs: options.workDeadlineMs, stageSoftDeadlinesMs: options.stageSoftDeadlinesMs,
    onProgress: options.onProgress, topicRange: { min: full ? 5 : 1, max: full ? 10 : 5 }, request: callAI }
  try {
    if (runtime.signal?.aborted) throw runtime.signal.reason || new Error('日报任务已取消')
    if (meta.sourceCompleteness === 'incomplete') throw new ReportAnalysisError('日报原始记录不完整', 'generation_failed', 'collecting', meta)
    const summary = await measureAnalysisStage('summary_and_merge', meta, runtime, () => summarizeCompleteInput(messages, meta, runtime))
    const result = createDefaultAnalysisResult() as AnalysisResult
    if (full) {
      const outcomes = await Promise.allSettled([
        measureAnalysisStage('basic', meta, runtime, () => analyzeBasic(summary, messages, true, meta, runtime)),
        measureAnalysisStage('full', meta, runtime, () => analyzeFull(summary, messages, getTopMembers(data), meta, runtime)),
      ])
      const failures = outcomes.filter((outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected')
      if (failures.length) throw (failures.find(outcome => outcome.reason?.code === 'DAILY_REPORT_TOTAL_TIMEOUT') || failures[0]).reason
      const basic = (outcomes[0] as PromiseFulfilledResult<BasicAnalysis>).value
      const detailed = (outcomes[1] as PromiseFulfilledResult<FullSectionAnalysis>).value
      result.topics = basic.topics; result.goldenQuotes = basic.goldenQuotes
      result.userTitles = detailed.userTitles; result.qualityReview = detailed.qualityReview
    } else {
      const basic = await measureAnalysisStage('basic', meta, runtime, () => analyzeBasic(summary, messages, false, meta, runtime))
      result.topics = basic.topics; result.goldenQuotes = basic.goldenQuotes
      meta.stages.full = 'not_requested'
    }
    if (now() >= runtime.deadlineMs) throw new ReportAnalysisError('日报运行总时限已耗尽', 'total_timeout', 'analysis', meta)
    if (meta.topicInputMessageCount !== messages.length || meta.omittedMessageCount !== 0) throw new ReportAnalysisError('最终话题输入覆盖不完整', 'generation_failed', 'basic', meta)
    meta.analysisState = 'complete'
    result.tokenUsage = { ...meta.tokenUsage }
    result.meta = meta
    runtime.onProgress?.(meta)
    return result
  } catch (error) {
    if (runtime.signal?.aborted) throw runtime.signal.reason || error
    const failure = error instanceof ReportAnalysisError ? error :
      new ReportAnalysisError(getErrorMessage(error), now() >= runtime.deadlineMs ? 'total_timeout' : 'generation_failed', 'analysis', meta)
    runtime.onProgress?.(meta)
    throw failure
  }
}

export = { analyzeWithAI, buildFallbackFullAnalysis, buildFallbackBasicAnalysis }
