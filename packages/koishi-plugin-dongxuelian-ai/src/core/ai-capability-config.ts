/**
 * MODULE: AI 四能力配置契约。
 * 职责: 统一供应商目录、模型池、优先级、旧三链迁移与运行时读取。
 * 边界: 不发起上游请求，不写入配置文件；写入由 Dashboard 原子事务负责。
 */
const fs = require('fs') as typeof import('fs')
const path = require('path') as typeof import('path')
import contract = require('../public/ai-capability-contract.json')
const { DATA_DIR, FALLBACK_CHAINS_FILE } = require('./constants') as typeof import('./constants')

const AI_CAPABILITIES = Object.freeze([...contract.capabilities] as const)
type AiCapability = (typeof AI_CAPABILITIES)[number]
type ProviderId = 'glm' | 'mimorium' | 'dashscope' | 'deepseek' | 'openai' | 'anthropic' | 'gemini' | 'opencode'
type DiscoveryProtocol = 'openai-models' | 'anthropic-models' | 'gemini-models' | 'blocked'
type ChatProtocol = 'openai-chat' | 'anthropic-messages' | 'gemini-content'

interface ProviderCatalogEntry {
  id: ProviderId
  name: string
  keyFile: string
  baseURL: string
  chatProtocol: ChatProtocol
  discoveryProtocol: DiscoveryProtocol
  discoveryURL?: string
  discoveryReason?: string
  documentationURL: string
}

interface CapabilityModel {
  id: string
  name: string
  capabilities: AiCapability[]
}

interface CapabilityPriorityStep {
  provider: ProviderId
  model: string
}

interface ProviderModelPool {
  models: CapabilityModel[]
}

interface CapabilityConfig {
  version: number
  providers: Record<ProviderId, ProviderModelPool>
  priorities: Record<AiCapability, CapabilityPriorityStep[]>
}

interface LegacyFallbackStep {
  provider?: unknown
  model?: unknown
}

interface MigrationResult {
  config: CapabilityConfig
  diagnostics: string[]
  migrated: boolean
}

interface ReplaceModelsResult {
  config: CapabilityConfig
  removedModels: number
  removedSteps: number
  emptyCapabilities: AiCapability[]
}

interface RuntimeCapabilityStep {
  capability: AiCapability
  provider: ProviderId
  providerName: string
  model: string
  apiKey: string
  baseURL: string
  chatProtocol: ChatProtocol
  priorityIndex: number
}

const CAPABILITY_CONFIG_FILE = path.join(DATA_DIR, 'ai-capability-config.json')
const MAX_CAPABILITY_CONFIG_BYTES = 512 * 1024
const MAX_KEY_BYTES = 64 * 1024

// --- 权威供应商目录 ---

const PROVIDER_CATALOG: Record<ProviderId, ProviderCatalogEntry> = Object.freeze({
  glm: {
    id: 'glm', name: '智谱', keyFile: 'ai-glm-key.txt', baseURL: 'https://open.bigmodel.cn/api/paas/v4', chatProtocol: 'openai-chat',
    discoveryProtocol: 'blocked', discoveryReason: '尚未确认仅凭 API Key 枚举模型的官方接口', documentationURL: 'https://open.bigmodel.cn/dev/api',
  },
  mimorium: {
    id: 'mimorium', name: '小米', keyFile: 'ai-mimorium-key.txt', baseURL: 'https://token-plan-cn.xiaomimimo.com/v1', chatProtocol: 'openai-chat',
    discoveryProtocol: 'blocked', discoveryReason: '官方模型能力已确认，但尚未确认 Key 级模型枚举接口', documentationURL: 'https://mimo.mi.com/docs/quick-start/summary/model',
  },
  dashscope: {
    id: 'dashscope', name: '千问', keyFile: 'ai-dashscope-key.txt', baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1', chatProtocol: 'openai-chat',
    discoveryProtocol: 'blocked', discoveryReason: '官方模型目录要求 Workspace ID，当前导入契约仅接收 API Key', documentationURL: 'https://help.aliyun.com/en/model-studio/list-models',
  },
  deepseek: {
    id: 'deepseek', name: '深度求索', keyFile: 'ai-deepseek-key.txt', baseURL: 'https://api.deepseek.com', chatProtocol: 'openai-chat',
    discoveryProtocol: 'openai-models', discoveryURL: 'https://api.deepseek.com/models', documentationURL: 'https://api-docs.deepseek.com/api/list-models/',
  },
  openai: {
    id: 'openai', name: 'GPT', keyFile: 'ai-openai-official-key.txt', baseURL: 'https://api.openai.com/v1', chatProtocol: 'openai-chat',
    discoveryProtocol: 'openai-models', discoveryURL: 'https://api.openai.com/v1/models', documentationURL: 'https://developers.openai.com/api/reference/resources/models/methods/list',
  },
  anthropic: {
    id: 'anthropic', name: 'Claude', keyFile: 'ai-anthropic-key.txt', baseURL: 'https://api.anthropic.com/v1', chatProtocol: 'anthropic-messages',
    discoveryProtocol: 'anthropic-models', discoveryURL: 'https://api.anthropic.com/v1/models', documentationURL: 'https://platform.claude.com/docs/en/api/models/list',
  },
  gemini: {
    id: 'gemini', name: 'Gemini', keyFile: 'ai-gemini-key.txt', baseURL: 'https://generativelanguage.googleapis.com/v1beta', chatProtocol: 'gemini-content',
    discoveryProtocol: 'gemini-models', discoveryURL: 'https://generativelanguage.googleapis.com/v1beta/models', documentationURL: 'https://ai.google.dev/api/models',
  },
  opencode: {
    id: 'opencode', name: 'OpenCode', keyFile: 'ai-openai-key.txt', baseURL: 'https://opencode.ai/zen/go/v1', chatProtocol: 'openai-chat',
    discoveryProtocol: 'blocked', discoveryReason: '官方仅公布推荐模型目录，尚未确认 Key 级模型枚举接口', documentationURL: 'https://opencode.ai/docs/zen/',
  },
})

