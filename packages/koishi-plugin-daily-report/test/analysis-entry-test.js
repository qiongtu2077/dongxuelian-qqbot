/** 正式分析入口行为：实际摘要输入、预计算捷径失效、覆盖与严格失败。 */
'use strict'
const assert = require('assert')
const { makeSummaryRequest } = require('./complete-input-test')

// 构造前中后主题与可核对的连续来源，不含任何生产发送目标。
function makeInput(count) {
  const messages = Array.from({ length: count }, (_, index) => ({ analysisId: index + 1, ts: 1791000000000 + index * 1000,
    time: '12:00:00', user: '同名成员', userId: 'u', content: index === 0 ? '前段独立主题' : index === Math.floor(count / 2) ? '中段独立主题' : index === count - 1 ? '后段独立主题' : `普通讨论${index}` }))
  return { totalMessages: count + 20, windowMessageCount: count + 20, messages, sourceCompleteness: 'complete',
    topMembers: [{ userId: 'u', name: '同名成员', msgCount: count }], precomputedContext: '只有末尾80条的错误预计算文本', precomputedCoverageRate: 100 }
}

// 模拟公共API边界：摘要只传播实际输入，最终话题只引用实际共同摘要。
function makeModelRequest(calls, options = {}) {
  const summarize = makeSummaryRequest(calls)
  let basicAttempts = 0
  return async (messages, config, extra) => {
    const system = messages[0].content
    const input = messages[1].content
    if (system.includes('consumedFragmentIds') || system.includes('consumedNodeIds')) {
      return { type: 'text', content: await summarize(system, input, extra.max_tokens, extra) }
    }
    extra._onRequestAttempt?.()
    calls.push({ system, input, extra })
    if (system.includes('qualityReview')) {
      const members = JSON.parse(input).members
      if (options.missingPortrait) return { type: 'text', content: JSON.stringify({ userTitles: [] }) }
      return { type: 'text', content: JSON.stringify({ userTitles: members.map(member => ({ userId: member.userId, title: '讨论参与者', reason: '参与各时段讨论', mbti: '' })),
        qualityReview: { title: '实际讨论锐评', subtitle: '有前中后主题', summary: '各时段都有明确讨论',
          dimensions: ['信息', '互动', '情绪', '节奏'].map(name => ({ name, percentage: 25, comment: '实际讨论依据' })) } }) }
    }
    basicAttempts += 1
    if (options.badBasic || (options.retryBasic && basicAttempts === 1)) return { type: 'text', content: '{broken' }
    const digest = JSON.parse(input)
    const value = { topics: digest.topics.map(topic => ({ ...topic })), goldenQuotes: digest.quoteRefs.slice(0, 1) }
    if (options.badReference) value.topics[0].sourceIds = [999999]
    if (options.duplicateTopics) value.topics.push(value.topics[0])
    if (options.rewriteQuote) value.goldenQuotes[0].content = '这是模型改写的假原话'
    extra._onRequestUsage?.({ readable: false, promptTokens: 0, completionTokens: 0, totalTokens: 0 })
    return { type: 'text', content: JSON.stringify(value) }
  }
}

// 汇总独立行为，不以源码字符串断言代替实际输入和结果检查。
async function verify(check, name, run) {
  try { await run(); check(name, true) } catch (error) { check(name, false, error.stack || String(error)) }
}

