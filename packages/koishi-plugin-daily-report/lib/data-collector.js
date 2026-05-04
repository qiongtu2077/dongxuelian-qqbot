/**
 * MODULE: 数据收集模块。
 * 职责: 读取今日缓存，计算统计数据。无缓存时返回null。
 */
const fs = require('fs')
const path = require('path')

const { DATA_DIR } = require('./config')

function safeKey(channelKey) {
  return String(channelKey).replace(/[^a-zA-Z0-9._-]/g, '_')
}

function collectReportData(channelKey) {
  const key = safeKey(channelKey)
  const cacheFile = path.join(DATA_DIR, `today-cache-${key}.json`)

  // 尝试读取今日缓存
  let cache = null
  try {
    const raw = fs.readFileSync(cacheFile, 'utf8')
    cache = JSON.parse(raw)
  } catch {
    // 文件不存在或读取失败
  }

  // 检查日期
  const today = new Date().toISOString().slice(0, 10)
  if (cache && cache.date === today && cache.messages && cache.messages.length > 0) {
    return processMessages(cache.messages, today)
  }

  // 无今日缓存
  return null
}

function processMessages(messages, today) {
  // 统计消息总数
  const totalMessages = messages.length

  // 统计活跃成员（去重）
  const memberMap = new Map()
  for (const msg of messages) {
    const uid = msg.userId || msg.user
    if (!memberMap.has(uid)) {
      memberMap.set(uid, { userId: uid, name: msg.user, msgCount: 0, firstMsg: msg.time, lastMsg: msg.time })
    }
    const m = memberMap.get(uid)
    m.msgCount++
    m.lastMsg = msg.time
  }
  const activeMembers = memberMap.size

  // 按消息数排序，取Top成员
  const topMembers = [...memberMap.values()]
    .sort((a, b) => b.msgCount - a.msgCount)
    .slice(0, 20)

  // 统计表情数量
  const faceRegex = /\[CQ:face,id=\d+\]/g
  let emojiCount = 0
  for (const msg of messages) {
    const matches = msg.content.match(faceRegex)
    if (matches) emojiCount += matches.length
  }

  // 统计总字数
  let totalChars = 0
  for (const msg of messages) {
    const text = msg.content.replace(/\[CQ:[^\]]+\]/g, '').trim()
    totalChars += text.length
  }

  // 计算24小时分布
  const hourlyActivity = new Array(24).fill(0)
  for (const msg of messages) {
    const hour = parseInt(msg.time.split(':')[0], 10)
    if (!isNaN(hour) && hour >= 0 && hour < 24) {
      hourlyActivity[hour]++
    }
  }

  // 找峰值时段
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