const PROVIDER_IDS = Object.freeze(Object.keys(PROVIDER_CATALOG) as ProviderId[])

// 官方枚举不返回模态时，只允许命中这里的精确模型 ID；禁止名称正则或前缀推断。
const VERIFIED_MODEL_CAPABILITIES: Partial<Record<ProviderId, Record<string, AiCapability[]>>> = Object.freeze({
  glm: {
    'glm-4.6v-flash': ['text', 'vision'],
  },
  mimorium: {
    'mimo-v2.5-pro': ['text'],
    'mimo-v2.5-pro-ultrspeed': ['text'],
    'mimo-v2.5': ['text', 'vision'],
    'mimo-v2.5-asr': ['voice-asr'],
    'mimo-v2.5-tts': ['voice-tts'],
    'mimo-v2.5-tts-voiceclone': ['voice-tts'],
    'mimo-v2.5-tts-voicedesign': ['voice-tts'],
  },
  dashscope: {
    'qwen3.5-plus': ['text', 'vision'],
    'qwen3.6-plus': ['text', 'vision'],
    'qwen3.5-omni-flash': ['text', 'vision'],
    'qwen-turbo': ['text'],
  },
  deepseek: {
    'deepseek-v4-flash': ['text'],
    'deepseek-v4-pro': ['text'],
  },
  openai: {
    'gpt-5.6-sol': ['text', 'vision'],
    'gpt-5.6-terra': ['text', 'vision'],
    'gpt-5.6-luna': ['text', 'vision'],
    'gpt-5.6-cyber': ['text', 'vision'],
    'gpt-daybreak-red-latest': ['text', 'vision'],
    'gpt-daybreak-blue-latest': ['text', 'vision'],
    'gpt-4o': ['text', 'vision'],
    'gpt-4o-mini': ['text', 'vision'],
    'gpt-transcribe': ['voice-asr'],
    'gpt-live-transcribe': ['voice-asr'],
    'gpt-realtime-whisper': ['voice-asr'],
    'gpt-4o-transcribe': ['voice-asr'],
    'gpt-4o-mini-transcribe': ['voice-asr'],
    'gpt-4o-mini-tts': ['voice-tts'],
    'tts-1': ['voice-tts'],
    'tts-1-hd': ['voice-tts'],
  },
  gemini: {
    'gemini-3.7-flash': ['text', 'vision'],
    'gemini-3.6-flash': ['text', 'vision'],
    'gemini-3.5-flash': ['text', 'vision'],
    'gemini-3.5-flash-lite': ['text', 'vision'],
    'gemini-3.1-pro': ['text', 'vision'],
    'gemini-3-flash': ['text', 'vision'],
  },
  opencode: {
    'glm-5': ['text', 'vision'],
    'glm-5.1': ['text', 'vision'],
    'kimi-k2.5': ['text', 'vision'],
    'kimi-k2.6': ['text', 'vision'],
    'deepseek-v4-pro': ['text'],
    'deepseek-v4-flash': ['text'],
    'mimo-v2.5-pro': ['text'],
    'mimo-v2.5': ['text'],
    'qwen3.6-plus': ['text', 'vision'],
    'qwen3.5-plus': ['text', 'vision'],
  },
})

