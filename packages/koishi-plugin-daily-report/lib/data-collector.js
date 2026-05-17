/**
 * MODULE: 数据收集模块。
 * 职责: 读取今日缓存，计算统计数据。无缓存时返回null。
 */
const fs = require('fs')
const path = require('path')

const { DATA_DIR } = require('./config')
const { todayCst, getShanghaiHourFromTs } = require('../../koishi-plugin-dongxuelian-ai/lib/utils')

const MAX_CACHE_FILE_BYTES = parsePositiveInt(process.env.DAILY_REPORT_MAX_CACHE_FILE_BYTES, 8 * 1024 * 1024, 512 * 1024, 64 * 1024 * 1024)
const MAX_ANALYSIS_MESSAGES = parsePositiveInt(process.env.DAILY_REPORT_MAX_ANALYSIS_MESSAGES, 2000, 200, 10000)

function parsePositiveInt(value, fallback, min, max) {
  const parsed = parseInt(value, 10)
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(min, Math.min(max, parsed))
}

function safeKey(channelKey) {
  return String(channelKey).replace(/[^a-zA-Z0-9._-]/g, '_')
}

/** 旧缓存 time 字符串解析为 0–23（尽力兼容 24h / 12h en-US） */
function hourFromLegacyTimeString(timeStr) {
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

function messageHourShanghai(msg) {
  if (msg && typeof msg.ts === 'number' && Number.isFinite(msg.ts)) {
    const h = getShanghaiHourFromTs(msg.ts)
    if (!isNaN(h) && h >= 0 && h < 24) return h
  }
  return hourFromLegacyTimeString(msg && msg.time)
}

function collectReportData(channelKey) {
  if (!DATA_DIR) return null

  const key = safeKey(channelKey)
  const today = todayCst()

  const cacheFile = path.join(DATA_DIR, `today-cache-${key}.json`)

  let cache = null
  try {
    const stat = fs.statSync(cacheFile)
    if (!stat.isFile() || stat.size > MAX_CACHE_FILE_BYTES) return null
    const raw = fs.readFileSync(cacheFile, 'utf8')
    cache = JSON.parse(raw)
  } catch {
    return null
  }

  if (!cache || cache.date !== today || !cache.messages || !Array.isArray(cache.messages) || cache.messages.length === 0) {
    return null
  }

  return processMessages(cache.messages, today)
}

function processMessages(messages, today) {
  if (!messages.length) return null

  const totalMessages = messages.length
  const analysisMessages = messages.length > MAX_ANALYSIS_MESSAGES ? messages.slice(-MAX_ANALYSIS_MESSAGES) : messages

  const memberMap = new Map()
  for (const msg of messages) {
    const uid = msg.userId || msg.user || 'unknown'
    if (!memberMap.has(uid)) {
      memberMap.set(uid, { userId: uid, name: msg.user || '群友', msgCount: 0, firstMsg: msg.time, lastMsg: msg.time })
    }
    const m = memberMap.get(uid)
    m.msgCount++
    if (msg.time) m.lastMsg = msg.time
  }
  const activeMembers = memberMap.size
  if (activeMembers === 0) return null

  const topMembers = [...memberMap.values()]
    .sort((a, b) => b.msgCount - a.msgCount)
    .slice(0, 20)

  const faceRegex = /\[CQ:face,id=\d+\]/g
  let emojiCount = 0
  for (const msg of messages) {
    if (!msg.content) continue
    const matches = msg.content.match(faceRegex)
    if (matches) emojiCount += matches.length
  }

  let totalChars = 0
  for (const msg of messages) {
    if (!msg.content) continue
    const text = msg.content
      .replace(/\[CQ:[^\]]+\]/g, '')
      .replace(/https?:\/\/\S+/g, '')
      .replace(/【[^】]*】/g, '')
      .trim()
    totalChars += text.length
  }

  const hourlyActivity = new Array(24).fill(0)
  for (const msg of messages) {
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
    truncatedMessages: Math.max(0, messages.length - analysisMessages.length),
  }
}

module.exports = { collectReportData, processMessages, messageHourShanghai }
