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
const { generateMockAnalysis } = require('./mock-data')

// 冷却机制（带过期清理）
const cooldown = new Map()
const COOLDOWN_CLEANUP_INTERVAL = 600000

function cleanupCooldown() {
  const now = Date.now()
  for (const [key, ts] of cooldown) {
    if (now - ts > TIMEOUTS.cooldown) cooldown.delete(key)
  }
}

// 读取主插件的白名单
function isGroupWhitelisted(channelKey) {
  const dataDir = process.env.DONGXUELIAN_AI_DATA_DIR
  if (!dataDir) return false
  try {
    const raw = fs.readFileSync(path.join(dataDir, 'summary-whitelist.json'), 'utf8')
    const whitelist = JSON.parse(raw)
    return Array.isArray(whitelist) && whitelist.includes(String(channelKey))
  } catch {
    return false
  }
}

exports.name = 'daily-report'

exports.apply = (ctx) => {
  ctx.on('ready', () => {
    ctx.logger('daily-report').info('daily-report loaded')
    setInterval(cleanupCooldown, COOLDOWN_CLEANUP_INTERVAL)
  })

  ctx.middleware(async (session, next) => {
    const content = session.content || ''

    if (content === '群聊日报' || content === '/群聊日报') {
      const channelKey = session.guildId || session.channelId || 'private'

      if (!session.guildId) {
        await session.send('这个命令只能在群里使用。')
        return
      }

      // 白名单检查
      if (!isGroupWhitelisted(channelKey)) {
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
      await session.send('正在生成群聊日报，请稍候...')

      try {
        let analysis
        try {
          analysis = await analyzeWithAI(data)
        } catch (aiErr) {
          ctx.logger('daily-report').warn(`AI分析失败，使用演示数据: ${aiErr.message}`)
          analysis = generateMockAnalysis(data)
        }

        if (!analysis.topics.length && !analysis.userTitles.length && !analysis.goldenQuotes.length) {
          ctx.logger('daily-report').warn('AI分析返回空结果，使用演示数据')
          analysis = generateMockAnalysis(data)
        }

        const imageBuffer = await renderReport(data, analysis)
        const base64 = imageBuffer.toString('base64')
        await session.send(h.image(`base64://${base64}`))

        cooldown.set(channelKey, Date.now())
        ctx.logger('daily-report').info(`日报生成成功: ${data.date}, ${data.totalMessages}条消息`)
      } catch (err) {
        ctx.logger('daily-report').error(`日报生成失败: ${err.message}`)
        await session.send('日报生成失败了，请稍后再试。')
      }
      return
    }

    return next()
  })
}