const LEGACY_DEFAULT_CHAINS = Object.freeze({
  chat: [
    { provider: 'glm', model: 'glm-4.6v-flash' },
    { provider: 'opencode', model: 'deepseek-v4-flash' },
    { provider: 'dashscope', model: 'qwen3.5-omni-flash' },
    { provider: 'dashscope', model: 'qwen3.5-plus' },
  ],
  vision: [
    { provider: 'glm', model: 'glm-4.6v-flash' },
    { provider: 'mimorium', model: 'mimo-v2-omni' },
    { provider: 'dashscope', model: 'qwen3.5-omni-flash' },
    { provider: 'dashscope', model: 'qwen3.5-plus' },
  ],
  lightweight: [
    { provider: 'glm', model: 'glm-4.6v-flash' },
    { provider: 'opencode', model: 'deepseek-v4-flash' },
    { provider: 'dashscope', model: 'qwen3.5-omni-flash' },
    { provider: 'dashscope', model: 'qwen3.5-plus' },
  ],
})

// --- 契约与模型规范化 ---

// 判断一个运行时值是否为唯一契约定义的能力标识。
function isAiCapability(value: unknown): value is AiCapability {
  return typeof value === 'string' && AI_CAPABILITIES.includes(value)
}

// 判断一个运行时值是否为白名单供应商标识。
function isProviderId(value: unknown): value is ProviderId {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(PROVIDER_CATALOG, value)
}

// 返回官方证据确认的精确模型能力，未命中时返回空数组。
function getVerifiedModelCapabilities(providerId: unknown, modelId: unknown): AiCapability[] {
  if (!isProviderId(providerId)) return []
  const model = String(modelId || '').trim()
  return [...(VERIFIED_MODEL_CAPABILITIES[providerId]?.[model] || [])]
}

// 创建包含八家空模型池和四条空优先级的最新配置。
function createEmptyCapabilityConfig(): CapabilityConfig {
  const providers = {} as Record<ProviderId, ProviderModelPool>
  for (const providerId of PROVIDER_IDS) providers[providerId] = { models: [] }
  const priorities = {} as Record<AiCapability, CapabilityPriorityStep[]>
  for (const capability of AI_CAPABILITIES) priorities[capability] = []
  return { version: contract.version, providers, priorities }
}

// 对单个模型池条目进行边界清洗，并限制能力只能来自统一契约。
function normalizeCapabilityModel(value: unknown): CapabilityModel | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const source = value as { id?: unknown; name?: unknown; capabilities?: unknown }
  const id = String(source.id || '').trim()
  if (!id || id.length > 256) return null
  const name = String(source.name || id).trim().slice(0, 256) || id
  const capabilities = Array.isArray(source.capabilities)
    ? [...new Set(source.capabilities.filter(isAiCapability))]
    : []
  if (!capabilities.length) return null
  return { id, name, capabilities }
}

