/**
 * MODULE: AI API 调用。
 * 职责: requestChatCompletions + fallback 链 + 图片/转发拉取。
 * 边界: 不存 conversation，不做业务判断。结果返回给调用方（chat.js）处理。
 */
const { PROVIDERS, REQUEST_TIMEOUT, GLM_KEY_FILE, DASHSCOPE_KEY_FILE, MIMORIUM_KEY_FILE, CUSTOM_PROVIDERS_FILE, FALLBACK_CHAINS_FILE, DATA_DIR } = require('./constants') as typeof import('./constants')
const { readTextFile, isDashScopeConfig, todayCst, validatePublicHttpUrl, resolveAndValidateHostname } = require('./utils') as typeof import('./utils')
const { resolveOneBotWsUrl } = require('./onebot-endpoint') as typeof import('./onebot-endpoint')
const path = require('path')
const fs = require('fs')

const MAX_IMAGE_BYTES = parseApiPositiveInt(process.env.DONGXUELIAN_MAX_IMAGE_BYTES, 4 * 1024 * 1024, 128 * 1024, 16 * 1024 * 1024)
const MAX_REMOTE_IMAGE_BYTES = parseApiPositiveInt(process.env.DONGXUELIAN_MAX_REMOTE_IMAGE_BYTES, MAX_IMAGE_BYTES, 128 * 1024, 16 * 1024 * 1024)
const MAX_API_CONFIG_FILE_BYTES = parseApiPositiveInt(process.env.DONGXUELIAN_API_CONFIG_MAX_BYTES, 256 * 1024, 4 * 1024, 1024 * 1024)
const MAX_API_KEY_FILE_BYTES = parseApiPositiveInt(process.env.DONGXUELIAN_API_KEY_MAX_BYTES, 64 * 1024, 1 * 1024, 256 * 1024)
const REQUEST_TIMEOUT_CAP = parseApiPositiveInt(process.env.AI_REQUEST_TIMEOUT_CAP_MS, 300000, 5000, 600000)

interface ChatMessage {
  role?: string
  content?: string
}

interface ApiConfig {
  apiKey: string
  model: string
  baseURL: string
  provider?: string
  _originalConfig?: Pick<ApiConfig, 'model' | 'provider' | 'baseURL' | 'apiKey'>
  _fallbackTried?: number
  _isOriginalRetry?: boolean
}

interface RequestExtraBody {
  _fallbackSet?: string
  _timeoutMs?: number | string
  _thinkingEnabled?: boolean
  _thinkingManaged?: boolean
  _explicitThinkingKeys?: string[]
  signal?: AbortSignal
  [key: string]: unknown
}

interface ToolDefinition {
  [key: string]: unknown
}

type ChatCompletionResult =
  | { type: 'tool_calls'; tool_calls: unknown[]; message: Record<string, unknown>; reasoning: string }
  | { type: 'text'; content: string; reasoning: string }

interface UsageDetails {
  prompt_tokens?: number
  input_tokens?: number
  inputTokens?: number
  completion_tokens?: number
  output_tokens?: number
  completionTokens?: number
  outputTokens?: number
  cache_read_tokens?: number
  cache_read_input_tokens?: number
  cached_tokens?: number
  cache_creation_tokens?: number
  cache_creation_input_tokens?: number
  prompt_tokens_details?: { cached_tokens?: number; cache_creation_tokens?: number }
  input_tokens_details?: { cached_tokens?: number; cache_creation_tokens?: number }
}

interface TokenUsageDay {
  providers: Record<string, TokenUsageStat>
  models: Record<string, TokenUsageStat & { provider?: string }>
  total: number
  requests: number
  input: number
  output: number
  cacheCreation: number
  cacheRead: number
}

interface TokenUsageStat {
  total: number
  requests: number
  input: number
  output: number
  cacheCreation: number
  cacheRead: number
}

interface FallbackStep {
  model: string
  provider: string
  keyFile?: string | null
}

