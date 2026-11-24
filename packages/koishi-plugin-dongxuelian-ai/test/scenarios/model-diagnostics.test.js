const fs = require('fs')
const http = require('node:http')
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
      t.checkEqual('diagnostic confirmed upstream rejection tries backup ' + status, mocked.calls.length, 2)
      const files = fs.readdirSync(path.join(data.dataDir, 'ai-call-diagnostics')).filter(name => name.endsWith('.jsonl'))
      const events = files.flatMap(name => fs.readFileSync(path.join(data.dataDir, 'ai-call-diagnostics', name), 'utf8').trim().split('\n').map(JSON.parse))
      t.check('diagnostic attempts share id and failure body stays sanitized ' + status, events.length === mocked.calls.length && new Set(events.map(item => item.requestId)).size === 1 && !JSON.stringify(events).includes('private-message') && !JSON.stringify(events).includes('test-deepseek-key'), JSON.stringify(events))
      t.check('diagnostic final chain result ' + status, !error && diagnostic.formatRecentModelDiagnostic().includes('备用接手成功'))
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
  await withApi([], async ({ diagnostic, data }) => {
    const common = { requestId: 'same-millisecond', capability: 'text', purpose: 'chat', elapsedMs: 0 }
    diagnostic.recordModelDiagnostic({ ...common, ...CHAIN[0], status: 'failure', attempt: 1, fallback: false, reason: '请求受限' })
    diagnostic.recordModelDiagnostic({ ...common, ...CHAIN[1], status: 'success', attempt: 2, fallback: true })
    const file = 'ai-call-diagnostics/recent.json', instant = new Date().toISOString()
    const failureKey = 'text:' + CHAIN[0].provider + ':' + CHAIN[0].model, successKey = 'text:' + CHAIN[1].provider + ':' + CHAIN[1].model
    const recent = data.readJson(file)
    for (const record of Object.values(recent)) record.createdAt = instant
    data.writeJson(file, { [failureKey]: recent[failureKey], [successKey]: recent[successKey] })
    t.check('same-millisecond final success follows persisted recording order', diagnostic.formatRecentModelDiagnostic().includes('备用接手成功'))
    diagnostic.recordModelDiagnostic({ ...common, ...CHAIN[0], status: 'failure', attempt: 3, fallback: true, reason: '请求受限' })
    const failed = data.readJson(file)
    for (const record of Object.values(failed)) record.createdAt = instant
    data.writeJson(file, { [successKey]: failed[successKey], [failureKey]: failed[failureKey] })
    t.check('same-millisecond later failure is not hidden by previous success', diagnostic.formatRecentModelDiagnostic().startsWith('最近文字调用：请求受限'))
  })
}

