/**
 * MODULE: AI API 调用。
 * 职责: requestChatCompletions + fallback 链 + 图片/转发拉取。
 * 边界: 不存 conversation，不做业务判断。结果返回给调用方（chat.js）处理。
 */
const { REQUEST_TIMEOUT, DATA_DIR } = require('./constants') as typeof import('./constants')
const { isDashScopeConfig, todayCst, validatePublicHttpUrl, resolveAndValidateHostname, errorMessage } = require('./utils') as typeof import('./utils')
const {
  AI_CAPABILITIES,
  isAiCapability,
  getProviderCatalogEntry,
  getVerifiedModelCapabilities,
  loadCapabilityConfigSync,
  resolveCapabilityRuntimeSteps,
} = require('./ai-capability-config') as typeof import('./ai-capability-config')
const { notifyCapabilityStepFailure } = require('./capability-failure-notifier') as typeof import('./capability-failure-notifier')
const { resolveOneBotWsUrl } = require('./onebot-endpoint') as typeof import('./onebot-endpoint')
const WebSocket = require('ws') as typeof import('ws')
const path = require('path')
const fs = require('fs')
const http = require('http') as typeof import('http')
const https = require('https') as typeof import('https')

const MAX_IMAGE_BYTES = parseApiPositiveInt(process.env.DONGXUELIAN_MAX_IMAGE_BYTES, 4 * 1024 * 1024, 128 * 1024, 16 * 1024 * 1024)
const MAX_REMOTE_IMAGE_BYTES = parseApiPositiveInt(process.env.DONGXUELIAN_MAX_REMOTE_IMAGE_BYTES, MAX_IMAGE_BYTES, 128 * 1024, 16 * 1024 * 1024)
const REQUEST_TIMEOUT_CAP = parseApiPositiveInt(process.env.AI_REQUEST_TIMEOUT_CAP_MS, 300000, 5000, 600000)

interface ChatMessage {
  role?: string
  content?: unknown
  tool_call_id?: string
  tool_calls?: unknown[]
}

interface ApiConfig {
  apiKey: string
  model: string
  baseURL: string
  provider?: string
  capability?: string
  chatProtocol?: string
  priorityIndex?: number
  searchEnabled?: boolean
}

interface RequestExtraBody {
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
  total_tokens?: number
  totalTokens?: number
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
  readableRequests: number
  unreadableRequests: number
}

interface TokenUsageStat {
  total: number
  requests: number
  input: number
  output: number
  cacheCreation: number
  cacheRead: number
  readableRequests: number
  unreadableRequests: number
}

