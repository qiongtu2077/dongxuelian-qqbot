/**
 * MODULE: provider 注册表与自定义 provider 解析。
 * 职责: 统一读取内置 provider、自定义 provider，以及按 provider 解析 baseURL/models/keyFile。
 * 边界: 只读 provider 定义与 key 文件，不缓存运行时主配置。
 */
const {
  PROVIDERS,
  DATA_DIR,
  CUSTOM_PROVIDERS_FILE,
  KEY_FILE,
  DEEPSEEK_KEY_FILE,
  DASHSCOPE_KEY_FILE,
  GLM_KEY_FILE,
  MIMORIUM_KEY_FILE,
} = require('./constants') as typeof import('./constants')
const fs = require('fs') as typeof import('fs')
const fsp = require('fs/promises') as typeof import('fs/promises')
const path = require('path') as typeof import('path')

interface ProviderModel {
  id: string
  name?: string
  vision?: boolean
}

interface ProviderDefinitionLike {
  name: string
  baseURL: string
  models: ProviderModel[]
}

interface CustomProviderRecord {
  id: string
  name: string
  baseURL: string
  keyFile?: string
  models: ProviderModel[]
}

interface ResolvedProviderDefinition extends ProviderDefinitionLike {
  id: string
  keyFile?: string
  custom: boolean
}

type ProviderRegistryMap = Record<string, ResolvedProviderDefinition>

interface KeyFileMap {
  default: string
  opencode: string
  deepseek: string
  dashscope: string
  glm: string
  mimorium: string
}

interface ResolveProviderKeyOptions {
  allowFallback?: boolean
}

const BUILTIN_PROVIDER_KEY_FILES: KeyFileMap = {
  default: KEY_FILE,
  opencode: KEY_FILE,
  deepseek: DEEPSEEK_KEY_FILE,
  dashscope: DASHSCOPE_KEY_FILE,
  glm: GLM_KEY_FILE,
  mimorium: MIMORIUM_KEY_FILE,
}
const MAX_PROVIDER_CONFIG_BYTES = 256 * 1024
const MAX_PROVIDER_KEY_BYTES = 64 * 1024

function normalizeProviderModel(model: unknown): ProviderModel | null {
  if (typeof model === 'string') {
    const id = String(model).trim()
    return id ? { id, name: id, vision: false } : null
  }
  if (!model || typeof model !== 'object') return null
  const candidate = model as { id?: unknown; name?: unknown; vision?: unknown }
  const id = String(candidate.id || '').trim()
  if (!id) return null
  const name = String(candidate.name || '').trim()
  return {
    id,
    name: name || id,
    vision: !!candidate.vision,
  }
}

function normalizeCustomProvider(provider: unknown): CustomProviderRecord | null {
  if (!provider || typeof provider !== 'object') return null
  const candidate = provider as {
    id?: unknown
    name?: unknown
    baseURL?: unknown
    keyFile?: unknown
    models?: unknown
  }
  const id = String(candidate.id || '').trim()
  const name = String(candidate.name || '').trim()
  const baseURL = String(candidate.baseURL || '').trim().replace(/\/+$/, '')
  if (!id || !name || !baseURL) return null
  const models = Array.isArray(candidate.models)
    ? candidate.models.map(normalizeProviderModel).filter(Boolean) as ProviderModel[]
    : []
  const keyFile = String(candidate.keyFile || '').trim()
  return {
    id,
    name,
    baseURL,
    keyFile: keyFile || undefined,
    models,
  }
}

async function readCustomProviders(): Promise<CustomProviderRecord[]> {
  const data = await readJsonFileDirect(CUSTOM_PROVIDERS_FILE, [])
  return Array.isArray(data) ? data.map(normalizeCustomProvider).filter(Boolean) as CustomProviderRecord[] : []
}

function readCustomProvidersSync(): CustomProviderRecord[] {
  const data = readJsonFileDirectSync(CUSTOM_PROVIDERS_FILE, [])
  return Array.isArray(data) ? data.map(normalizeCustomProvider).filter(Boolean) as CustomProviderRecord[] : []
}

async function getMergedProviderMap(): Promise<ProviderRegistryMap> {
  const merged = buildBuiltinProviderMap()
  const customProviders = await readCustomProviders()
  for (const provider of customProviders) {
    merged[provider.id] = {
      id: provider.id,
      name: provider.name,
      baseURL: provider.baseURL,
      models: provider.models,
      keyFile: provider.keyFile,
      custom: true,
    }
  }
  return merged
}