// 使用单一 DeepSeek 节点验证连接错误、响应体断开和脱敏。
async function runTransportCases(t) {
  await withApi([], async ({ api, notifier, data, mocked, notifications }) => {
    seedCapabilityConfig(data, { text: [CHAIN[0]] })
    const ipv4 = Object.assign(new Error('private connection payload'), { code: 'ETIMEDOUT', syscall: 'connect', address: '192.0.2.1' })
    const ipv6 = Object.assign(new Error('private connection payload'), { code: 'ENETUNREACH', syscall: 'connect' })
    const cause = new AggregateError([ipv4, ipv6, ipv4, ipv6], 'test-deepseek-key')
    mocked.push({ error: new TypeError('fetch failed', { cause }) }, OK, OK, { invalidJson: true })
    const diagnosticFile = 'ai-call-diagnostics/recent.json'
    const key = 'text:' + CHAIN[0].provider + ':' + CHAIN[0].model
    let error
    try { await api.requestChatCompletions([], CONFIG) } catch (caught) { error = caught }
    const failed = data.readJson(diagnosticFile)[key]
    t.checkEqual('connection diagnostics keep the network error classification', error?.code, 'NETWORK_ERROR')
    t.checkEqual('connection diagnostics retain each socket failure and stage', JSON.stringify(failed.transport),
      JSON.stringify({ phase: 'request', errors: [
        { code: 'ETIMEDOUT', syscall: 'connect' }, { code: 'ENETUNREACH', syscall: 'connect' },
        { code: 'ETIMEDOUT', syscall: 'connect' }, { code: 'ENETUNREACH', syscall: 'connect' },
      ] }))
    t.check('connection logs omit addresses, keys and raw exceptions', !/192\.0\.2\.1|test-deepseek-key|private connection payload/.test(JSON.stringify(failed)))
    t.check('connection failure notification surfaces deduplicated transport codes without leaking addresses or keys',
      notifications.length > 0
      && notifications.every(item => item.message.includes('传输诊断：请求连接（connect ETIMEDOUT、connect ENETUNREACH）')
        && !/192\.0\.2\.1|test-deepseek-key|private connection payload/.test(item.message)),
      JSON.stringify(notifications))
    await api.requestChatCompletions([], CONFIG)
    const recovered = data.readJson(diagnosticFile)[key]
    t.check('success records its own fields and retains only the historical failure summary', recovered.status === 'success'
      && !recovered.code && !recovered.reason && recovered.httpStatus === undefined && !recovered.transport
      && recovered.lastFailureAt === failed.createdAt && recovered.lastFailureReason === failed.reason)

    notifications.length = 0
    global.fetch = async (...args) => {
      const response = await mocked.fetch(...args)
      return { ...response, async json() {
        throw new TypeError('terminated', { cause: Object.assign(new Error('private socket data'), { code: 'UND_ERR_SOCKET' }) })
      } }
    }
    try { await api.requestChatCompletions([], CONFIG) } catch (caught) { error = caught }
    const interrupted = data.readJson(diagnosticFile)[key]
    t.check('response body failure retains HTTP status and socket code', error?.code === 'NETWORK_ERROR'
      && interrupted.httpStatus === 200 && interrupted.transport?.phase === 'response_body'
      && interrupted.transport.errors[0]?.code === 'UND_ERR_SOCKET')
    t.check('response body failure notification surfaces response_body transport code safely',
      notifications.length > 0
      && notifications.every(item => item.message.includes('传输诊断：响应读取（UND_ERR_SOCKET）') && !item.message.includes('private socket data')),
      JSON.stringify(notifications))

    notifications.length = 0
    global.fetch = mocked.fetch
    try { await api.requestChatCompletions([], CONFIG) } catch (caught) { error = caught }
    const malformed = data.readJson(diagnosticFile)[key]
    t.check('malformed JSON remains a format error with the received HTTP status', error?.code === 'INVALID_RESPONSE'
      && malformed.httpStatus === 200 && !malformed.transport)
    t.check('malformed JSON notification omits transport line when no socket error occurred',
      notifications.length > 0 && notifications.every(item => !item.message.includes('传输诊断：')),
      JSON.stringify(notifications))

    notifications.length = 0
    await notifier.notifyCapabilityStepFailure('deepseek', CHAIN[0].model, 'text', {
      code: 'NETWORK_ERROR',
      transport: { phase: 'request', errors: [{ code: 'http://192.0.2.1/sk-secret', syscall: 'connect; leak' }] },
    })
    t.check('notifier rejects untrusted transport codes or syscalls',
      notifications.length > 0 && notifications.every(item => !item.message.includes('传输诊断：') && !/192\.0\.2\.1|sk-secret|leak/.test(item.message)),
      JSON.stringify(notifications))
    t.check('transport verification stays on DeepSeek', mocked.calls.length === 4 && mocked.calls.every(call => call.requestBody.model === CHAIN[0].model))
  })
}

