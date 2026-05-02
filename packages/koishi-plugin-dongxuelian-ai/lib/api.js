const { PROVIDERS, REQUEST_TIMEOUT, GLM_KEY_FILE, DASHSCOPE_KEY_FILE } = require('./constants')
const { readTextFile, isDashScopeConfig } = require('./utils')

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
    return extractResponsesText(data)
  } finally { clearTimeout(timer) }
}

const FALLBACK_STEPS = [
  { model: 'glm-4.6v-flash', provider: 'glm', keyFile: GLM_KEY_FILE },
  { model: 'deepseek-v4-flash', provider: 'opencode' },
  { model: 'qwen3.5-plus', provider: 'dashscope', keyFile: DASHSCOPE_KEY_FILE },
  { model: 'qwen3.6-plus', provider: 'dashscope', keyFile: DASHSCOPE_KEY_FILE },
]

async function buildFallbackConfig(config, step) {
  const fallback = FALLBACK_STEPS[step - 1]
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
    next.apiKey = (await readTextFile(fallback.keyFile).catch(() => '') || config.apiKey).replace(/[\r\n]+/g, '')
  }
  return next
}

function getFallbackSteps() {
  return FALLBACK_STEPS.map(item => ({ ...item }))
}

function callGetImage(fileName) {
  return new Promise((resolve) => {
    try {
      const ws = new (require('ws'))('ws://127.0.0.1:8080/onebot/v11/ws')
      const timer = setTimeout(() => { ws.close(); resolve(null) }, 5000)
      ws.on('open', () => { ws.send(JSON.stringify({ action: 'get_image', params: { file: fileName }, echo: 'gi' })) })
      ws.on('message', (d) => { clearTimeout(timer); try { const m = JSON.parse(d.toString()); if (m.echo === 'gi' && m.data && m.data.file) resolve(m.data); else if (m.echo === 'gi') resolve(null); ws.close() } catch { resolve(null); ws.close() } })
      ws.on('error', () => { clearTimeout(timer); resolve(null) })
    } catch { resolve(null) }
  })
}

function callGetForwardMsg(forwardId) {
  return new Promise((resolve) => {
    try {
      const ws = new (require('ws'))('ws://127.0.0.1:8080/onebot/v11/ws')
      const timer = setTimeout(() => { ws.close(); resolve(null) }, 10000)
      ws.on('open', () => { ws.send(JSON.stringify({ action: 'get_forward_msg', params: { id: forwardId }, echo: 'gf' })) })
      ws.on('message', (d) => { try { const m = JSON.parse(d.toString()); if (m.echo === 'gf') { clearTimeout(timer); const msgs = m.data ? (m.data.messages || m.data.message || (Array.isArray(m.data) ? m.data : null)) : null; resolve(msgs); ws.close() } } catch {} })
      ws.on('error', () => { clearTimeout(timer); resolve(null) })
    } catch { resolve(null) }
  })
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
    if (!url || !url.startsWith('http')) return resolve(null)
    const mod = url.startsWith('https') ? require('https') : require('http')
    const timeout = setTimeout(() => resolve(null), timeoutMs)
    mod.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
      const chunks = []; res.on('data', c => chunks.push(c)); res.on('end', () => { clearTimeout(timeout); const buf = Buffer.concat(chunks); resolve(`data:${res.headers['content-type'] || 'image/jpeg'};base64,${buf.toString('base64')}`) }); res.on('error', () => { clearTimeout(timeout); resolve(null) })
    }).on('error', () => { clearTimeout(timeout); resolve(null) })
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
