/** 两套真实模板的普通/详细0、1、2话题与全部不足截图；只用固定虚构展示结果。 */
'use strict'
const assert = require('assert').strict
const fs = require('fs'), path = require('path'), { spawnSync } = require('child_process')
const scenarios = [[false, 0], [false, 1], [false, 2], [true, 0], [true, 1], [true, 2], [true, 0, true]]

// 单场景使用正式渲染与完整截图，仅包装浏览器读回布局证据。
async function renderCase(template, index, outputDir) {
  process.env.DAILY_REPORT_TEMPLATE = template
  const { makeReportDisplayFixture } = require('./helpers/report-display-fixture')
  const { data, analysis, detailed, topicCount, allEmpty } = makeReportDisplayFixture(...scenarios[index])
  const { getReportEmptyStates } = require('../lib/models'), expectedEmpty = getReportEmptyStates(analysis)
  const name = template.replace('.html', '') + '-' + (detailed ? 'detailed' : 'ordinary') + '-' + topicCount + (allEmpty ? '-all-empty' : '')
  const puppeteer = require('puppeteer-core'), launch = puppeteer.launch.bind(puppeteer)
  let measured
  puppeteer.launch = async options => {
    const browser = await launch(options), newPage = browser.newPage.bind(browser)
    browser.newPage = async () => {
      const page = await newPage(), setContent = page.setContent.bind(page), screenshot = page.screenshot.bind(page)
      page.setContent = async (html, options) => { fs.writeFileSync(path.join(outputDir, name + '.html'), html); return setContent(html, options) }
      page.screenshot = async options => {
        measured = await page.evaluate(() => {
          const header = document.querySelector('.hd').getBoundingClientRect(), title = document.querySelector('.hd h1').getBoundingClientRect()
          const date = document.querySelector('.hd-date').getBoundingClientRect(), period = document.querySelector('.hd-period').getBoundingClientRect()
          return { text: document.body.innerText, topics: document.querySelectorAll('.topic-card').length, portraits: document.querySelectorAll('.profile-card').length,
            quotes: document.querySelectorAll('.quote-block').length, emptyCards: document.querySelectorAll('.report-empty').length,
            fullHeight: Math.max(document.body.scrollHeight, document.documentElement.scrollHeight), footerBottom: document.querySelector('.ft').getBoundingClientRect().bottom,
            horizontalOverflow: document.documentElement.scrollWidth > 880,
            header: { titleRight: title.right, dateLeft: date.left, firstRowBottom: Math.max(title.bottom, date.bottom), periodTop: period.top,
              periodBottom: period.bottom, periodRight: period.right, right: header.right, bottom: header.bottom } }
        })
        measured.captureHeight = options.clip.height
        return screenshot(options)
      }
      return page
    }
    return browser
  }
  const renderer = require('../lib/html-renderer')
  const buffer = await renderer.renderReport(data, analysis, { taskId: 'empty-smoke-' + name, deadlineMs: Date.now() + 60000, workDeadlineMs: Date.now() + 55000 })
  assert.equal(measured.topics, analysis.topics.length); assert.equal(measured.portraits, analysis.userTitles.length)
  assert.equal(measured.quotes, analysis.goldenQuotes.length); assert.equal(measured.emptyCards, Object.keys(expectedEmpty).length)
  for (const text of Object.values(expectedEmpty)) assert(measured.text.includes(text))
  for (const topic of analysis.topics) assert(measured.text.includes(topic.title) && measured.text.includes(topic.summary))
  for (const quote of analysis.goldenQuotes) assert(measured.text.includes(quote.content))
  for (const portrait of analysis.userTitles) assert(measured.text.includes(portrait.reason))
  if (analysis.qualityReview) assert(measured.text.includes(analysis.qualityReview.summary))
  assert(!measured.horizontalOverflow); assert(measured.fullHeight <= measured.captureHeight && measured.captureHeight <= 6000)
  assert(measured.footerBottom <= measured.captureHeight)
  assert(measured.header.titleRight <= measured.header.dateLeft && measured.header.periodTop >= measured.header.firstRowBottom)
  assert(measured.header.periodBottom <= measured.header.bottom && measured.header.periodRight <= measured.header.right)
  assert(measured.text.includes('42') && measured.text.includes('2026-10-06') && measured.text.includes('北京时间'))
  assert(!measured.text.includes('insufficient') && !measured.text.includes('grounded-report') && !measured.text.includes('覆盖率'))
  const png = path.join(outputDir, name + '.png')
  fs.writeFileSync(png, buffer)
  const metadata = await require('sharp')(buffer).metadata()
  assert.equal(metadata.height, measured.captureHeight)
  fs.writeFileSync(path.join(outputDir, name + '.json'), JSON.stringify({ template, detailed, topicCount, allEmpty, ...measured, png, bytes: buffer.length }, null, 2))
  console.log(JSON.stringify({ name, topics: measured.topics, emptyCards: measured.emptyCards, height: metadata.height, bytes: buffer.length }))
}

// 每个子进程独立数据根与模板，完成后释放正式浏览器及活动租约，不发送消息。
async function main() {
  const outputDir = path.resolve(__dirname, '../../..', 'tmp/workspace/daily-report-empty-smoke')
  fs.mkdirSync(outputDir, { recursive: true })
  const [template, rawIndex] = process.argv.slice(2)
  if (template) {
    if (!['light.html', 'dark.html'].includes(template) || !/^[0-6]$/.test(rawIndex)) throw new Error('未知固定视觉用例')
    return renderCase(template, Number(rawIndex), outputDir)
  }
  for (const theme of ['light.html', 'dark.html']) for (let index = 0; index < scenarios.length; index++) {
    const result = spawnSync(process.execPath, [__filename, theme, String(index)], { encoding: 'utf8', timeout: 75000, windowsHide: true,
      env: { ...process.env, DONGXUELIAN_AI_DATA_DIR: path.join(outputDir, 'data-' + theme + '-' + index), RESOURCE_WORKER_SUPERVISOR_ENABLED: '0' } })
    process.stdout.write(result.stdout || '')
    assert.equal(result.status, 0, result.stderr || result.error?.message)
  }
}
main().catch(error => { console.error(error.stack || error); process.exitCode = 1 })
