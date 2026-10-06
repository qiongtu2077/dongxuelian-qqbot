/** 实际浏览器验收两套模板；只用虚构内容、隔离输出和真实截图，不发送消息。 */
'use strict'
const assert = require('assert').strict
const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')

// 单模板子进程在加载配置前固定模板，保留正式渲染及浏览器清理逻辑。
async function renderOne(template, outputDir) {
  process.env.DAILY_REPORT_TEMPLATE = template
  const puppeteer = require('puppeteer-core')
  const originalLaunch = puppeteer.launch.bind(puppeteer)
  let measured
  puppeteer.launch = async options => {
    const browser = await originalLaunch(options)
    const originalNewPage = browser.newPage.bind(browser)
    browser.newPage = async () => {
      const page = await originalNewPage()
      const setContent = page.setContent.bind(page)
      page.setContent = async (html, options) => { fs.writeFileSync(path.join(outputDir, template), html); return setContent(html, options) }
      const screenshot = page.screenshot.bind(page)
      page.screenshot = async options => {
        measured = await page.evaluate(() => {
          const title = document.querySelector('.hd h1').getBoundingClientRect()
          const date = document.querySelector('.hd-date').getBoundingClientRect()
          const period = document.querySelector('.hd-period').getBoundingClientRect()
          const header = document.querySelector('.hd').getBoundingClientRect()
          return { topics: document.querySelectorAll('.topic-card').length,
          portraits: document.querySelectorAll('.profile-card').length, text: document.body.innerText,
          fullHeight: Math.max(document.body.scrollHeight, document.documentElement.scrollHeight),
          lastTopicBottom: document.querySelectorAll('.topic-card')[9].getBoundingClientRect().bottom,
          reviewBottom: document.querySelector('.qr-summary').getBoundingClientRect().bottom,
          header: { titleRight: title.right, dateLeft: date.left, firstRowBottom: Math.max(title.bottom, date.bottom),
            periodTop: period.top, periodBottom: period.bottom, periodRight: period.right, bottom: header.bottom, right: header.right } }
        })
        measured.captureHeight = options.clip.height
        return screenshot(options)
      }
      return page
    }
    return browser
  }
  const { renderReport } = require('../lib/html-renderer')
  const { createReportPeriod } = require('koishi-plugin-dongxuelian-ai/lib/daily-precompute/report-period')
  const reportPeriod = createReportPeriod(Date.parse('2026-10-02T03:59:00+08:00'))
  const data = { date: reportPeriod.reportDate, reportPeriod, totalMessages: 4000, activeMembers: 8, emojiCount: 200,
    totalChars: 80000, peakHour: '21:00', hourlyActivity: Array.from({ length: 24 }, (_, i) => i * 5) }
  const analysis = { topics: Array.from({ length: 10 }, (_, i) => ({ title: `主题${i + 1}：具体讨论`,
    summary: `第${i + 1}个主题讨论了实际问题、解决过程和最终结论。前中后时段的信息均有保留。`, participants: ['成员甲', '成员乙'] })),
    userTitles: Array.from({ length: 8 }, (_, i) => ({ userId: `fixture-${i}`, name: `成员${i + 1}`, title: '讨论参与者', mbti: '', reason: `成员${i + 1}画像：参与不同时间的讨论，提出问题并分享解决经验。` })),
    goldenQuotes: [{ userId: 'fixture-0', sender: '成员1', content: '先确认事实，再一起解决问题。', reason: '原话体现了讨论方式。' }],
    qualityReview: { title: '完整讨论评价', subtitle: '信息与互动均有依据', summary: '锐评结尾完整保留，全部十个主题和八位成员画像均已展示。',
      dimensions: ['信息', '互动', '组织', '情绪'].map(name => ({ name, percentage: 25, comment: `${name}维度说明完整。`, color: '#39C5BB' })) } }
  const buffer = await renderReport(data, analysis, { taskId: `template-${template}`, deadlineMs: Date.now() + 60000, workDeadlineMs: Date.now() + 55000 })
  assert.equal(measured.topics, 10); assert.equal(measured.portraits, 8)
  assert(measured.header.titleRight <= measured.header.dateLeft, '页头标题与分析日期重叠')
  assert(measured.header.periodTop >= measured.header.firstRowBottom, '统计时段必须位于标题和日期下方')
  assert(measured.header.periodBottom <= measured.header.bottom && measured.header.periodRight <= measured.header.right, '统计时段溢出页头')
  assert(measured.text.includes('2026-10-01') && measured.text.includes('北京时间'))
  assert(!measured.text.includes('覆盖率'))
  assert(measured.fullHeight <= measured.captureHeight && measured.captureHeight <= 6000)
  assert(measured.lastTopicBottom < measured.captureHeight && measured.reviewBottom < measured.captureHeight)
  for (let i = 1; i <= 10; i++) assert(measured.text.includes(`第${i}个主题`))
  for (let i = 1; i <= 8; i++) assert(measured.text.includes(`成员${i}画像`))
  const png = path.join(outputDir, template.replace('.html', '.png'))
  fs.writeFileSync(png, buffer)
  const metadata = await require('sharp')(buffer).metadata()
  assert.equal(metadata.height, measured.captureHeight)
  const evidence = { template, topics: measured.topics, portraits: measured.portraits, fullHeight: measured.fullHeight,
    captureHeight: metadata.height, reviewBottom: measured.reviewBottom, header: measured.header, bytes: buffer.length, png }
  fs.writeFileSync(path.join(outputDir, template.replace('.html', '.json')), JSON.stringify(evidence, null, 2))
  console.log(JSON.stringify(evidence))
}

// 固定输出到工作区临时目录；调用者不能指定任意写入位置。
async function main() {
  const outputDir = path.resolve(__dirname, '../../..', 'tmp/workspace/daily-report-template-smoke')
  fs.mkdirSync(outputDir, { recursive: true })
  if (process.argv[2]) return renderOne(process.argv[2], outputDir)
  for (const template of ['light.html', 'dark.html']) {
    const result = spawnSync(process.execPath, [__filename, template], { encoding: 'utf8', timeout: 75000, env: { ...process.env,
      DONGXUELIAN_AI_DATA_DIR: path.join(outputDir, template.replace('.html', '-data')), RESOURCE_WORKER_SUPERVISOR_ENABLED: '0' } })
    process.stdout.write(result.stdout || '')
    assert.equal(result.status, 0, result.stderr || result.error?.message)
  }
}
main().catch(error => { console.error(error.stack || error); process.exitCode = 1 })
