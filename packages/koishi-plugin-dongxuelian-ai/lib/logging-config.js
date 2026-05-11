const fs = require('fs')
const fsp = require('fs/promises')
const path = require('path')
const { DATA_DIR } = require('./constants')

const DEBUG_LOG_CONFIG_FILE = path.join(DATA_DIR, 'debug-log-config.json')
const CONFIG_CHECK_INTERVAL_MS = 2000

let cachedConfig = null
let cachedMtimeMs = 0
let nextCheckAt = 0
let cachedFromFile = false

function envDebugEnabled() {
  return /^(?:1|true|on|yes)$/i.test(String(process.env.DONGXUELIAN_DEBUG || '').trim())
}

function normalizeDebugLogConfig(input = {}) {
  const source = input && typeof input === 'object' ? input : {}
  const enabled = !!(Object.prototype.hasOwnProperty.call(source, 'enabled') ? source.enabled : source.debug)
  const modules = {}
  if (source.modules && typeof source.modules === 'object' && !Array.isArray(source.modules)) {
    for (const [key, value] of Object.entries(source.modules)) {
      if (key) modules[String(key)] = !!value
    }
  }
  return {
    enabled,
    debug: enabled,
    modules,
    updatedAt: Number(source.updatedAt) || 0,
  }
}

function readDebugLogConfig(force = false) {
  const now = Date.now()
  if (!force && cachedConfig && now < nextCheckAt) return cachedConfig
  nextCheckAt = now + CONFIG_CHECK_INTERVAL_MS

  try {
    const stat = fs.statSync(DEBUG_LOG_CONFIG_FILE)
    if (!force && cachedConfig && cachedFromFile && stat.mtimeMs === cachedMtimeMs) return cachedConfig
    const parsed = JSON.parse(fs.readFileSync(DEBUG_LOG_CONFIG_FILE, 'utf8') || '{}')
    cachedConfig = normalizeDebugLogConfig(parsed)
    cachedConfig.source = 'file'
    cachedMtimeMs = stat.mtimeMs
    cachedFromFile = true
    return cachedConfig
  } catch {
    const enabled = envDebugEnabled()
    cachedConfig = normalizeDebugLogConfig({ enabled, updatedAt: 0 })
    cachedConfig.source = 'env'
    cachedMtimeMs = 0
    cachedFromFile = false
    return cachedConfig
  }
}

async function writeDebugLogConfig(input = {}) {
  const next = normalizeDebugLogConfig({ ...input, updatedAt: Date.now() })
  const dir = path.dirname(DEBUG_LOG_CONFIG_FILE)
  const tmp = path.join(dir, `.${path.basename(DEBUG_LOG_CONFIG_FILE)}.${process.pid}.${Date.now()}.tmp`)
  await fsp.mkdir(dir, { recursive: true })
  await fsp.writeFile(tmp, JSON.stringify(next, null, 2), 'utf8')
  await fsp.rename(tmp, DEBUG_LOG_CONFIG_FILE)
  cachedConfig = { ...next, source: 'file' }
  try { cachedMtimeMs = fs.statSync(DEBUG_LOG_CONFIG_FILE).mtimeMs } catch { cachedMtimeMs = Date.now() }
  cachedFromFile = true
  nextCheckAt = Date.now() + CONFIG_CHECK_INTERVAL_MS
  return cachedConfig
}

function isDebugLogEnabled(moduleName = '') {
  const config = readDebugLogConfig()
  if (!config.enabled) return false
  const key = String(moduleName || '').trim()
  if (key && Object.prototype.hasOwnProperty.call(config.modules, key)) return !!config.modules[key]
  return true
}

function logDebug(ctx, moduleName, message) {
  if (!isDebugLogEnabled(moduleName)) return
  const logger = ctx && typeof ctx.logger === 'function' ? ctx.logger('dongxuelian-ai') : null
  if (!logger || typeof logger.info !== 'function') return
  logger.info(`[D] [${moduleName || 'debug'}] ${message}`)
}

module.exports = {
  DEBUG_LOG_CONFIG_FILE,
  normalizeDebugLogConfig,
  readDebugLogConfig,
  writeDebugLogConfig,
  isDebugLogEnabled,
  logDebug,
}
