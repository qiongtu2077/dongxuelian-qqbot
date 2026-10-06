/** 正式管线验证：完整文字、固定窗口、进度与失败分类使用真实模型分析入口。 */
'use strict'
const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { makeInput, makeModelRequest } = require('./analysis-entry-test')
const runtime = require('koishi-plugin-dongxuelian-ai/lib/public/management-runtime')
const { createReportPeriod } = runtime.loadManagementModule('daily.reportPeriod')
const { ReportRuntimeTimeoutError } = runtime.loadManagementModule('daily.reportAnalysis')
const collectorPath = require.resolve('../lib/data-collector')
const rendererPath = require.resolve('../lib/html-renderer')
const pipelinePath = require.resolve('../lib/report-pipeline')

// 只替换采集和图片边界，管线、摘要引擎与模型分析保持正式实现。
async function withPipeline(data, request, withMockedAiAnalyzer, run, render = async () => Buffer.from('test-image')) {
  const originals = [collectorPath, rendererPath, pipelinePath].map(file => [file, require.cache[file]])
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'daily-complete-pipeline-'))
  const period = createReportPeriod(data.messages[data.messages.length - 1].ts)
  let collectedPeriod
  require.cache[collectorPath] = { id: collectorPath, filename: collectorPath, loaded: true, exports: {
    collectReportData(channelKey, reportPeriod) { collectedPeriod = reportPeriod; return { ...data, date: reportPeriod.reportDate, reportPeriod } },
  } }
  require.cache[rendererPath] = { id: rendererPath, filename: rendererPath, loaded: true, exports: { renderReport: render } }
  try {
    await withMockedAiAnalyzer(request, async () => {
      delete require.cache[pipelinePath]
      await run(require(pipelinePath), outputDir, period, () => collectedPeriod)
    })
  } finally {
    for (const [file, original] of originals) { if (original) require.cache[file] = original; else delete require.cache[file] }
    const resolved = path.resolve(outputDir)
    assert.ok(resolved.startsWith(path.resolve(os.tmpdir()) + path.sep))
    fs.rmSync(resolved, { recursive: true, force: true })
  }
}

// 独立汇总正式管线的可观察结果，模拟不会发送群消息。
async function verify(check, label, run) {
  try { await run(); check(label, true) } catch (error) { check(label, false, error.stack || String(error)) }
}

// 生成十个独立主题与八个实际成员，模型模拟仅引用真实输入。
function tenTopicInput() {
  const messages = Array.from({ length: 10 }, (_, index) => ({ analysisId: index + 1, ts: 1791000000000 + index * 1000,
    time: '12:00:00', userId: String(index % 8 + 1), user: `成员${index % 8 + 1}`, content: `主题${index + 1}的独立事实及结论` }))
  return { messages, totalMessages: 10, windowMessageCount: 10, sourceCompleteness: 'complete',
    topMembers: Array.from({ length: 8 }, (_, index) => ({ userId: String(index + 1), name: `成员${index + 1}`, msgCount: 2 })) }
}

// 返回显式消费集合和来源；冗长最终摘要用于验证文字不会再被整篇截断。
async function tenTopicRequest(messages, config, extra) {
  extra._onRequestAttempt?.()
  const system = messages[0].content
  const input = messages[1].content
  if (system.includes('consumedFragmentIds')) {
    const fragments = [...input.matchAll(/\[M(\d+):P(\d+)\] \S+ 用户ID=([^:]+): ([^\n]*)/g)]
    return { type: 'text', content: JSON.stringify({ consumedFragmentIds: fragments.map(match => `${match[1]}:${match[2]}`),
      topics: fragments.map(match => ({ title: `主题${match[1]}`, summary: `事实${match[1]}`, participants: [match[3]], sourceIds: [Number(match[1])] })),
      quoteRefs: [{ sourceId: 1, reason: '真实来源' }] }) }
  }
  if (system.includes('qualityReview')) {
    const { members } = JSON.parse(input)
    return { type: 'text', content: JSON.stringify({ userTitles: members.map(member => ({ userId: member.userId, title: '讨论参与者', reason: `成员${member.userId}完整画像`, mbti: '' })),
      qualityReview: { title: '完整锐评', subtitle: '必要副标题', summary: '必要总结', dimensions: ['信息', '互动', '组织', '情绪'].map(name => ({ name, percentage: 25, comment: `${name}必要说明` })) } }) }
  }
  const digest = JSON.parse(input)
  return { type: 'text', content: JSON.stringify({ topics: digest.topics.map(topic => ({ ...topic, summary: topic.summary.repeat(160) + `主题${topic.sourceIds[0]}尾部保留` })),
    goldenQuotes: [{ sourceId: 1, reason: '保留原话' }] }) }
}

