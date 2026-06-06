/**
 * MODULE: 数据收集模块。
 * 职责: 读取今日缓存，计算统计数据。无缓存时返回null。
 */
const fs = require('fs')
const path = require('path')

const { DATA_DIR } = require('./config') as typeof import('./config')
const { todayCst, getShanghaiHourFromTs, safeChannelKey } = require('../../koishi-plugin-dongxuelian-ai/lib/core/utils') as typeof import('../../koishi-plugin-dongxuelian-ai/lib/core/utils')

interface ReportMessage {
  time?: string
  ts?: number
  user?: string
  userId?: string | number
  content?: string
}

interface TopMember {
  userId: string | number
  name: string
  msgCount: number
  firstMsg?: string
  lastMsg?: string
}

interface ReportData {
  date: string
  totalMessages: number
  activeMembers: number
  emojiCount: number
  totalChars: number
  hourlyActivity: number[]
  peakHour: string
  topMembers: TopMember[]
  messages: ReportMessage[]
  analysisMessages: ReportMessage[]
  sampledMessages: number
  truncatedMessages: number
}

interface TodayCache {
  date?: string
  messages?: ReportMessage[]
}

const MAX_CACHE_FILE_BYTES = parsePositiveInt(process.env.DAILY_REPORT_MAX_CACHE_FILE_BYTES, 8 * 1024 * 1024, 512 * 1024, 64 * 1024 * 1024)
const MAX_ANALYSIS_MESSAGES = parsePositiveInt(process.env.DAILY_REPORT_MAX_ANALYSIS_MESSAGES, 2000, 200, 10000)
const CQ_EMOJI_RE = /\[CQ:(?:face|mface)\b[^\]]*\]/gi
const XML_EMOJI_RE = /<(?:face|mface)\b[^>]*\/?>/gi
const TEXT_EMOJI_RE = /【QQ表情[^】]*】/g
const UNICODE_EMOJI_RE = /\p{Extended_Pictographic}/gu

function parsePositiveInt(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = parseInt(String(value), 10)
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(min, Math.min(max, parsed))
}

/** 计算上海日历日边界，用于把 today-cache 中跨日恢复的消息过滤掉。 */
function getShanghaiDayBounds(today: string): { startMs: number, endMs: number } | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(today || ''))) return null
  const startMs = Date.parse(`${today}T00:00:00.000+08:00`)
  const endMs = Date.parse(`${today}T23:59:59.999+08:00`)
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return null
  return { startMs, endMs }
}

/** 判断消息时间戳是否属于本次日报日期，且不晚于当前生成时刻。 */
function isMessageInReportDay(msg: ReportMessage | null | undefined, today: string, now = Date.now()): boolean {
  const ts = Number(msg && msg.ts)
  if (!Number.isFinite(ts) || ts <= 0) return false
  const bounds = getShanghaiDayBounds(today)
  if (!bounds) return false
  const cappedEnd = Math.min(bounds.endMs, Number.isFinite(now) ? now : Date.now())
  return ts >= bounds.startMs && ts <= cappedEnd
}

/** 旧缓存 time 字符串解析为 0–23（尽力兼容 24h / 12h en-US） */
function hourFromLegacyTimeString(timeStr: unknown): number {
  if (!timeStr || typeof timeStr !== 'string') return NaN
  const s = timeStr.trim()
  const m24 = s.match(/^(\d{1,2}):(\d{2})/)
  if (!m24) return NaN
  let h = parseInt(m24[1], 10)
  const rest = s.slice(m24[0].length).toUpperCase()
  if (rest.includes('PM') && h < 12) h += 12
  if (rest.includes('AM') && h === 12) h = 0
  if (h >= 0 && h < 24) return h
  return NaN
}

function messageHourShanghai(msg: ReportMessage | null | undefined): number {
  if (msg && typeof msg.ts === 'number' && Number.isFinite(msg.ts)) {
    const h = getShanghaiHourFromTs(msg.ts)
    if (!isNaN(h) && h >= 0 && h < 24) return h
  }
  return hourFromLegacyTimeString(msg && msg.time)
}

