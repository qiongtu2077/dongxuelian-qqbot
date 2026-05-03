/**
 * MODULE: 运行时配置读取。
 * 职责: 提供 provider/model/baseURL/apiKey/thinking 等运行时配置的统一入口。
 * 边界: 只读配置，不含业务逻辑。业务模块通过此文件获取配置，不直接 require constants.js 中的路径常量。
 */
const {
  KEY_FILE, MODEL_FILE, BASE_URL_FILE,
  SEARCH_ENABLED_FILE,
  PROVIDERS, PROVIDER_FILE, DEEPSEEK_KEY_FILE, DASHSCOPE_KEY_FILE, GLM_KEY_FILE, MIMORIUM_KEY_FILE,
} = require('./constants')
const {
  readTextFile,
  parseEnabledText,
  isDashScopeConfig,
} = require('./utils')

let configCache = null
let thinkingEnabled = false

function getThinkingArgs(config) {
  if (!thinkingEnabled) {
    if (isDashScopeConfig(config)) return { enable_thinking: false }
    if (/glm|mimo|kimi/i.test(config.model || '')) return { thinking: { type: 'disabled' } }
    if (/deepseek/i.test(config.model || '')) return { enable_thinking: false }
    return {}
  }
  if (isDashScopeConfig(config)) return { enable_thinking: true }
  if (/glm|mimo|kimi/i.test(config.model || '')) return { thinking: { type: 'enabled' } }
  return {}
}

async function loadConfig(force = false) {
  if (configCache && !force) return configCache

  const [apiKey, model, baseURL, searchEnabledText, provider, deepseekKey, dashscopeKey, glmKey, mimoriumKey] = await Promise.all([
    readTextFile(KEY_FILE),
    readTextFile(MODEL_FILE),
    readTextFile(BASE_URL_FILE),
    readTextFile(SEARCH_ENABLED_FILE),
    readTextFile(PROVIDER_FILE),
    readTextFile(DEEPSEEK_KEY_FILE),
    readTextFile(DASHSCOPE_KEY_FILE).catch(() => ''),
    readTextFile(GLM_KEY_FILE).catch(() => ''),
    readTextFile(MIMORIUM_KEY_FILE).catch(() => ''),
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
    searchEnabled: parseEnabledText(searchEnabledText),
    provider: activeProvider,
  }

  return configCache
}

function resetConfigCache() {
  configCache = null
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
  getThinkingEnabled,
  setThinkingEnabled,
}
