/**
 * MODULE: 群聊随机语音升级概率。
 * 职责: 读取/保存每个群“已触发回复后升级为语音”的概率。
 * 边界: 不发送消息，不合成语音，不参与聊天模型调用。
 */
const fs = require('fs')
const { RANDOM_VOICE_RATE_FILE } = require('../core/constants') as typeof import('../core/constants')
const { readJsonFile, writeJsonFile } = require('../core/utils') as typeof import('../core/utils')

const DEFAULT_RANDOM_VOICE_RATE = 0.1
let rateCache: Map<string, number> | null = null
let rateCacheMtimeMs = 0

function normalizeVoiceRate(value: unknown): number | null {
  const rate = Number(value)
  if (!Number.isFinite(rate)) return null
  if (rate < 0 || rate > 1) return null
  return rate
}

function normalizeRateMap(raw: unknown): Map<string, number> {
  const map: Map<string, number> = new Map()
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return map
  for (const [channelKey, value] of Object.entries(raw)) {
    const key = String(channelKey || '').trim()
    const rate = normalizeVoiceRate(value)
    if (key && rate !== null) map.set(key, rate)
  }
  return map
}

function readRateFileSync(): Map<string, number> {
  try {
    const stat = fs.statSync(RANDOM_VOICE_RATE_FILE)
    if (rateCache && stat.mtimeMs === rateCacheMtimeMs) return rateCache
    const raw = JSON.parse(fs.readFileSync(RANDOM_VOICE_RATE_FILE, 'utf8'))
    rateCache = normalizeRateMap(raw)
    rateCacheMtimeMs = stat.mtimeMs
    return rateCache
  } catch { /* non-critical: missing or invalid random voice config falls back to defaults */
    rateCache = rateCache || new Map()
    rateCacheMtimeMs = 0
    return rateCache
  }
}

async function loadRandomVoiceRateCache(): Promise<Map<string, number>> {
  rateCache = normalizeRateMap(await readJsonFile(RANDOM_VOICE_RATE_FILE, {}))
  try {
    rateCacheMtimeMs = fs.statSync(RANDOM_VOICE_RATE_FILE).mtimeMs
  } catch { /* non-critical: mtime cache is only an optimization */
    rateCacheMtimeMs = 0
  }
  return rateCache
}

function getRandomVoiceRate(channelKey: string): number {
  const cache = readRateFileSync()
  const key = String(channelKey || '')
  return cache.has(key) ? cache.get(key) : DEFAULT_RANDOM_VOICE_RATE
}

async function saveRateCache(cache: Map<string, number>): Promise<void> {
  await writeJsonFile(RANDOM_VOICE_RATE_FILE, Object.fromEntries(cache))
  try {
    rateCacheMtimeMs = fs.statSync(RANDOM_VOICE_RATE_FILE).mtimeMs
  } catch { /* non-critical: mtime cache is refreshed on next load */
    rateCacheMtimeMs = 0
  }
}

async function setRandomVoiceRate(channelKey: string, rate: unknown): Promise<boolean> {
  const key = String(channelKey || '').trim()
  const normalized = normalizeVoiceRate(rate)
  if (!key || normalized === null) return false
  const cache = readRateFileSync()
  cache.set(key, normalized)
  rateCache = cache
  await saveRateCache(cache)
  return true
}

async function resetRandomVoiceRate(channelKey: string): Promise<boolean> {
  const key = String(channelKey || '').trim()
  if (!key) return false
  const cache = readRateFileSync()
  const existed = cache.delete(key)
  rateCache = cache
  await saveRateCache(cache)
  return existed
}

function shouldTriggerRandomVoiceByRate(channelKey: string, randomFn: () => number = Math.random): boolean {
  return randomFn() < getRandomVoiceRate(channelKey)
}

export = {
  DEFAULT_RANDOM_VOICE_RATE,
  normalizeVoiceRate,
  loadRandomVoiceRateCache,
  getRandomVoiceRate,
  setRandomVoiceRate,
  resetRandomVoiceRate,
  shouldTriggerRandomVoiceByRate,
}
