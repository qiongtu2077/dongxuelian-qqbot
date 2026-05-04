/**
 * MODULE: 群聊日报插件入口。
 * 职责: 通过中间件拦截消息，识别并处理日报命令。
 * 边界: 不自己管理白名单，复用主插件的 summary-whitelist.json。
 */
const { h } = require('koishi')
const fs = require('fs')
const path = require('path')
const { TIMEOUTS } = require('./config')
const { collectReportData } = require('./data-collector')
const { analyzeWithAI } = require('./ai-analyzer')
const { renderReport } = require('./html-renderer')

// 冷却机制
const cooldown = new Map()

// 白名单缓存（避免每次同步读文件）
let whitelistCache = null
let whitelistCacheTime = 0
const WHITELIST_CACHE_TTL = 60000 // 1分钟刷新

function getWhitelist() {
  const now = Date.now()
  if (whitelistCache && now - whitelistCacheTime < WHITELIST_CACHE_TTL) {
    return whitelistCache
  }
  const dataDir = process.env.DONGXUELIAN_AI_DATA_DIR
  if (!dataDir) { whitelistCache = []; return whitelistCache }
  try {
    const raw = fs.readFileSync(path.join(dataDir, 'summary-whitelist.json'), 'utf8')
    const arr = JSON.parse(raw)
    whitelistCache = Array.isArray(arr) ? arr.map(String) : []
  } catch {
    whitelistCache = []
  }
  whitelistCacheTime = now
  return whitelistCache
}

exports.name = 'daily-report'

exports.apply = (ctx) => {
  ctx.on('ready', () => {
    ctx.logger('daily-report').info('daily-report loaded')
  })

  ctx.middleware(async (session, next) => {
    const content = session.content || ''
    const isFull = content === '群聊详细日报' || content === '/群聊详细日报'
    const isBasic = content === '群聊日报' || content === '/群聊日报'

    if (isFull || isBasic) {
      const channelKey = session.guildId || session.channelId || 'private'

      if (!session.guildId) {
        await session.send('这个命令只能在群里使用。')
        return
      }

      // 白名单检查
      const whitelist = getWhitelist()
      if (!whitelist.includes(String(channelKey))) {
        await session.send('本群未启用日报功能，请联系管理员添加白名单。')
        return
      }

      // 冷却检查
      const lastReport = cooldown.get(channelKey) || 0
      if (Date.now() - lastReport < TIMEOUTS.cooldown) {
        await session.send('日报生成太频繁了，1分钟后再试。')
        return
      }

      // 收集数据
      const data = collectReportData(channelKey)
      if (!data || data.messages.length === 0) {
        await session.send('今天还没有收录足够消息，稍后再试。')
        return
      }

      // 发送提示
      const modeLabel = isFull ? '详细日报' : '日报'
      await session.send(`正在生成群聊${modeLabel}，请稍候...`)

      try {
        const analysis = await analyzeWithAI(data, isFull)
        const imageBuffer = await renderReport(data, analysis)
        const base64 = imageBuffer.toString('base64')
        await session.send(h.image(`data:image/png;base64,${base64}`))

        cooldown.set(channelKey, Date.now())
        ctx.logger('daily-report').info(`${modeLabel}生成成功: ${data.date}, ${data.totalMessages}条消息`)
      } catch (err) {
        ctx.logger('daily-report').error(`${modeLabel}生成失败: ${err.message}`)
        await session.send(`${modeLabel}生成失败了，请稍后再试。`)
      }
      return
    }

    return next()
  })
}