// 严格读取并校验完整配置，阻止未知供应商、重复模型和悬空优先级引用。
function normalizeCapabilityConfig(value: unknown): CapabilityConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('AI 能力配置必须是对象')
  const source = value as { version?: unknown; providers?: unknown; priorities?: unknown }
  if (Number(source.version) !== contract.version) throw new Error(`不支持的 AI 能力配置版本: ${String(source.version || '')}`)
  const rawProviders = source.providers && typeof source.providers === 'object' && !Array.isArray(source.providers)
    ? source.providers as Record<string, unknown>
    : {}
  const rawPriorities = source.priorities && typeof source.priorities === 'object' && !Array.isArray(source.priorities)
    ? source.priorities as Record<string, unknown>
    : {}
  if (Object.keys(rawProviders).some(key => !isProviderId(key))) throw new Error('AI 能力配置包含未知供应商')
  if (Object.keys(rawPriorities).some(key => !isAiCapability(key))) throw new Error('AI 能力配置包含未知能力')

  const result = createEmptyCapabilityConfig()
  for (const providerId of PROVIDER_IDS) {
    const rawPool = rawProviders[providerId]
    const rawModels = rawPool && typeof rawPool === 'object' && !Array.isArray(rawPool)
      ? (rawPool as { models?: unknown }).models
      : []
    if (!Array.isArray(rawModels)) throw new Error(`${providerId} 模型池必须是数组`)
    const models = rawModels.map(normalizeCapabilityModel).filter((model): model is CapabilityModel => !!model)
    if (models.length !== rawModels.length) throw new Error(`${providerId} 模型池包含无效模型`)
    const ids = new Set<string>()
    for (const model of models) {
      if (ids.has(model.id)) throw new Error(`${providerId} 模型池包含重复模型: ${model.id}`)
      ids.add(model.id)
    }
    result.providers[providerId] = { models }
  }

  for (const capability of AI_CAPABILITIES) {
    const chain = rawPriorities[capability] ?? []
    if (!Array.isArray(chain)) throw new Error(`${capability} 优先级必须是数组`)
    const seen = new Set<string>()
    result.priorities[capability] = chain.map((rawStep, index): CapabilityPriorityStep => {
      if (!rawStep || typeof rawStep !== 'object' || Array.isArray(rawStep)) throw new Error(`${capability} 第 ${index + 1} 步必须是对象`)
      const provider = String((rawStep as { provider?: unknown }).provider || '').trim()
      const model = String((rawStep as { model?: unknown }).model || '').trim()
      if (!isProviderId(provider) || !model) throw new Error(`${capability} 第 ${index + 1} 步缺少有效供应商或模型`)
      const poolModel = result.providers[provider].models.find(item => item.id === model)
      if (!poolModel) throw new Error(`${capability} 第 ${index + 1} 步引用模型池外模型: ${provider}/${model}`)
      if (!poolModel.capabilities.includes(capability)) throw new Error(`${provider}/${model} 不支持 ${capability}`)
      const key = `${provider}\u0000${model}`
      if (seen.has(key)) throw new Error(`${capability} 优先级包含重复模型: ${provider}/${model}`)
      seen.add(key)
      return { provider, model }
    })
  }
  return result
}

// 将已验证的发现结果规范为唯一模型池顺序。
function normalizeDiscoveredModels(models: unknown): CapabilityModel[] {
  if (!Array.isArray(models)) throw new Error('发现结果必须是模型数组')
  const result: CapabilityModel[] = []
  const seen = new Set<string>()
  for (const raw of models) {
    const model = normalizeCapabilityModel(raw)
    if (!model) throw new Error('发现结果包含无效模型')
    if (seen.has(model.id)) continue
    seen.add(model.id)
    result.push(model)
  }
  return result
}

// --- 文件与旧链迁移 ---

// 安全读取受大小上限保护的 JSON 文件。
function readJsonFile<T>(filePath: string, fallback: T, maxBytes = MAX_CAPABILITY_CONFIG_BYTES): T {
  try {
    const stat = fs.statSync(filePath)
    if (!stat.isFile() || stat.size > maxBytes) return fallback
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T
  } catch {
    return fallback
  }
}

// 读取固定供应商 Key；只返回内存字符串，不记录文件内容。
function readProviderKey(providerId: ProviderId): string {
  const filePath = path.join(DATA_DIR, PROVIDER_CATALOG[providerId].keyFile)
  try {
    const stat = fs.statSync(filePath)
    if (!stat.isFile() || stat.size > MAX_KEY_BYTES) return ''
    return String(fs.readFileSync(filePath, 'utf8') || '').trim().replace(/[\r\n]+/g, '')
  } catch {
    return ''
  }
}

// 仅报告固定供应商 Key 是否已保存，不暴露明文。
function isProviderKeyConfigured(providerId: ProviderId): boolean {
  return !!readProviderKey(providerId)
}

// 返回脱敏 Key 状态，前缀只用于管理员确认当前保存槽位。
function getProviderKeyStatus(providerId: ProviderId): { configured: boolean; prefix: string } {
  const key = readProviderKey(providerId)
  return { configured: !!key, prefix: key ? `${key.slice(0, 6)}****` : '' }
}

