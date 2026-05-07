/**
 * MODULE: 数据收集模块。
 * 职责: 读取今日缓存，计算统计数据。无缓存时返回null。
 */
const fs = require('fs')
const path = require('path')

const { DATA_DIR } = require('./config')

/** 返回北京时间（UTC+8）日期字符串，确保在北京时间 0:00 切换 */
function todayCst() {
  return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10)
}

function safeKey(channelKey) {
  return String(channelKey).replace(/[^a-zA-Z0-9._-]/g, '_')
}

function collectReportData(channelKey) {
  if (!DATA_DIR) return null

  const key = safeKey(channelKey)
  const today = todayCst()

  const cacheFile = path.join(DATA_DIR, `today-cache-${key}.json`)

  let cache = null
  try {
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
    if (!msg.time) continue
    // 兼容旧版 12h 制缓存（如 "3:30:00 PM"）和新版 24h 制（如 "15:30:00"）
    const timeParts = msg.time.split(':')
    let hour = parseInt(timeParts[0], 10)
    if (msg.time.includes('PM') && hour !== 12) hour += 12
    else if (msg.time.includes('AM') && hour === 12) hour = 0
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
    messages,
  }
}

module.exports = { collectReportData }
