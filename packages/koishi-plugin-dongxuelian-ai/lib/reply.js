/**
 * MODULE: 消息发送。
 * 职责: sendReply + sticker 发送 + 输出过滤（括号/敏感词）。
 * 边界: 不调 AI API，不存 conversation（saveSharedChannelTurn 等由调用方负责）。
 */
const fs = require('fs')
const path = require('path')
const { h } = require('koishi')
const { STICKER_DIR, THROTTLE_CONFIG_FILE } = require('./constants')
const { getChannelKey, saveSharedChannelTurn } = require('./conversation')
const { splitSentences, sleep, getRandomDelayMs, readJsonFile } = require('./utils')

const STICKER_GLOBAL_COOLDOWN_MS = 30000
const STICKER_FILE_COOLDOWN_MS = 120000
const lastStickerSentAt = new Map()
const throttleWindow = new Map()
const lastStickerFileSentAt = new Map()

let stickerBase64Cache = {}

function loadStickerCache() {
  try {
    stickerBase64Cache = {}
    const files = fs.readdirSync(STICKER_DIR)
    for (const f of files) {
      const buf = fs.readFileSync(path.join(STICKER_DIR, f))
      const ext = f.split('.').pop().toLowerCase()
      const mime = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif' }[ext] || 'image/jpeg'
      stickerBase64Cache[f] = `base64://${buf.toString('base64')}`
    }
  } catch {}
}

// 表情包映射（按关键词长度降序，最长优先）
const STICKER_MAP = [
  { kw: '绷不住了', file: '憋笑.jpg' },
  { kw: '你又在狗叫什么', file: '你在狗叫什么.jpg' },
  { kw: '群友怎么这么坏', file: '群友怎么这么坏.jpg' },
  { kw: '可以先叫声爸爸', file: '可以，先叫声爸爸.jpg' },
  { kw: '不想活了', file: '不想活了.jpg' },
  { kw: '考试不及格', file: '考试不及格.jpg' },
  { kw: '假装思考', file: '假装思考.jpg' },
  { kw: '顺着网线打', file: '顺着网线打你.jpg' },
  { kw: '请你吃粑粑', file: '请你吃粑粑.jpg' },
  { kw: '多充钱少抱怨', file: '多充钱少抱怨.jpg' },
  { kw: '不准发屎', file: '不准发屎.jpg' },
  { kw: '这是大便', file: '这是大便.jpg' },
  { kw: '连续打你', file: '连续打你.jpg' },
  { kw: '欧皇真讨厌', file: '欧皇真讨厌.jpg' },
  { kw: '急哭了', file: '急哭了.jpg' },
  { kw: '厉害了', file: '厉害叉手.jpg' },
  { kw: '喜欢你', file: '喜欢你.jpg' },
  { kw: '小生气', file: '小生气.jpg' },
  { kw: '无语流汗', file: '无语流汗.jpg' },
  { kw: '无语', file: '无语.jpg' },
  { kw: '难过', file: '难过.jpg' },
  { kw: '惊讶', file: '惊讶.jpg' },
  { kw: '惊醒', file: '惊醒.jpg' },
  { kw: '偷看', file: '偷看.jpg' },
  { kw: '泪目', file: '泪目.jpg' },
  { kw: '懵逼', file: '懵逼.jpg' },
  { kw: '危险', file: '危险.jpg' },
  { kw: '红温', file: '红温.jpg' },
  { kw: '呵呵', file: '呵呵.jpg' },
  { kw: '开心', file: '开心.png' },
  { kw: '哭哭', file: '哭哭.png' },
  { kw: '寄了', file: '寄了.jpg' },
  { kw: '摸鱼', file: '摸鱼.jpg' },
  { kw: '摆烂', file: '摆烂.jpg' },
  { kw: '气炸', file: '气炸了.jpg' },
  { kw: '呆滞', file: '呆滞.jpg' },
  { kw: '群友欠揍', file: '群友欠揍.jpg' },
  { kw: '不支持', file: '不支持.jpg' },
  { kw: '搞笑了', file: '搞笑.jpg' },
  { kw: '搞笑', file: '搞笑.jpg' },
  { kw: '哈哈', file: '搞笑.jpg' },
  { kw: '乐', file: '搞笑.jpg' },
  { kw: '草', file: '搞笑.jpg' },
  { kw: '绷', file: '憋笑.jpg' },
  { kw: '打你', file: '连续打你.jpg' },
  { kw: '粑粑', file: '请你吃粑粑.jpg' },
  { kw: '粑', file: '请你吃粑粑.jpg' },
  { kw: '大便', file: '这是大便.jpg' },
  { kw: '屎', file: '不准发屎.jpg' },
  { kw: '厉害', file: '厉害叉手.jpg' },
  { kw: '生气', file: '小生气.jpg' },
  { kw: '哭', file: '哭哭.png' },
].sort((a, b) => b.kw.length - a.kw.length)