interface CustomProvider {
  id: string
  baseURL?: string
  keyFile?: string
  models?: Array<{ id: string; vision?: boolean }>
}

interface OneBotMessage {
  echo?: string
  status?: string
  retcode?: number
  data?: Record<string, unknown> | unknown[] | null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

interface SessionLike {
  content?: string
  event?: {
    message?: Array<{ type?: string; data?: { file?: string } }>
  }
}

function parseApiPositiveInt(value: string | number | undefined, fallback: number, min: number, max: number): number {
  const parsed = parseInt(String(value), 10)
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(min, Math.min(max, parsed))
}

const TOKEN_USAGE_FILE = path.join(DATA_DIR, 'token-usage.json')
const TOKEN_USAGE_EXIT_HOOK = Symbol.for('dongxuelian.ai.tokenUsageExitHook')
const TOKEN_USAGE_EXIT_FLUSH = Symbol.for('dongxuelian.ai.tokenUsageExitFlush')
let _tokenUsageCache: Record<string, TokenUsageDay> | null = null
let _tokenUsageFlushTimer: ReturnType<typeof setTimeout> | null = null

function usageNumber(value: unknown): number {
  const n = Number(value || 0)
  return Number.isFinite(n) && n > 0 ? n : 0
}

function normalizeTokenUsageDay(day: unknown): TokenUsageDay {
  if (!day || typeof day !== 'object' || Array.isArray(day)) return { providers: {}, models: {}, total: 0, requests: 0, input: 0, output: 0, cacheCreation: 0, cacheRead: 0 }
  const source = day as Record<string, unknown>
  if (isRecord(source.providers)) {
    return {
      providers: source.providers as Record<string, TokenUsageStat>,
      models: isRecord(source.models) ? source.models as Record<string, TokenUsageStat & { provider?: string }> : {},
      total: usageNumber(source.total),
      requests: usageNumber(source.requests),
      input: usageNumber(source.input),
      output: usageNumber(source.output),
      cacheCreation: usageNumber(source.cacheCreation),
      cacheRead: usageNumber(source.cacheRead),
    }
  }
  const providers: Record<string, TokenUsageStat> = {}
  let total = 0
  for (const [key, value] of Object.entries(day)) {
    const amount = usageNumber(value)
    if (!key || amount <= 0) continue
    providers[key] = { total: amount, requests: 0, input: 0, output: 0, cacheCreation: 0, cacheRead: 0 }
    total += amount
  }
  return { providers, models: {}, total, requests: 0, input: 0, output: 0, cacheCreation: 0, cacheRead: 0 }
}

function readUsageDetails(usage: UsageDetails = {}): Omit<TokenUsageStat, 'total' | 'requests'> {
  const input = usageNumber(usage.prompt_tokens || usage.input_tokens || usage.inputTokens)
  const output = usageNumber(usage.completion_tokens || usage.output_tokens || usage.completionTokens || usage.outputTokens)
  const cacheRead = usageNumber(
    usage.cache_read_tokens
    || usage.cache_read_input_tokens
    || usage.cached_tokens
    || usage.prompt_tokens_details?.cached_tokens
    || usage.input_tokens_details?.cached_tokens
  )
  const cacheCreation = usageNumber(
    usage.cache_creation_tokens
    || usage.cache_creation_input_tokens
    || usage.prompt_tokens_details?.cache_creation_tokens
    || usage.input_tokens_details?.cache_creation_tokens
  )
  return { input, output, cacheCreation, cacheRead }
}

function bumpUsageStat(target: TokenUsageStat, delta: Omit<TokenUsageStat, 'requests'>): void {
  target.total = usageNumber(target.total) + usageNumber(delta.total)
  target.requests = usageNumber(target.requests) + 1
  target.input = usageNumber(target.input) + usageNumber(delta.input)
  target.output = usageNumber(target.output) + usageNumber(delta.output)
  target.cacheCreation = usageNumber(target.cacheCreation) + usageNumber(delta.cacheCreation)
  target.cacheRead = usageNumber(target.cacheRead) + usageNumber(delta.cacheRead)
}

function recordTokenUsage(provider: string, tokens: number, details: { model?: string; usage?: UsageDetails } = {}): void {
  if (!provider || !tokens || tokens <= 0) return
  const date = todayCst()
  if (!_tokenUsageCache) {
    try {
      const raw = fs.readFileSync(TOKEN_USAGE_FILE, 'utf8')
      _tokenUsageCache = JSON.parse(raw)
    } catch { _tokenUsageCache = {} }
  }
  const day = normalizeTokenUsageDay(_tokenUsageCache[date])
  _tokenUsageCache[date] = day
  const usage = readUsageDetails(details.usage || {})
  const delta = {
    total: usageNumber(tokens),
    input: usage.input,
    output: usage.output,
    cacheCreation: usage.cacheCreation,
    cacheRead: usage.cacheRead,
  }
  const providerKey = String(provider || 'unknown')
  if (!day.providers[providerKey] || typeof day.providers[providerKey] !== 'object') {
    day.providers[providerKey] = { total: usageNumber(day.providers[providerKey]), requests: 0, input: 0, output: 0, cacheCreation: 0, cacheRead: 0 }
  }
  bumpUsageStat(day.providers[providerKey], delta)
  const modelKey = String(details.model || '').trim()
  if (modelKey) {
    if (!day.models[modelKey] || typeof day.models[modelKey] !== 'object') day.models[modelKey] = { provider: providerKey, total: 0, requests: 0, input: 0, output: 0, cacheCreation: 0, cacheRead: 0 }
    day.models[modelKey].provider = providerKey
    bumpUsageStat(day.models[modelKey], delta)
  }
  bumpUsageStat(day, delta)
  if (!_tokenUsageFlushTimer) {
    _tokenUsageFlushTimer = setTimeout(() => {
      _tokenUsageFlushTimer = null
      try { fs.writeFileSync(TOKEN_USAGE_FILE, JSON.stringify(_tokenUsageCache, null, 2)) } catch { /* non-critical: token usage flush is best-effort */ }
    }, 5000)
  }
}

function flushTokenUsage(): void {
  if (_tokenUsageCache && _tokenUsageFlushTimer) {
    clearTimeout(_tokenUsageFlushTimer)
    _tokenUsageFlushTimer = null
    try { fs.writeFileSync(TOKEN_USAGE_FILE, JSON.stringify(_tokenUsageCache, null, 2)) } catch { /* non-critical: token usage exit flush is best-effort */ }
  }
}

globalThis[TOKEN_USAGE_EXIT_FLUSH] = flushTokenUsage
if (!globalThis[TOKEN_USAGE_EXIT_HOOK]) {
  globalThis[TOKEN_USAGE_EXIT_HOOK] = true
  process.on('exit', () => {
    const handler = globalThis[TOKEN_USAGE_EXIT_FLUSH]
    if (typeof handler === 'function') handler()
  })
}

function mimeFromImagePath(filePath: string = ''): string {
  const ext = String(filePath || '').split('.').pop().toLowerCase()
  return { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp' }[ext] || 'image/jpeg'
}

function readApiTextFileSync(file: string, maxBytes: number = MAX_API_KEY_FILE_BYTES): string {
  try {
    const stat = fs.statSync(file)
    if (!stat.isFile() || stat.size > maxBytes) return ''
    return String(fs.readFileSync(file, 'utf8')).trim()
  } catch {
    return ''
  }
}

function readApiJsonFileSync<T>(file: string, fallback: T, maxBytes: number = MAX_API_CONFIG_FILE_BYTES): T {
  try {
    const text = readApiTextFileSync(file, maxBytes)
    return text ? JSON.parse(text) : fallback
  } catch {
    return fallback
  }
}

function buildResponsesInput(messages: ChatMessage[] = []): Array<{ role: string; content: Array<{ type: string; text: string }> }> {
  return messages.filter(item => item && item.content).map(item => ({
    role: item.role === 'assistant' ? 'assistant' : item.role === 'system' ? 'system' : 'user',
    content: [{ type: 'input_text', text: String(item.content) }],
  }))
}

function extractResponsesText(data: { output_text?: string; output?: Array<{ type?: string; content?: Array<{ type?: string; text?: string }> }> } = {}): string {
  if (typeof data.output_text === 'string' && data.output_text.trim()) return data.output_text.trim()
  const parts: string[] = []
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

function buildManagedThinkingArgs(config: Partial<ApiConfig> = {}, enabled: boolean = false): Record<string, unknown> {
  const model = String(config.model || '')
  if (!enabled) {
    if (isDashScopeConfig(config)) return { enable_thinking: false }
    if (/deepseek/i.test(model)) return { enable_thinking: false }
    return {}
  }
  if (isDashScopeConfig(config)) return { enable_thinking: true }
  if (/glm|mimo|kimi/i.test(model)) return { thinking: { type: 'enabled' } }
  return {}
}

function rebuildFallbackExtraBody(extraBody: RequestExtraBody = {}, config: ApiConfig): RequestExtraBody {
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

function normalizeMessagesForProvider(messages: ChatMessage[] = [], config: Partial<ApiConfig> = {}): ChatMessage[] {
  if (!isDashScopeConfig(config)) return messages
  const result = []
  let firstSystem = null
  for (const message of Array.isArray(messages) ? messages : []) {
    if (!message || !message.content) continue
    if (message.role === 'system') {
      if (!firstSystem) {
        firstSystem = { ...message, content: String(message.content) }
        result.push(firstSystem)
      } else {
        firstSystem.content += '\n\n' + String(message.content)
      }
    } else {
      result.push(message)
    }
  }
  return result
}

async function requestChatCompletions(messages: ChatMessage[], config: ApiConfig, extraBody: RequestExtraBody = {}, tools: ToolDefinition[] | null = null): Promise<ChatCompletionResult> {
  const fallbackSet = extraBody._fallbackSet || 'chat'
  if (!config._originalConfig && !config._fallbackTried) {
    config._originalConfig = { model: config.model, provider: config.provider, baseURL: config.baseURL, apiKey: config.apiKey }
  }
  const controller = new AbortController()
  const externalSignal = extraBody.signal && typeof extraBody.signal === 'object' ? extraBody.signal : null
  const requestedTimeout = Number(extraBody._timeoutMs)
  const timeout = Number.isFinite(requestedTimeout) && requestedTimeout > 0
    ? Math.max(1000, Math.min(REQUEST_TIMEOUT_CAP, requestedTimeout))
    : config._fallbackTried ? 10000 : REQUEST_TIMEOUT
  const timer = setTimeout(() => controller.abort(), timeout)
  const filteredExtraBody: Record<string, unknown> = {}
  for (const key of ['max_tokens', 'temperature', 'enable_search', 'web_search_options', 'search_options', 'enable_thinking', 'thinking']) {
    if (extraBody[key] === undefined) continue
    if (key === 'temperature') {
      const temperature = Number(extraBody[key])
      if (Number.isFinite(temperature)) filteredExtraBody.temperature = Math.max(0, Math.min(2, temperature))
      continue
    }
    filteredExtraBody[key] = extraBody[key]
  }
  const maxTokens = filteredExtraBody.max_tokens || 1500
  const providerMessages = normalizeMessagesForProvider(messages, config)
  let cleanupExternalSignal = null
  if (externalSignal && typeof externalSignal.addEventListener === 'function') {
    if (externalSignal.aborted) {
      controller.abort()
    } else {
      const onAbort = () => controller.abort()
      externalSignal.addEventListener('abort', onAbort, { once: true })
      cleanupExternalSignal = () => {
        try { externalSignal.removeEventListener('abort', onAbort) } catch { /* non-critical: external signal cleanup can race with abort */ }
      }
    }
  }
  try {
    let response
    try {
      response = await fetch(config.baseURL + '/chat/completions', {
        method: 'POST', signal: controller.signal,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.apiKey}` },
        body: JSON.stringify({
          model: config.model, temperature: 0.9, max_tokens: maxTokens,
          ...buildManagedThinkingArgs(config, !!extraBody._thinkingEnabled),
          ...filteredExtraBody, messages: providerMessages,
          ...(tools && Array.isArray(tools) && tools.length ? { tools, tool_choice: 'auto' } : {}),
        }),
      })
    } finally { clearTimeout(timer) }
    if (!response.ok) {
      if (response.status === 429 || response.status === 401 || response.status === 400) {
        const fbStep = (config._fallbackTried || 0) + 1
        const fbConfig = await buildFallbackConfig(config, fbStep, fallbackSet)
        if (fbConfig) return requestChatCompletions(messages, fbConfig, rebuildFallbackExtraBody(extraBody, fbConfig), tools)
      }
      const text = await response.text().catch(() => '')
      const isFallback = (response.status === 429 || response.status === 401) && config._fallbackTried
      throw new Error((isFallback ? '[FALLBACK] ' : '') + `HTTP ${response.status} ${text}`.trim())
    }
    const data = await response.json()
    const usageTokens = data?.usage?.total_tokens || data?.usage?.totalTokens || 0
    if (usageTokens > 0) recordTokenUsage(config.provider || 'unknown', usageTokens, { model: config.model, usage: data?.usage || {} })
    const m = data?.choices?.[0]?.message || {}

    // tool_calls 必须在 content 判空之前检查
    if (tools && m.tool_calls && Array.isArray(m.tool_calls) && m.tool_calls.length > 0) {
      return { type: 'tool_calls', tool_calls: m.tool_calls, message: m, reasoning: m.reasoning_content || '' }
    }

    let content = m.content && m.content.trim() ? m.content : ''
    const reasoning = m.reasoning_content || ''

    if (content && /<think>[\s\S]*?<\/think>/i.test(content)) {
      content = content.replace(/<think>[\s\S]*?<\/think>/gi, '').trim()
    }

    if (!content && reasoning) {
      const fbStep = (config._fallbackTried || 0) + 1
      const fbConfig = await buildFallbackConfig(config, fbStep, fallbackSet)
      if (fbConfig) return requestChatCompletions(messages, fbConfig, rebuildFallbackExtraBody(extraBody, fbConfig), tools)
      return { type: 'text', content: '', reasoning }
    }
    if (!content) {
      if (config._fallbackTried) return { type: 'text', content: '', reasoning }
      const fbStep = (config._fallbackTried || 0) + 1
      const fbConfig = await buildFallbackConfig(config, fbStep, fallbackSet)
      if (fbConfig) return requestChatCompletions(messages, fbConfig, rebuildFallbackExtraBody(extraBody, fbConfig), tools)
      return { type: 'text', content: '', reasoning }
    }
    return { type: 'text', content: String(content).replace(/\s+/g, ' ').trim(), reasoning }
  } catch (networkErr) {
    if (externalSignal?.aborted) throw networkErr
    const isHttpError = String(networkErr?.message || '').includes('HTTP')
    const fbStep = (config._fallbackTried || 0) + 1
    if (!isHttpError && fbStep <= 5) {
      const fbConfig = await buildFallbackConfig(config, fbStep, fallbackSet)
      if (fbConfig) return requestChatCompletions(messages, fbConfig, rebuildFallbackExtraBody(extraBody, fbConfig), tools)
    }
    throw networkErr
  } finally {
    if (cleanupExternalSignal) cleanupExternalSignal()
  }
}

async function requestOpenAIResponsesWithSearch(messages: ChatMessage[], config: ApiConfig): Promise<string> {
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
    const usageTokens = data?.usage?.total_tokens || data?.usage?.totalTokens || 0
    if (usageTokens > 0) recordTokenUsage(config.provider || 'unknown', usageTokens, { model: config.model, usage: data?.usage || {} })
    return extractResponsesText(data)
  } finally { clearTimeout(timer) }
}

const DEFAULT_CHAT_FALLBACK = [
  { model: 'glm-4.6v-flash', provider: 'glm', keyFile: GLM_KEY_FILE },
  { model: 'deepseek-v4-flash', provider: 'opencode', keyFile: null },
  { model: 'qwen3.5-omni-flash', provider: 'dashscope', keyFile: DASHSCOPE_KEY_FILE },
  { model: 'qwen3.5-plus', provider: 'dashscope', keyFile: DASHSCOPE_KEY_FILE },
]

const DEFAULT_VISION_FALLBACK = [
  { model: 'glm-4.6v-flash', provider: 'glm', keyFile: GLM_KEY_FILE },
  { model: 'mimo-v2-omni', provider: 'mimorium', keyFile: MIMORIUM_KEY_FILE },
  { model: 'qwen3.5-omni-flash', provider: 'dashscope', keyFile: DASHSCOPE_KEY_FILE },
  { model: 'qwen3.5-plus', provider: 'dashscope', keyFile: DASHSCOPE_KEY_FILE },
]

const FALLBACK_DEFAULTS = {
  chat: DEFAULT_CHAT_FALLBACK,
  vision: DEFAULT_VISION_FALLBACK,
  lightweight: DEFAULT_CHAT_FALLBACK,
}

function readFallbackSteps(): Record<string, FallbackStep[]> | null {
  const data = readApiJsonFileSync(FALLBACK_CHAINS_FILE, null)
  if (data && data.chains) return data.chains
  return null
}

function readCustomProviders(): CustomProvider[] {
  const data = readApiJsonFileSync(CUSTOM_PROVIDERS_FILE, [])
  return Array.isArray(data) ? data : []
}

function resolveCustomProviderKey(providerId: string, fallbackKey: string): string {
  const custom = readCustomProviders()
  const cp = custom.find(function(p) { return p.id === providerId })
  if (!cp || !cp.keyFile) return fallbackKey
  return readApiTextFileSync(cp.keyFile).replace(/[\r\n]+/g, '') || fallbackKey
}

function resolveFallbackProvider(fbStep: FallbackStep, config: ApiConfig): string | Promise<string> {
  const provider = PROVIDERS[fbStep.provider]
  if (provider) {
    const keyFileRef = fbStep.keyFile
    if (keyFileRef) return readTextFile(keyFileRef).catch(function() { return '' }).then(function(val) { return (val || config.apiKey).replace(/[\r\n]+/g, '') })
    return config.apiKey
  }
  const custom = readCustomProviders()
  const cp = custom.find(function(p) { return p.id === fbStep.provider })
  if (!cp) return config.apiKey
  if (cp.keyFile) {
    const key = readApiTextFileSync(cp.keyFile).replace(/[\r\n]+/g, '')
    if (key) return key
  }
  return config.apiKey
}

async function buildFallbackConfig(config: ApiConfig, step: number, fallbackSet: string): Promise<ApiConfig | null> {
  const chain = FALLBACK_DEFAULTS[fallbackSet] || DEFAULT_CHAT_FALLBACK
  const custom = readFallbackSteps()
  const steps = (custom && custom[fallbackSet]) ? custom[fallbackSet] : chain
  const fb = steps[step - 1]
  if (!fb) {
    if (config._originalConfig && !config._isOriginalRetry) {
      return Object.assign({}, config._originalConfig, { _fallbackTried: step, _isOriginalRetry: true })
    }
    return null
  }
  const provider = PROVIDERS[fb.provider]
  if (!provider) {
    const cp = (readCustomProviders()).find(function(p) { return p.id === fb.provider })
    if (!cp) return null
    let apiKey = config.apiKey
    if (cp.keyFile) apiKey = readApiTextFileSync(cp.keyFile).replace(/[\r\n]+/g, '') || apiKey
    return Object.assign({}, config, { _fallbackTried: step, provider: fb.provider, model: fb.model, baseURL: String(cp.baseURL || '').replace(/\/+$/, ''), apiKey: apiKey })
  }
  let nextKey = config.apiKey
  if (fb.keyFile) {
    nextKey = readApiTextFileSync(fb.keyFile).replace(/[\r\n]+/g, '') || nextKey
  }
  return Object.assign({}, config, { _fallbackTried: step, provider: fb.provider, model: fb.model, baseURL: String(provider.baseURL).replace(/\/+$/, ''), apiKey: nextKey })
}

function getFallbackSteps(): Record<string, FallbackStep[]> {
  return {
    chat: DEFAULT_CHAT_FALLBACK.map(function(item) { return Object.assign({}, item) }),
    vision: DEFAULT_VISION_FALLBACK.map(function(item) { return Object.assign({}, item) }),
    lightweight: DEFAULT_CHAT_FALLBACK.map(function(item) { return Object.assign({}, item) }),
  }
}

function callOneBotWs<T>(action: string, params: Record<string, unknown>, echo: string, timeoutMs: number, extractData: (message: OneBotMessage) => T | null): Promise<T | null> {
  return new Promise((resolve) => {
    let ws = null
    let timer = null
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      try { if (ws) ws.close() } catch { /* non-critical: OneBot websocket may already be closed */ }
      resolve(value || null)
    }

    try {
      ws = new (require('ws'))(resolveOneBotWsUrl())
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

function callGetImage(fileName: string): Promise<Record<string, unknown> | null> {
  return callOneBotWs(
    'get_image',
    { file: fileName },
    'gi',
    5000,
    message => (isRecord(message.data) && message.data.file ? message.data : null)
  )
}

function callGetFile(fileId: string): Promise<Record<string, unknown> | null> {
  return callOneBotWs(
    'get_file',
    { file_id: fileId },
    'gf_file',
    8000,
    message => (isRecord(message.data) && (message.data.file || message.data.url) ? message.data : null)
  )
}

function callGetRecord(fileName: string): Promise<Record<string, unknown> | null> {
  return callOneBotWs(
    'get_record',
    { file: fileName, out_format: 'wav' },
    'gr',
    8000,
    message => (isRecord(message.data) && message.data.file ? message.data : null)
  )
}

function callGetForwardMsg(forwardId: string): Promise<unknown[] | unknown | null> {
  return callOneBotWs(
    'get_forward_msg',
    { id: forwardId },
    'gf',
    10000,
    message => isRecord(message.data) ? (message.data.messages || message.data.message || null) : (Array.isArray(message.data) ? message.data : null)
  )
}

function sendForwardMsg(groupId: string | number, nodes: unknown[], timeoutMs: number = 10000): Promise<Record<string, unknown> | null> {
  return callOneBotWs(
    'send_group_forward_msg',
    { group_id: Number(groupId), messages: nodes },
    'sfm',
    timeoutMs,
    message => (isRecord(message.data) && message.data.message_id ? message.data : null)
  )
}

function getGroupMemberInfo(groupId: string | number, userId: string | number, timeoutMs: number = 800): Promise<Record<string, unknown> | null> {
  return callOneBotWs(
    'get_group_member_info',
    { group_id: Number(groupId), user_id: Number(userId), no_cache: false },
    'ggmi',
    timeoutMs,
    message => (message.retcode === 0 || message.status === 'ok') && isRecord(message.data) ? message.data : null
  )
}

function getGroupInfo(groupId: string | number, timeoutMs: number = 800): Promise<Record<string, unknown> | null> {
  return callOneBotWs(
    'get_group_info',
    { group_id: Number(groupId), no_cache: false },
    'ggi',
    timeoutMs,
    message => (message.retcode === 0 || message.status === 'ok') && isRecord(message.data) ? message.data : null
  )
}

async function readImageAsBase64(filePath: string): Promise<string | null> {
  try {
    const stat = fs.statSync(filePath)
    if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_IMAGE_BYTES) return null
    const buf = fs.readFileSync(filePath)
    return `data:${mimeFromImagePath(filePath)};base64,${buf.toString('base64')}`
  } catch {
    return null
  }
}

function extractImageFileFromElements(session: SessionLike): string | null {
  try {
    const segs = Array.isArray(session.event?.message) ? session.event.message : []
    for (const seg of segs) { if ((seg.type === 'image' || seg.type === 'img') && seg.data?.file) return seg.data.file }
    const m = session.content?.match(/\[CQ:image[^\]]*?file=([^,\]\s]+)/i); if (m) return m[1]
  } catch { /* non-critical: malformed session elements fall back to no image file */ }
  return null
}

async function downloadImageAsBase64(url: string, timeoutMs: number = 5000): Promise<string | null> {
  return new Promise((resolve) => {
    let request = null
    let timer = null
    let settled = false
    let currentUrl = null
    const finishDownload = (value) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      resolve(value || null)
    }

    ;(async () => {
      try {
        currentUrl = validatePublicHttpUrl(url)
        await resolveAndValidateHostname(currentUrl)
      } catch {
        return finishDownload(null)
      }
      try {
        const mod = currentUrl.protocol === 'https:' ? require('https') : require('http')
        timer = setTimeout(() => {
          try { if (request) request.destroy() } catch { /* non-critical: request may already be closed */ }
          finishDownload(null)
        }, timeoutMs)
        request = mod.get(currentUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
          const status = Number(res.statusCode || 0)
          if (status >= 300 && status < 400 && res.headers.location) {
            res.resume()
            return finishDownload(null)
          }
          if (status !== 200) {
            res.resume()
            return finishDownload(null)
          }
          const type = String(res.headers['content-type'] || 'image/jpeg').split(';')[0].trim().toLowerCase()
          if (type && !/^image\/(?:png|jpe?g|gif|webp|bmp)$/.test(type)) {
            res.resume()
            return finishDownload(null)
          }
          const declared = parseInt(res.headers['content-length'], 10)
          if (Number.isFinite(declared) && declared > MAX_REMOTE_IMAGE_BYTES) {
            res.resume()
            return finishDownload(null)
          }
          const chunks = []
          let received = 0
          res.on('data', c => {
            received += c.length
            if (received > MAX_REMOTE_IMAGE_BYTES) {
              try { if (request) request.destroy() } catch { /* non-critical: request may already be closed */ }
              return finishDownload(null)
            }
            chunks.push(c)
          })
          res.on('end', () => {
            const buf = Buffer.concat(chunks)
            if (!buf.length || buf.length > MAX_REMOTE_IMAGE_BYTES) return finishDownload(null)
            finishDownload(`data:${type || 'image/jpeg'};base64,${buf.toString('base64')}`)
          })
          res.on('error', () => finishDownload(null))
        })
        request.on('error', () => finishDownload(null))
      } catch {
        finishDownload(null)
      }
    })()
  })
}

function isVisionModel(provider: string, modelId: string): boolean {
  // 1. 查内置 PROVIDERS 的 vision 标记
  const p = PROVIDERS[provider]
  if (p) {
    const m = p.models.find(function(x) { return x.id === modelId })
    if (m) return !!m.vision
  }
  // 2. 查自定义供应商
  const custom = readCustomProviders()
  const cp = custom.find(function(x) { return x.id === provider })
  if (cp) return cp.models && cp.models.some(function(x) { return x.id === modelId && x.vision })
  // 3. fallback 正则（兼容旧数据）
  return /qwen|glm|kimi|omni/i.test(modelId)
}

export = {
  requestChatCompletions, normalizeMessagesForProvider, buildResponsesInput, extractResponsesText,
  requestOpenAIResponsesWithSearch,
  buildFallbackConfig, getFallbackSteps,
  callGetImage, callGetFile, callGetRecord, callGetForwardMsg, sendForwardMsg, getGroupMemberInfo, getGroupInfo,
  readImageAsBase64, extractImageFileFromElements, downloadImageAsBase64,
  isVisionModel, recordTokenUsage, flushTokenUsage,
}
