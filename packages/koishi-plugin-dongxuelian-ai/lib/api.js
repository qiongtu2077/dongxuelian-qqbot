/**
 * MODULE: AI API 调用。
 * 职责: requestChatCompletions + fallback 链 + 图片/转发拉取。
 * 边界: 不存 conversation，不做业务判断。结果返回给调用方（chat.js）处理。
 */
const { PROVIDERS, REQUEST_TIMEOUT, GLM_KEY_FILE, DASHSCOPE_KEY_FILE } = require('./constants')
const { readTextFile, isDashScopeConfig } = require('./utils')
const { atomicWriteJson } = require('./persona')
const fs = require('fs')
const path = require('path')

function trackUsage(provider, tokens) {
  try {
    const { DATA_DIR } = require('./constants')
    const file = path.join(DATA_DIR, 'token-usage.json')
    let data = {}
    try { data = JSON.parse(fs.readFileSync(file, 'utf8')) } catch {}
    const today = new Date().toISOString().slice(0, 10)
    if (!data[today]) data[today] = {}
    data[today][provider] = (data[today][provider] || 0) + tokens
    atomicWriteJson(file, data)
  } catch {}
}

function buildResponsesInput(messages = []) {
  return messages.filter(item => item && item.content).map(item => ({
    role: item.role === 'assistant' ? 'assistant' : item.role === 'system' ? 'system' : 'user',
    content: [{ type: 'input_text', text: String(item.content) }],
  }))
}

function extractResponsesText(data = {}) {
  if (typeof data.output_text === 'string' && data.output_text.trim()) return data.output_text.trim()
  const parts = []
  for (const item of Array.isArray(data.output) ? data.output : []) {
    if (item?.type !== 'message') continue
    for (const content of Array.isArray(item.content) ? item.content : []) {
      if ((content?.type === 'output_text' || content?.type === 'text') && content.text) parts.push(String(content.text))
    }
  }
  const joined = String(parts.join(' ')).replace(/\s+/g, ' ').trim()
  if (!joined) throw new Error('Empty model response.')
  return joined
}

function buildManagedThinkingArgs(config = {}, enabled = false) {
  const model = String(config.model || '')
  if (!enabled) {
    if (isDashScopeConfig(config)) return { enable_thinking: false }
    if (/glm|mimo|kimi/i.test(model)) return { thinking: { type: 'disabled' } }
    if (/deepseek/i.test(model)) return { enable_thinking: false }
    return {}
  }
  if (isDashScopeConfig(config)) return { enable_thinking: true }
  if (/glm|mimo|kimi/i.test(model)) return { thinking: { type: 'enabled' } }
  return {}
}

function rebuildFallbackExtraBody(extraBody = {}, config = {}) {
  if (!extraBody._thinkingManaged) return extraBody
  const next = { ...extraBody }
  const explicit = new Set(Array.isArray(extraBody._explicitThinkingKeys) ? extraBody._explicitThinkingKeys : [])
  if (!explicit.has('enable_thinking')) delete next.enable_thinking
  if (!explicit.has('thinking')) delete next.thinking
  const managed = buildManagedThinkingArgs(config, !!extraBody._thinkingEnabled)
  for (const [key, value] of Object.entries(managed)) {
    if (!explicit.has(key)) next[key] = value
  }
  return next
}