// 预编译否定语境正则（避免每次 sendReply 都 new RegExp）
const STICKER_NEG_RE_MAP = new Map(
  STICKER_MAP.map(s => [s.kw, new RegExp('不.{0,3}' + s.kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))])
)

async function sendStickerImage(ctx, session, sticker) {
  const logger = ctx.logger('dongxuelian-ai')
  const image = typeof sticker === 'string' ? sticker : sticker?.image
  const file = typeof sticker === 'string' ? '' : sticker?.file
  if (!image) return false

  let internalError = null
  const bot = session.bot
  const userId = session.userId
  const isDirect = !!session.isDirect

  if (bot?.internal && userId) {
    try {
      const segArr = [{ type: 'image', data: { file: image } }]
      if (isDirect) {
        await bot.internal.sendPrivateMsg(userId, segArr)
      } else {
        if (!session.guildId) throw new Error('missing guildId for group sticker send')
        await bot.internal.sendGroupMsg(session.guildId, segArr)
      }
      logger.info(`sticker sent via internal API${file ? `: ${file}` : ''}`)
      return true
    } catch (error) {
      internalError = error
      logger.warn(`sticker internal send failed${file ? ` (${file})` : ''}: ${error.message}`)
    }
  } else {
    logger.warn(`sticker internal API not available${file ? ` (${file})` : ''}, trying Koishi image fallback`)
  }

  try {
    await session.send(h.image(image))
    logger.info(`sticker sent via Koishi image fallback${file ? `: ${file}` : ''}`)
    return true
  } catch (error) {
    const internalMsg = internalError ? `; internal=${internalError.message}` : ''
    logger.error(`sticker fallback send failed${file ? ` (${file})` : ''}: ${error.message}${internalMsg}`)
    return false
  }
}

function resolveNow(options) {
  if (typeof options?.now === 'function') return options.now
  if (typeof options?.time?.now === 'function') return options.time.now
  return Date.now
}

