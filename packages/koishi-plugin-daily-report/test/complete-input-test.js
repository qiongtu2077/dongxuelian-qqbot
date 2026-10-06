/** 检查实际请求输入和内容传播，覆盖分片、来源、合并、重试与取消。 */
'use strict'
const assert = require('assert')
const engine = require('../lib/complete-input')
const contract = require('koishi-plugin-dongxuelian-ai/lib/public/management-runtime').loadManagementModule('daily.reportAnalysis')

// 为不同数量提供前中后独立主题，分析序号与入选消息一一对应。
function sampleMessages(count) {
  return Array.from({ length: count }, (_, index) => ({ analysisId: index + 1, ts: 1791000000000 + index * 1000, time: '12:00:00', userId: 'u', user: '甲',
    content: index === 0 ? '前段独立主题' : index === Math.floor(count / 2) ? '中段独立主题' : index === count - 1 ? '后段独立主题' : `普通讨论${index}` }))
}

// 模拟摘要内容提炼，读取真实请求中的来源标记和主题；合并只传播输入节点内容。
function makeSummaryRequest(calls) {
  return async (system, input, maxTokens, extra) => {
    extra._onRequestAttempt?.()
    calls.push({ system, input, maxTokens, extra })
    if (system.includes('consumedNodeIds')) {
      const nodes = JSON.parse(input)
      const topics = [...new Map(nodes.flatMap(node => node.topics).map(topic => [topic.title, topic])).values()]
      const quoteRefs = nodes.flatMap(node => node.quoteRefs).slice(0, 1)
      return JSON.stringify({ consumedNodeIds: nodes.map(node => node.id), topics, quoteRefs })
    }
    const fragments = [...input.matchAll(/\[M(\d+):P(\d+)\]/g)]
    const themes = ['前段独立主题', '中段独立主题', '后段独立主题', '长消息尾部独立主题'].filter(theme => input.includes(theme))
    if (!themes.length) themes.push('普通讨论')
    return JSON.stringify({ consumedFragmentIds: fragments.map(match => `${match[1]}:${match[2]}`),
      topics: themes.map(title => ({ title, summary: title + '的实际讨论与结论', participants: [...new Set([...input.matchAll(/\[M\d+:P\d+\] \S+ 用户ID=([^:]+): /g)].map(match => match[1]))], sourceIds: [Number(fragments[0][1])] })),
      quoteRefs: [{ sourceId: Number(fragments[0][1]), reason: '真实来源候选' }] })
  }
}

// 每个行为独立汇总失败，后续测试仍能给出实际诊断证据。
async function checkBehavior(check, label, run) {
  try { await run(); check(label, true) } catch (error) { check(label, false, error.stack || String(error)) }
}