interface FallbackStep {
  model: string
  provider: string
  capability?: string
  chatProtocol?: string
  priorityIndex?: number
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
const TOKEN_USAGE_STATE_REGISTRY = Symbol.for('dongxuelian.ai.tokenUsageStateRegistry')
interface TokenUsageState {
  cache: Record<string, Record<string, unknown>> | null
  flushTimer: ReturnType<typeof setTimeout> | null
}
type TokenUsageGlobal = typeof globalThis & {
  [TOKEN_USAGE_EXIT_HOOK]?: boolean
  [TOKEN_USAGE_EXIT_FLUSH]?: () => void
  [TOKEN_USAGE_STATE_REGISTRY]?: Map<string, TokenUsageState>
}
const tokenUsageGlobal = globalThis as TokenUsageGlobal
const tokenUsageStates = tokenUsageGlobal[TOKEN_USAGE_STATE_REGISTRY]
  || (tokenUsageGlobal[TOKEN_USAGE_STATE_REGISTRY] = new Map<string, TokenUsageState>())

// 记录不会阻断请求、但会导致 token 用量磁盘状态滞后的写入失败。
function warnTokenUsagePersistence(stage: string, error: unknown): void {
  console.warn(`[ai-api] token_usage_persistence_failed stage=${stage} detail=${errorMessage(error)}`)
}

// 获取当前数据目录的共享写缓冲，保证模块热重载后仍由同一次 dispose 统一冲盘。
function getTokenUsageState(): TokenUsageState {
  let state = tokenUsageStates.get(TOKEN_USAGE_FILE)
  if (!state) {
    state = { cache: null, flushTimer: null }
    tokenUsageStates.set(TOKEN_USAGE_FILE, state)
  }
  return state
}

function usageNumber(value: unknown): number {
  const n = Number(value || 0)
  return Number.isFinite(n) && n > 0 ? n : 0
}

// 把一个能力在一天内的持久化统计规范为可安全累计的结构。
function normalizeTokenUsageDay(day: unknown): TokenUsageDay {
  if (!day || typeof day !== 'object' || Array.isArray(day)) return { providers: {}, models: {}, total: 0, requests: 0, input: 0, output: 0, cacheCreation: 0, cacheRead: 0, readableRequests: 0, unreadableRequests: 0 }
  const source = day as Record<string, unknown>
  return {
    providers: isRecord(source.providers) ? source.providers as Record<string, TokenUsageStat> : {},
    models: isRecord(source.models) ? source.models as Record<string, TokenUsageStat & { provider?: string }> : {},
    total: usageNumber(source.total),
    requests: usageNumber(source.requests),
    input: usageNumber(source.input),
    output: usageNumber(source.output),
    cacheCreation: usageNumber(source.cacheCreation),
    cacheRead: usageNumber(source.cacheRead),
    readableRequests: usageNumber(source.readableRequests),
    unreadableRequests: usageNumber(source.unreadableRequests),
  }
}

function readUsageDetails(usage: UsageDetails = {}): Pick<TokenUsageStat, 'input' | 'output' | 'cacheCreation' | 'cacheRead'> {
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

// 判断上游是否真实返回过 Token 字段；字段值为零也属于“可读取”。
function hasReadableTokenUsage(usage: unknown): boolean {
  if (!isRecord(usage)) return false
  return [
    'total_tokens', 'totalTokens', 'prompt_tokens', 'input_tokens', 'inputTokens',
    'completion_tokens', 'output_tokens', 'completionTokens', 'outputTokens',
  ].some(key => typeof usage[key] === 'number' && Number.isFinite(usage[key]))
}

// 累计一次成功调用，并同时记录上游 Token 字段是否可读。
function bumpUsageStat(target: TokenUsageStat, delta: Omit<TokenUsageStat, 'requests' | 'readableRequests' | 'unreadableRequests'>, readable: boolean): void {
  target.total = usageNumber(target.total) + usageNumber(delta.total)
  target.requests = usageNumber(target.requests) + 1
  target.input = usageNumber(target.input) + usageNumber(delta.input)
  target.output = usageNumber(target.output) + usageNumber(delta.output)
  target.cacheCreation = usageNumber(target.cacheCreation) + usageNumber(delta.cacheCreation)
  target.cacheRead = usageNumber(target.cacheRead) + usageNumber(delta.cacheRead)
  target.readableRequests = usageNumber(target.readableRequests) + (readable ? 1 : 0)
  target.unreadableRequests = usageNumber(target.unreadableRequests) + (readable ? 0 : 1)
}

// 只把带统一能力标识的新调用写入 capabilities 节点；旧记录保持原样且不会被推断迁移。
function recordTokenUsage(provider: string, tokens: number, details: { capability?: unknown; model?: string; usage?: UsageDetails; readable?: boolean } = {}): void {
  if (!provider || !isAiCapability(details.capability)) return
  const date = todayCst()
  const state = getTokenUsageState()
  if (!state.cache) {
    try {
      const raw = fs.readFileSync(TOKEN_USAGE_FILE, 'utf8')
      const parsed = JSON.parse(raw) as unknown
      state.cache = isRecord(parsed) ? parsed as Record<string, Record<string, unknown>> : {}
    } catch { state.cache = {} }
  }
  const usageCache = state.cache
  const dateEntry = isRecord(usageCache[date]) ? usageCache[date] : {}
  usageCache[date] = dateEntry
  const capabilities = isRecord(dateEntry.capabilities) ? dateEntry.capabilities : {}
  dateEntry.capabilities = capabilities
  const day = normalizeTokenUsageDay(capabilities[details.capability])
  capabilities[details.capability] = day
  const usage = readUsageDetails(details.usage || {})
  const readable = details.readable !== undefined ? !!details.readable : hasReadableTokenUsage(details.usage)
  const delta = {
    total: usageNumber(tokens),
    input: usage.input,
    output: usage.output,
    cacheCreation: usage.cacheCreation,
    cacheRead: usage.cacheRead,
  }
  const providerKey = String(provider || 'unknown')
  if (!day.providers[providerKey] || typeof day.providers[providerKey] !== 'object') {
    day.providers[providerKey] = { total: usageNumber(day.providers[providerKey]), requests: 0, input: 0, output: 0, cacheCreation: 0, cacheRead: 0, readableRequests: 0, unreadableRequests: 0 }
  }
  bumpUsageStat(day.providers[providerKey], delta, readable)
  const modelKey = String(details.model || '').trim()
  if (modelKey) {
    if (!day.models[modelKey] || typeof day.models[modelKey] !== 'object') day.models[modelKey] = { provider: providerKey, total: 0, requests: 0, input: 0, output: 0, cacheCreation: 0, cacheRead: 0, readableRequests: 0, unreadableRequests: 0 }
    day.models[modelKey].provider = providerKey
    bumpUsageStat(day.models[modelKey], delta, readable)
  }
  bumpUsageStat(day, delta, readable)
  if (!state.flushTimer) {
    state.flushTimer = setTimeout(() => {
      state.flushTimer = null
      try { fs.writeFileSync(TOKEN_USAGE_FILE, JSON.stringify(state.cache, null, 2)) } catch (error) { warnTokenUsagePersistence('delayed_flush', error) }
      if (tokenUsageStates.get(TOKEN_USAGE_FILE) === state) tokenUsageStates.delete(TOKEN_USAGE_FILE)
    }, 5000)
  }
}

// 冲盘所有模块实例和数据目录的待写统计，避免热重载闭包遗留延迟定时器。
function flushTokenUsage(): void {
  for (const [usageFile, state] of [...tokenUsageStates]) {
    if (state.cache && state.flushTimer) {
      clearTimeout(state.flushTimer)
      state.flushTimer = null
      try { fs.writeFileSync(usageFile, JSON.stringify(state.cache, null, 2)) } catch (error) { warnTokenUsagePersistence('exit_flush', error) }
    }
    if (tokenUsageStates.get(usageFile) === state) tokenUsageStates.delete(usageFile)
  }
}

tokenUsageGlobal[TOKEN_USAGE_EXIT_FLUSH] = flushTokenUsage
if (!tokenUsageGlobal[TOKEN_USAGE_EXIT_HOOK]) {
  tokenUsageGlobal[TOKEN_USAGE_EXIT_HOOK] = true
  process.on('exit', () => {
    const handler = tokenUsageGlobal[TOKEN_USAGE_EXIT_FLUSH]
    if (typeof handler === 'function') handler()
  })
}

function mimeFromImagePath(filePath: string = ''): string {
  const ext = String(filePath || '').split('.').pop() || ''
  return { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp' }[ext] || 'image/jpeg'
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

interface ProtocolAttemptResult {
  result: ChatCompletionResult
  usage?: UsageDetails
  usageReadable: boolean
}

class CapabilityUpstreamError extends Error {
  retryable: boolean
  status: number
  code: string

  // 保存稳定诊断字段，消息中绝不包含上游正文或认证内容。
  constructor(message: string, code: string, retryable: boolean, status = 0) {
    super(message)
    this.name = 'CapabilityUpstreamError'
    this.code = code
    this.retryable = retryable
    this.status = status
  }
}

// 仅复制允许进入上游请求体的参数，并对温度做数值边界校验。
function buildFilteredExtraBody(extraBody: RequestExtraBody): Record<string, unknown> {
  const filtered: Record<string, unknown> = {}
  for (const key of ['max_tokens', 'temperature', 'enable_search', 'web_search_options', 'search_options', 'enable_thinking', 'thinking']) {
    if (extraBody[key] === undefined) continue
    if (key === 'temperature') {
      const temperature = Number(extraBody[key])
      if (Number.isFinite(temperature)) filtered.temperature = Math.max(0, Math.min(2, temperature))
      continue
    }
    filtered[key] = extraBody[key]
  }
  return filtered
}

// 对非成功 HTTP 状态分类；只有鉴权、限流和 5xx 允许进入下一优先级。
function assertUpstreamResponseOk(response: Response): void {
  if (response.ok) return
  const status = Number(response.status || 0)
  const retryable = status === 401 || status === 403 || status === 429 || status >= 500
  throw new CapabilityUpstreamError(`AI 上游请求失败（HTTP ${status}）`, `HTTP_${status}`, retryable, status)
}

// 解析上游 JSON，失败时只报告稳定错误，不读取或回传正文。
async function readUpstreamJson(response: Response): Promise<Record<string, unknown>> {
  try {
    const value: unknown = await response.json()
    if (!isRecord(value)) throw new Error('not_object')
    return value
  } catch {
    throw new CapabilityUpstreamError('AI 上游返回了无法解析的结果', 'INVALID_RESPONSE', true)
  }
}

// 从字符串或 OpenAI 内容块中提取可见文本。
function extractMessageText(content: unknown): string {
  if (typeof content === 'string') return content.trim()
  if (!Array.isArray(content)) return ''
  return content.map(item => {
    if (!isRecord(item)) return ''
    return typeof item.text === 'string' ? item.text : ''
  }).filter(Boolean).join(' ').trim()
}

// 把 data URI 拆成官方多模态协议需要的 MIME 与 base64 数据。
function parseDataUri(value: unknown): { mediaType: string; data: string } | null {
  const match = String(value || '').match(/^data:([^;,]+);base64,([A-Za-z0-9+/=_-]+)$/i)
  return match ? { mediaType: match[1].toLowerCase(), data: match[2] } : null
}

// 把 OpenAI 风格工具定义转换为 Anthropic/Gemini 可复用的函数声明。
function readToolFunction(tool: unknown): { name: string; description?: string; parameters: Record<string, unknown> } | null {
  if (!isRecord(tool) || !isRecord(tool.function)) return null
  const name = String(tool.function.name || '').trim()
  if (!name) return null
  return {
    name,
    ...(typeof tool.function.description === 'string' ? { description: tool.function.description } : {}),
    parameters: isRecord(tool.function.parameters) ? tool.function.parameters : { type: 'object', properties: {} },
  }
}

// 把 OpenAI 内容块转换为 Anthropic Messages 内容块，保留文字和已验证图片来源。
function buildAnthropicContent(content: unknown): unknown[] {
  if (typeof content === 'string') return content ? [{ type: 'text', text: content }] : []
  if (!Array.isArray(content)) return []
  const result: unknown[] = []
  for (const item of content) {
    if (!isRecord(item)) continue
    if ((item.type === 'text' || item.type === 'input_text') && typeof item.text === 'string') {
      result.push({ type: 'text', text: item.text })
      continue
    }
    if (item.type !== 'image_url') continue
    const url = isRecord(item.image_url) ? item.image_url.url : item.image_url
    const dataUri = parseDataUri(url)
    if (dataUri) result.push({ type: 'image', source: { type: 'base64', media_type: dataUri.mediaType, data: dataUri.data } })
    else if (/^https:\/\//i.test(String(url || ''))) result.push({ type: 'image', source: { type: 'url', url: String(url) } })
  }
  return result
}

// 将统一消息转换为 Anthropic 的 system + messages 结构，并保持工具调用轮次。
function buildAnthropicMessages(messages: ChatMessage[]): { system: string; messages: Array<Record<string, unknown>> } {
  const system: string[] = []
  const result: Array<Record<string, unknown>> = []
  for (const message of messages) {
    if (message.role === 'system') {
      const text = extractMessageText(message.content)
      if (text) system.push(text)
      continue
    }
    if (message.role === 'tool') {
      result.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: String(message.tool_call_id || ''), content: extractMessageText(message.content) }] })
      continue
    }
    const content = buildAnthropicContent(message.content)
    if (message.role === 'assistant' && Array.isArray(message.tool_calls)) {
      for (const call of message.tool_calls) {
        if (!isRecord(call) || !isRecord(call.function)) continue
        let input: unknown = {}
        try { input = JSON.parse(String(call.function.arguments || '{}')) } catch { input = {} }
        content.push({ type: 'tool_use', id: String(call.id || ''), name: String(call.function.name || ''), input })
      }
    }
    if (content.length) result.push({ role: message.role === 'assistant' ? 'assistant' : 'user', content })
  }
  return { system: system.join('\n\n'), messages: result }
}

// 把统一内容块转换为 Gemini parts；图片仅接受内联 data URI，避免猜测远程文件协议。
function buildGeminiParts(content: unknown): Array<Record<string, unknown>> {
  if (typeof content === 'string') return content ? [{ text: content }] : []
  if (!Array.isArray(content)) return []
  const result: Array<Record<string, unknown>> = []
  for (const item of content) {
    if (!isRecord(item)) continue
    if ((item.type === 'text' || item.type === 'input_text') && typeof item.text === 'string') result.push({ text: item.text })
    if (item.type === 'image_url') {
      const url = isRecord(item.image_url) ? item.image_url.url : item.image_url
      const dataUri = parseDataUri(url)
      if (dataUri) result.push({ inlineData: { mimeType: dataUri.mediaType, data: dataUri.data } })
    }
  }
  return result
}

// 将统一消息转换为 Gemini contents，并用前序工具调用补全 functionResponse 名称。
function buildGeminiMessages(messages: ChatMessage[]): { systemInstruction?: Record<string, unknown>; contents: Array<Record<string, unknown>> } {
  const systemParts: Array<Record<string, unknown>> = []
  const contents: Array<Record<string, unknown>> = []
  const toolNames = new Map<string, string>()
  for (const message of messages) {
    for (const call of Array.isArray(message.tool_calls) ? message.tool_calls : []) {
      if (isRecord(call) && isRecord(call.function)) toolNames.set(String(call.id || ''), String(call.function.name || ''))
    }
  }
  for (const message of messages) {
    if (message.role === 'system') {
      const text = extractMessageText(message.content)
      if (text) systemParts.push({ text })
      continue
    }
    if (message.role === 'tool') {
      const name = toolNames.get(String(message.tool_call_id || '')) || 'tool'
      contents.push({ role: 'user', parts: [{ functionResponse: { name, response: { result: extractMessageText(message.content) } } }] })
      continue
    }
    const parts = buildGeminiParts(message.content)
    if (message.role === 'assistant' && Array.isArray(message.tool_calls)) {
      for (const call of message.tool_calls) {
        if (!isRecord(call) || !isRecord(call.function)) continue
        let args: unknown = {}
        try { args = JSON.parse(String(call.function.arguments || '{}')) } catch { args = {} }
        parts.push({ functionCall: { name: String(call.function.name || ''), args } })
      }
    }
    if (parts.length) contents.push({ role: message.role === 'assistant' ? 'model' : 'user', parts })
  }
  return { ...(systemParts.length ? { systemInstruction: { parts: systemParts } } : {}), contents }
}

// 调用 OpenAI 兼容 Chat Completions 并规范为统一结果。
async function requestOpenAiChatAttempt(messages: ChatMessage[], config: ApiConfig, filtered: Record<string, unknown>, tools: ToolDefinition[] | null, signal: AbortSignal): Promise<ProtocolAttemptResult> {
  const { _thinkingEnabled, ...requestFields } = filtered
  const response = await fetch(String(config.baseURL).replace(/\/+$/, '') + '/chat/completions', {
    method: 'POST', signal,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.apiKey}` },
    body: JSON.stringify({
      model: config.model, temperature: 0.9, max_tokens: filtered.max_tokens || 1500,
      ...buildManagedThinkingArgs(config, !!_thinkingEnabled),
      ...requestFields, messages: normalizeMessagesForProvider(messages, config),
      ...(tools?.length ? { tools, tool_choice: 'auto' } : {}),
    }),
  })
  assertUpstreamResponseOk(response)
  const data = await readUpstreamJson(response)
  const choices = Array.isArray(data.choices) ? data.choices : []
  const first = isRecord(choices[0]) ? choices[0] : {}
  const message = isRecord(first.message) ? first.message : {}
  const reasoning = String(message.reasoning_content || '')
  const usage = isRecord(data.usage) ? data.usage as UsageDetails : undefined
  if (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
    return { result: { type: 'tool_calls', tool_calls: message.tool_calls, message, reasoning }, usage, usageReadable: hasReadableTokenUsage(usage) }
  }
  let content = extractMessageText(message.content)
  if (/<think>[\s\S]*?<\/think>/i.test(content)) content = content.replace(/<think>[\s\S]*?<\/think>/gi, '').trim()
  if (!content) throw new CapabilityUpstreamError('AI 上游返回空结果', 'EMPTY_RESPONSE', true)
  return { result: { type: 'text', content: content.replace(/\s+/g, ' ').trim(), reasoning }, usage, usageReadable: hasReadableTokenUsage(usage) }
}

// 调用 Anthropic Messages 并把 text/tool_use 结果转换为统一格式。
async function requestAnthropicAttempt(messages: ChatMessage[], config: ApiConfig, filtered: Record<string, unknown>, tools: ToolDefinition[] | null, signal: AbortSignal): Promise<ProtocolAttemptResult> {
  const converted = buildAnthropicMessages(messages)
  const anthropicTools = (tools || []).map(readToolFunction).filter((tool): tool is NonNullable<ReturnType<typeof readToolFunction>> => !!tool).map(tool => ({ name: tool.name, description: tool.description, input_schema: tool.parameters }))
  const response = await fetch(String(config.baseURL).replace(/\/+$/, '') + '/messages', {
    method: 'POST', signal,
    headers: { 'Content-Type': 'application/json', 'x-api-key': config.apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: config.model,
      max_tokens: Number(filtered.max_tokens) || 1500,
      ...(typeof filtered.temperature === 'number' ? { temperature: filtered.temperature } : {}),
      ...(converted.system ? { system: converted.system } : {}),
      messages: converted.messages,
      ...(anthropicTools.length ? { tools: anthropicTools } : {}),
    }),
  })
  assertUpstreamResponseOk(response)
  const data = await readUpstreamJson(response)
  const blocks = Array.isArray(data.content) ? data.content.filter(isRecord) : []
  const text = blocks.filter(block => block.type === 'text').map(block => String(block.text || '')).join(' ').trim()
  const toolCalls = blocks.filter(block => block.type === 'tool_use').map(block => ({ id: String(block.id || ''), type: 'function', function: { name: String(block.name || ''), arguments: JSON.stringify(block.input || {}) } }))
  const usage = isRecord(data.usage) ? data.usage as UsageDetails : undefined
  if (toolCalls.length) return { result: { type: 'tool_calls', tool_calls: toolCalls, message: { content: text, tool_calls: toolCalls }, reasoning: '' }, usage, usageReadable: hasReadableTokenUsage(usage) }
  if (!text) throw new CapabilityUpstreamError('AI 上游返回空结果', 'EMPTY_RESPONSE', true)
  return { result: { type: 'text', content: text.replace(/\s+/g, ' '), reasoning: '' }, usage, usageReadable: hasReadableTokenUsage(usage) }
}

// 调用 Gemini generateContent 并把文本、函数调用和用量规范为统一结构。
async function requestGeminiAttempt(messages: ChatMessage[], config: ApiConfig, filtered: Record<string, unknown>, tools: ToolDefinition[] | null, signal: AbortSignal): Promise<ProtocolAttemptResult> {
  const converted = buildGeminiMessages(messages)
  const declarations = (tools || []).map(readToolFunction).filter((tool): tool is NonNullable<ReturnType<typeof readToolFunction>> => !!tool).map(tool => ({ name: tool.name, description: tool.description, parameters: tool.parameters }))
  const endpoint = `${String(config.baseURL).replace(/\/+$/, '')}/models/${encodeURIComponent(config.model)}:generateContent`
  const response = await fetch(endpoint, {
    method: 'POST', signal,
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': config.apiKey },
    body: JSON.stringify({
      ...converted,
      generationConfig: {
        maxOutputTokens: Number(filtered.max_tokens) || 1500,
        ...(typeof filtered.temperature === 'number' ? { temperature: filtered.temperature } : {}),
      },
      ...(declarations.length ? { tools: [{ functionDeclarations: declarations }] } : {}),
    }),
  })
  assertUpstreamResponseOk(response)
  const data = await readUpstreamJson(response)
  const candidates = Array.isArray(data.candidates) ? data.candidates : []
  const candidate = isRecord(candidates[0]) ? candidates[0] : {}
  const content = isRecord(candidate.content) ? candidate.content : {}
  const parts = Array.isArray(content.parts) ? content.parts.filter(isRecord) : []
  const text = parts.map(part => typeof part.text === 'string' ? part.text : '').filter(Boolean).join(' ').trim()
  const toolCalls = parts.filter(part => isRecord(part.functionCall)).map((part, index) => {
    const call = part.functionCall as Record<string, unknown>
    return { id: `gemini-${index + 1}`, type: 'function', function: { name: String(call.name || ''), arguments: JSON.stringify(call.args || {}) } }
  })
  const metadata = isRecord(data.usageMetadata) ? data.usageMetadata : null
  const usage: UsageDetails | undefined = metadata ? {
    total_tokens: usageNumber(metadata.totalTokenCount),
    input_tokens: usageNumber(metadata.promptTokenCount),
    output_tokens: usageNumber(metadata.candidatesTokenCount),
  } : undefined
  if (toolCalls.length) return { result: { type: 'tool_calls', tool_calls: toolCalls, message: { content: text, tool_calls: toolCalls }, reasoning: '' }, usage, usageReadable: !!metadata }
  if (!text) throw new CapabilityUpstreamError('AI 上游返回空结果', 'EMPTY_RESPONSE', true)
  return { result: { type: 'text', content: text.replace(/\s+/g, ' '), reasoning: '' }, usage, usageReadable: !!metadata }
}

// 依据权威供应商协议执行单个优先级步骤。
async function requestProtocolAttempt(messages: ChatMessage[], config: ApiConfig, filtered: Record<string, unknown>, tools: ToolDefinition[] | null, signal: AbortSignal): Promise<ProtocolAttemptResult> {
  const protocol = String(config.chatProtocol || getProviderCatalogEntry(config.provider)?.chatProtocol || 'openai-chat')
  if (protocol === 'anthropic-messages') return requestAnthropicAttempt(messages, config, filtered, tools, signal)
  if (protocol === 'gemini-content') return requestGeminiAttempt(messages, config, filtered, tools, signal)
  return requestOpenAiChatAttempt(messages, config, filtered, tools, signal)
}

// 计算一次成功调用的总 Token；无可读用量时保留零值并记录不可读状态。
function getUsageTotal(usage: UsageDetails | undefined): number {
  if (!usage) return 0
  return usageNumber(usage.total_tokens || usage.totalTokens)
    || usageNumber(usage.prompt_tokens || usage.input_tokens || usage.inputTokens)
      + usageNumber(usage.completion_tokens || usage.output_tokens || usage.completionTokens || usage.outputTokens)
}

// 严格从能力优先级第一项开始请求，只在规定错误条件下通知并进入下一项。
async function requestChatCompletions(messages: ChatMessage[], config: ApiConfig, extraBody: RequestExtraBody = {}, tools: ToolDefinition[] | null = null): Promise<ChatCompletionResult> {
  const managedCapability = isAiCapability(config.capability) ? config.capability : null
  const capability = managedCapability || 'text'
  const attempts: ApiConfig[] = managedCapability
    ? resolveCapabilityRuntimeSteps(managedCapability).map(step => ({ ...step, searchEnabled: config.searchEnabled }))
    : [{ ...config, capability }]
  if (!attempts.length) throw new Error('该能力未配置模型')
  const filtered = buildFilteredExtraBody(extraBody)
  filtered._thinkingEnabled = extraBody._thinkingEnabled
  const externalSignal = extraBody.signal && typeof extraBody.signal === 'object' ? extraBody.signal : null
  const requestedTimeout = Number(extraBody._timeoutMs)

  for (let index = 0; index < attempts.length; index += 1) {
    const attempt = attempts[index]
    const controller = new AbortController()
    const timeout = Number.isFinite(requestedTimeout) && requestedTimeout > 0
      ? Math.max(1000, Math.min(REQUEST_TIMEOUT_CAP, requestedTimeout))
      : index > 0 ? 10000 : REQUEST_TIMEOUT
    const timer = setTimeout(() => controller.abort(), timeout)
    let cleanupExternalSignal: (() => void) | null = null
    if (externalSignal && typeof externalSignal.addEventListener === 'function') {
      if (externalSignal.aborted) controller.abort()
      else {
        const onAbort = () => controller.abort()
        externalSignal.addEventListener('abort', onAbort, { once: true })
        cleanupExternalSignal = () => externalSignal.removeEventListener('abort', onAbort)
      }
    }
    try {
      const response = await requestProtocolAttempt(messages, attempt, filtered, tools, controller.signal)
      recordTokenUsage(attempt.provider || 'unknown', getUsageTotal(response.usage), {
        capability,
        model: attempt.model,
        usage: response.usage,
        readable: response.usageReadable,
      })
      return response.result
    } catch (error) {
      if (externalSignal?.aborted) throw error
      const failure = error instanceof CapabilityUpstreamError
        ? error
        : new CapabilityUpstreamError('AI 上游网络请求失败', 'NETWORK_ERROR', true)
      console.warn(`[ai-api] capability_step_failed capability=${capability} provider=${attempt.provider || 'unknown'} model=${attempt.model} code=${failure.code}`)
      await notifyCapabilityStepFailure(attempt.provider || 'unknown', attempt.model).catch(() => false)
      if (!failure.retryable || index >= attempts.length - 1) throw failure
    } finally {
      clearTimeout(timer)
      try { cleanupExternalSignal?.() } catch { /* non-critical: abort listener cleanup can race with cancellation */ }
    }
  }
  throw new Error('该能力未配置模型')
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
    assertUpstreamResponseOk(response)
    const data = await readUpstreamJson(response)
    const usage = isRecord(data.usage) ? data.usage as UsageDetails : undefined
    recordTokenUsage(config.provider || 'unknown', getUsageTotal(usage), {
      capability: isAiCapability(config.capability) ? config.capability : 'text',
      model: config.model,
      usage,
      readable: hasReadableTokenUsage(usage),
    })
    return extractResponsesText(data)
  } finally { clearTimeout(timer) }
}

// 返回当前能力链中相对当前步骤的后继项；不重试原模型，也不读取旧三链。
async function buildFallbackConfig(config: ApiConfig, step: number, fallbackSet: string): Promise<ApiConfig | null> {
  if (!isAiCapability(fallbackSet) || !Number.isInteger(step) || step < 1) return null
  const chain = resolveCapabilityRuntimeSteps(fallbackSet)
  const currentIndex = chain.findIndex(item => item.provider === config.provider && item.model === config.model)
  const next = chain[(currentIndex >= 0 ? currentIndex : -1) + step]
  return next ? { ...next, searchEnabled: config.searchEnabled } : null
}

// 返回四项能力的当前脱敏优先级视图，不再暴露 chat/lightweight 旧链。
function getFallbackSteps(): Record<string, FallbackStep[]> {
  const result: Record<string, FallbackStep[]> = {}
  for (const capability of AI_CAPABILITIES) {
    result[capability] = resolveCapabilityRuntimeSteps(capability).map(step => ({
      provider: step.provider,
      model: step.model,
      capability: step.capability,
      chatProtocol: step.chatProtocol,
      priorityIndex: step.priorityIndex,
    }))
  }
  return result
}

function callOneBotWs<T>(action: string, params: Record<string, unknown>, echo: string, timeoutMs: number, extractData: (message: OneBotMessage) => T | null): Promise<T | null> {
  return new Promise((resolve) => {
    let ws: InstanceType<typeof WebSocket> | null = null
    let timer: NodeJS.Timeout | null = null
    let settled = false
    const finish = (value: T | null): void => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      try { if (ws) ws.close() } catch { /* non-critical: OneBot websocket may already be closed */ }
      resolve(value || null)
    }

    try {
      ws = new WebSocket(resolveOneBotWsUrl())
      const socket = ws
      timer = setTimeout(() => finish(null), timeoutMs)
      socket.on('open', () => {
        try { socket.send(JSON.stringify({ action, params, echo })) } catch { finish(null) }
      })
      socket.on('message', (d: import('ws').RawData) => {
        let message: OneBotMessage | null = null
        try { message = JSON.parse(d.toString()) } catch { return finish(null) }
        if (!message) return finish(null)
        if (message.echo !== echo) return
        try { finish(extractData(message)) } catch { finish(null) }
      })
      socket.on('error', () => finish(null))
      socket.on('close', () => finish(null))
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
    let request: import('http').ClientRequest | null = null
    let timer: NodeJS.Timeout | null = null
    let settled = false
    let currentUrl: URL | null = null
    const finishDownload = (value: string | null): void => {
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
        if (!currentUrl) return finishDownload(null)
        const mod = currentUrl.protocol === 'https:' ? https : http
        timer = setTimeout(() => {
          try { if (request) request.destroy() } catch { /* non-critical: request may already be closed */ }
          finishDownload(null)
        }, timeoutMs)
        request = mod.get(currentUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res: import('http').IncomingMessage) => {
          const status = Number(res.statusCode || 0)
          if (status >= 300 && status < 400 && res.headers.location) {
            res.resume()
            return finishDownload(null)
          }
          if (status !== 200) {
            res.resume()
            return finishDownload(null)
          }
          const contentTypeHeader = res.headers['content-type']
          const contentTypeValue = Array.isArray(contentTypeHeader) ? contentTypeHeader[0] : contentTypeHeader
          const type = String(contentTypeValue || 'image/jpeg').split(';')[0].trim().toLowerCase()
          if (type && !/^image\/(?:png|jpe?g|gif|webp|bmp)$/.test(type)) {
            res.resume()
            return finishDownload(null)
          }
          const contentLengthHeader = res.headers['content-length']
          const contentLengthValue = Array.isArray(contentLengthHeader) ? contentLengthHeader[0] : contentLengthHeader
          const declared = parseInt(String(contentLengthValue || ''), 10)
          if (Number.isFinite(declared) && declared > MAX_REMOTE_IMAGE_BYTES) {
            res.resume()
            return finishDownload(null)
          }
          const chunks: Buffer[] = []
          let received = 0
          res.on('data', (c: Buffer) => {
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

// 只依据权威精确表或已校验模型池判断视觉能力，禁止按模型名称猜测。
function isVisionModel(provider: string, modelId: string): boolean {
  if (getVerifiedModelCapabilities(provider, modelId).includes('vision')) return true
  try {
    const { config } = loadCapabilityConfigSync()
    const pool = config.providers[provider as keyof typeof config.providers]
    return !!pool?.models.find(model => model.id === modelId)?.capabilities.includes('vision')
  } catch {
    return false
  }
}

export = {
  requestChatCompletions, normalizeMessagesForProvider, buildResponsesInput, extractResponsesText,
  requestOpenAIResponsesWithSearch,
  buildFallbackConfig, getFallbackSteps,
  callGetImage, callGetFile, callGetRecord, callGetForwardMsg, sendForwardMsg, getGroupMemberInfo, getGroupInfo,
  readImageAsBase64, extractImageFileFromElements, downloadImageAsBase64,
  isVisionModel, recordTokenUsage, flushTokenUsage,
}