async function requestChatCompletions(messages, config, extraBody = {}) {
  const controller = new AbortController()
  const timeout = config._fallbackTried ? 10000 : REQUEST_TIMEOUT
  const timer = setTimeout(() => controller.abort(), timeout)
  const filteredExtraBody = {}
  for (const key of ['max_tokens', 'enable_search', 'web_search_options', 'search_options', 'enable_thinking', 'thinking']) {
    if (extraBody[key] !== undefined) filteredExtraBody[key] = extraBody[key]
  }
  const maxTokens = filteredExtraBody.max_tokens || 1500
  try {
    let response
    try {
      response = await fetch(config.baseURL + '/chat/completions', {
        method: 'POST', signal: controller.signal,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.apiKey}` },
        body: JSON.stringify({
          model: config.model, temperature: 0.9, max_tokens: maxTokens,
          ...(isDashScopeConfig(config) ? { enable_thinking: false } : {}),
          ...filteredExtraBody, messages,
        }),
      })
    } finally { clearTimeout(timer) }
    if (!response.ok) {
      if (response.status === 429 || response.status === 401 || response.status === 400) {
        const fbStep = (config._fallbackTried || 0) + 1
        const fbConfig = await buildFallbackConfig(config, fbStep)
        if (fbConfig) return requestChatCompletions(messages, fbConfig, rebuildFallbackExtraBody(extraBody, fbConfig))
      }
      const text = await response.text().catch(() => '')
      const isFallback = (response.status === 429 || response.status === 401) && config._fallbackTried
      throw new Error((isFallback ? '[FALLBACK] ' : '') + `HTTP ${response.status} ${text}`.trim())
    }
    const data = await response.json()
    if (data?.usage?.total_tokens) trackUsage(config?.provider || 'unknown', data.usage.total_tokens)
    const m = data?.choices?.[0]?.message || {}
    let content = m.content && m.content.trim() ? m.content : ''
    if (!content && m.reasoning_content) {
      console.warn('[dongxuelian-ai] reasoning-only model response dropped')
      const fbStep = (config._fallbackTried || 0) + 1
      const fbConfig = await buildFallbackConfig(config, fbStep)
      if (fbConfig) return requestChatCompletions(messages, fbConfig, rebuildFallbackExtraBody(extraBody, fbConfig))
    }
    if (!content) throw new Error('Empty model response.')
    if (/request was rejected|considered high risk/i.test(content)) {
      const fbStep = (config._fallbackTried || 0) + 1
      const fbConfig = await buildFallbackConfig(config, fbStep)
      if (fbConfig) return requestChatCompletions(messages, fbConfig, rebuildFallbackExtraBody(extraBody, fbConfig))
      content = ''
    }
    if (!content) throw new Error('Empty model response.')
    return String(content).replace(/\s+/g, ' ').trim()
  } catch (networkErr) {
    const isHttpError = String(networkErr?.message || '').includes('HTTP')
    const fbStep = (config._fallbackTried || 0) + 1
    if (!isHttpError && fbStep <= 4) {
      const fbConfig = await buildFallbackConfig(config, fbStep)
      if (fbConfig) return requestChatCompletions(messages, fbConfig, rebuildFallbackExtraBody(extraBody, fbConfig))
    }
    throw networkErr
  }
}

async function requestOpenAIResponsesWithSearch(messages, config) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT)
  try {
    const response = await fetch(config.baseURL + '/responses', {
      method: 'POST', signal: controller.signal,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.apiKey}` },
      body: JSON.stringify({
        model: config.model, temperature: 0.9, max_output_tokens: 160,
        input: buildResponsesInput(messages),
        tools: [{ type: 'web_search' }],
      }),
    })
    if (!response.ok) { const text = await response.text().catch(() => ''); throw new Error(`HTTP ${response.status} ${text}`.trim()) }
    const data = await response.json()
    if (data?.usage?.total_tokens) trackUsage(config?.provider || 'unknown', data.usage.total_tokens)
    return extractResponsesText(data)
  } finally { clearTimeout(timer) }
}

const FALLBACK_STEPS = [
  { model: 'glm-4.6v-flash', provider: 'glm', keyFile: GLM_KEY_FILE },
  { model: 'deepseek-v4-flash', provider: 'opencode' },
  { model: 'qwen3.5-plus', provider: 'dashscope', keyFile: DASHSCOPE_KEY_FILE },
  { model: 'qwen3.6-plus', provider: 'dashscope', keyFile: DASHSCOPE_KEY_FILE },
]

const DEFAULT_CHAINS = {
  chat: [
    { provider: 'opencode', model: 'deepseek-v4-flash', keyFile: '' },
    { provider: 'deepseek', model: 'deepseek-chat', keyFile: 'ai-deepseek-key.txt' },
    { provider: 'dashscope', model: 'qwen3.5-plus', keyFile: 'ai-dashscope-key.txt' },
    { provider: 'glm', model: 'glm-4.6v-flash', keyFile: 'ai-glm-key.txt' },
    { provider: 'mimorium', model: 'mimo-v2.5-pro', keyFile: 'ai-mimorium-key.txt' },
  ],
  vision: [
    { provider: 'dashscope', model: 'qwen3.5-omni-flash', keyFile: 'ai-dashscope-key.txt' },
    { provider: 'opencode', model: 'mimo-v2-omni', keyFile: '' },
    { provider: 'glm', model: 'glm-4.6v-flash', keyFile: 'ai-glm-key.txt' },
  ],
  analysis: [
    { provider: 'opencode', model: 'deepseek-v4-flash', keyFile: '' },
    { provider: 'deepseek', model: 'deepseek-chat', keyFile: 'ai-deepseek-key.txt' },
    { provider: 'dashscope', model: 'qwen3.5-plus', keyFile: 'ai-dashscope-key.txt' },
  ],
}

let customFallbackCache = null

function loadCustomFallbackChains() {
  try {
    const { DATA_DIR } = require('./constants')
    const file = path.join(DATA_DIR, 'ai-fallback-chains.json')
    if (fs.existsSync(file)) {
      const raw = fs.readFileSync(file, 'utf8')
      const data = JSON.parse(raw)
      customFallbackCache = data
      return data
    }
  } catch {}
  customFallbackCache = null
  return null
}

