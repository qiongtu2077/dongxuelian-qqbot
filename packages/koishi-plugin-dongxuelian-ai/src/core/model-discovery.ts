/**
 * MODULE: 受限供应商模型发现。
 * 职责: 按权威目录调用已验证的官方模型枚举协议并解析能力元数据。
 * 边界: API Key 只存在于请求内存和认证头，不写日志、不进入返回体。
 */
const {
  getProviderCatalogEntry,
  getVerifiedModelCapabilities,
} = require('./ai-capability-config') as typeof import('./ai-capability-config')

interface FetchResponseLike {
  ok: boolean
  status: number
  json(): Promise<unknown>
}

type DiscoveryFetch = (input: string, init?: RequestInit) => Promise<FetchResponseLike>

interface DiscoveredModel {
  id: string
  name: string
  capabilities: string[]
  importable: boolean
  unavailableReason?: string
}

interface DiscoveryOptions {
  fetchImpl?: DiscoveryFetch
  timeoutMs?: number
}

class ModelDiscoveryError extends Error {
  code: string
  status: number

  // 携带稳定错误码，不包含上游响应体或认证信息。
  constructor(message: string, code: string, status = 400) {
    super(message)
    this.name = 'ModelDiscoveryError'
    this.code = code
    this.status = status
  }
}

const MAX_DISCOVERY_CONCURRENCY = 2
const MAX_DISCOVERED_MODELS = 1000
let activeDiscoveries = 0
const discoveryWaiters: Array<() => void> = []

// --- 并发与错误边界 ---

// 在全局并发上限内执行发现请求，避免密钥失焦事件压垮上游。
async function withDiscoverySlot<T>(task: () => Promise<T>): Promise<T> {
  if (activeDiscoveries >= MAX_DISCOVERY_CONCURRENCY) {
    await new Promise<void>(resolve => discoveryWaiters.push(resolve))
  }
  activeDiscoveries += 1
  try {
    return await task()
  } finally {
    activeDiscoveries -= 1
    discoveryWaiters.shift()?.()
  }
}

// 将 HTTP 状态转换为详细但不含上游正文的脱敏错误。
function throwDiscoveryHttpError(status: number): never {
  if (status === 401 || status === 403) throw new ModelDiscoveryError(`供应商鉴权失败（HTTP ${status}）`, 'DISCOVERY_AUTH_FAILED', 422)
  if (status === 429) throw new ModelDiscoveryError('供应商限流，请稍后重试（HTTP 429）', 'DISCOVERY_RATE_LIMITED', 429)
  if (status >= 500) throw new ModelDiscoveryError(`供应商服务错误（HTTP ${status}）`, 'DISCOVERY_UPSTREAM_ERROR', 502)
  throw new ModelDiscoveryError(`供应商拒绝模型发现请求（HTTP ${status}）`, 'DISCOVERY_HTTP_ERROR', 422)
}

// 解析 JSON；任何原始响应内容都不会进入错误消息。
async function readDiscoveryJson(response: FetchResponseLike): Promise<unknown> {
  try {
    return await response.json()
  } catch {
    throw new ModelDiscoveryError('供应商返回了无法解析的模型列表', 'DISCOVERY_INVALID_JSON', 502)
  }
}

// --- 协议解析 ---

// 解析 OpenAI 兼容模型列表，并仅接受精确官方能力表命中的模型。
function parseOpenAiModelList(providerId: string, payload: unknown): DiscoveredModel[] {
  const data = payload && typeof payload === 'object' && !Array.isArray(payload)
    ? (payload as { data?: unknown }).data
    : null
  if (!Array.isArray(data)) throw new ModelDiscoveryError('供应商模型列表缺少 data 数组', 'DISCOVERY_INVALID_RESPONSE', 502)
  return data.slice(0, MAX_DISCOVERED_MODELS).map((item): DiscoveredModel | null => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return null
    const id = String((item as { id?: unknown }).id || '').trim()
    if (!id) return null
    const capabilities = getVerifiedModelCapabilities(providerId, id)
    return {
      id,
      name: id,
      capabilities,
      importable: capabilities.length > 0,
      ...(capabilities.length ? {} : { unavailableReason: '官方枚举未提供模态，且精确能力表尚未确认该模型' }),
    }
  }).filter((model): model is DiscoveredModel => !!model)
}

// 解析 Anthropic 模型列表，直接使用官方 image_input 能力字段。
function parseAnthropicModelList(payload: unknown): DiscoveredModel[] {
  const data = payload && typeof payload === 'object' && !Array.isArray(payload)
    ? (payload as { data?: unknown }).data
    : null
  if (!Array.isArray(data)) throw new ModelDiscoveryError('Claude 模型列表缺少 data 数组', 'DISCOVERY_INVALID_RESPONSE', 502)
  return data.slice(0, MAX_DISCOVERED_MODELS).map((item): DiscoveredModel | null => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return null
    const source = item as { id?: unknown; display_name?: unknown; capabilities?: unknown }
    const id = String(source.id || '').trim()
    if (!id) return null
    const caps = source.capabilities && typeof source.capabilities === 'object' && !Array.isArray(source.capabilities)
      ? source.capabilities as { image_input?: unknown }
      : {}
    const image = caps.image_input && typeof caps.image_input === 'object' && !Array.isArray(caps.image_input)
      ? !!(caps.image_input as { supported?: unknown }).supported
      : false
    return { id, name: String(source.display_name || id).trim() || id, capabilities: image ? ['text', 'vision'] : ['text'], importable: true }
  }).filter((model): model is DiscoveredModel => !!model)
}