// 验证正式管线的保存、失败和渲染边界，而不是仅检查分析函数被调用。
async function runPipelineCompletenessTests(check, withMockedAiAnalyzer) {
  for (const count of [591, 1330, 4000]) await verify(check, `正式管线${count}条保存完整覆盖与固定提交窗口`, async () => {
    const data = makeInput(count)
    await withPipeline(data, makeModelRequest([]), withMockedAiAnalyzer, async (pipeline, outputDir, period, getPeriod) => {
      const result = await pipeline.generateDailyReportResult({ taskId: `pipeline-${count}`, channelKey: 'test', reportPeriod: period, outputDir, renderImage: false })
      assert.deepEqual(getPeriod(), period)
      assert.deepEqual(result.reportPeriod, period)
      assert.equal(result.analysisMeta.topicInputMessageCount, count)
      assert.equal(result.analysisMeta.analysisState, 'complete')
      const saved = JSON.parse(fs.readFileSync(path.join(outputDir, 'result.json'), 'utf8'))
      const progress = JSON.parse(fs.readFileSync(path.join(outputDir, 'analysis-progress.json'), 'utf8'))
      assert.equal(saved.analysisMeta.topicInputMessageCount, count)
      assert.equal(progress.analysisMeta.topicInputMessageCount, count)
      const text = fs.readFileSync(result.textPath, 'utf8')
      for (const theme of ['前段独立主题', '中段独立主题', '后段独立主题']) assert.ok(text.includes(theme))
      assert.ok(!text.includes('覆盖率'))
    })
  })
  await verify(check, '详细管线10话题8画像完整文字超过4000仍保留最后话题与锐评', async () => {
    await withPipeline(tenTopicInput(), tenTopicRequest, withMockedAiAnalyzer, async (pipeline, outputDir, period) => {
      const result = await pipeline.generateDailyReportResult({ channelKey: 'test', detail: true, reportPeriod: period, outputDir, renderImage: false })
      const text = fs.readFileSync(result.textPath, 'utf8')
      assert.ok(text.length > 4000)
      for (let i = 1; i <= 10; i++) assert.ok(text.includes(`主题${i}尾部保留`))
      for (let i = 1; i <= 8; i++) assert.ok(text.includes(`成员${i}完整画像`))
      for (const name of ['信息', '互动', '组织', '情绪']) assert.ok(text.includes(`${name}必要说明`))
      assert.ok(!text.includes('内容已截断') && !text.includes('覆盖率'))
    })
  })
  await verify(check, '正式详细入口画像样本实际来自同一入选范围的前中后时段', async () => {
    const data = tenTopicInput()
    for (const message of data.messages) { message.userId = '1'; message.user = '同名成员' }
    data.topMembers = [{ userId: '1', name: '同名成员', msgCount: 10 }]
    let samples
    const request = async (messages, config, extra) => {
      if (messages[0].content.includes('qualityReview')) samples = JSON.parse(messages[1].content).members[0].samples
      return tenTopicRequest(messages, config, extra)
    }
    await withPipeline(data, request, withMockedAiAnalyzer, async (pipeline, outputDir, period) => {
      await pipeline.generateDailyReportResult({ channelKey: 'test', detail: true, reportPeriod: period, outputDir, renderImage: false })
      assert(samples.length <= 15)
      assert.deepEqual(samples.map(item => item.sourceId), data.messages.map(item => item.analysisId))
      for (const sample of samples) assert.equal(sample.excerpt, data.messages[sample.sourceId - 1].content)
      assert.equal(samples[0].sourceId, 1); assert.equal(samples.at(-1).sourceId, 10)
    })
  })
  await verify(check, '正式管线必要结果失败落盘保留全部诊断且不保存部分文字', async () => {
    await withPipeline(makeInput(3), makeModelRequest([], { badBasic: true }), withMockedAiAnalyzer, async (pipeline, outputDir, period) => {
      await assert.rejects(pipeline.generateDailyReportResult({ channelKey: 'test', reportPeriod: period, outputDir, renderImage: false }), error => error.code === 'DAILY_REPORT_GENERATION_FAILED')
      const saved = JSON.parse(fs.readFileSync(path.join(outputDir, 'result.json'), 'utf8'))
      assert.equal(saved.ok, false)
      assert.equal(saved.failureKind, 'generation_failed')
      assert.equal(saved.failureNotificationVersion, 2)
      assert.equal(saved.analysisMeta.failedBatches[0].attempts, 2)
      assert.equal(saved.analysisMeta.summarizedMessageCount, 3)
      assert.equal(saved.analysisMeta.analysisState, 'failed')
      assert.ok(!fs.existsSync(path.join(outputDir, 'report.txt')))
    })
  })
  await verify(check, '正式管线渲染失败在总截止之前发送完整文字并传递同一预算', async () => {
    const clock = 1791000000000
    let renderContext
    await withPipeline(makeInput(3), makeModelRequest([]), withMockedAiAnalyzer, async (pipeline, outputDir, period) => {
      const result = await pipeline.generateDailyReportResult({ channelKey: 'test', reportPeriod: period, outputDir, now: () => clock, deadlineMs: clock + 600000 })
      assert.equal(renderContext.deadlineMs, clock + 600000)
      assert.equal(renderContext.workDeadlineMs, clock + 570000)
      assert.equal(renderContext.now(), clock)
      assert.equal(result.mode, 'text')
      assert.ok(result.reason.startsWith('render_failed:'))
      assert.ok(fs.readFileSync(result.textPath, 'utf8').includes('后段独立主题'))
    }, async (data, analysis, context) => { renderContext = context; throw new Error('图片渲染单次失败') })
  })
  await verify(check, '正式管线渲染用尽570秒预算保留完整文字和30秒保存时间', async () => {
    let clock = 1791000000000
    const startedAtMs = clock
    await withPipeline(makeInput(3), makeModelRequest([]), withMockedAiAnalyzer, async (pipeline, outputDir, period) => {
      const result = await pipeline.generateDailyReportResult({ channelKey: 'test', reportPeriod: period, outputDir, startedAtMs, now: () => clock, deadlineMs: startedAtMs + 600000 })
      assert.equal(result.ok, true); assert.equal(result.mode, 'text')
      assert.equal(result.analysisMeta.analysisState, 'complete')
      assert.equal(result.analysisMeta.stageDurationsMs.runtime, 570000)
      assert.ok(fs.readFileSync(result.textPath, 'utf8').includes('后段独立主题'))
      assert.equal(JSON.parse(fs.readFileSync(path.join(outputDir, 'result.json'), 'utf8')).ok, true)
    }, async (_data, _analysis, context) => { clock = context.workDeadlineMs; throw new Error('图片预算耗尽') })
  })
  await verify(check, '正式管线渲染越过硬截止必须总超时，不能文字降级标成功', async () => {
    let clock = 1791000000000
    const deadlineMs = clock + 600000
    await withPipeline(makeInput(3), makeModelRequest([]), withMockedAiAnalyzer, async (pipeline, outputDir, period) => {
      await assert.rejects(pipeline.generateDailyReportResult({ channelKey: 'test', reportPeriod: period, outputDir, now: () => clock, deadlineMs }), error => error.code === 'DAILY_REPORT_TOTAL_TIMEOUT')
      const saved = JSON.parse(fs.readFileSync(path.join(outputDir, 'result.json'), 'utf8'))
      assert.equal(saved.ok, false)
      assert.equal(saved.failureKind, 'total_timeout')
      assert.equal(saved.analysisMeta.topicInputMessageCount, 3)
    }, async () => { clock = deadlineMs; throw new Error('图片异常') })
  })
  await verify(check, '正式管线外层总超时与用户取消使用不同持久化路径', async () => {
    await withPipeline(makeInput(3), makeModelRequest([]), withMockedAiAnalyzer, async (pipeline, outputDir, period) => {
      const controller = new AbortController()
      controller.abort(new ReportRuntimeTimeoutError())
      await assert.rejects(pipeline.generateDailyReportResult({ channelKey: 'test', reportPeriod: period, outputDir, signal: controller.signal }), error => error.code === 'DAILY_REPORT_TOTAL_TIMEOUT')
      assert.equal(JSON.parse(fs.readFileSync(path.join(outputDir, 'result.json'), 'utf8')).failureKind, 'total_timeout')
    })
    await withPipeline(makeInput(3), makeModelRequest([]), withMockedAiAnalyzer, async (pipeline, outputDir, period) => {
      const controller = new AbortController()
      const reason = new Error('控制台取消')
      controller.abort(reason)
      await assert.rejects(pipeline.generateDailyReportResult({ channelKey: 'test', reportPeriod: period, outputDir, signal: controller.signal }), error => error === reason)
      assert.ok(!fs.existsSync(path.join(outputDir, 'result.json')))
    })
  })
}

module.exports = { runPipelineCompletenessTests }
