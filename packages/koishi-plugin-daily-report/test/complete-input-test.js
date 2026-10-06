/** 检查实际请求输入和内容传播，覆盖分片、来源、合并、重试与取消。 */
'use strict'
const assert = require('assert')
const engine = require('../lib/complete-input')
const contract = require('koishi-plugin-dongxuelian-ai/lib/public/management-runtime').loadManagementModule('daily.reportAnalysis')

// 生成明确的逐条交换记录，外层业务对象只由程序持有。
function formatExchange(value) {
  return [...value.groups.map(group => ({ kind: 'group', ...group })), ...value.quotes.map(quote => ({ kind: 'quote', ...quote })), { kind: 'end' }].map(JSON.stringify).join('\n')
}

// 画像与锐评也独立输出，缺失必要记录必须由正式入口拒绝。
function formatFullExchange(value) {
  return [...value.userTitles.map(portrait => ({ kind: 'portrait', ...portrait })), ...(value.qualityReview ? [{ kind: 'review', ...value.qualityReview }] : []), { kind: 'end' }].map(JSON.stringify).join('\n')
}

// 将已知有效的模拟响应恢复为业务形状，用于精确注入单项错误。
function parseExchangeResponse(text) {
  const records = engine.parseExchangeRecords(text)
  return { groups: records.filter(record => record.kind === 'group').map(({ kind, ...item }) => item),
    quotes: records.filter(record => record.kind === 'quote').map(({ kind, ...item }) => item) }
}

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
    const { items, quotes } = JSON.parse(input)
    const groups = new Map()
    for (const item of items) {
      const themes = item.title ? [item.title] : ['前段独立主题', '中段独立主题', '后段独立主题', '长消息尾部独立主题'].filter(theme => item.text.includes(theme))
      if (!themes.length) themes.push('普通讨论')
      for (const title of themes) {
        if (!groups.has(title)) groups.set(title, { title, summary: title + '的实际讨论与结论', refs: [] })
        groups.get(title).refs.push(item.ref)
      }
    }
    return formatExchange({ groups: [...groups.values()], quotes: [{ ref: quotes ? quotes[0].ref : items[0].ref, reason: '真实来源候选' }] })
  }
}

// 每个行为独立汇总失败，后续测试仍能给出实际诊断证据。
async function checkBehavior(check, label, run) {
  try { await run(); check(label, true) } catch (error) { check(label, false, error.stack || String(error)) }
}