// 解析 Gemini 模型列表；生成方法确认文字能力，视觉仍要求精确官方能力表。
function parseGeminiModelList(payload: unknown): DiscoveredModel[] {
  const models = payload && typeof payload === 'object' && !Array.isArray(payload)
    ? (payload as { models?: unknown }).models
    : null
  if (!Array.isArray(models)) throw new ModelDiscoveryError('Gemini 模型列表缺少 models 数组', 'DISCOVERY_INVALID_RESPONSE', 502)
  return models.slice(0, MAX_DISCOVERED_MODELS).map((item): DiscoveredModel | null => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return null
    const source = item as { name?: unknown; displayName?: unknown; supportedGenerationMethods?: unknown }
    const resourceName = String(source.name || '').trim()
    const id = resourceName.replace(/^models\//, '')
    if (!id) return null
    const methods = Array.isArray(source.supportedGenerationMethods) ? source.supportedGenerationMethods.map(String) : []
    const verified = getVerifiedModelCapabilities('gemini', id)
    const capabilities = methods.includes('generateContent')
      ? [...new Set(['text', ...verified.filter(capability => capability === 'vision')])]
      : []
    return {
      id,
      name: String(source.displayName || id).trim() || id,
      capabilities,
      importable: capabilities.length > 0,
      ...(capabilities.length ? {} : { unavailableReason: '该模型未声明 generateContent 能力' }),
    }
  }).filter((model): model is DiscoveredModel => !!model)
}

// --- 官方请求 ---

// 构造固定官方认证头，禁止调用方传入 URL 或自定义头。
function buildDiscoveryHeaders(protocol: string, apiKey: string): Record<string, string> {
  if (protocol === 'anthropic-models') {
    return { Accept: 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' }
  }
  if (protocol === 'gemini-models') return { Accept: 'application/json', 'x-goog-api-key': apiKey }
  return { Accept: 'application/json', Authorization: `Bearer ${apiKey}` }
}

// 调用一个白名单供应商的官方模型枚举接口并返回脱敏模型元数据。
async function discoverProviderModels(providerId: string, apiKey: string, options: DiscoveryOptions = {}): Promise<DiscoveredModel[]> {
  const provider = getProviderCatalogEntry(providerId)
  if (!provider) throw new ModelDiscoveryError('未知供应商', 'DISCOVERY_PROVIDER_INVALID', 400)
  if (provider.discoveryProtocol === 'blocked' || !provider.discoveryURL) {
    throw new ModelDiscoveryError(provider.discoveryReason || '该供应商模型发现尚未验证', 'DISCOVERY_BLOCKED', 409)
  }
  const key = String(apiKey || '').trim().replace(/[\r\n]+/g, '')
  if (!key) throw new ModelDiscoveryError('API Key 不能为空', 'DISCOVERY_KEY_REQUIRED', 400)
  if (key.length > 16384) throw new ModelDiscoveryError('API Key 长度超出限制', 'DISCOVERY_KEY_INVALID', 400)
  const fetchImpl = options.fetchImpl || (fetch as unknown as DiscoveryFetch)
  const timeoutMs = Math.max(1000, Math.min(15000, Number(options.timeoutMs) || 8000))

  return withDiscoverySlot(async () => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const response = await fetchImpl(provider.discoveryURL as string, {
        method: 'GET',
        signal: controller.signal,
        headers: buildDiscoveryHeaders(provider.discoveryProtocol, key),
      })
      if (!response.ok) throwDiscoveryHttpError(response.status)
      const payload = await readDiscoveryJson(response)
      if (provider.discoveryProtocol === 'anthropic-models') return parseAnthropicModelList(payload)
      if (provider.discoveryProtocol === 'gemini-models') return parseGeminiModelList(payload)
      return parseOpenAiModelList(provider.id, payload)
    } catch (error) {
      if (error instanceof ModelDiscoveryError) throw error
      const name = error && typeof error === 'object' && 'name' in error ? String((error as { name?: unknown }).name || '') : ''
      if (name === 'AbortError') throw new ModelDiscoveryError('模型发现请求超时', 'DISCOVERY_TIMEOUT', 504)
      throw new ModelDiscoveryError('模型发现网络请求失败', 'DISCOVERY_NETWORK_ERROR', 502)
    } finally {
      clearTimeout(timer)
    }
  })
}

export = {
  ModelDiscoveryError,
  parseOpenAiModelList,
  parseAnthropicModelList,
  parseGeminiModelList,
  discoverProviderModels,
}