function getMergedProviderMapSync(): ProviderRegistryMap {
  const merged = buildBuiltinProviderMap()
  const customProviders = readCustomProvidersSync()
  for (const provider of customProviders) {
    merged[provider.id] = {
      id: provider.id,
      name: provider.name,
      baseURL: provider.baseURL,
      models: provider.models,
      keyFile: provider.keyFile,
      custom: true,
    }
  }
  return merged
}

function buildBuiltinProviderMap(): ProviderRegistryMap {
  const merged = {} as ProviderRegistryMap
  for (const [id, provider] of Object.entries(PROVIDERS)) {
    merged[id] = {
      id,
      name: provider.name,
      baseURL: String(provider.baseURL || '').replace(/\/+$/, ''),
      models: Array.isArray(provider.models) ? provider.models.map(model => ({
        id: String(model.id || '').trim(),
        name: String(model.name || model.id || '').trim(),
        vision: !!model.vision,
      })) : [],
      keyFile: getBuiltinProviderKeyFile(id),
      custom: false,
    }
  }
  return merged
}

function getBuiltinProviderKeyFile(providerId: string): string {
  return BUILTIN_PROVIDER_KEY_FILES[providerId as keyof KeyFileMap] || BUILTIN_PROVIDER_KEY_FILES.default
}

function resolveProviderKeyFile(file: string): string {
  const value = String(file || '').trim()
  if (!value) return ''
  return path.isAbsolute(value) ? value : path.join(DATA_DIR, value)
}

async function resolveProviderDefinition(providerId: string): Promise<ResolvedProviderDefinition | null> {
  const merged = await getMergedProviderMap()
  return merged[String(providerId || '').trim()] || null
}

function resolveProviderDefinitionSync(providerId: string): ResolvedProviderDefinition | null {
  const merged = getMergedProviderMapSync()
  return merged[String(providerId || '').trim()] || null
}

async function resolveProviderApiKey(providerId: string, fallbackKey: string, options: ResolveProviderKeyOptions = {}): Promise<string> {
  const provider = await resolveProviderDefinition(providerId)
  const fallback = options.allowFallback === false ? '' : String(fallbackKey || '')
  if (!provider || !provider.keyFile) return fallback.replace(/[\r\n]+/g, '')
  const keyFile = resolveProviderKeyFile(provider.keyFile)
  return ((await readTextFileDirect(keyFile).catch(() => '')) || fallback).replace(/[\r\n]+/g, '')
}

function resolveProviderApiKeySync(providerId: string, fallbackKey: string, options: ResolveProviderKeyOptions = {}): string {
  const provider = resolveProviderDefinitionSync(providerId)
  const fallback = options.allowFallback === false ? '' : String(fallbackKey || '')
  if (!provider || !provider.keyFile) return fallback.replace(/[\r\n]+/g, '')
  const keyFile = resolveProviderKeyFile(provider.keyFile)
  return ((readTextFileDirectSync(keyFile)) || fallback).replace(/[\r\n]+/g, '')
}

async function readJsonFileDirect<T>(file: string, fallback: T): Promise<T> {
  try {
    const stat = await fsp.stat(file)
    if (!stat.isFile() || stat.size > MAX_PROVIDER_CONFIG_BYTES) return fallback
    return JSON.parse(await fsp.readFile(file, 'utf8'))
  } catch {
    return fallback
  }
}

function readJsonFileDirectSync<T>(file: string, fallback: T): T {
  try {
    const stat = fs.statSync(file)
    if (!stat.isFile() || stat.size > MAX_PROVIDER_CONFIG_BYTES) return fallback
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}

async function readTextFileDirect(file: string): Promise<string> {
  try {
    const stat = await fsp.stat(file)
    if (!stat.isFile() || stat.size > MAX_PROVIDER_KEY_BYTES) return ''
    return String(await fsp.readFile(file, 'utf8')).trim()
  } catch {
    return ''
  }
}

function readTextFileDirectSync(file: string): string {
  try {
    const stat = fs.statSync(file)
    if (!stat.isFile() || stat.size > MAX_PROVIDER_KEY_BYTES) return ''
    return String(fs.readFileSync(file, 'utf8') || '').trim()
  } catch {
    return ''
  }
}

export = {
  readCustomProviders,
  readCustomProvidersSync,
  getMergedProviderMap,
  getMergedProviderMapSync,
  resolveProviderDefinition,
  resolveProviderDefinitionSync,
  resolveProviderApiKey,
  resolveProviderApiKeySync,
  resolveProviderKeyFile,
  getBuiltinProviderKeyFile,
}
