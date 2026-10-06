/** 模拟挂起的浏览器操作，实际信号取消后关闭并再次渲染，全部输出隔离。 */
'use strict'
const assert = require('assert').strict
const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawnSync } = require('child_process')

// 子进程中只模拟浏览器边界，正式渲染计时、信号和槽位不替换。
async function fixture() {
  const puppeteerPath = require.resolve('puppeteer-core')
  let hanging = true
  let closeCount = 0
  let releaseContent
  let contentStarted
  const started = new Promise(resolve => { contentStarted = resolve })
  require.cache[puppeteerPath] = { id: puppeteerPath, filename: puppeteerPath, loaded: true, exports: {
    async launch() { return {
      async newPage() { return { async setRequestInterception() {}, on() {}, async setViewport() {},
        async setContent() { if (!hanging) return; contentStarted(); return new Promise(resolve => { releaseContent = resolve }) },
        async evaluate() { return 800 }, async waitForNetworkIdle() {}, async screenshot() { return Buffer.from('next-render') } } },
      async close() { closeCount++; releaseContent?.() },
    } },
  } }
  const renderer = require('../lib/html-renderer')
  const { ReportRuntimeTimeoutError } = require('koishi-plugin-dongxuelian-ai/lib/daily-precompute/report-analysis')
  const controller = new AbortController()
  const pending = renderer.renderHtmlToImage('<html><body>挂起</body></html>', { deadlineMs: Date.now() + 600000, signal: controller.signal })
  await started
  controller.abort(new ReportRuntimeTimeoutError())
  await assert.rejects(pending, error => error.code === 'DAILY_REPORT_TOTAL_TIMEOUT')
  assert.equal(closeCount, 1)
  hanging = false
  const next = await renderer.renderHtmlToImage('<html><body>下一份</body></html>', { deadlineMs: Date.now() + 600000 })
  assert.equal(next.toString(), 'next-render'); assert.equal(closeCount, 2)
  console.log(JSON.stringify({ actualAbort: true, browserClosed: true, slotReusable: true }))
}

// 隔离目录与子进程，使信号、计时器、租约状态不污染其他插件测试。
function runRenderRuntimeTests(check) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'daily-render-runtime-'))
  try {
    const result = spawnSync(process.execPath, [__filename, '--fixture'], { encoding: 'utf8', timeout: 10000, env: { ...process.env, DONGXUELIAN_AI_DATA_DIR: dataDir } })
    assert.equal(result.status, 0, result.stderr || result.error?.message)
    const evidence = JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1))
    assert(evidence.actualAbort && evidence.browserClosed && evidence.slotReusable)
    check('渲染硬取消实际关闭浏览器并释放后续任务槽位', true)
  } catch (error) { check('渲染硬取消实际关闭浏览器并释放后续任务槽位', false, error.stack) }
  finally {
    const resolved = path.resolve(dataDir)
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()))
    assert(path.basename(resolved).startsWith('daily-render-runtime-'))
    fs.rmSync(resolved, { recursive: true, force: true })
  }
}
if (process.argv.includes('--fixture')) fixture().catch(error => { console.error(error.stack); process.exitCode = 1 })
module.exports = { runRenderRuntimeTests }