// 用真实 HTTP 连接区分收头后的正文超时与调用方取消。
async function runResponseBodyDeadlineCase(t) {
  const fetchHttp = global.fetch
  await withApi([], async ({ api, data, notifications }) => {
    const server = http.createServer((request, response) => {
      request.resume()
      response.writeHead(200, { 'content-type': 'application/json' })
      response.write('{"choices":')
    })
    await new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
    const config = { ...CHAIN[0], apiKey: 'local-fixture', baseURL: 'http://127.0.0.1:' + server.address().port }
    const current = () => data.readJson('ai-call-diagnostics/recent.json')['text:' + config.provider + ':' + config.model]
    try {
      global.fetch = fetchHttp
      const timeout = await api.requestChatCompletions([], config, { _timeoutMs: 1000 }).catch(error => error)
      const failed = current()
      t.check('body deadline after headers records TIMEOUT, HTTP 200 and response_body', timeout?.code === 'TIMEOUT'
        && timeout.status === 200 && failed.code === 'TIMEOUT' && failed.httpStatus === 200 && failed.transport?.phase === 'response_body')

      const count = notifications.length
      const controller = new AbortController(), reason = new Error('caller cancelled after headers')
      global.fetch = async (...args) => {
        const response = await fetchHttp(...args)
        setImmediate(() => controller.abort(reason))
        return response
      }
      const cancelled = await api.requestChatCompletions([], config, { signal: controller.signal }).catch(error => error)
      t.check('caller cancellation during body read preserves the reason and emits no upstream failure',
        cancelled === reason && notifications.length === count && current().sequence === failed.sequence)
    } finally {
      server.closeAllConnections()
      await new Promise(resolve => server.close(resolve))
    }
  })
}