// 执行完整摘要行为验收；所有模型请求均为本地模拟，没有生产通知。
async function runCompleteInputTests(check) {
  await checkBehavior(check, '最终共同摘要不满足详细话题数时重试一次并明确失败，不编造补足', async () => {
    const diagnostics = contract.createReportAnalysisDiagnostics({ selectedMessageCount: 250, windowMessageCount: 250, sourceCompleteness: 'complete' })
    await assert.rejects(engine.summarizeCompleteInput(sampleMessages(250), diagnostics, { deadlineMs: Date.now() + 60000,
      topicRange: { min: 5, max: 10 }, request: makeSummaryRequest([]) }), error => {
      assert.equal(error.diagnostics.failedBatches[0].stage, 'merge')
      assert.equal(error.diagnostics.failedBatches[0].attempts, 2)
      assert(error.message.includes('最终摘要需要5—10'))
      return error.code === 'DAILY_REPORT_GENERATION_FAILED'
    })
    assert.equal(diagnostics.summarizedMessageCount, 250)
  })

  await checkBehavior(check, '逐条传输支持空白折叠及字符串括号，截断、乱序、外层旧包装均明确拒绝', async () => {
    const messages = sampleMessages(2)
    const context = engine.createDigestExchange([{ title: '事实', summary: '内容', sourceIds: [1, 2], participants: ['u'] }], [], messages)
    const valid = formatExchange({ groups: [{ title: '含{括号}与"引号"', summary: '转义\\及\n换行', refs: ['r1'] }], quotes: [] })
    const result = engine.readExchange(valid.replace(/\n/g, ' '), context)
    assert.equal(result.topics[0].title, '含{括号}与"引号"')
    assert.equal(result.topics[0].summary, '转义\\及\n换行')
    assert.deepEqual(engine.readExchange(valid.replace(/\n/g, ', '), context), result)
    assert.throws(() => engine.readExchange(valid.replace(/\n/g, ',,'), context), /JSON_PARSE/)
    assert.throws(() => engine.readExchange(valid + ',', context), /JSON_PARSE/)
    assert.throws(() => engine.readExchange(valid.replace(/\n\{"kind":"end"\}$/, ''), context), /RECORD_INCOMPLETE/)
    assert.throws(() => engine.readExchange(valid + '\n{"kind":"end"}', context), /RECORD_ORDER/)
    assert.throws(() => engine.readExchange(valid + '\n{"kind":"group"}', context), /RECORD_INCOMPLETE/)
    assert.throws(() => engine.readExchange('{"kind":"group","title":"a","summary":"b","refs":["r1"}\n{"kind":"end"}', context), /JSON_PARSE/)
    assert.throws(() => engine.readExchange('[{"kind":"end"}]', context), /JSON_PARSE/)
    assert.throws(() => engine.readExchange('{"groups":[],"quotes":[]}\n{"kind":"end"}', context), /FIELD_TYPE/)
    assert.throws(() => engine.readExchange('{"kind":"quote","ref":"q1","reason":"点评"}\n' + valid, context), /RECORD_ORDER/)
  })

  await checkBehavior(check, '交换协议拒绝类型、字段、未知引用、重复与遗漏，不泄露非引用正文', async () => {
    const messages = sampleMessages(2)
    const context = engine.createDigestExchange(messages.map((message, index) => ({ title: message.content, summary: message.content,
      participants: [String(index + 1)], sourceIds: [index + 1] })), [{ sourceId: 2, reason: '候选' }], messages)
    const valid = { groups: [{ title: '讨论', summary: '内容', refs: ['r1', 'r2'] }], quotes: [{ ref: 'r3', reason: '点评' }] }
    const cases = [
      [value => delete value.groups[0].refs, 'FIELD_MISSING'],
      [value => value.groups[0].refs = [1], 'FIELD_TYPE'],
      [value => value.groups[0].refs = ['r999'], 'REF_UNKNOWN'],
      [value => value.groups[0].refs = ['r1', 'r1'], 'REF_DUPLICATE'],
      [value => value.groups[0].refs = ['r1'], 'REF_UNCOVERED'],
      [value => value.quotes[0].ref = 'r1', 'REF_UNKNOWN'],
      [value => value.quotes.push(value.quotes[0]), 'REF_DUPLICATE'],
    ]
    for (const [mutate, code] of cases) {
      const value = JSON.parse(JSON.stringify(valid)); mutate(value)
      assert.throws(() => engine.readExchange(formatExchange(value), context), error => error.message.includes(code))
    }
    assert.throws(() => engine.readExchange('{"secret":"私密正文', context), error => error.message.includes('JSON_PARSE') && !error.message.includes('私密正文'))
    const sensitive = JSON.parse(JSON.stringify(valid)); sensitive.groups[0].refs = ['私密正文']
    assert.throws(() => engine.readExchange(formatExchange(sensitive), context), error => error.message.includes('REF_UNKNOWN') && !error.message.includes('私密正文'))
    const multi = JSON.parse(JSON.stringify(valid)); multi.groups.push({ title: '另一话题', summary: '同一发言涉及多个主题', refs: ['r2'] })
    const restored = engine.readExchange(formatExchange(multi), context)
    assert.deepEqual(restored.topics[0].sourceIds, [1, 2]); assert.deepEqual(restored.topics[1].sourceIds, [2])
    assert.deepEqual(restored.topics[0].participants, ['1', '2']); assert.equal(restored.quoteRefs[0].sourceId, 2)
    const extra = JSON.parse(JSON.stringify(valid))
    extra.groups[0].participants = ['虚构用户']; extra.groups[0].sourceIds = [99999]
    extra.quotes[0].content = '伪造原话'; extra.quotes[0].userId = '虚构身份'
    const actual = engine.readExchange(formatExchange(extra), context)
    assert.deepEqual(actual.topics[0].sourceIds, [1, 2]); assert.deepEqual(actual.topics[0].participants, ['1', '2'])
    assert.deepEqual(actual.quoteRefs, [{ sourceId: 2, reason: '点评' }])
    const quoteAsEvidence = JSON.parse(JSON.stringify(valid)); quoteAsEvidence.groups[0].refs.push('r3')
    assert.deepEqual(engine.readExchange(formatExchange(quoteAsEvidence), context).topics[0].sourceIds, [1, 2])
  })

  await checkBehavior(check, '4000来源只保存在引用表，模型合并输入大小不随全局编号膨胀', async () => {
    const messages = sampleMessages(4000)
    const context = engine.createDigestExchange([{ title: '主题', summary: '结论', sourceIds: messages.map(message => message.analysisId),
      participants: ['可信身份'] }], [], messages)
    assert(context.input.length < 150)
    assert(!context.input.includes('sourceIds') && !context.input.includes('可信身份'))
    const result = engine.readExchange(formatExchange({ groups: [{ title: '主题', summary: '结论', refs: ['r1'] }], quotes: [] }), context)
    assert.equal(new Set(result.topics[0].sourceIds).size, 4000)
  })

  await checkBehavior(check, '含引号换行反斜杠的长消息按真实JSON长度分片且完整恢复', async () => {
    const messages = sampleMessages(3)
    messages[1].content = '"\\\n🧩'.repeat(1800) + '长消息尾部独立主题'
    const batches = engine.packInputBatches(messages)
    const parts = batches.flatMap(batch => batch.fragments).filter(part => part.sourceId === 2)
    assert.equal(parts.map(part => part.text.slice(part.text.indexOf(': ') + 2)).join(''), messages[1].content)
    const calls = []
    const diagnostics = contract.createReportAnalysisDiagnostics({ selectedMessageCount: 3, windowMessageCount: 3, sourceCompleteness: 'complete' })
    await engine.summarizeCompleteInput(messages, diagnostics, { deadlineMs: Date.now() + 60000, request: makeSummaryRequest(calls) })
    assert(calls.every(call => call.input.length <= 4000)); assert.equal(diagnostics.summarizedMessageCount, 3)
  })

  await checkBehavior(check, '分批前缀、40条上限、完整长正文与Unicode片段', async () => {
    const messages = sampleMessages(250)
    messages[120].content = '🧩'.repeat(6000) + '长消息尾部独立主题'
    const batches = engine.packInputBatches(messages)
    assert.ok(batches.length > 3)
    for (const batch of batches) {
      assert.ok(batch.text.length <= 4000)
      assert.ok(new Set(batch.fragments.map(fragment => fragment.sourceId)).size <= 40)
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
    const submittedItems = calls.filter(call => !call.system.includes('摘要合并助手')).flatMap(call => JSON.parse(call.input).items)
    assert.equal(submittedItems.length, count)
    assert(submittedItems.some(item => item.text === '后段独立主题'))
    assert(calls.every(call => call.input.length <= 4000))
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
      const value = parseExchangeResponse(await normal(...args))
      if (requests.length === 1) value.groups.push({ title: '金句候选', summary: '', refs: ['r1'] })
      return formatExchange(value)
    } })
    assert.equal(requests.length, 2)
    assert.equal(requests[0].input, requests[1].input)
    assert(requests[1].system.includes('summary必须为非空文字'))
    assert(requests[1].system.includes('金句单独输出quote记录'))
    assert.equal(diagnostics.retryCount, 1)
    assert.equal(diagnostics.summarizedMessageCount, 3)
  })

  await checkBehavior(check, '非法来源和必要合并失败均整份判失败', async () => {
    const messages = sampleMessages(250)
    const normal = makeSummaryRequest([])
    for (const mode of ['bad_source', 'bad_merge']) {
      const diagnostics = contract.createReportAnalysisDiagnostics({ windowMessageCount: 250, selectedMessageCount: 250, sourceCompleteness: 'complete' })
      await assert.rejects(engine.summarizeCompleteInput(messages, diagnostics, { deadlineMs: Date.now() + 60000, request: async (...args) => {
        const value = parseExchangeResponse(await normal(...args))
        if (mode === 'bad_source') value.groups[0].refs = ['r9999']
        else if (args[0].includes('摘要合并助手')) {
          return ''
        }
        return formatExchange(value)
      } }), error => error.code === 'DAILY_REPORT_GENERATION_FAILED')
      assert.equal(diagnostics.failedBatches.length, 1)
      assert.equal(diagnostics.analysisState, 'failed')
    }
  })

  await checkBehavior(check, '未改写的有效摘要保留原文和来源，程序不把遗漏引用猜补到新话题', async () => {
    const messages = sampleMessages(250)
    const normal = makeSummaryRequest([])
    const diagnostics = contract.createReportAnalysisDiagnostics({ windowMessageCount: 250, selectedMessageCount: 250, sourceCompleteness: 'complete' })
    const result = await engine.summarizeCompleteInput(messages, diagnostics, { deadlineMs: Date.now() + 60000, request: async (...args) => {
      const value = parseExchangeResponse(await normal(...args))
      if (args[0].includes('摘要合并助手') && value.groups.length > 1) value.groups.pop()
      return formatExchange(value)
    } })
    assert.equal(result.sourceIds.size, 250)
    assert.equal(diagnostics.summarizedMessageCount, 250)
    assert.ok(result.digest.includes('后段独立主题'))
    assert(diagnostics.warnings.some(warning => warning.includes('程序已原样保留')))
    const original = { title: '未选中原主题', summary: '原始已验证结论', sourceIds: [2], participants: ['另一身份'] }
    const context = engine.createDigestExchange([{ title: '已选主题', summary: '事实', sourceIds: [1], participants: ['本人'] }, original], [], sampleMessages(2))
    const retained = engine.readExchange(formatExchange({ groups: [{ title: '改写主题', summary: '改写结论', refs: ['r1'] }], quotes: [] }), context, 1400, true)
    assert.deepEqual(retained.topics[0].sourceIds, [1]); assert.deepEqual(retained.topics[1], original)
    assert.deepEqual(retained.retainedRefs, ['r2'])
    assert.throws(() => engine.readExchange(formatExchange({ groups: [{ title: '改写主题', summary: '改写结论', refs: ['r999'] }], quotes: [] }), context, 1400, true), /REF_UNKNOWN/)
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

module.exports = { runCompleteInputTests, makeSummaryRequest, formatExchange, formatFullExchange, parseExchangeResponse }
