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
    const quoteRef = quotes ? quotes[0]?.ref : items[0].ref
    return formatExchange({ groups: [...groups.values()], quotes: quoteRef ? [{ ref: quoteRef, reason: '真实来源候选' }] : [] })
  }
}

// 每个行为独立汇总失败，后续测试仍能给出实际诊断证据。
async function checkBehavior(check, label, run) {
  try { await run(); check(label, true) } catch (error) { check(label, false, error.stack || String(error)) }
}

// 执行完整摘要行为验收；所有模型请求均为本地模拟，没有生产通知。
async function runCompleteInputTests(check) {
  await checkBehavior(check, '唯一恢复使用调用方明确格式，默认JSONL与records对象契约不混用', async () => {
    for (const wrapped of [false, true]) {
      const diagnostics = contract.createReportAnalysisDiagnostics({ selectedMessageCount: 1, windowMessageCount: 1, sourceCompleteness: 'complete' })
      const systems = []
      const runtime = { deadlineMs: Date.now() + 60000,
        ...(wrapped ? { recoveryInstructions: '只返回单个records对象，最后一项为end。' } : {}),
        request: async (system, _input, _tokens, extra) => {
          extra._onRequestAttempt()
          systems.push(system)
          if (systems.length === 1) return '{broken'
          return wrapped ? '{"records":[{"kind":"end"}]}' : '{"kind":"end"}'
        } }
      const value = await engine.requestAnalysisUnit(runtime, diagnostics,
        { id: 'format-recovery', stage: 'basic', sourceIds: [1], timestamps: [] }, '明确业务契约', '固定原输入', 100, 1000,
        output => wrapped ? engine.parseExchangeObject(output).records : engine.parseExchangeRecords(output))
      assert.equal(systems.length, 2)
      assert.equal(diagnostics.retryCount, 1)
      assert.equal(diagnostics.requestCount, 2)
      if (wrapped) {
        assert(systems[1].endsWith(runtime.recoveryInstructions))
        assert(!systems[1].includes('输出全部独立JSON记录，不写外层包装'))
        assert.deepEqual(value, [{ kind: 'end' }])
      } else {
        assert(systems[1].includes('输出全部独立JSON记录，不写外层包装'))
        assert.deepEqual(value, [])
      }
    }
  })

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

  await checkBehavior(check, '摘要正文夹带旧临时引用时拒绝整轮，防止下一层同名编号串绑', async () => {
    const messages = sampleMessages(2)
    const context = engine.createDigestExchange([{ title: '图片分享', summary: '只有媒体提示', sourceIds: [1, 2], participants: ['u'] }], [], messages)
    for (const field of ['title', 'summary']) {
      for (const leak of ['（r20,r33）', '由p10与p13讨论', '沿用r20结论']) {
        const group = { title: '图片分享', summary: '只有媒体提示', refs: ['r1'] }
        group[field] += leak
        assert.throws(() => engine.readExchange(formatExchange({ groups: [group], quotes: [] }), context), /REF_IN_TEXT/)
      }
    }
    assert.doesNotThrow(() => engine.readExchange(formatExchange({ groups: [{ title: 'TCP1协议', summary: 'arp10字段与TCP1协议独立', refs: ['r1'] }], quotes: [] }), context))
    let calls = 0
    const diagnostics = contract.createReportAnalysisDiagnostics({ selectedMessageCount: 2, windowMessageCount: 2, sourceCompleteness: 'complete' })
    await engine.summarizeCompleteInput(messages, diagnostics, { deadlineMs: Date.now() + 60000, request: async (system, input) => {
      calls++
      if (calls === 2) assert(system.includes('[REF_IN_TEXT]'))
      const refs = JSON.parse(input).items.map(item => item.ref)
      return formatExchange({ groups: [{ title: '普通讨论', summary: calls === 1 ? '媒体提示（r20）' : '消息正文的实际讨论', refs }], quotes: [] })
    } })
    assert.equal(calls, 2)
    assert.equal(diagnostics.summarizedMessageCount, 2)
  })

  await checkBehavior(check, '唯一结构恢复切换冻结下一节点，实际调用额度仍在提交前限制', async () => {
    const diagnostics = contract.createReportAnalysisDiagnostics({ selectedMessageCount: 1, windowMessageCount: 1, sourceCompleteness: 'complete' })
    const calls = []
    const runtime = { deadlineMs: Date.now() + 60000, maxRequestCount: 2, recoveryStepIndex: execution => execution.stepIndex + 1,
      request: async (system, input, tokens, extra) => {
        calls.push(extra)
        const step = { routeIdentity: 'frozen', stepIndex: extra._frozenRouteStartStepIndex || 0 }
        extra._onRequestAttempt(step)
        extra._onRequestExecution({ ...step, model: step.stepIndex ? 'backup' : 'primary' })
        return calls.length === 1 ? 'broken' : 'valid'
      } }
    const result = await engine.requestAnalysisUnit(runtime, diagnostics, { id: 'unit', stage: 'compression', sourceIds: [1], timestamps: [] }, 'system', 'input', 100, 10000,
      text => { if (text !== 'valid') throw new Error('[JSON_PARSE] invalid'); return text })
    assert.equal(result, 'valid')
    assert.equal(calls.length, 2)
    assert.equal(calls[1]._frozenRouteStartStepIndex, 1)
    assert.equal(diagnostics.requestCount, 2)
    assert.equal(diagnostics.retryCount, 1)
    const exhausted = contract.createReportAnalysisDiagnostics({ selectedMessageCount: 1, windowMessageCount: 1, sourceCompleteness: 'complete' })
    calls.length = 0
    await assert.rejects(engine.requestAnalysisUnit({ ...runtime, maxRequestCount: 1 }, exhausted, { id: 'unit', stage: 'compression', sourceIds: [1], timestamps: [] },
      'system', 'input', 100, 10000, () => { throw new Error('[JSON_PARSE] invalid') }), /实际模型调用额度已耗尽/)
    assert.equal(exhausted.requestCount, 1)
  })

  await checkBehavior(check, '明确length结束的闭合正文不校验或保存，只能在原额度内整输入恢复', async () => {
    for (const finishes of [['length', 'stop'], ['length', 'length']]) {
      const diagnostics = contract.createReportAnalysisDiagnostics({ selectedMessageCount: 1, windowMessageCount: 1, sourceCompleteness: 'complete' })
      const attempts = [], completed = []
      let calls = 0, validations = 0
      const runtime = { deadlineMs: Date.now() + 60000, maxRequestCount: 2,
        onUnitCompleted: (unit, history, value) => { completed.push(value); attempts.push(...history) },
        onUnitFailed: (unit, history) => attempts.push(...history),
        request: async (system, input, tokens, extra) => {
          extra._onRequestAttempt()
          extra._onRequestExecution({ finishReason: finishes[calls++], finishReasonReadable: true })
          return '{"completed":true}'
        } }
      const request = () => engine.requestAnalysisUnit(runtime, diagnostics, { id: 'closed-length', stage: 'compression', sourceIds: [1], timestamps: [] },
        'same-system', 'same-full-input', 100, 10000, text => { validations++; return JSON.parse(text) })
      if (finishes[1] === 'stop') assert.deepEqual(await request(), { completed: true })
      else await assert.rejects(request(), /MODEL_TRUNCATED/)
      assert.equal(calls, 2)
      assert.equal(validations, finishes[1] === 'stop' ? 1 : 0)
      assert.equal(completed.length, finishes[1] === 'stop' ? 1 : 0)
      assert.equal(diagnostics.requestCount, 2)
      assert.equal(diagnostics.retryCount, 1)
      assert.equal(attempts[0].input, 'same-full-input')
      assert.equal(attempts[1].input, 'same-full-input')
      assert(attempts[0].error.includes('MODEL_TRUNCATED'))
    }
  })

  for (const scenario of [
    { count: 565, batch: 2, missing: ['r3'] },
    { count: 592, batch: 3, missing: ['r8', 'r9', 'r10', 'r17', 'r20', 'r36'] },
  ]) await checkBehavior(check, `${scenario.count}条注入历史遗漏：仅补${scenario.missing.join(',')}，首次文字来源保留且计数唯一`, async () => {
    const messages = sampleMessages(scenario.count)
    const batches = engine.packInputBatches(messages)
    const target = batches[scenario.batch - 1]
    const missing = new Set(scenario.missing)
    const originalRefs = target.fragments.map((_, index) => `r${index + 1}`).filter(ref => !missing.has(ref))
    const diagnostics = contract.createReportAnalysisDiagnostics({ selectedMessageCount: scenario.count, windowMessageCount: scenario.count, sourceCompleteness: 'complete' })
    const calls = []
    const normal = makeSummaryRequest(calls)
    const seen = []
    let compressionCount = 0
    let injected = false
    let firstMergeObserved = false
    await engine.summarizeCompleteInput(messages, diagnostics, { deadlineMs: Date.now() + 60000, request: async (...args) => {
      const [system, input, , extra] = args
      const parsed = JSON.parse(input)
      seen.push({ system, ...parsed })
      if (system.includes('定向补漏')) {
        extra._onRequestAttempt?.()
        assert.deepEqual(parsed.items.map(item => item.ref), scenario.missing)
        assert(parsed.items.every(item => item.text === target.fragments[Number(item.ref.slice(1)) - 1].content))
        return formatExchange({ groups: [{ title: '补漏讨论', summary: '补漏只解释缺失片段', refs: scenario.missing }], quotes: [] })
      }
      if (!system.includes('摘要合并助手') && ++compressionCount === scenario.batch) {
        extra._onRequestAttempt?.(); injected = true
        return formatExchange({ groups: [{ title: '首轮原主题', summary: '首轮有效结论必须逐字保留', refs: originalRefs }], quotes: [] })
      }
      if (!firstMergeObserved && system.includes('摘要合并助手') && parsed.items.some(item => item.title === '首轮原主题')) {
        const first = parsed.items.find(item => item.title === '首轮原主题')
        assert.equal(first.summary, '首轮有效结论必须逐字保留')
        firstMergeObserved = true
      }
      return normal(...args)
    } })
    assert(injected)
    assert(firstMergeObserved)
    assert.equal(seen.filter(call => call.system.includes('定向补漏')).length, 1)
    assert.equal(diagnostics.retryCount, 1)
    assert.equal(diagnostics.summarizedMessageCount, scenario.count)
    assert.equal(diagnostics.submittedMessageCount, scenario.count)
  })

  await checkBehavior(check, '遗漏与非法金句同时出现先拒绝金句，结构恢复重发完整输入且不走补漏', async () => {
    const messages = sampleMessages(3)
    const normal = makeSummaryRequest([])
    const requests = []
    const diagnostics = contract.createReportAnalysisDiagnostics({ selectedMessageCount: 3, windowMessageCount: 3, sourceCompleteness: 'complete' })
    await engine.summarizeCompleteInput(messages, diagnostics, { deadlineMs: Date.now() + 60000, request: async (...args) => {
      requests.push({ system: args[0], input: args[1] })
      if (requests.length === 1) return formatExchange({ groups: [{ title: '事实', summary: '结论', refs: ['r1'] }], quotes: [{ ref: 'r999', reason: '非法候选' }] })
      return normal(...args)
    } })
    assert.equal(requests.length, 2)
    assert.equal(requests[0].input, requests[1].input)
    assert(requests[1].system.includes('REF_UNKNOWN'))
    assert(!requests[1].system.includes('定向补漏'))
  })

  for (const badRepair of ['uncovered', 'unknown', 'already_covered', 'invalid_quote']) await checkBehavior(check, `补漏${badRepair}严格失败，只允许一次恢复且不标批次完成`, async () => {
    const diagnostics = contract.createReportAnalysisDiagnostics({ selectedMessageCount: 4, windowMessageCount: 4, sourceCompleteness: 'complete' })
    const calls = []
    await assert.rejects(engine.summarizeCompleteInput(sampleMessages(4), diagnostics, { deadlineMs: Date.now() + 60000, request: async (system, input, tokens, extra) => {
      extra._onRequestAttempt?.(); calls.push({ system, input })
      if (calls.length === 1) return formatExchange({ groups: [{ title: '首轮', summary: '有效内容', refs: ['r1', 'r2'] }], quotes: [] })
      assert.deepEqual(JSON.parse(input).items.map(item => item.ref), ['r3', 'r4'])
      const refs = badRepair === 'uncovered' ? ['r3'] : badRepair === 'unknown' ? ['r999'] : badRepair === 'already_covered' ? ['r1', 'r3', 'r4'] : ['r3', 'r4']
      return formatExchange({ groups: [{ title: '恢复', summary: '内容', refs }], quotes: badRepair === 'invalid_quote' ? [{ ref: 'r1', reason: '已覆盖引用不可用于恢复' }] : [] })
    } }), error => error.code === 'DAILY_REPORT_GENERATION_FAILED' && error.message.includes(badRepair === 'uncovered' ? 'r4' : 'REF_UNKNOWN'))
    assert.equal(calls.length, 2)
    assert.equal(diagnostics.summarizedMessageCount, 0)
    assert.equal(diagnostics.retryCount, 1)
    assert.equal(diagnostics.failedBatches[0].attempts, 2)
  })

  await checkBehavior(check, '首轮与补漏各1400字独立预算，超过首轮预算的合法合计以完整节点合并', async () => {
    const diagnostics = contract.createReportAnalysisDiagnostics({ selectedMessageCount: 4, windowMessageCount: 4, sourceCompleteness: 'complete' })
    let calls = 0
    const normal = makeSummaryRequest([])
    await engine.summarizeCompleteInput(sampleMessages(4), diagnostics, { deadlineMs: Date.now() + 60000, request: async (...args) => {
      calls++
      if (calls <= 2) {
        args[3]._onRequestAttempt?.()
        return formatExchange({ groups: [{ title: calls === 1 ? '首轮长事实' : '补漏长事实', summary: '完整有效事实'.repeat(140), refs: calls === 1 ? ['r1', 'r2'] : ['r3', 'r4'] }], quotes: [] })
      }
      const items = JSON.parse(args[1]).items
      assert.equal(items.length, 2)
      assert(items.every(item => item.summary === '完整有效事实'.repeat(140)))
      return normal(...args)
    } })
    assert.equal(calls, 3)
    assert.equal(diagnostics.summarizedMessageCount, 4)
  })

  await checkBehavior(check, '成功单元先持久化再计完成，落盘失败仅一次调用且保持未完成', async () => {
    const diagnostics = contract.createReportAnalysisDiagnostics({ selectedMessageCount: 3, windowMessageCount: 3, sourceCompleteness: 'complete' })
    const normal = makeSummaryRequest([])
    let calls = 0
    let failureTrace
    await assert.rejects(engine.summarizeCompleteInput(sampleMessages(3), diagnostics, { deadlineMs: Date.now() + 60000,
      request: (...args) => { calls++; return normal(...args) },
      onUnitCompleted(unit, attempts, result) {
        assert.equal(diagnostics.summarizedMessageCount, 0)
        assert.equal(unit.id, 'B1'); assert.equal(attempts.length, 1)
        assert(result.topics.length > 0)
        throw new Error('模拟落盘失败')
      },
      onUnitFailed(unit, attempts) { failureTrace = { unit, attempts } },
    }), error => error.code === 'DAILY_REPORT_GENERATION_FAILED' && error.message === '模拟落盘失败')
    assert.equal(calls, 1)
    assert.equal(diagnostics.summarizedMessageCount, 0)
    assert.equal(diagnostics.retryCount, 0)
    assert.equal(failureTrace.attempts.length, 1)
  })

  await checkBehavior(check, '失败诊断保留两轮与真实缺失引用，诊断保存失败不能掩盖原始错误', async () => {
    const diagnostics = contract.createReportAnalysisDiagnostics({ selectedMessageCount: 4, windowMessageCount: 4, sourceCompleteness: 'complete' })
    const attemptsSeen = []
    let calls = 0
    await assert.rejects(engine.summarizeCompleteInput(sampleMessages(4), diagnostics, { deadlineMs: Date.now() + 60000,
      request: async (system, input, tokens, extra) => {
        extra._onRequestAttempt?.(); calls++
        return formatExchange({ groups: [{ title: '已确认', summary: '具体事实', refs: calls === 1 ? ['r1', 'r2'] : ['r3'] }], quotes: [] })
      },
      onUnitFailed(unit, attempts) { attemptsSeen.push(...attempts); throw new Error('受控诊断磁盘写入失败') },
      onProgress(value) { if (value.analysisState === 'failed') throw new Error('受控失败进度写入失败') },
    }), error => error.code === 'DAILY_REPORT_GENERATION_FAILED' && error.message.includes('r4'))
    assert.equal(attemptsSeen.length, 2)
    assert.deepEqual(attemptsSeen[0].missingRefs, ['r3', 'r4'])
    assert.deepEqual(attemptsSeen[1].missingRefs, ['r4'])
    assert.deepEqual(diagnostics.failedBatches[0].allowedRefs, ['r1', 'r2', 'r3', 'r4'])
    assert.deepEqual(diagnostics.failedBatches[0].missingRefs, ['r4'])
    assert.deepEqual(contract.sanitizeReportAnalysisDiagnostics(diagnostics).failedBatches[0].missingRefs, ['r4'])
    const invalid = JSON.parse(JSON.stringify(diagnostics)); invalid.failedBatches[0].missingRefs = ['私密正文']
    assert.throws(() => contract.sanitizeReportAnalysisDiagnostics(invalid), /引用清单无效/)
    assert(diagnostics.warnings.some(warning => warning.includes('失败诊断保存失败')))
    assert(diagnostics.warnings.some(warning => warning.includes('失败进度保存失败')))
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