// 从旧 chat/vision/lightweight 三链构建幂等四能力配置，不写文件。
function buildLegacyMigration(): MigrationResult {
  const raw = readJsonFile<Record<string, unknown>>(FALLBACK_CHAINS_FILE, {})
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) && raw.chains && typeof raw.chains === 'object'
    ? raw.chains as Record<string, unknown>
    : raw
  const config = createEmptyCapabilityConfig()
  const diagnostics: string[] = []
  const pools = new Map<ProviderId, Map<string, CapabilityModel>>()
  for (const providerId of PROVIDER_IDS) pools.set(providerId, new Map())

  const readLegacyChain = (key: 'chat' | 'vision' | 'lightweight'): LegacyFallbackStep[] => {
    const chain = source && Array.isArray(source[key]) ? source[key] : LEGACY_DEFAULT_CHAINS[key]
    return chain as LegacyFallbackStep[]
  }
  const mergeChain = (target: AiCapability, steps: LegacyFallbackStep[]): void => {
    const seen = new Set(config.priorities[target].map(step => `${step.provider}\u0000${step.model}`))
    for (const rawStep of steps) {
      const provider = String(rawStep?.provider || '').trim()
      const model = String(rawStep?.model || '').trim()
      if (!isProviderId(provider) || !model) {
        diagnostics.push(`${target}: 已移除无法解析的旧步骤`)
        continue
      }
      const capabilities = getVerifiedModelCapabilities(provider, model)
      if (!capabilities.includes(target)) {
        diagnostics.push(`${target}: 已移除能力不匹配的 ${provider}/${model}`)
        continue
      }
      if (!isProviderKeyConfigured(provider)) {
        diagnostics.push(`${target}: 已移除未配置密钥的 ${provider}/${model}`)
        continue
      }
      const dedupeKey = `${provider}\u0000${model}`
      if (seen.has(dedupeKey)) continue
      seen.add(dedupeKey)
      const modelRecord = { id: model, name: model, capabilities }
      pools.get(provider)?.set(model, modelRecord)
      config.priorities[target].push({ provider, model })
    }
  }

  mergeChain('text', readLegacyChain('chat'))
  mergeChain('text', readLegacyChain('lightweight'))
  mergeChain('vision', readLegacyChain('vision'))
  for (const providerId of PROVIDER_IDS) config.providers[providerId].models = [...(pools.get(providerId)?.values() || [])]
  return { config: normalizeCapabilityConfig(config), diagnostics, migrated: true }
}

// 读取最新配置；文件缺失时只在内存中执行旧链迁移。
function loadCapabilityConfigSync(): MigrationResult {
  if (!fs.existsSync(CAPABILITY_CONFIG_FILE)) return buildLegacyMigration()
  const raw = readJsonFile<unknown>(CAPABILITY_CONFIG_FILE, null)
  if (raw === null) throw new Error('AI 能力配置无法读取或超过大小限制')
  return { config: normalizeCapabilityConfig(raw), diagnostics: [], migrated: false }
}

// 序列化前再次执行完整校验，保证事务写入的是规范配置。
function serializeCapabilityConfig(config: CapabilityConfig): Buffer {
  return Buffer.from(JSON.stringify(normalizeCapabilityConfig(config), null, 2), 'utf8')
}

// --- 模型池与优先级更新 ---

// 用新发现池覆盖一个供应商，并同步清理四能力中的悬空引用。
function replaceProviderModels(current: CapabilityConfig, providerId: unknown, discovered: unknown): ReplaceModelsResult {
  if (!isProviderId(providerId)) throw new Error('未知供应商')
  const config = normalizeCapabilityConfig(current)
  const models = normalizeDiscoveredModels(discovered)
  if (!models.length) throw new Error('发现结果没有可导入模型')
  const previousIds = new Set(config.providers[providerId].models.map(model => model.id))
  const nextIds = new Set(models.map(model => model.id))
  const removedModels = [...previousIds].filter(id => !nextIds.has(id)).length
  config.providers[providerId] = { models }
  let removedSteps = 0
  for (const capability of AI_CAPABILITIES) {
    const before = config.priorities[capability]
    config.priorities[capability] = before.filter(step => {
      if (step.provider !== providerId) return true
      const model = models.find(item => item.id === step.model)
      return !!model?.capabilities.includes(capability)
    })
    removedSteps += before.length - config.priorities[capability].length
  }
  const validated = normalizeCapabilityConfig(config)
  const emptyCapabilities = AI_CAPABILITIES.filter(capability => validated.priorities[capability].length === 0)
  return { config: validated, removedModels, removedSteps, emptyCapabilities }
}