// 执行完整摘要行为验收；所有模型请求均为本地模拟，没有生产通知。
async function runCompleteInputTests(check) {
  await checkBehavior(check, '分批前缀、100条上限、完整长正文与Unicode片段', async () => {
    const messages = sampleMessages(250)
    messages[120].content = '🧩'.repeat(6000) + '长消息尾部独立主题'
    const batches = engine.packInputBatches(messages)
    assert.ok(batches.length > 3)
    for (const batch of batches) {
      assert.ok(batch.text.length <= 4000)
      assert.ok(new Set(batch.fragments.map(fragment => fragment.sourceId)).size <= 100)
      assert.ok(!/[\uD800-\uDBFF]$/.test(batch.text))
    }
    const fragments = batches.flatMap(batch => batch.fragments)
    assert.equal(new Set(fragments.map(fragment => fragment.id)).size, fragments.length)
    for (const message of messages) {
      const parts = fragments.filter(fragment => fragment.sourceId === message.analysisId)
      assert.equal(parts.map(fragment => fragment.text.slice(fragment.text.indexOf(': ') + 2)).join(''), message.content)
      assert.equal(parts.length, parts[0].partCount)
    }
  })

  for (const count of [591, 1330, 4000]) await checkBehavior(check, `${count}条完整进入摘要，分层合并保留前中后主题`, async () => {
    const messages = sampleMessages(count)
    const calls = []
    const progress = []
    const diagnostics = contract.createReportAnalysisDiagnostics({ windowMessageCount: count, selectedMessageCount: count, sourceCompleteness: 'complete' })
    const result = await engine.summarizeCompleteInput(messages, diagnostics, { deadlineMs: Date.now() + 60000, request: makeSummaryRequest(calls), onProgress: value => progress.push(JSON.parse(JSON.stringify(value))) })
    const submittedIds = new Set(calls.filter(call => !call.system.includes('consumedNodeIds')).flatMap(call => [...call.input.matchAll(/\[M(\d+):P(\d+)\]/g)].map(match => Number(match[1]))))
    assert.equal(submittedIds.size, count)
    assert.equal(diagnostics.summarizedMessageCount, count)
    assert.equal(diagnostics.submittedMessageCount, count)
    assert.equal(diagnostics.unprocessedCount, 0)
    assert.equal(diagnostics.reportCallCount, calls.length)
    assert.equal(result.sourceIds.size, count)
    for (const theme of ['前段独立主题', '中段独立主题', '后段独立主题']) assert.ok(result.digest.includes(theme))
    assert.ok(result.digest.length <= 4000)
    assert.ok(progress.length > diagnostics.batchCount)
    if (count === 4000) assert.ok(diagnostics.mergeLevels >= 2)
  })

  await checkBehavior(check, '长消息全部片段成功才计为一条，尾部进入共同摘要', async () => {
    const messages = sampleMessages(3)
    messages[1].content = '🧩'.repeat(6000) + '长消息尾部独立主题'
    const diagnostics = contract.createReportAnalysisDiagnostics({ windowMessageCount: 3, selectedMessageCount: 3, sourceCompleteness: 'complete' })
    const result = await engine.summarizeCompleteInput(messages, diagnostics, { deadlineMs: Date.now() + 60000, request: makeSummaryRequest([]) })
    assert.equal(diagnostics.summarizedMessageCount, 3)
    assert.ok(result.digest.includes('长消息尾部独立主题'))
  })

  await checkBehavior(check, '失败一次可恢复；连续失败终止后续批次且不制造成功覆盖', async () => {
    const messages = sampleMessages(250)
    const diagnostics = contract.createReportAnalysisDiagnostics({ windowMessageCount: 250, selectedMessageCount: 250, sourceCompleteness: 'complete' })
    const normal = makeSummaryRequest([])
    let attempted = 0
    await engine.summarizeCompleteInput(messages, diagnostics, { deadlineMs: Date.now() + 60000, request: (...args) => ++attempted === 1 ? Promise.resolve('{broken') : normal(...args) })
    assert.equal(diagnostics.retryCount, 1)
    assert.equal(diagnostics.failedBatches.length, 0)
    const failed = contract.createReportAnalysisDiagnostics({ windowMessageCount: 250, selectedMessageCount: 250, sourceCompleteness: 'complete' })
    let failures = 0
    await assert.rejects(engine.summarizeCompleteInput(messages, failed, { deadlineMs: Date.now() + 60000, request: async () => { failures++; return '{broken' } }), error => error.code === 'DAILY_REPORT_GENERATION_FAILED')
    assert.equal(failures, 2)
    assert.equal(failed.failedBatches[0].attempts, 2)
    assert.equal(failed.summarizedMessageCount, 0)
    assert.ok(failed.unprocessedCount > 0)
    assert.equal(failed.coverageRate, 0)
  })

  await checkBehavior(check, '金句混入话题明确指出缺失字段，重试完整原输入而不丢弃坏元素', async () => {
    const messages = sampleMessages(3)
    const normal = makeSummaryRequest([])
    const diagnostics = contract.createReportAnalysisDiagnostics({ windowMessageCount: 3, selectedMessageCount: 3, sourceCompleteness: 'complete' })
    const requests = []
    await engine.summarizeCompleteInput(messages, diagnostics, { deadlineMs: Date.now() + 60000, request: async (...args) => {
      requests.push({ system: args[0], input: args[1] })
      const value = JSON.parse(await normal(...args))
      if (requests.length === 1) value.topics.push({ title: '金句候选', quoteRefs: value.quoteRefs })
      return JSON.stringify(value)
    } })
    assert.equal(requests.length, 2)
    assert.equal(requests[0].input, requests[1].input)
    assert(requests[1].system.includes('缺少非空summary'))
    assert(requests[1].system.includes('金句候选只能放顶层quoteRefs'))
    assert.equal(diagnostics.retryCount, 1)
    assert.equal(diagnostics.summarizedMessageCount, 3)
  })

  await checkBehavior(check, '非法来源、遗漏消费节点和必要合并失败均整份判失败', async () => {
    const messages = sampleMessages(250)
    const normal = makeSummaryRequest([])
    for (const mode of ['bad_source', 'missing_node', 'bad_merge']) {
      const diagnostics = contract.createReportAnalysisDiagnostics({ windowMessageCount: 250, selectedMessageCount: 250, sourceCompleteness: 'complete' })
      await assert.rejects(engine.summarizeCompleteInput(messages, diagnostics, { deadlineMs: Date.now() + 60000, request: async (...args) => {
        const value = JSON.parse(await normal(...args))
        if (mode === 'bad_source') value.topics[0].sourceIds = [9999]
        else if (args[0].includes('consumedNodeIds')) {
          if (mode === 'missing_node') value.consumedNodeIds.pop()
          else return ''
        }
        return JSON.stringify(value)
      } }), error => error.code === 'DAILY_REPORT_GENERATION_FAILED')
      assert.equal(diagnostics.failedBatches.length, 1)
      assert.equal(diagnostics.analysisState, 'failed')
    }
  })

  await checkBehavior(check, '单请求取消属于普通失败，硬截止耗尽实际取消且分类为总超时', async () => {
    for (const total of [false, true]) {
      const diagnostics = contract.createReportAnalysisDiagnostics({ windowMessageCount: 1, selectedMessageCount: 1, sourceCompleteness: 'complete' })
      let clock = 0
      let aborted = 0
      const runtime = { deadlineMs: total ? 10 : 1000, now: () => clock, request: (system, input, tokens, extra) => new Promise((resolve, reject) => {
        extra.signal.addEventListener('abort', () => { aborted++; if (total) clock = 10; reject(new Error('request stopped')) }, { once: true })
      }) }
      await assert.rejects(engine.requestAnalysisUnit(runtime, diagnostics, { id: 'B1', stage: 'compression', sourceIds: [1], timestamps: [] }, 'test', 'test', 100, 10, text => text),
        error => error.code === (total ? 'DAILY_REPORT_TOTAL_TIMEOUT' : 'DAILY_REPORT_GENERATION_FAILED'))
      assert.equal(aborted, total ? 1 : 2)
      assert.equal(diagnostics.failureKind, total ? 'total_timeout' : 'generation_failed')
    }
  })

  await checkBehavior(check, '阶段软预算可借用且保存预留耗尽不误标600秒总超时', async () => {
    const diagnostics = contract.createReportAnalysisDiagnostics({ windowMessageCount: 1, selectedMessageCount: 1, sourceCompleteness: 'complete' })
    let clock = 370000
    const calls = []
    const runtime = { deadlineMs: 600000, workDeadlineMs: 570000, stageSoftDeadlinesMs: { compression: 360000 }, now: () => clock,
      request: async (_system, _input, _tokens, extra) => { calls.push(extra._timeoutMs); clock += 1000; return 'valid' } }
    assert.equal(await engine.requestAnalysisUnit(runtime, diagnostics, { id: 'B1', stage: 'compression', sourceIds: [1], timestamps: [] }, 'test', 'test', 100, 45000, value => value), 'valid')
    assert.deepEqual(calls, [45000])
    assert.equal(diagnostics.warnings.length, 1)
    assert.equal(diagnostics.stageDurationsMs.compression, 1000)
    clock = 570000
    await assert.rejects(engine.requestAnalysisUnit(runtime, diagnostics, { id: 'B2', stage: 'compression', sourceIds: [1], timestamps: [] }, 'test', 'test', 100, 45000, value => value), error => error.code === 'DAILY_REPORT_GENERATION_FAILED')
    assert.equal(calls.length, 1)
    clock = 600000
    await assert.rejects(engine.requestAnalysisUnit(runtime, diagnostics, { id: 'B3', stage: 'compression', sourceIds: [1], timestamps: [] }, 'test', 'test', 100, 45000, value => value), error => error.code === 'DAILY_REPORT_TOTAL_TIMEOUT')
  })

  await checkBehavior(check, '保存预留实际取消请求且剩余预算不足不再重试', async () => {
    const diagnostics = contract.createReportAnalysisDiagnostics({ windowMessageCount: 1, selectedMessageCount: 1, sourceCompleteness: 'complete' })
    let clock = 569990
    let aborted = 0
    let calls = 0
    const runtime = { deadlineMs: 600000, workDeadlineMs: 570000, now: () => clock, request: (_system, _input, _tokens, extra) => {
      calls++; assert.equal(extra._timeoutMs, 10)
      return new Promise((_resolve, reject) => extra.signal.addEventListener('abort', () => { aborted++; clock = 570000; reject(extra.signal.reason) }, { once: true }))
    } }
    await assert.rejects(engine.requestAnalysisUnit(runtime, diagnostics, { id: 'B1', stage: 'compression', sourceIds: [1], timestamps: [] }, 'test', 'test', 100, 45000, value => value), error => error.code === 'DAILY_REPORT_GENERATION_FAILED')
    assert.equal(calls, 1); assert.equal(aborted, 1); assert.equal(diagnostics.failedBatches[0].attempts, 1)
  })

  await checkBehavior(check, '画像例句覆盖早中晚，最多15条且只读取入选用户本人', async () => {
    const messages = sampleMessages(90).map((message, i) => ({ ...message, content: `本人例句${i}`, ts: 1000 + i * 60 * 60 * 1000 }))
    messages.push({ userId: 'other', content: '别人的发言', ts: 2000 })
    const sample = engine.selectRepresentativeMessages(messages, 'u')
    assert.equal(sample.length, 15)
    assert.equal(sample[0].content, '本人例句0')
    assert.equal(sample[sample.length - 1].content, '本人例句89')
    assert.ok(sample.every(message => message.userId === 'u' && messages.includes(message)))
    assert.ok(sample.some(message => message.ts > messages[30].ts && message.ts < messages[60].ts))
  })
}

module.exports = { runCompleteInputTests, makeSummaryRequest }