// 复用测试侧公共模块替换边界，真实调用正式analyzeWithAI入口。
async function runAnalysisEntryTests(check, withMockedAiAnalyzer) {
  for (const count of [591, 1330, 4000]) await verify(check, `正式入口${count}条全覆盖，100%统计预计算不能绕过完整摘要`, async () => {
    const input = makeInput(count)
    const calls = []
    await withMockedAiAnalyzer(makeModelRequest(calls), async analyzer => {
      const result = await analyzer.analyzeWithAI(input, false)
      const rawCalls = calls.filter(call => call.system.includes('consumedFragmentIds'))
      const ids = new Set(rawCalls.flatMap(call => [...call.input.matchAll(/\[M(\d+):P(\d+)\]/g)].map(match => Number(match[1]))))
      assert.equal(ids.size, count)
      assert.equal(result.meta.summarizedMessageCount, count)
      assert.equal(result.meta.topicInputMessageCount, count)
      assert.equal(result.meta.excludedByLimitCount, 20)
      assert.equal(result.meta.omittedMessageCount, 0)
      assert.equal(result.meta.coverageRate, 100)
      assert.equal(result.meta.analysisState, 'complete')
      assert.equal(result.meta.requestCount, calls.length)
      assert.equal(result.meta.reportCallCount, calls.length)
      assert.equal(result.meta.usageReadableRequests, 0)
      assert.equal(result.tokenUsage.totalTokens, 0)
      const final = calls.find(call => !call.system.includes('consumedFragmentIds') && !call.system.includes('consumedNodeIds'))
      for (const theme of ['前段独立主题', '中段独立主题', '后段独立主题']) {
        assert.ok(final.input.includes(theme))
        assert.ok(result.topics.some(topic => topic.title === theme))
      }
      assert.ok(!final.input.includes('只有末尾80条'))
    })
  })
  await verify(check, '正式入口长正文尾部完整传播，最终分析一次失败可恢复', async () => {
    const input = makeInput(3)
    input.messages[1].content = '🧩'.repeat(6000) + '长消息尾部独立主题'
    await withMockedAiAnalyzer(makeModelRequest([], { retryBasic: true }), async analyzer => {
      const result = await analyzer.analyzeWithAI(input, false)
      assert.equal(result.meta.retryCount, 1)
      assert.equal(result.meta.summarizedMessageCount, 3)
      assert.ok(result.topics.some(topic => topic.title === '长消息尾部独立主题'))
    })
  })
  for (const options of [{ badBasic: true }, { badReference: true }, { duplicateTopics: true }]) await verify(check, `正式入口必要话题校验失败拒绝部分成功：${Object.keys(options)[0]}`, async () => {
    const calls = []
    await withMockedAiAnalyzer(makeModelRequest(calls, options), async analyzer => {
      await assert.rejects(analyzer.analyzeWithAI(makeInput(3), false), error => {
        assert.equal(error.code, 'DAILY_REPORT_GENERATION_FAILED')
        assert.equal(error.diagnostics.failedBatches[0].attempts, 2)
        assert.equal(error.diagnostics.analysisState, 'failed')
        return true
      })
      assert.equal(calls.filter(call => call.system.includes('只输出JSON：{"topics"')).length, 2)
    })
  })
  await verify(check, '正式入口详细版不足5个话题或缺画像整份失败', async () => {
    await withMockedAiAnalyzer(makeModelRequest([], { missingPortrait: true }), async analyzer => {
      await assert.rejects(analyzer.analyzeWithAI(makeInput(3), true), error => {
        assert.equal(error.code, 'DAILY_REPORT_GENERATION_FAILED')
        assert.equal(error.diagnostics.failedBatches.length, 2)
        return true
      })
    })
  })
  await verify(check, '正式入口金句忽略模型改写并恢复真实来源', async () => {
    const input = makeInput(3)
    input.messages[1].userId = 'other-same-name'
    await withMockedAiAnalyzer(makeModelRequest([], { rewriteQuote: true }), async analyzer => {
      const result = await analyzer.analyzeWithAI(input, false)
      assert.equal(result.goldenQuotes[0].content, input.messages[0].content)
      assert.equal(result.goldenQuotes[0].userId, 'u')
      assert.equal(input.messages[0].user, input.messages[1].user)
      assert.notEqual(result.goldenQuotes[0].userId, input.messages[1].userId)
    })
  })
  await verify(check, '正式入口总截止耗尽零请求，用户取消原原因传播', async () => {
    const calls = []
    await withMockedAiAnalyzer(makeModelRequest(calls), async analyzer => {
      await assert.rejects(analyzer.analyzeWithAI(makeInput(3), false, { now: () => 100, deadlineMs: 100 }), error => error.code === 'DAILY_REPORT_TOTAL_TIMEOUT')
      assert.equal(calls.length, 0)
      const controller = new AbortController()
      const reason = new Error('控制台主动取消')
      controller.abort(reason)
      await assert.rejects(analyzer.analyzeWithAI(makeInput(3), false, { signal: controller.signal }), error => error === reason)
      assert.equal(calls.length, 0)
    })
  })
}

module.exports = { runAnalysisEntryTests, makeInput, makeModelRequest }
