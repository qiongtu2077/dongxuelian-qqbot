const { withScenario } = require('./_setup')
const { mockFetch } = require('../fake/fetch')
const { seedCapabilityConfig } = require('../helpers/ai-capability-fixture')
const { readStatusResult } = require('../helpers/status-result')

// 为连通性行为测试隔离内存快照与网络桩，离开时恢复全局状态。
async function withProbeEnvironment(fetch, fn) {
  const previousFetch = global.fetch
  const previousNow = Date.now
  let statusNow = previousNow()
  // 只控制冷却时钟，保留真实网络超时和异步调度。
  Date.now = () => statusNow
  const previousAvailable = process.env.RESOURCE_SCHEDULER_MEM_AVAILABLE_MB_OVERRIDE
  const previousTotal = process.env.RESOURCE_SCHEDULER_MEM_TOTAL_MB_OVERRIDE
  global.fetch = fetch
  process.env.RESOURCE_SCHEDULER_MEM_AVAILABLE_MB_OVERRIDE = '1200'
  process.env.RESOURCE_SCHEDULER_MEM_TOTAL_MB_OVERRIDE = '1600'
  try { await fn(milliseconds => { statusNow += milliseconds }) }
  finally {
    global.fetch = previousFetch
    Date.now = previousNow
    if (previousAvailable === undefined) delete process.env.RESOURCE_SCHEDULER_MEM_AVAILABLE_MB_OVERRIDE
    else process.env.RESOURCE_SCHEDULER_MEM_AVAILABLE_MB_OVERRIDE = previousAvailable
    if (previousTotal === undefined) delete process.env.RESOURCE_SCHEDULER_MEM_TOTAL_MB_OVERRIDE
    else process.env.RESOURCE_SCHEDULER_MEM_TOTAL_MB_OVERRIDE = previousTotal
  }
}

// 验证合并记录遵守群/私聊目标，冷却只发普通文字；记录失败可降级。
async function runForwardCases(t) {
  await withScenario({ data: { randomWhitelist: ['10001'], randomRate: { '10001': 1 } } }, async ({ makeSession, run }) => {
    await withProbeEnvironment(mockFetch().fetch, async advance => {
      const group = await run(makeSession({ content: 'AI状态' }))
      t.check('merged group status shows configured whitelist and base rate', readStatusResult(group).includes('当前群基础触发率：100%') && readStatusResult(group).includes('当前群白名单状态：允许主动回复'))
      advance(120000)
      const session = makeSession({ content: 'AI状态', isDirect: true, guildId: '', userId: 'private-user' })
      session.bot.internal.sendPrivateForwardMsg = async function (userId, messages) { session.internalCalls.push({ method: 'sendPrivateForwardMsg', userId, messages }); return 101 }
      const direct = await run(session)
      t.check('private AI status uses merged private record', direct.sent.length === 0 && direct.internalCalls.some(call => call.method === 'sendPrivateForwardMsg' && call.userId === 'private-user') && !readStatusResult(direct).includes('当前群人格：'))
      const cooling = await run(makeSession({ content: 'AI状态' }))
      t.check('cooldown never sends merged record', cooling.sent.join('') === '查询冷却倒计时120秒' && cooling.internalCalls.length === 0)
      advance(120000)
      const failed = await run(makeSession({ content: 'AI状态', internal: { forwardShouldFail: true } }))
      t.check('failed merged record falls back to readable status', failed.sent.join('').startsWith('莲莲 · AI状态'))
    })
  })
}