function getFallbackSteps(purpose) {
  if (purpose) {
    const custom = loadCustomFallbackChains()
    if (custom && custom[purpose]) return custom[purpose].map(item => ({ ...item }))
    if (DEFAULT_CHAINS[purpose]) return DEFAULT_CHAINS[purpose].map(item => ({ ...item }))
  }
  return FALLBACK_STEPS.map(item => ({ ...item }))
}

async function buildFallbackConfig(config, step, purpose) {
  purpose = purpose || config.purpose || null
  const steps = getFallbackSteps(purpose)
  const fallback = steps[step - 1]
  if (!fallback) return null
  const provider = PROVIDERS[fallback.provider]
  if (!provider) return null
  const next = {
    ...config,
    _fallbackTried: step,
    provider: fallback.provider,
    model: fallback.model,
    baseURL: provider.baseURL.replace(/\/+$/, ''),
  }
  if (fallback.keyFile) {
    const keyPath = path.join(require('./constants').DATA_DIR, fallback.keyFile)
    next.apiKey = (await readTextFile(keyPath).catch(() => '') || config.apiKey).replace(/[\r\n]+/g, '')
  }
  return next
}

function callOneBotWs(action, params, echo, timeoutMs, extractData) {
  return new Promise((resolve) => {
    let ws = null
    let timer = null
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      try { if (ws) ws.close() } catch {}
      resolve(value || null)
    }

    try {
      ws = new (require('ws'))('ws://127.0.0.1:8080/onebot/v11/ws')
      timer = setTimeout(() => finish(null), timeoutMs)
      ws.on('open', () => {
        try { ws.send(JSON.stringify({ action, params, echo })) } catch { finish(null) }
      })
      ws.on('message', (d) => {
        let message = null
        try { message = JSON.parse(d.toString()) } catch { return finish(null) }
        if (message.echo !== echo) return
        try { finish(extractData(message)) } catch { finish(null) }
      })
      ws.on('error', () => finish(null))
      ws.on('close', () => finish(null))
    } catch {
      finish(null)
    }
  })
}

function callGetImage(fileName) {
  return callOneBotWs(
    'get_image',
    { file: fileName },
    'gi',
    5000,
    message => (message.data && message.data.file ? message.data : null)
  )
}

function callGetForwardMsg(forwardId) {
  return callOneBotWs(
    'get_forward_msg',
    { id: forwardId },
    'gf',
    10000,
    message => (message.data ? (message.data.messages || message.data.message || (Array.isArray(message.data) ? message.data : null)) : null)
  )
}

async function readImageAsBase64(filePath) {
  try { const buf = require('fs').readFileSync(filePath); const ext = filePath.split('.').pop().toLowerCase(); const m = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp' }; return `data:${m[ext] || 'image/jpeg'};base64,${buf.toString('base64')}` } catch { return null }
}

function extractImageFileFromElements(session) {
  try {
    const segs = Array.isArray(session.event?.message) ? session.event.message : []
    for (const seg of segs) { if ((seg.type === 'image' || seg.type === 'img') && seg.data?.file) return seg.data.file }
    const m = session.content?.match(/\[CQ:image[^\]]*?file=([^,\]\s]+)/i); if (m) return m[1]
  } catch {}
  return null
}

async function downloadImageAsBase64(url, timeoutMs = 5000) {
  return new Promise((resolve) => {
    let request = null
    let timer = null
    let settled = false
    const finishDownload = (value) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      resolve(value || null)
    }

    if (!url || !url.startsWith('http')) return finishDownload(null)
    try {
      const mod = url.startsWith('https') ? require('https') : require('http')
      timer = setTimeout(() => {
        try { if (request) request.destroy() } catch {}
        finishDownload(null)
      }, timeoutMs)
      request = mod.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
        const chunks = []
        res.on('data', c => chunks.push(c))
        res.on('end', () => {
          const buf = Buffer.concat(chunks)
          finishDownload(`data:${res.headers['content-type'] || 'image/jpeg'};base64,${buf.toString('base64')}`)
        })
        res.on('error', () => finishDownload(null))
      })
      request.on('error', () => finishDownload(null))
    } catch {
      finishDownload(null)
    }
  })
}

function isVisionModel(provider, modelId) {
  if (/qwen/i.test(modelId)) return true; if (/glm/i.test(modelId)) return true; if (/kimi/i.test(modelId)) return true
  if (provider === 'mimorium' && /^mimo-v2\.5$|omni/i.test(modelId)) return true; return false
}

module.exports = {
  requestChatCompletions, buildResponsesInput, extractResponsesText,
  requestOpenAIResponsesWithSearch,
  buildFallbackConfig, getFallbackSteps,
  callGetImage, callGetForwardMsg,
  readImageAsBase64, extractImageFileFromElements, downloadImageAsBase64,
  isVisionModel,
}
