const fs = require('fs')
const path = require('path')
const { withScenario } = require('./_setup')
const { mockFetch } = require('../fake/fetch')
const { seedCapabilityConfig } = require('../helpers/ai-capability-fixture')

const CHAIN = [{ provider: 'deepseek', model: 'deepseek-v4-flash' }, { provider: 'openai', model: 'gpt-4o-mini' }]
const CONFIG = { capability: 'text', provider: 'ignored', model: 'ignored', apiKey: '', baseURL: '' }
const OK = { json: { choices: [{ message: { content: 'NO' }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } } }
const TRUNCATED = { json: { choices: [{ message: { content: '', reasoning_content: 'private-reasoning' }, finish_reason: 'length' }], usage: { prompt_tokens: 10, completion_tokens: 256, total_tokens: 266 } } }

// 每组请求使用隔离配置、真实计时器与可观察的私聊发送器。
async function withApi(queue, fn) {
  await withScenario({}, async scenario => {
    seedCapabilityConfig(scenario.data, { text: CHAIN })
    const api = require('../../lib/core/api')
    const notifier = require('../../lib/core/capability-failure-notifier')
    const diagnostic = require('../../lib/core/request-diagnostics')
    const notifications = [], mocked = mockFetch(queue)
    const previousFetch = global.fetch, previousInfo = console.info, previousWarn = console.warn
    notifier.setCapabilityFailureSender(async (adminId, message) => { notifications.push({ adminId, message }) })
    global.fetch = mocked.fetch
    console.info = () => {}; console.warn = () => {}
    try { await fn({ ...scenario, api, notifier, diagnostic, notifications, mocked }) }
    finally { global.fetch = previousFetch; console.info = previousInfo; console.warn = previousWarn; notifier.resetCapabilityFailureNotifier() }
  })
}

// 验证已确认错误码、脱敏、独立告警、失败用量和请求关联。
async function runEvidenceCases(t) {
  for (const [status, code, message, expected] of [
    [401, 'invalid_api_key', 'bad credential', '认证失败'],
    [403, 'permission_denied', 'permission denied', '权限不足'],
    [429, 'rate_limit', 'too many requests', '请求受限'],
    [402, 'insufficient_balance', '余额不足', '欠费或余额不足'],
    [404, 'model_not_found', 'model not found', '模型或接口不存在'],
  ]) {
    await withApi([{ status, headers: { 'x-request-id': 'upstream-42' }, json: { error: { code, message: message + ' test-deepseek-key private-message' } } }, OK], async ({ api, diagnostic, notifications, mocked, data }) => {
      let error
      try { await api.requestChatCompletions([{ role: 'user', content: 'private-message' }], CONFIG) } catch (caught) { error = caught }
      t.check('diagnostic confirmed reason HTTP ' + status, notifications.length > 0 && notifications.every(item => item.message.includes('原因：' + expected) && item.message.includes('upstream-42') && !item.message.includes('test-deepseek-key') && !item.message.includes('private-message')), JSON.stringify(notifications))
      t.check('diagnostic no invented debt HTTP ' + status, status === 402 || notifications.every(item => !item.message.includes('欠费')), JSON.stringify(notifications))
      t.check('HTTP code includes Chinese status ' + status, notifications.every(item => item.message.includes('状态：HTTP ' + status + '（') && !item.message.includes('（原因未明）')), JSON.stringify(notifications))
      t.checkEqual('diagnostic model missing fallback and permanent rejection ' + status, mocked.calls.length, status === 402 ? 1 : 2)
      const files = fs.readdirSync(path.join(data.dataDir, 'ai-call-diagnostics')).filter(name => name.endsWith('.jsonl'))
      const events = files.flatMap(name => fs.readFileSync(path.join(data.dataDir, 'ai-call-diagnostics', name), 'utf8').trim().split('\n').map(JSON.parse))
      t.check('diagnostic attempts share id and failure body stays sanitized ' + status, events.length === mocked.calls.length && new Set(events.map(item => item.requestId)).size === 1 && !JSON.stringify(events).includes('private-message') && !JSON.stringify(events).includes('test-deepseek-key'), JSON.stringify(events))
      t.check('diagnostic final chain result ' + status, status === 402 ? !!error : diagnostic.formatRecentModelDiagnostic().includes('备用接手成功'))
      api.flushTokenUsage()
      const usage = JSON.parse(fs.readFileSync(path.join(data.dataDir, 'token-usage.json'), 'utf8'))
      const day = Object.values(usage).find(item => item.capabilities?.text)
      t.check('failed call retains unknown usage ' + status, day.capabilities.text.models[CHAIN[0].model].unreadableRequests === 1)
    })
  }
  await withApi([{ status: 404, json: { error: { code: 'not_found', message: 'path missing' } } }, OK], async ({ api, mocked }) => {
    try { await api.requestChatCompletions([], CONFIG) } catch { /* 预期路径错误停止。 */ }
    t.checkEqual('plain path 404 never becomes unconditional fallback', mocked.calls.length, 1)
  })
}

// 截断仅共享一次扩容，所有节点预算总和与整次判断期限均有界。
async function runJudgmentCases(t) {
  await withApi([TRUNCATED, OK], async ({ api, mocked, notifications, data }) => {
    const result = await api.requestChatCompletions([], CONFIG, { _purpose: 'topic_switch' })
    t.checkEqual('judgment recovers using visible answer', result.content, 'NO')
    t.checkEqual('judgment initial and recovery budgets', mocked.calls.map(call => call.requestBody.max_tokens).join(','), '256,512')
    t.check('judgment failure notifies before successful recovery', notifications.length > 0 && notifications.every(item => item.message.includes('用途：话题判断') && item.message.includes('输出预算耗尽')))
    api.flushTokenUsage()
    const usage = JSON.parse(fs.readFileSync(path.join(data.dataDir, 'token-usage.json'), 'utf8'))
    const day = Object.values(usage).find(item => item.capabilities?.text)
    t.check('failed truncation records actual output usage', day.capabilities.text.models[CHAIN[0].model].total === 278, JSON.stringify(day.capabilities.text))
  })
  await withApi([TRUNCATED, TRUNCATED, TRUNCATED, OK], async ({ api, mocked }) => {
    try { await api.requestChatCompletions([], CONFIG, { _purpose: 'identity_judge' }) } catch { /* 无可见判断时整体失败。 */ }
    t.checkEqual('whole chain allows only one expansion', mocked.calls.map(call => call.requestBody.max_tokens).join(','), '256,512,256')
    t.checkEqual('whole chain reserves at most 1024 requested output tokens', mocked.calls.reduce((sum, call) => sum + call.requestBody.max_tokens, 0), 1024)
    t.check('judgment internal purpose never enters HTTP body', mocked.calls.every(call => !('_purpose' in call.requestBody)))
  })
  await withApi([TRUNCATED, OK], async ({ api, mocked }) => {
    const now = Date.now, start = now()
    Date.now = () => start
    global.fetch = async (...args) => { const result = await mocked.fetch(...args); Date.now = () => start + 8001; return result }
    try { await api.requestChatCompletions([], CONFIG, { _purpose: 'topic_switch' }) } catch { /* 总期限已耗尽。 */ }
    finally { Date.now = now }
    t.checkEqual('judgment total deadline stops recovery and backup', mocked.calls.length, 1)
  })
}

// 用户取消与本地回调不发故障告警；通知发送异常不阻断备用。
async function runBoundaryCases(t) {
  await withApi([OK], async ({ api, notifications, mocked }) => {
    const controller = new AbortController()
    controller.abort()
    try { await api.requestChatCompletions([], CONFIG, { signal: controller.signal }) } catch { /* 提交前取消。 */ }
    t.check('pre-cancel makes no call or notification', mocked.calls.length === 0 && notifications.length === 0)
    const inFlight = new AbortController()
    global.fetch = async () => { inFlight.abort(); throw new Error('cancelled') }
    try { await api.requestChatCompletions([], CONFIG, { signal: inFlight.signal }) } catch { /* 在途取消。 */ }
    t.checkEqual('in-flight cancel makes no notification', notifications.length, 0)
  })
  await withApi([{ status: 500 }, OK], async ({ api, notifier, mocked }) => {
    notifier.setCapabilityFailureSender(async () => { throw new Error('private sender detail') })
    const result = await api.requestChatCompletions([], CONFIG)
    t.check('notification send failure cannot break fallback', result.content === 'NO' && mocked.calls.length === 2)
  })
  await withApi([{ status: 500 }, OK], async ({ api, notifier, mocked }) => {
    notifier.setCapabilityFailureSender(async () => new Promise(() => {}))
    const startedAt = Date.now()
    const result = await api.requestChatCompletions([], CONFIG)
    t.check('hung notification sender releases fallback within bounded time', result.content === 'NO' && mocked.calls.length === 2 && Date.now() - startedAt < 3000)
  })
  await withApi([OK], async ({ api, notifications }) => {
    try { await api.requestChatCompletions([], CONFIG, { _onRequestExecution: () => { throw new Error('local processing error') } }) } catch { /* 本地处理失败。 */ }
    t.checkEqual('local execution callback failure never alerts upstream', notifications.length, 0)
  })
}

// 运行模型故障治理专项场景。
// 媒体成功响应也可能无法使用，仍须保存上游实际计量，并排除本地文件错误。
async function runMediaUsageCases(t) {
  await withApi([{ json: { text: '', usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } } }, { json: { choices: [{ message: { content: '识别成功' } }], usage: { total_tokens: 7 } } }], async ({ data, api, notifications }) => {
    seedCapabilityConfig(data, { 'voice-asr': [{ provider: 'openai', model: 'gpt-4o-transcribe' }, { provider: 'mimorium', model: 'mimo-v2.5-asr' }] })
    const voice = require('../../lib/media/voice/voice')
    try { await voice.callModelAsr(data.pathFor('missing.wav')) } catch { /* 本地文件缺失。 */ }
    t.checkEqual('ASR local file error sends no model alert', notifications.length, 0)
    const wav = Buffer.alloc(46)
    wav.write('RIFF'); wav.writeUInt32LE(38, 4); wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16)
    wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(16000, 24); wav.writeUInt32LE(32000, 28)
    wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(2, 40)
    fs.writeFileSync(data.pathFor('sample.wav'), wav)
    t.checkEqual('ASR empty result falls back to actual next model', await voice.callModelAsr(data.pathFor('sample.wav')), '识别成功')
    api.flushTokenUsage()
    const day = Object.values(JSON.parse(fs.readFileSync(data.pathFor('token-usage.json'), 'utf8'))).find(item => item.capabilities?.['voice-asr'])
    t.check('ASR failed call preserves actual usage', day.capabilities['voice-asr'].models['gpt-4o-transcribe'].total === 15)
    t.check('ASR failed call notifies with Chinese reason', notifications.length > 0 && notifications.every(item => item.message.includes('语音识别模型调用失败') && item.message.includes('未返回可见答案')))
  })
  await withApi([{ json: { choices: [{ message: { audio: { data: Buffer.from('not audio').toString('base64') } } }], usage: { total_tokens: 17, input_tokens: 10, output_tokens: 7 } } }], async ({ data, api, notifications }) => {
    seedCapabilityConfig(data, { 'voice-tts': [{ provider: 'mimorium', model: 'mimo-v2.5-tts' }] })
    const tts = require('../../lib/media/voice/tts')
    const result = await tts.synthesizeSpeech('测试文本', { voice: '冰糖' })
    api.flushTokenUsage()
    const day = Object.values(JSON.parse(fs.readFileSync(data.pathFor('token-usage.json'), 'utf8'))).find(item => item.capabilities?.['voice-tts'])
    t.check('TTS invalid audio preserves actual failed-call usage', result === null && day.capabilities['voice-tts'].models['mimo-v2.5-tts'].total === 17)
    t.check('TTS invalid audio notifies with Chinese cause', notifications.length > 0 && notifications.every(item => item.message.includes('语音合成模型调用失败') && item.message.includes('不可播放的音频')))
  })
}

// 运行模型故障治理专项场景。
async function run(t) {
  t.section('scenario: model diagnostics')
  await runEvidenceCases(t)
  await runJudgmentCases(t)
  await runBoundaryCases(t)
  await runMediaUsageCases(t)
}
module.exports = { run }