function collectReportData(channelKey: unknown): ReportData | null {
  if (!DATA_DIR) return null

  const rawKey = String(channelKey)
  const key = rawKey ? safeChannelKey(rawKey) : rawKey
  const today = todayCst()

  const cacheFile = path.join(DATA_DIR, `today-cache-${key}.json`)

  let cache: TodayCache | null = null
  try {
    const stat = fs.statSync(cacheFile)
    if (!stat.isFile() || stat.size > MAX_CACHE_FILE_BYTES) return null
    const raw = fs.readFileSync(cacheFile, 'utf8')
    cache = JSON.parse(raw)
  } catch {
    return null
  }

  if (!cache || !cache.messages || !Array.isArray(cache.messages) || cache.messages.length === 0) {
    return null
  }

  return processMessages(cache.messages, today)
}

/** 统计 CQ、XML、可读 QQ 表情标记和 Unicode emoji 数量。 */
function countEmojiInContent(content: unknown): number {
  const text = String(content || '')
  if (!text) return 0
  let total = 0
  for (const re of [CQ_EMOJI_RE, XML_EMOJI_RE, TEXT_EMOJI_RE, UNICODE_EMOJI_RE]) {
    re.lastIndex = 0
    total += (text.match(re) || []).length
  }
  return total
}

function processMessages(messages: ReportMessage[], today: string, now = Date.now()): ReportData | null {
  const reportMessages = (Array.isArray(messages) ? messages : []).filter(msg => isMessageInReportDay(msg, today, now))
  if (!reportMessages.length) return null

  const totalMessages = reportMessages.length
  const analysisMessages = reportMessages.length > MAX_ANALYSIS_MESSAGES ? reportMessages.slice(-MAX_ANALYSIS_MESSAGES) : reportMessages

  const memberMap = new Map<string | number, TopMember>()
  for (const msg of reportMessages) {
    const uid = msg.userId || msg.user || 'unknown'
    if (!memberMap.has(uid)) {
      memberMap.set(uid, { userId: uid, name: msg.user || '群友', msgCount: 0, firstMsg: msg.time, lastMsg: msg.time })
    }
    const m = memberMap.get(uid)
    if (!m) continue
    m.msgCount++
    if (msg.time) m.lastMsg = msg.time
  }
  const activeMembers = memberMap.size
  if (activeMembers === 0) return null

  const topMembers = [...memberMap.values()]
    .sort((a, b) => b.msgCount - a.msgCount)
    .slice(0, 20)

  let emojiCount = 0
  for (const msg of reportMessages) emojiCount += countEmojiInContent(msg.content)

  let totalChars = 0
  for (const msg of reportMessages) {
    if (!msg.content) continue
    const text = msg.content
      .replace(/\[CQ:[^\]]+\]/g, '')
      .replace(/<(?:face|mface)\b[^>]*\/?>/gi, '')
      .replace(/https?:\/\/\S+/g, '')
      .replace(/【[^】]*】/g, '')
      .trim()
    totalChars += text.length
  }

  const hourlyActivity = new Array(24).fill(0)
  for (const msg of reportMessages) {
    const hour = messageHourShanghai(msg)
    if (!isNaN(hour) && hour >= 0 && hour < 24) {
      hourlyActivity[hour]++
    }
  }

  let maxHour = 0
  let maxCount = 0
  for (let i = 0; i < 24; i++) {
    if (hourlyActivity[i] > maxCount) {
      maxCount = hourlyActivity[i]
      maxHour = i
    }
  }
  const peakHour = `${String(maxHour).padStart(2, '0')}:00-${String(maxHour).padStart(2, '0')}:59`

  return {
    date: today,
    totalMessages,
    activeMembers,
    emojiCount,
    totalChars,
    hourlyActivity,
    peakHour,
    topMembers,
    messages: analysisMessages,
    analysisMessages,
    sampledMessages: analysisMessages.length,
    truncatedMessages: Math.max(0, reportMessages.length - analysisMessages.length),
  }
}

export = { collectReportData, processMessages, messageHourShanghai, isMessageInReportDay, countEmojiInContent }
