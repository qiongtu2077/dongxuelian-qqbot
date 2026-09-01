import capabilityContract from '../../../../koishi-plugin-dongxuelian-ai/src/public/ai-capability-contract.json'

export const AI_CAPABILITY_IDS = Object.freeze([...capabilityContract.capabilities])
export type AiCapability = 'text' | 'vision' | 'voice-asr' | 'voice-tts'

export interface AiCapabilityModel {
  id: string
  name: string
  capabilities: AiCapability[]
}

export interface AiPriorityStep {
  provider: string
  model: string
}

export interface AiProviderCatalogItem {
  id: string
  name: string
  discoveryAvailable: boolean
  discoveryReason: string
  documentationURL: string
  supportedCapabilities: AiCapability[]
}

export interface AiProviderState {
  models: AiCapabilityModel[]
  key: {
    configured: boolean
    prefix: string
  }
}

export interface AiCapabilityConfigView {
  version: number
  capabilities: AiCapability[]
  providers: Record<string, AiProviderState>
  priorities: Record<AiCapability, AiPriorityStep[]>
}

export interface AiModelApiConfigResponse {
  ok: boolean
  message?: string
  code?: string
  catalog: AiProviderCatalogItem[]
  config: AiCapabilityConfigView
  migration?: {
    applied: boolean
    diagnostics: string[]
  }
}

export interface AiDiscoveryResponse {
  ok: boolean
  message: string
  code?: string
  config?: AiCapabilityConfigView
  models?: Array<AiCapabilityModel & { importable?: boolean; unavailableReason?: string }>
  removedModels?: number
  removedSteps?: number
  emptyCapabilities?: AiCapability[]
}

export interface AiPriorityResponse {
  ok: boolean
  message: string
  code?: string
  config?: AiCapabilityConfigView
}

export interface CapabilityUsageRow {
  key: string
  label: string
  provider?: string
  total: number
  requests: number
  input: number
  output: number
  cacheCreation: number
  cacheRead: number
  readableRequests: number
  unreadableRequests: number
}

export interface CapabilityUsageDay extends CapabilityUsageRow {
  date: string
  providers: Record<string, CapabilityUsageRow>
  models: Record<string, CapabilityUsageRow>
}

export interface CapabilityUsageResponse {
  ok?: boolean
  message?: string
  capability: AiCapability
  days: CapabilityUsageDay[]
  providers: CapabilityUsageRow[]
  models: CapabilityUsageRow[]
  readable: boolean
  unavailable: boolean
}

// 判断服务端返回的能力是否来自共享契约。
export function isAiCapability(value: unknown): value is AiCapability {
  return typeof value === 'string' && AI_CAPABILITY_IDS.includes(value)
}

// 深拷贝四条优先级，保证 KeepAlive 页面中的未保存编辑不会改写服务端快照。
export function cloneCapabilityPriorities(source: AiCapabilityConfigView['priorities']): AiCapabilityConfigView['priorities'] {
  const result = {} as AiCapabilityConfigView['priorities']
  for (const capability of AI_CAPABILITY_IDS) {
    if (!isAiCapability(capability)) continue
    result[capability] = (source[capability] || []).map(step => ({ provider: step.provider, model: step.model }))
  }
  return result
}

// 只返回当前能力兼容且供应商已有保存 Key 的模型。
export function listAvailableCapabilityModels(config: AiCapabilityConfigView, capability: AiCapability): Array<AiPriorityStep & { name: string }> {
  const result: Array<AiPriorityStep & { name: string }> = []
  for (const [provider, state] of Object.entries(config.providers || {})) {
    if (!state.key?.configured) continue
    for (const model of state.models || []) {
      if (model.capabilities.includes(capability)) result.push({ provider, model: model.id, name: model.name || model.id })
    }
  }
  return result
}