// 每个辅助判断节点仅恢复一次，恢复共享节点期限，后继节点独立分配预算。
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
    const result = await api.requestChatCompletions([], CONFIG, { _purpose: 'identity_judge' })
    t.checkEqual('judgment backup recovers using its own output budget', result.content, 'NO')
    t.checkEqual('each judgment node permits one expansion', mocked.calls.map(call => call.requestBody.max_tokens).join(','), '256,512,256,512')
    t.checkEqual('judgment recovery stays on its actual priority node', mocked.calls.map(call => call.requestBody.model).join(','), [CHAIN[0].model, CHAIN[0].model, CHAIN[1].model, CHAIN[1].model].join(','))
    t.check('judgment internal purpose never enters HTTP body', mocked.calls.every(call => !('_purpose' in call.requestBody)))
  })
  await withApi([TRUNCATED, OK], async ({ api, mocked }) => {
    const now = Date.now, start = now()
    Date.now = () => start
    // 首节点返回截断时耗尽其八秒期限，下一节点必须从当前时刻重新计时。
    global.fetch = async (...args) => { const result = await mocked.fetch(...args); Date.now = () => start + 8001; return result }
    let result
    try { result = await api.requestChatCompletions([], CONFIG, { _purpose: 'topic_switch' }) }
    finally { Date.now = now }
    t.checkEqual('expired judgment node does not block successful backup', result.content, 'NO')
    t.checkEqual('expired judgment skips same-node recovery and calls next priority', mocked.calls.map(call => call.requestBody.model).join(','), CHAIN.map(step => step.model).join(','))
    t.checkEqual('new judgment node starts with its initial output budget', mocked.calls.map(call => call.requestBody.max_tokens).join(','), '256,256')
  })
  await withApi([TRUNCATED, TRUNCATED, OK], async ({ api, mocked }) => {
    const now = Date.now, start = now()
    const setTimer = global.setTimeout, scheduledTimeouts = []
    let elapsed = 0
    Date.now = () => start + elapsed
    // 记录真实计时器期限；排除通知 1500ms 和 Token 用量延迟冲盘 5000ms。
    global.setTimeout = (callback, timeout, ...args) => {
      scheduledTimeouts.push(timeout)
      return setTimer(callback, timeout, ...args)
    }
    // 首轮消耗 7.5 秒，恢复只能用剩余 500ms，超时后再进入新节点。
    global.fetch = async (url, options) => {
      const response = await mocked.fetch(url, options)
      if (mocked.calls.length === 1) elapsed = 7500
      if (mocked.calls.length === 2) return new Promise((_resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true })
      })
      return response
    }
    let result
    try { result = await api.requestChatCompletions([], CONFIG, { _purpose: 'identity_judge' }) }
    finally { Date.now = now; global.setTimeout = setTimer }
    t.checkEqual('judgment backup succeeds after previous recovery exhausts node deadline', result.content, 'NO')
    t.checkEqual('same-node recovery shares deadline and runs only once', mocked.calls.map(call => call.requestBody.max_tokens).join(','), '256,512,256')
    t.checkEqual('judgment recovery retains only the remaining time while next node resets deadline', scheduledTimeouts.filter(timeout => ![1500, 5000].includes(timeout)).join(','), '8000,500,8000')
    t.checkEqual('deadline-exhausted recovery moves to the next actual model', mocked.calls.map(call => call.requestBody.model).join(','), [CHAIN[0].model, CHAIN[0].model, CHAIN[1].model].join(','))
  })
  await withApi([TRUNCATED, OK], async ({ api, mocked, notifications }) => {
    // 只由真实请求定时器中止首节点，不能用独立 AbortError 冒充超时。
    global.fetch = async (url, options) => {
      const response = await mocked.fetch(url, options)
      if (mocked.calls.length !== 1) return response
      return new Promise((_resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true })
      })
    }
    const result = await api.requestChatCompletions([], CONFIG, { _purpose: 'topic_switch', _timeoutMs: 1000 })
    t.checkEqual('judgment real timeout continues to a successful backup', result.content, 'NO')
    t.checkEqual('judgment real timeout calls each priority once', mocked.calls.map(call => call.requestBody.model).join(','), CHAIN.map(step => step.model).join(','))
    const [first, second] = mocked.calls.map(call => call.options.signal)
    t.check('judgment backup gets a fresh non-aborted controller', first.aborted && !second.aborted && first !== second)
    t.check('judgment real timeout is classified and notified accurately', notifications.length > 0 && notifications.every(item => item.message.includes('用途：话题判断') && item.message.includes('原因：请求超时') && item.message.includes('TIMEOUT')))
  })
  await withApi([...Array(8).fill(TRUNCATED), OK], async ({ api, mocked, data }) => {
    const extendedChain = [...CHAIN,
      { provider: 'mimorium', model: 'mimo-v2.5-pro' },
      { provider: 'deepseek', model: 'deepseek-v4-pro' },
      { provider: 'opencode', model: 'deepseek-v4-flash' },
    ]
    seedCapabilityConfig(data, { text: extendedChain })
    const result = await api.requestChatCompletions([], CONFIG, { _purpose: 'identity_judge' })
    t.checkEqual('judgment reaches the fifth model after four failed nodes and recoveries', result.content, 'NO')
    t.checkEqual('judgment traverses every configured priority without a global output cutoff', mocked.calls.map(call => call.requestBody.model).join(','), extendedChain.flatMap((step, index) => index < 4 ? [step.model, step.model] : [step.model]).join(','))
    t.checkEqual('each of five judgment nodes owns its output budget', mocked.calls.map(call => call.requestBody.max_tokens).join(','), '256,512,256,512,256,512,256,512,256')
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
    notifications.length = 0
    const asrNetCause = new AggregateError([
      Object.assign(new Error('asr socket payload'), { code: 'ETIMEDOUT', syscall: 'connect', address: '198.51.100.8' }),
      Object.assign(new Error('asr socket payload'), { code: 'ENETUNREACH', syscall: 'connect' }),
    ], 'test-openai-key')
    global.fetch = async (url, options) => {
      if (String(url).includes('/audio/transcriptions')) throw new TypeError('fetch failed', { cause: asrNetCause })
      return mockFetch([{ json: { choices: [{ message: { content: '备用识别成功' } }], usage: { total_tokens: 5 } } }]).fetch(url, options)
    }
    t.checkEqual('ASR dual-stack connect error falls back to backup', await voice.callModelAsr(data.pathFor('sample.wav')), '备用识别成功')
    const asrFailed = data.readJson('ai-call-diagnostics/recent.json')['voice-asr:openai:gpt-4o-transcribe']
    t.check('ASR network failure records sanitized transport and notifies admin',
      asrFailed?.transport?.phase === 'request'
      && asrFailed.transport.errors.length === 2
      && notifications.length > 0
      && notifications.every(item => item.message.includes('传输诊断：请求连接（connect ETIMEDOUT、connect ENETUNREACH）')
        && !/198\.51\.100\.8|test-openai-key|asr socket payload/.test(item.message)),
      JSON.stringify({ asrFailed, notifications }))
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
  await runTransportCases(t)
  await runResponseBodyDeadlineCase(t)
  await runJudgmentCases(t)
  await runBoundaryCases(t)
  await runMediaUsageCases(t)
}
module.exports = { run }