// 独立保存一个能力的有序优先级，并校验模型池、能力和已保存密钥。
function replaceCapabilityPriority(current: CapabilityConfig, capability: unknown, steps: unknown): CapabilityConfig {
  if (!isAiCapability(capability)) throw new Error('未知能力')
  if (!Array.isArray(steps)) throw new Error('模型优先级必须是数组')
  const config = normalizeCapabilityConfig(current)
  config.priorities[capability] = steps.map((rawStep, index): CapabilityPriorityStep => {
    if (!rawStep || typeof rawStep !== 'object' || Array.isArray(rawStep)) throw new Error(`第 ${index + 1} 步必须是对象`)
    const provider = String((rawStep as { provider?: unknown }).provider || '').trim()
    const model = String((rawStep as { model?: unknown }).model || '').trim()
    if (!isProviderId(provider) || !model) throw new Error(`第 ${index + 1} 步缺少有效供应商或模型`)
    if (!isProviderKeyConfigured(provider)) throw new Error(`${PROVIDER_CATALOG[provider].name} 尚未保存 API Key`)
    return { provider, model }
  })
  return normalizeCapabilityConfig(config)
}

// --- Dashboard 与运行时视图 ---

// 返回不含 URL、Key 文件名和密钥的前端供应商目录。
function getPublicProviderCatalog(): Array<Record<string, unknown>> {
  return PROVIDER_IDS.map(providerId => {
    const provider = PROVIDER_CATALOG[providerId]
    const supported = new Set<AiCapability>()
    for (const capabilities of Object.values(VERIFIED_MODEL_CAPABILITIES[providerId] || {})) {
      for (const capability of capabilities) supported.add(capability)
    }
    return {
      id: provider.id,
      name: provider.name,
      discoveryAvailable: provider.discoveryProtocol !== 'blocked',
      discoveryReason: provider.discoveryReason || '',
      documentationURL: provider.documentationURL,
      supportedCapabilities: AI_CAPABILITIES.filter(capability => supported.has(capability)),
    }
  })
}

// 返回统一页面需要的脱敏模型池、优先级和 Key 状态。
function getPublicCapabilityConfig(config: CapabilityConfig): Record<string, unknown> {
  const normalized = normalizeCapabilityConfig(config)
  const providers = {} as Record<string, unknown>
  for (const providerId of PROVIDER_IDS) {
    providers[providerId] = {
      models: normalized.providers[providerId].models,
      key: getProviderKeyStatus(providerId),
    }
  }
  return { version: normalized.version, capabilities: AI_CAPABILITIES, providers, priorities: normalized.priorities }
}

// 将某能力的优先级解析为可直接调用的运行时配置；缺 Key 的步骤不会进入调用链。
function resolveCapabilityRuntimeSteps(capability: unknown): RuntimeCapabilityStep[] {
  if (!isAiCapability(capability)) throw new Error('未知能力')
  const { config } = loadCapabilityConfigSync()
  const result: RuntimeCapabilityStep[] = []
  for (let index = 0; index < config.priorities[capability].length; index += 1) {
    const step = config.priorities[capability][index]
    const provider = PROVIDER_CATALOG[step.provider]
    const apiKey = readProviderKey(step.provider)
    if (!apiKey) continue
    result.push({
      capability,
      provider: step.provider,
      providerName: provider.name,
      model: step.model,
      apiKey,
      baseURL: provider.baseURL,
      chatProtocol: provider.chatProtocol,
      priorityIndex: index,
    })
  }
  return result
}

// 返回服务端内部供应商定义，调用方不得把结果原样发给前端。
function getProviderCatalogEntry(providerId: unknown): ProviderCatalogEntry | null {
  return isProviderId(providerId) ? PROVIDER_CATALOG[providerId] : null
}

export = {
  AI_CAPABILITIES,
  CAPABILITY_CONFIG_FILE,
  PROVIDER_IDS,
  isAiCapability,
  isProviderId,
  getVerifiedModelCapabilities,
  createEmptyCapabilityConfig,
  normalizeCapabilityConfig,
  normalizeDiscoveredModels,
  buildLegacyMigration,
  loadCapabilityConfigSync,
  serializeCapabilityConfig,
  replaceProviderModels,
  replaceCapabilityPriority,
  getPublicProviderCatalog,
  getPublicCapabilityConfig,
  getProviderCatalogEntry,
  getProviderKeyStatus,
  isProviderKeyConfigured,
  resolveCapabilityRuntimeSteps,
}
