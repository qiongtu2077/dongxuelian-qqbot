import type { CustomProvider, FallbackChains, ProviderModel } from '../types'

export type FallbackKey = 'chat' | 'vision' | 'lightweight'

export interface FallbackCard {
  key: FallbackKey
  label: string
}

export interface ProviderDraft {
  id: string
  name: string
  baseURL: string
  keyFile: string
  apiKey: string
  models: Array<ProviderModel & { name?: string }>
}

export interface ProviderTransactionModel {
  error: string
  provider: CustomProvider
  providers: CustomProvider[]
  chains: FallbackChains
  keyValue?: string
}

export const FALLBACK_CARDS: FallbackCard[] = [
  { key: 'chat', label: '聊天优先级' },
  { key: 'vision', label: '视觉优先级' },
  { key: 'lightweight', label: '轻量任务优先级' },
]

// Creates the initial custom-provider editor model.
export function createProviderDraft(): ProviderDraft {
  return {
    id: 'openai-official',
    name: 'OpenAI 官方',
    baseURL: 'https://api.openai.com/v1',
    keyFile: 'ai-openai-official-key.txt',
    apiKey: '',
    models: [
      { id: 'gpt-4o', name: 'GPT-4o', vision: true },
      { id: 'gpt-4o-mini', name: 'GPT-4o mini', vision: true },
    ],
  }
}

// Picks a suitable model when appending one provider to a fallback queue.
export function pickProviderModelForQueue(provider: CustomProvider, key: FallbackKey): string {
  const models = Array.isArray(provider.models) ? provider.models : []
  if (key === 'vision') return (models.find(model => model.vision) || models[0])?.id || ''
  if (key === 'lightweight') return (models.find(model => /(?:mini|flash|lite|turbo|small)/i.test(model.id || model.name || '')) || models[0])?.id || ''
  return models[0]?.id || ''
}

// Appends a new provider to every fallback chain without duplicating existing steps.
export function appendProviderToFallbackTail(chains: FallbackChains, provider: CustomProvider): FallbackChains {
  const next: FallbackChains = { ...chains }
  for (const card of FALLBACK_CARDS) {
    const list = [...(next[card.key] || [])]
    if (list.some(step => step.provider === provider.id)) {
      next[card.key] = list
      continue
    }
    const model = pickProviderModelForQueue(provider, card.key)
    if (model) list.push({ provider: provider.id, model, keyFile: provider.keyFile || '' })
    next[card.key] = list
  }
  return next
}

// Normalizes the provider editor into the backend DTO.
export function normalizeProviderDraft(draft: ProviderDraft): CustomProvider {
  return {
    id: String(draft.id || '').trim(),
    name: String(draft.name || '').trim(),
    baseURL: String(draft.baseURL || '').trim(),
    keyFile: String(draft.keyFile || '').trim(),
    models: draft.models.map(model => ({
      id: String(model.id || '').trim(),
      name: String(model.name || '').trim() || undefined,
      vision: !!model.vision,
    })).filter(model => model.id),
  }
}

// Builds and validates the complete provider/key/fallback transaction before any API call.
export function buildProviderTransaction(draft: ProviderDraft, currentProviders: CustomProvider[], currentChains: FallbackChains): ProviderTransactionModel {
  const provider = normalizeProviderDraft(draft)
  const isComplete = provider.id && provider.name && provider.baseURL && provider.keyFile && provider.models.length
  if (!isComplete) {
    return { error: '供应商、Base URL、Key 文件和模型不能为空', provider, providers: currentProviders, chains: currentChains }
  }
  const isNewProvider = !currentProviders.some(item => item.id === provider.id)
  const providers = [...currentProviders.filter(item => item.id !== provider.id), provider]
  const chains = isNewProvider ? appendProviderToFallbackTail(currentChains, provider) : currentChains
  const keyValue = draft.apiKey.trim() || undefined
  return { error: '', provider, providers, chains, keyValue }
}