async function sendReply(ctx, session, reply, isRandom = false, options = {}) {
  const nowMs = resolveNow(options)
  // 全局发送节流：检查该频道是否超过每分钟上限
  try {
    const cfg = JSON.parse(fs.readFileSync(THROTTLE_CONFIG_FILE, 'utf8'))
    const maxPerMin = parseInt(cfg.maxPerMinute, 10) || 0
    if (maxPerMin > 0) {
      const windowKey = String(session.guildId || session.channelId || 'default')
      let entries = throttleWindow.get(windowKey) || []
      entries = entries.filter(function(e) { return nowMs - e < 60000 })
      if (entries.length >= maxPerMin) {
        ctx.logger('dongxuelian-ai').warn(`sendReply throttled: ${windowKey} (${entries.length}/${maxPerMin})`)
        return
      }
      entries.push(nowMs)
      throttleWindow.set(windowKey, entries)
    }
  } catch {} // 配置文件不存在或不合法时直接放行
  // 图片文件转 base64 CQ 码（使用缓存）
  const stickerToCQ = (file) => {
    const b64 = stickerBase64Cache[file]
    return b64 ? b64 : ''
  }
  // 替换 AI 主动调用的 [图:xxx] 并收集图片 base64
  const pendingStickers = []
  const addPendingSticker = (file) => {
    const image = stickerToCQ(file)
    if (image && !pendingStickers.some(sticker => sticker.file === file)) {
      pendingStickers.push({ file, image })
    }
  }
  reply = reply.replace(/\[图:(.+?)\]/g, (m, name) => {
    const match = STICKER_MAP.find(s => s.kw === name)
    if (match) {
      addPendingSticker(match.file)
    }
    return ''
  }).trim()
  // 关键词自动匹配（最长优先，30% 概率，跳过否定语境）
  if (!reply.includes('[CQ:image')) {
    const autoSkip = new Set(['喜欢你'])
    const matched = STICKER_MAP.find(s =>
      !autoSkip.has(s.kw) && reply.includes(s.kw) &&
      !STICKER_NEG_RE_MAP.get(s.kw).test(reply)
    )
    if (matched && Math.random() < 0.3) {
      addPendingSticker(matched.file)
    }
  }
  const parts = splitSentences(reply)
  const msgId = session.messageId
  const quotePrefix = msgId && (!isRandom || Math.random() < 0.2) ? `<quote id="${msgId}"/>` : ''
  const userName = (session.author?.nick || session.author?.name || session.username || '').replace(/[\s\u200b-\u200f\ufeff]+/g, '').trim()
  let sentParts = 0
  for (let i = 0; i < parts.length; i++) {
    let part = parts[i].replace(/。$/, '').trim()
    if (!part) continue
    part = part.replace(/[（(][^）)]*[）)]/g, '').trim()
    if (!part) continue
    // 引用回复时替换昵称为"你"
      // [暂禁用] 昵称替换：原意图是防止 AI 引用回复时重复昵称，
      // 但全局替换导致 AI 对用户的称呼被强制替换为"你"，效果诡异。
      // 后续优化思路：只替换引用消息中非 AI 主动提及的昵称，或不替换。
      // if (i === 0 && quotePrefix && userName && part.includes(userName)) {
      //   const esc = userName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      //   part = part
      //     .replace(new RegExp('^' + esc + '[，,、]?'), '')
      //     .replace(new RegExp('[，,]' + esc + '$'), '，你')
      //     .replace(new RegExp(esc, 'g'), '你')
      // }
    await session.send(i === 0 ? quotePrefix + part : part)
    sentParts++
    saveSharedChannelTurn(session, '东雪莲', part, 'assistant')
    if (i < parts.length - 1) {
      await sleep(getRandomDelayMs())
    }
  }
  // 发送收集到的表情包图片；fallback 只在 sticker 图片这里触发，不接管普通文本。
  const stickerChannelKey = getChannelKey(session)
  const stickerBatchStart = nowMs()
  const lastStickerAtBeforeBatch = lastStickerSentAt.get(stickerChannelKey) || 0
  for (const sticker of pendingStickers) {
    const now = nowMs()
    if (stickerBatchStart - lastStickerAtBeforeBatch < STICKER_GLOBAL_COOLDOWN_MS) {
      ctx.logger('dongxuelian-ai').info(`sticker global cooldown active (${Math.ceil((STICKER_GLOBAL_COOLDOWN_MS - (stickerBatchStart - lastStickerAtBeforeBatch)) / 1000)}s remaining), skipping ${sticker.file}`)
      continue
    }

    const stickerFileKey = `${stickerChannelKey}:${sticker.file}`
    const lastFileAt = lastStickerFileSentAt.get(stickerFileKey) || 0
    if (now - lastFileAt < STICKER_FILE_COOLDOWN_MS) {
      ctx.logger('dongxuelian-ai').info(`sticker file cooldown active (${Math.ceil((STICKER_FILE_COOLDOWN_MS - (now - lastFileAt)) / 1000)}s remaining), skipping ${sticker.file}`)
      continue
    }

    const sent = await sendStickerImage(ctx, session, sticker)
    if (sent) {
      const sentAt = nowMs()
      lastStickerSentAt.set(stickerChannelKey, sentAt)
      lastStickerFileSentAt.set(stickerFileKey, sentAt)
    }
  }
  ctx.logger('dongxuelian-ai').info(`reply sent: random=${isRandom} parts=${sentParts}`)
}

module.exports = {
  loadStickerCache,
  sendReply,
}