// 验证真实命令入口的请求上限、跨会话冷却、过期重测、超时和资源退让。
async function run(t) {
  t.section('scenario: status connectivity')
  await runForwardCases(t)
  await withScenario({}, async ({ data, makeSession, run }) => {
    seedCapabilityConfig(data, { text: [
      { provider: 'opencode', model: 'probe-one' }, { provider: 'dashscope', model: 'probe-two' },
      { provider: 'glm', model: 'probe-three' }, { provider: 'deepseek', model: 'probe-four' },
      { provider: 'mimorium', model: 'not-probed' },
    ] })
    const mocked = mockFetch([
      { status: 404, delayMs: 20 }, { invalidJson: true, delayMs: 20 },
      { json: { choices: [{ message: { content: '' }, finish_reason: 'stop' }] }, delayMs: 20 },
      { error: new Error('private-network-error'), delayMs: 20 },
    ])
    let active = 0
    let peak = 0
    // 记录同时在途请求，真实异步延迟保证并发上限可观测。
    const fetch = async (...args) => {
      active++
      peak = Math.max(peak, active)
      try { return await mocked.fetch(...args) }
      finally { active-- }
    }
    await withProbeEnvironment(fetch, async advance => {
      const results = await Promise.all([
        run(makeSession({ content: 'AI状态', channelId: 'probe-a' })),
        run(makeSession({ content: 'ai状态', channelId: 'probe-b', userId: 'another-user', isDirect: true, guildId: '' })),
      ])
      const replies = results.map(readStatusResult)
      const text = replies.find(reply => reply.startsWith('莲莲 · AI状态')) || ''
      t.check('scenario concurrent status queries start one bounded batch and share a global cooldown',
        mocked.calls.length === 4 && peak === 2 && replies.filter(reply => reply === '查询冷却倒计时120秒').length === 1, JSON.stringify({ calls: mocked.calls.length, peak, replies }))
      t.check('scenario status probes only the four displayed text nodes', !mocked.calls.some(call => call.requestBody.model === 'not-probed') && text.includes('另 1 项见控制台'), text)
      t.check('scenario connectivity distinguishes missing model invalid JSON empty result and network failure',
        text.includes('HTTP 404：模型或接口不存在') && text.includes('返回格式异常') && text.includes('未返回有效文本或截断标记') && text.includes('网络请求失败') && !text.includes('private-network-error'), text)
      t.check('scenario connectivity does not send per-node business alerts', results.every(result => !result.internalCalls.some(call => call.method === 'sendPrivateMsg')), JSON.stringify(results.map(result => result.internalCalls)))
      advance(61000)
      const cooling = await run(makeSession({ content: 'AI状态', channelId: 'probe-cooling' }))
      t.check('scenario cooldown returns the exact remaining seconds without extending the window',
        cooling.sent.join('\n') === '查询冷却倒计时59秒' && mocked.calls.length === 4, JSON.stringify(cooling.sent))
      const resource = await run(makeSession({ content: '资源状态' }))
      t.check('scenario resource status remains readable during AI status cooldown',
        resource.sent.join('\n').includes('模型顺序（按配置排列）') && mocked.calls.length === 4, JSON.stringify(resource.sent))
      advance(58999)
      const finalSecond = await run(makeSession({ content: 'AI状态' }))
      t.check('scenario cooldown rounds the last millisecond up to one second',
        finalSecond.sent.join('\n') === '查询冷却倒计时1秒' && mocked.calls.length === 4, JSON.stringify(finalSecond.sent))
      advance(1)
      const expired = await run(makeSession({ content: 'AI状态', channelId: 'probe-expired' }))
      t.check('scenario exact two-minute boundary starts a fresh probe and cooldown',
        mocked.calls.length === 8 && readStatusResult(expired).includes('本次检测'), JSON.stringify(expired.sent))
      const renewed = await run(makeSession({ content: 'AI状态' }))
      t.check('scenario accepted query renews a full two-minute cooldown',
        renewed.sent.join('\n') === '查询冷却倒计时120秒' && mocked.calls.length === 8, JSON.stringify(renewed.sent))
      t.check('scenario connectivity releases the resource lock', require('../../lib/resource-gate/gate').getResourceGateStatus().meta === null)
    })
  })

  await withScenario({}, async ({ makeSession, run }) => {
    let calls = 0
    // 返回响应头后挂起响应体，验证五秒超时覆盖整个请求读取过程。
    const fetch = async (url, options) => {
      calls++
      return {
        ok: true,
        json: () => new Promise((resolve, reject) => {
          options.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
        }),
      }
    }
    await withProbeEnvironment(fetch, async () => {
      const result = await run(makeSession({ content: 'AI状态' }))
      t.check('scenario connectivity body timeout is reported without retry',
        calls === 1 && readStatusResult(result).includes('检测超时（5 秒）'), JSON.stringify(result.sent))
      t.check('scenario connectivity timeout releases the resource lock', require('../../lib/resource-gate/gate').getResourceGateStatus().meta === null)
    })
  })

  await withScenario({}, async ({ data, makeSession, run }) => {
    const mocked = mockFetch()
    await withProbeEnvironment(mocked.fetch, async advance => {
      data.writeText('ai-paused.txt', 'maintenance')
      const maintenance = await run(makeSession({ content: 'AI状态' }))
      require('fs').unlinkSync(data.pathFor('ai-paused.txt'))
      process.env.RESOURCE_SCHEDULER_MEM_AVAILABLE_MB_OVERRIDE = '299'
      advance(120000)
      const critical = await run(makeSession({ content: 'AI状态' }))
      t.check('scenario maintenance and low memory skip new connectivity requests',
        mocked.calls.length === 0 && [maintenance, critical].every(result => readStatusResult(result).includes('暂停探测')), JSON.stringify([maintenance.sent, critical.sent]))
      process.env.RESOURCE_SCHEDULER_MEM_AVAILABLE_MB_OVERRIDE = '1200'
      seedCapabilityConfig(data, { text: [{ provider: 'anthropic', model: 'claude-test' }] })
      advance(120000)
      const unsupported = await run(makeSession({ content: 'AI状态' }))
      t.check('scenario unsupported micro-probe protocol is skipped without guessed request',
        mocked.calls.length === 0 && readStatusResult(unsupported).includes('当前协议尚无微量探针'), JSON.stringify(unsupported.sent))
    })
  })
}
module.exports = { run }
