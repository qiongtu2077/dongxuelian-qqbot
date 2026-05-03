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
} = require('./constants')
const fs = require('fs')
const fsp = require('fs/promises')

let configCache = null
let adminUserIdsCache = null
let thinkingEnabled = false

const DEFAULT_ADMIN_USER_IDS = ['100000000', '200000000']

async function readRuntimeTextFile(file) {
  try { return (await fsp.readFile(file, 'utf8')).trim() } catch { return '' }
}

function parseRuntimeEnabledText(value = '') {
  return /^(?:1|true|on|yes|\u5f00|\u5f00\u542f)$/i.test(String(value).trim())
}

function getRuntimeBaseHostname(baseURL = '') {
  try { return new URL(String(baseURL || '')).hostname.toLowerCase() } catch { return '' }
}

function isRuntimeDashScopeConfig(config = {}) {
  const hostname = getRuntimeBaseHostname(config.baseURL)
  return hostname.includes('dashscope') || hostname.endsWith('aliyuncs.com')
}

function readAdminUserIdsFile() {
  try {
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

function getAdminUserIds(force = false) {
  if (adminUserIdsCache && !force) return adminUserIdsCache
  adminUserIdsCache = readAdminUserIdsFile() || new Set(DEFAULT_ADMIN_USER_IDS)
  return adminUserIdsCache
}

function isAdminUserId(userId) {
  return getAdminUserIds().has(String(userId || '').trim())
}

function getThinkingArgs(config) {
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

async function loadConfig(force = false) {
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

function resetConfigCache() {
  configCache = null
  adminUserIdsCache = null
}

function getThinkingEnabled() {
  return thinkingEnabled
}

function setThinkingEnabled(value) {
  thinkingEnabled = !!value
}

module.exports = {
  loadConfig,
  resetConfigCache,
  getThinkingArgs,
  getAdminUserIds,
  isAdminUserId,
  getThinkingEnabled,
  setThinkingEnabled,
}
