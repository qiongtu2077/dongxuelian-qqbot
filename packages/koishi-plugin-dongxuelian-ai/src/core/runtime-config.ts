/**
 * MODULE: 运行时配置读取。
 * 职责: 提供 provider/model/baseURL/apiKey/thinking 等运行时配置的统一入口。
 * 边界: 只读配置，不含业务逻辑。业务模块通过此文件获取配置，不直接 require constants.js 中的路径常量。
 */
const {
  KEY_FILE, MODEL_FILE, BASE_URL_FILE,
  SEARCH_ENABLED_FILE,
  ADMIN_IDS_FILE,
  PROVIDERS, PROVIDER_FILE, DEEPSEEK_KEY_FILE, DASHSCOPE_KEY_FILE, GLM_KEY_FILE, MIMORIUM_KEY_FILE,
} = require('./constants') as typeof import('./constants')
const fs = require('fs')
const fsp = require('fs/promises')

interface RuntimeConfig {
  apiKey: string
  model: string
  baseURL: string
  searchEnabled: boolean
  provider: string
  _originalConfig?: Pick<RuntimeConfig, 'model' | 'provider' | 'baseURL' | 'apiKey'>
  _fallbackTried?: number
  _isOriginalRetry?: boolean
}

type ThinkingArgs = Record<string, unknown>

let configCache: RuntimeConfig | null = null
let adminUserIdsCache: Set<string> | null = null
let thinkingEnabled = false

const DEFAULT_ADMIN_USER_IDS = process.env.DONGXUELIAN_DEFAULT_ADMIN_IDS
  ? process.env.DONGXUELIAN_DEFAULT_ADMIN_IDS.split(',').map(s => s.trim()).filter(Boolean)
  : []
const MAX_RUNTIME_TEXT_BYTES = 64 * 1024
const MAX_ADMIN_IDS_BYTES = 128 * 1024

async function readRuntimeTextFile(file: string): Promise<string> {
  try {
    const stat = await fsp.stat(file)
    if (!stat.isFile() || stat.size > MAX_RUNTIME_TEXT_BYTES) return ''
    return (await fsp.readFile(file, 'utf8')).trim()
  } catch { return '' }
}

function parseRuntimeEnabledText(value: string = ''): boolean {
  return /^(?:1|true|on|yes|\u5f00|\u5f00\u542f)$/i.test(String(value).trim())
}

function getRuntimeBaseHostname(baseURL: string = ''): string {
  try { return new URL(String(baseURL || '')).hostname.toLowerCase() } catch { return '' }
}

function isRuntimeDashScopeConfig(config: Partial<RuntimeConfig> = {}): boolean {
  const hostname = getRuntimeBaseHostname(config.baseURL)
  return hostname.includes('dashscope') || hostname.endsWith('aliyuncs.com')
}

function readAdminUserIdsFile(): Set<string> | null {
  try {
    const stat = fs.statSync(ADMIN_IDS_FILE)
    if (!stat.isFile() || stat.size > MAX_ADMIN_IDS_BYTES) return null
    const parsed = JSON.parse(fs.readFileSync(ADMIN_IDS_FILE, 'utf8'))
    if (!Array.isArray(parsed)) return null
    const ids = parsed
      .map(value => value === null || value === undefined ? '' : String(value).trim())
      .filter(Boolean)
    return ids.length ? new Set(ids) : null
  } catch {
    return null
  }
}

function getAdminUserIds(force: boolean = false): Set<string> {
  if (adminUserIdsCache && !force) return adminUserIdsCache
  adminUserIdsCache = readAdminUserIdsFile() || new Set(DEFAULT_ADMIN_USER_IDS)
  if (adminUserIdsCache.size === 0 && !(getAdminUserIds as { _warned?: boolean })._warned) {
    ;(getAdminUserIds as { _warned?: boolean })._warned = true
    console.warn('[runtime-config] 警告：未配置管理员 ID。请创建 data/ai-admin-ids.json 或设置环境变量 DONGXUELIAN_DEFAULT_ADMIN_IDS')
  }
  return adminUserIdsCache
}

function isAdminUserId(userId: string): boolean {
  return getAdminUserIds().has(String(userId || '').trim())
}

function getThinkingArgs(config: RuntimeConfig): ThinkingArgs {
  if (!thinkingEnabled) {
    if (isRuntimeDashScopeConfig(config)) return { enable_thinking: false }
    if (/glm|mimo|kimi/i.test(config.model || '')) return { thinking: { type: 'disabled' } }
    if (/deepseek/i.test(config.model || '')) return { enable_thinking: false }
    return {}
  }
  if (isRuntimeDashScopeConfig(config)) return { enable_thinking: true }
  if (/glm|mimo|kimi/i.test(config.model || '')) return { thinking: { type: 'enabled' } }
  return {}
}

async function loadConfig(force: boolean = false): Promise<RuntimeConfig> {
  if (configCache && !force) return configCache

  const [apiKey, model, baseURL, searchEnabledText, provider, deepseekKey, dashscopeKey, glmKey, mimoriumKey] = await Promise.all([
    readRuntimeTextFile(KEY_FILE),
    readRuntimeTextFile(MODEL_FILE),
    readRuntimeTextFile(BASE_URL_FILE),
    readRuntimeTextFile(SEARCH_ENABLED_FILE),
    readRuntimeTextFile(PROVIDER_FILE),
    readRuntimeTextFile(DEEPSEEK_KEY_FILE),
    readRuntimeTextFile(DASHSCOPE_KEY_FILE).catch(() => ''),
    readRuntimeTextFile(GLM_KEY_FILE).catch(() => ''),
    readRuntimeTextFile(MIMORIUM_KEY_FILE).catch(() => ''),
  ])

  const activeProvider = provider || 'opencode'
  const providerDef = PROVIDERS[activeProvider]
  const resolvedBaseURL = (providerDef ? providerDef.baseURL : baseURL || 'https://api.openai.com/v1').replace(/\/+$/, '')
  const resolvedApiKey = activeProvider === 'deepseek'
    ? (deepseekKey || apiKey).replace(/[\r\n]+/g, '')
    : activeProvider === 'dashscope'
    ? (dashscopeKey || apiKey).replace(/[\r\n]+/g, '')
    : activeProvider === 'glm'
    ? (glmKey || apiKey).replace(/[\r\n]+/g, '')
    : activeProvider === 'mimorium'
    ? (mimoriumKey || apiKey).replace(/[\r\n]+/g, '')
    : apiKey.replace(/[\r\n]+/g, '')

  configCache = {
    apiKey: resolvedApiKey,
    model: model || (providerDef ? providerDef.models[0].id : 'gpt-4o-mini'),
    baseURL: resolvedBaseURL,
    searchEnabled: parseRuntimeEnabledText(searchEnabledText),
    provider: activeProvider,
  }

  return configCache
}

function resetConfigCache(): void {
  configCache = null
  adminUserIdsCache = null
}

function getThinkingEnabled(): boolean {
  return thinkingEnabled
}

function setThinkingEnabled(value: boolean): void {
  thinkingEnabled = !!value
}

export = {
  loadConfig,
  resetConfigCache,
  getThinkingArgs,
  getAdminUserIds,
  isAdminUserId,
  getThinkingEnabled,
  setThinkingEnabled,
}
