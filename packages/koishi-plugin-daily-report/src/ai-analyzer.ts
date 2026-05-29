/**
 * MODULE: AI分析模块。
 * 职责: 根据模式执行不同深度的分析。
 * 边界: 复用主插件的 runtime-config.js + api.js。
 */
const { loadConfig } = require('../../koishi-plugin-dongxuelian-ai/lib/core/runtime-config') as typeof import('../../koishi-plugin-dongxuelian-ai/lib/core/runtime-config')
const { requestChatCompletions } = require('../../koishi-plugin-dongxuelian-ai/lib/core/api') as typeof import('../../koishi-plugin-dongxuelian-ai/lib/core/api')
const { createDefaultAnalysisResult, createTopic, createGoldenQuote, createUserTitle } = require('./models') as typeof import('./models')

interface ReportMessage {
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

interface AnalysisMeta {
  warnings: string[]
  stages: {
    compression: string
    basic: string
    full: string
  }
}

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

const COMPRESS_BATCH_SIZE = parsePositiveInt(process.env.DAILY_REPORT_COMPRESS_BATCH_SIZE, 100, 20, 200)
const MAX_COMPRESS_BATCHES = parsePositiveInt(process.env.DAILY_REPORT_MAX_COMPRESS_BATCHES, 20, 1, 60)
const MAX_COMPRESSED_CHARS = parsePositiveInt(process.env.DAILY_REPORT_MAX_COMPRESSED_CHARS, 12000, 2000, 40000)
const REPORT_AI_TEMPERATURE = parsePositiveFloat(process.env.DAILY_REPORT_AI_TEMPERATURE, 0.2, 0, 1)
const REPORT_COMPRESS_TIMEOUT_MS = parsePositiveInt(process.env.DAILY_REPORT_COMPRESS_TIMEOUT_MS, 45000, 5000, 180000)
const REPORT_ANALYSIS_TIMEOUT_MS = parsePositiveInt(process.env.DAILY_REPORT_AI_TIMEOUT_MS, 60000, 10000, 180000)

// --- Config helpers --- #

// Parses bounded integer config values from environment variables.
function parsePositiveInt(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = parseInt(String(value), 10)
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(min, Math.min(max, parsed))
}

// Parses bounded float config values from environment variables.
function parsePositiveFloat(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = parseFloat(String(value))
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(min, Math.min(max, parsed))
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === 'object' ? value as JsonRecord : {}
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
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

// Appends a warning to the analysis metadata.
function addMetaWarning(meta: AnalysisMeta | null | undefined, message: string): void {
  if (!meta || !message) return
  meta.warnings.push(message)
}

// Creates a metadata object that records degraded analysis stages.
function createAnalysisMeta(): AnalysisMeta {
  return {
    warnings: [],
    stages: {
      compression: 'ai',
      basic: 'ai',
      full: 'ai',
    },
  }
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
  const messages = Array.isArray(data && data.messages) ? data.messages : []
  const topIds = new Set((Array.isArray(data && data.topMembers) ? data.topMembers : [])
    .map(member => normalizeString(member && member.userId))
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
    const fallbackMember = Array.isArray(data && data.topMembers) && data.topMembers.length ? data.topMembers[0] : null
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
  const topMembers = Array.isArray(data && data.topMembers) ? data.topMembers.slice(0, 4) : []
  const participantNames = topMembers.map(member => normalizeString(member && member.name)).filter(Boolean)
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
  const members = Array.isArray(data && data.topMembers) ? data.topMembers.slice(0, 6) : []
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

// Fills missing basic sections from deterministic fallback data.
function completeBasicAnalysis(result: AnalysisResult, data: ReportData): AnalysisResult {
  const fallback = buildFallbackBasicAnalysis(data)
  if (!Array.isArray(result.topics) || result.topics.length === 0) {
    result.topics = fallback.topics
  }
  if (!Array.isArray(result.goldenQuotes) || result.goldenQuotes.length === 0) {
    result.goldenQuotes = fallback.goldenQuotes
  }
  return result
}

// Fills missing detailed sections from deterministic fallback data.
function completeFullAnalysis(result: AnalysisResult, data: ReportData): AnalysisResult {
  const fallback = buildFallbackFullAnalysis(data)
  if (!Array.isArray(result.topics) || result.topics.length === 0) {
    result.topics = fallback.topics
  }
  if (!Array.isArray(result.goldenQuotes) || result.goldenQuotes.length === 0) {
    result.goldenQuotes = fallback.goldenQuotes
  }
  if (!Array.isArray(result.userTitles) || result.userTitles.length === 0) {
    result.userTitles = fallback.userTitles
  }
  if (!result.qualityReview || typeof result.qualityReview !== 'object') {
    result.qualityReview = fallback.qualityReview
  }
  return result
}

// --- AI analysis stages --- #

// Compresses long message history into bounded summaries before analysis.
async function compressMessages(messages: unknown, meta?: AnalysisMeta): Promise<string> {
  const limited = (Array.isArray(messages) ? messages : []).slice(-COMPRESS_BATCH_SIZE * MAX_COMPRESS_BATCHES)
  const results: string[] = []
  let failedBatches = 0
  const totalBatches = Math.max(1, Math.ceil(limited.length / COMPRESS_BATCH_SIZE))

  for (let i = 0; i < limited.length; i += COMPRESS_BATCH_SIZE) {
    const batch = limited.slice(i, i + COMPRESS_BATCH_SIZE)
    const batchText = batch.map(m => {
      const msg = asRecord(m)
      return `[${msg.time}] ${msg.user}：${msg.content}`
    }).join('\n')
    try {
      const summary = await callAI(
        '你是群聊摘要助手。将以下群聊记录压缩成100字以内的摘要，保留主要话题和有趣对话。不要评价，只摘要。',
        batchText.slice(0, 4000),
        200,
        { _timeoutMs: REPORT_COMPRESS_TIMEOUT_MS },
      )
      if (summary) results.push(summary)
      else failedBatches++
    } catch {
      failedBatches++
    }
    if (results.join('\n---\n').length >= MAX_COMPRESSED_CHARS) break
  }

  if (meta) {
    meta.stages.compression = failedBatches === 0 ? 'ai' : (results.length ? 'partial' : 'fallback')
    if (failedBatches > 0) {
      addMetaWarning(meta, failedBatches >= totalBatches
        ? '压缩阶段全部失败，已直接使用统计兜底。'
        : `压缩阶段有 ${failedBatches} 批未能稳定生成摘要，已继续使用剩余结果。`)
    }
  }

  const compressed = results.join('\n---\n').slice(0, MAX_COMPRESSED_CHARS)
  if (!compressed && meta) addMetaWarning(meta, '压缩摘要为空，后续分析将主要依赖统计兜底。')
  return compressed
}

// Runs topic and golden-quote analysis, falling back per section on bad output.
async function analyzeBasic(compressed: string, messages: ReportMessage[], data: ReportData, meta?: AnalysisMeta): Promise<BasicAnalysis> {
  const { nameToUserId } = buildMessageMaps(messages)
  const memberMapStr = JSON.stringify(Object.fromEntries(nameToUserId))

  const prompt = `你是群聊分析师。根据以下压缩后的群聊摘要，完成两项任务：

1. 提取4-5个主要话题（标题6-12字，摘要50-80字，参与成员）
2. 精选3条最有趣/有梗的金句（发言者、原话、简短点评）

重要规则：
- 金句的sender必须使用原始消息中的确切昵称，不能用"群友""某人"等泛称
- userId必须从以下映射表中查找，查不到的不要编造
- 如果无法确定某条金句的发送者对应映射表中的哪个用户，则不生成该条金句

用户昵称→QQ号映射表：
${memberMapStr}

压缩摘要：
${compressed.slice(0, 6000)}

输出JSON：
{
  "topics": [{"id":1,"title":"标题","summary":"摘要","participants":["用户1"]}],
  "goldenQuotes": [{"sender":"昵称","userId":"QQ号","content":"原话","reason":"点评"}]
}`

  try {
    const text = await callAI(prompt, '请分析', 2000, {
      _timeoutMs: REPORT_ANALYSIS_TIMEOUT_MS,
    })
    const parsed = asRecord(safeParseJSON(text))
    const topics = normalizeTopics(parsed.topics)
    const goldenQuotes = normalizeGoldenQuotes(parsed.goldenQuotes, messages)
    const fallback = buildFallbackBasicAnalysis(data)
    const result = {
      topics: topics.length ? topics : fallback.topics,
      goldenQuotes: goldenQuotes.length ? goldenQuotes : fallback.goldenQuotes,
    }
    if (meta) {
      const usedFallback = topics.length === 0 || goldenQuotes.length === 0
      meta.stages.basic = usedFallback ? (Object.keys(parsed).length ? 'partial' : 'fallback') : 'ai'
      if (usedFallback) addMetaWarning(meta, '基础分析返回的 JSON 不完整，已启用话题/金句兜底。')
    }
    return result
  } catch (err) {
    if (meta) {
      meta.stages.basic = 'fallback'
      addMetaWarning(meta, `基础分析请求失败：${getErrorMessage(err)}`)
    }
    return buildFallbackBasicAnalysis(data)
  }
}

// Runs detailed portrait and quality-review analysis, falling back per section.
async function analyzeFull(compressed: string, messages: ReportMessage[], topMembers: TopMember[], data: ReportData, meta?: AnalysisMeta): Promise<FullSectionAnalysis> {
  const memberData = (Array.isArray(topMembers) ? topMembers : []).slice(0, 8).map(m => {
    const sample = (Array.isArray(messages) ? messages : [])
      .filter(msg => msg.userId === m.userId || msg.user === m.name)
      .slice(0, 15)
      .map(msg => msg.content).join(' | ')
    return { name: m.name, userId: m.userId, msgCount: m.msgCount, sample: sample.slice(0, 300) }
  })

  const prompt = `你是群聊分析师。根据以下压缩摘要和成员数据，完成两项任务：

1. 为每位活跃成员生成画像（角色标签、MBTI可选、50字特征描述）
2. 写一段群聊质量锐评（标题、副标题、4-5个维度含占比和点评、总结）

压缩摘要：
${compressed.slice(0, 4000)}

成员数据：
${JSON.stringify(memberData, null, 2)}

输出JSON：
{
  "userTitles": [{"name":"用户名","userId":"ID","title":"角色标签","mbti":"","reason":"描述"}],
  "qualityReview": {
    "title":"标题","subtitle":"副标题",
    "dimensions": [{"name":"维度","percentage":40,"comment":"点评","color":"#39C5BB"}],
    "summary":"总结"
  }
}`

  try {
    const text = await callAI(prompt, '请分析', 3000, {
      _timeoutMs: REPORT_ANALYSIS_TIMEOUT_MS,
    })
    const parsed = asRecord(safeParseJSON(text))
    const userTitles = normalizeUserTitles(parsed.userTitles, messages)
    const qualityReview = normalizeQualityReview(parsed.qualityReview)
    const fallback = buildFallbackFullAnalysis(data)
    const result = {
      userTitles: userTitles.length ? userTitles : fallback.userTitles,
      qualityReview: qualityReview || fallback.qualityReview,
    }
    if (meta) {
      const usedFallback = userTitles.length === 0 || !qualityReview
      meta.stages.full = usedFallback ? (Object.keys(parsed).length ? 'partial' : 'fallback') : 'ai'
      if (usedFallback) addMetaWarning(meta, '详细分析返回的 JSON 不完整，已启用画像/锐评兜底。')
    }
    return result
  } catch (err) {
    if (meta) {
      meta.stages.full = 'fallback'
      addMetaWarning(meta, `详细分析请求失败：${getErrorMessage(err)}`)
    }
    const fallback = buildFallbackFullAnalysis(data)
    return { userTitles: fallback.userTitles, qualityReview: fallback.qualityReview }
  }
}

// Main entry: generates AI-enhanced analysis with deterministic fallbacks.
async function analyzeWithAI(data: ReportData, full = false): Promise<AnalysisResult> {
  const result = createDefaultAnalysisResult() as AnalysisResult
  const meta = createAnalysisMeta()

  try {
    const messages = asArray(data.messages) as ReportMessage[]
    const compressed = await compressMessages(messages, meta)

    if (full) {
      const [basicResult, fullResult] = await Promise.allSettled([
        analyzeBasic(compressed, messages, data, meta),
        analyzeFull(compressed, messages, data.topMembers || [], data, meta),
      ])
      const basic = basicResult.status === 'fulfilled' ? basicResult.value : buildFallbackBasicAnalysis(data)
      const fullR = fullResult.status === 'fulfilled'
        ? fullResult.value
        : ((fallback) => ({ userTitles: fallback.userTitles, qualityReview: fallback.qualityReview }))(buildFallbackFullAnalysis(data))
      result.topics = basic.topics || []
      result.goldenQuotes = basic.goldenQuotes || []
      result.userTitles = fullR.userTitles || []
      result.qualityReview = fullR.qualityReview || null
      completeFullAnalysis(result, data)
    } else {
      const basicResult = await analyzeBasic(compressed, messages, data, meta)
      result.topics = basicResult.topics || []
      result.goldenQuotes = basicResult.goldenQuotes || []
      completeBasicAnalysis(result, data)
    }

    // token估算：中文约2字符=1 token，加上prompt开销
    // 压缩阶段：N批 × 200 tokens
    // 分析阶段：1-2次调用 × 1500 tokens
    const batches = Math.min(MAX_COMPRESS_BATCHES, Math.ceil((Array.isArray(data.messages) ? data.messages.length : 0) / COMPRESS_BATCH_SIZE))
    const compressTokens = batches * 200
    const analysisTokens = full ? 3500 : 2000
    result.tokenUsage = {
      promptTokens: compressTokens + analysisTokens,
      completionTokens: 0,
      totalTokens: compressTokens + analysisTokens,
    }
  } catch (err) {
    addMetaWarning(meta, `分析流程异常：${getErrorMessage(err)}`)
    if (full) completeFullAnalysis(result, data)
    else completeBasicAnalysis(result, data)
  }

  result.meta = meta
  return result
}

export = { analyzeWithAI, buildFallbackFullAnalysis, buildFallbackBasicAnalysis }
