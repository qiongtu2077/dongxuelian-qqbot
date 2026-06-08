'use strict'

import type { IncomingMessage, ServerResponse } from 'http'

const fs = require('fs') as typeof import('fs')
const path = require('path') as typeof import('path')
const { json, collectBody, readFileSyncSafe, writeFileSyncSafe } = require('../utils') as {
  json(res: ServerResponse, data: unknown, status?: number): void
  collectBody(req: IncomingMessage, res: ServerResponse, callback: (body: string) => void | Promise<void>): void
  readFileSyncSafe(filePath: string, maxBytes?: number): string
  writeFileSyncSafe(filePath: string, content: unknown): void
}
const { requireAdmin } = require('../auth') as { requireAdmin(req: IncomingMessage, res: ServerResponse): boolean }
const { DATA_DIR, AI_LIB, CUSTOM_PROVIDERS_FILE, FALLBACK_CHAINS_FILE } = require('../paths') as {
  DATA_DIR: string
  AI_LIB: string
  CUSTOM_PROVIDERS_FILE: string
  FALLBACK_CHAINS_FILE: string
}

type RouteHandler = (req: IncomingMessage, res: ServerResponse, pathname: string, url: URL) => unknown
type RegexRouteHandler = (req: IncomingMessage, res: ServerResponse, match: RegExpMatchArray, pathname: string, url: URL) => unknown
type WhitelistType = 'summary' | 'random' | 'userBlacklist' | 'videoBlacklist'
type WhitelistKind = 'array' | 'object'
type WhitelistBuckets = { groups: string[]; users: string[] }
type WhitelistData = unknown[] | WhitelistBuckets
type KeyFileName = `${string}-key.txt`
type ToolChannel = 'qq' | 'dashboard'

interface RegexRoute {
  pattern: RegExp
  method: string
  handler: RegexRouteHandler
}

interface WhitelistConfig {
  file: string
  label: string
  type: WhitelistKind
  default?: WhitelistData
}

interface WhitelistEntry {
  label: string
  data: WhitelistData
}

type WhitelistResponse = Record<WhitelistType, WhitelistEntry>

interface KeyFileConfig {
  name: string
  file: KeyFileName
}

interface KeySummary {
  label: string
  file: KeyFileName
  exists: boolean
  prefix: string
}

interface SettingsJsonBody {
  type?: unknown
  data?: unknown
  file?: unknown
  value?: unknown
  chains?: unknown
  ids?: unknown
  channel?: unknown
  enabled?: unknown
}

type UsageMetricKey = 'total' | 'requests' | 'input' | 'output' | 'cacheCreation' | 'cacheRead'
type UsageMetrics = Record<UsageMetricKey, number>

interface UsagePatch {
  label?: string
  provider?: string
  total?: unknown
  requests?: unknown
  input?: unknown
  output?: unknown
  cacheCreation?: unknown
  cacheRead?: unknown
}

interface UsageStat extends UsageMetrics {
  key?: string
  label?: string
  provider?: string
}

type UsageMap = Record<string, UsageStat>

interface UsageDay extends UsageMetrics {
  date: string
  models: UsageMap
  [provider: string]: string | number | UsageMap
}

interface ToolSummary {
  definition?: {
    name?: string
    description?: string
  }
  dangerous?: boolean
  defaultChannels?: string[]
}

const DEFAULT_FALLBACK_CHAINS = {
  chat: [
    { provider: 'glm', model: 'glm-4.6v-flash', keyFile: 'ai-glm-key.txt' },
    { provider: 'opencode', model: 'deepseek-v4-flash', keyFile: 'ai-openai-key.txt' },
    { provider: 'dashscope', model: 'qwen3.5-omni-flash', keyFile: 'ai-dashscope-key.txt' },
    { provider: 'dashscope', model: 'qwen3.5-plus', keyFile: 'ai-dashscope-key.txt' },
  ],
  vision: [
    { provider: 'glm', model: 'glm-4.6v-flash', keyFile: 'ai-glm-key.txt' },
    { provider: 'mimorium', model: 'mimo-v2-omni', keyFile: 'ai-mimorium-key.txt' },
    { provider: 'dashscope', model: 'qwen3.5-omni-flash', keyFile: 'ai-dashscope-key.txt' },
    { provider: 'dashscope', model: 'qwen3.5-plus', keyFile: 'ai-dashscope-key.txt' },
  ],
  lightweight: [
    { provider: 'glm', model: 'glm-4.6v-flash', keyFile: 'ai-glm-key.txt' },
    { provider: 'opencode', model: 'deepseek-v4-flash', keyFile: 'ai-openai-key.txt' },
    { provider: 'dashscope', model: 'qwen3.5-omni-flash', keyFile: 'ai-dashscope-key.txt' },
    { provider: 'dashscope', model: 'qwen3.5-plus', keyFile: 'ai-dashscope-key.txt' },
  ],
}

const ADMIN_IDS_FILE = path.join(DATA_DIR, 'ai-admin-ids.json')

const WHITELIST_TYPES: readonly WhitelistType[] = ['summary', 'random', 'userBlacklist', 'videoBlacklist']

const whitelistFiles: Record<WhitelistType, WhitelistConfig> = {
  summary: { file: 'summary-whitelist.json', label: '解除上限群白名单', type: 'array' },
  random: { file: 'ai-random-whitelist.json', label: '群聊AI白名单', type: 'array' },
  userBlacklist: { file: 'ai-user-blacklist.json', label: '用户黑名单', type: 'array' },
  videoBlacklist: { file: 'video-blacklist.json', label: '视频黑名单', type: 'object', default: { groups: [], users: [] } },
}

interface CustomProviderCandidate {
  id?: unknown
  [key: string]: unknown
}

type ProviderMap = Record<string, unknown>

interface DashboardRootExports {
  FEATURES_DATA?: unknown
  COMMANDS_DATA?: unknown
}

interface AgentToolRegistryModule {
  toolRegistry: Record<string, ToolSummary>
}

interface AgentToolChannelConfig {
  tools?: Record<string, unknown>
}

interface AgentConfigSnapshot {
  channels?: {
    qq?: AgentToolChannelConfig
    dashboard?: AgentToolChannelConfig
  }
  queue?: {
    timeoutMs?: number
    maxPendingPerUser?: number
  }
}

interface AgentConfigModule {
  getAgentConfig(reload?: boolean): AgentConfigSnapshot
  setToolEnabled(channel: ToolChannel, toolName: string, enabled: boolean): Promise<AgentConfigSnapshot>
}

interface PendingToolRecord extends Record<string, unknown> {
  id: string
  toolName: string
  userId: string
  channelKey: string
  channel?: string
  expireAt?: unknown
}

interface PendingModule {
  getPendingTool(channel: string, userId: string): PendingToolRecord | null
  findPendingToolById?: (id: unknown) => PendingToolRecord | null
  getPendingToolById?: (id: unknown) => PendingToolRecord | null
  listPendingTools?: () => PendingToolRecord[]
}

interface SubmitAgentWorkerTaskOptions {
  channel?: string
  channelKey: string
  userId: string
  timeoutMs?: number
  maxActivePerUser?: number
  source: string
  payload: Record<string, unknown>
}

interface AgentWorkerSubmissionResult {
  accepted: boolean
  taskId?: string
  status?: number
  message: string
}

interface WorkerSubmissionModule {
  submitAgentWorkerTask(options: SubmitAgentWorkerTaskOptions): AgentWorkerSubmissionResult
}

interface AgentPayloadModule {
  createAgentResumeWorkerPayload(entry: string, input?: Record<string, unknown>, pendingSnapshot?: Record<string, unknown> | null, warnings?: string[]): Record<string, unknown>
}

function requireToolDefinition(tool: ToolSummary): NonNullable<ToolSummary['definition']> {
  if (!tool.definition) throw new TypeError("Cannot read properties of undefined (reading 'name')")
  return tool.definition
}

function getErrorMessage(error: unknown): string {
  if (error && typeof error === 'object' && 'message' in error) return String((error as { message?: unknown }).message || '')
  return String(error || '')
}

function getLegacyErrorMessage(error: unknown): unknown {
  return error && typeof error === 'object' && 'message' in error ? (error as { message?: unknown }).message : undefined
}

function parseJsonObject(body: string): SettingsJsonBody {
  const data = JSON.parse(body || '{}')
  return data && typeof data === 'object' && !Array.isArray(data) ? data as SettingsJsonBody : {}
}

function isWhitelistType(value: unknown): value is WhitelistType {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(whitelistFiles, value)
}

function isWritableKeyFile(value: unknown): value is KeyFileName {
  return typeof value === 'string' && !!value && !value.includes('..') && value.endsWith('-key.txt')
}

function normalizeToolChannel(value: unknown): ToolChannel {
  return value === 'qq' || value === 'dashboard' ? value : 'dashboard'
}

function handleGetWhitelist(req: IncomingMessage, res: ServerResponse): void {
  if (!requireAdmin(req, res)) return
  const result = {} as WhitelistResponse
  for (const key of WHITELIST_TYPES) {
    const cfg = whitelistFiles[key]
    try {
      result[key] = { label: cfg.label, data: JSON.parse(fs.readFileSync(path.join(DATA_DIR, cfg.file), 'utf8')) }
    } catch {
      result[key] = { label: cfg.label, data: cfg.default || [] }
    }
  }
  return json(res, result)
}

function handlePutWhitelist(req: IncomingMessage, res: ServerResponse): void {
  if (!requireAdmin(req, res)) return
  collectBody(req, res, (body) => {
    try {
      const { type, data } = parseJsonObject(body)
      if (!isWhitelistType(type)) return json(res, { ok: false, message: '无效类型' }, 400)
      const cfg = whitelistFiles[type]
      writeFileSyncSafe(path.join(DATA_DIR, cfg.file), JSON.stringify(data, null, 2))
      try { require(path.join(AI_LIB, 'core', 'runtime-config')).resetConfigCache() } catch { /* non-critical: cache reset best effort */ }
      json(res, { ok: true, message: cfg.label + ' 已更新' })
    } catch (e) { json(res, { ok: false, message: getErrorMessage(e) }, 400) }
  })
}

function handleGetKeys(req: IncomingMessage, res: ServerResponse): void {
  if (!requireAdmin(req, res)) return
  const keyFiles: KeyFileConfig[] = [
    { name: 'OpenAI/OpenCode', file: 'ai-openai-key.txt' },
    { name: 'DeepSeek 官方', file: 'ai-deepseek-key.txt' },
    { name: '阿里云 DashScope', file: 'ai-dashscope-key.txt' },
    { name: '智谱 GLM', file: 'ai-glm-key.txt' },
    { name: '小米 MiMo', file: 'ai-mimorium-key.txt' },
  ]
  return json(res, keyFiles.map((k): KeySummary => {
    const content = readFileSyncSafe(path.join(DATA_DIR, k.file))
    return { label: k.name, file: k.file, exists: !!content, prefix: content ? content.slice(0, 8) + '****' : '' }
  }))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object'
}

function handleGetKeysUsage(req: IncomingMessage, res: ServerResponse): void {
  if (!requireAdmin(req, res)) return
  try {
    const usageFile = path.join(DATA_DIR, 'token-usage.json')
    if (!fs.existsSync(usageFile)) return json(res, { days: [], providers: [], models: [] })
    const raw = fs.readFileSync(usageFile, 'utf8')
    const parsed: unknown = JSON.parse(raw)
    const data = isRecord(parsed) ? parsed : {}
    const providers = new Map<string, UsageStat>()
    const models = new Map<string, UsageStat>()
    const toNum = (value: unknown): number => {
      const n = Number(value || 0)
      return Number.isFinite(n) && n > 0 ? n : 0
    }
    const addStat = (map: Map<string, UsageStat>, key: string, patch: UsagePatch = {}) => {
      if (!key) return
      const current = map.get(key) || { key, label: key, total: 0, requests: 0, input: 0, output: 0, cacheCreation: 0, cacheRead: 0 }
      current.label = patch.label || current.label || key
      current.provider = patch.provider || current.provider || ''
      current.total += toNum(patch.total)
      current.requests += toNum(patch.requests)
      current.input += toNum(patch.input)
      current.output += toNum(patch.output)
      current.cacheCreation += toNum(patch.cacheCreation)
      current.cacheRead += toNum(patch.cacheRead)
      map.set(key, current)
    }
    const unknownModelKey = (provider: string): string => `${provider || 'unknown'}:unknown`
    const normalizeModelKey = (model: unknown, provider = ''): string => {
      const raw = String(model || '').trim()
      const prov = String(provider || '').trim() || raw.split(':')[0]
      if (!raw) return unknownModelKey(prov)
      if (/:(?:legacy|unknown)$/i.test(raw)) return unknownModelKey(prov)
      return raw
    }
    const addDayModelStat = (dayModels: UsageMap, key: string, patch: UsagePatch = {}) => {
      if (!key) return
      const current = dayModels[key] || { provider: patch.provider || '', total: 0, requests: 0, input: 0, output: 0, cacheCreation: 0, cacheRead: 0 }
      current.provider = patch.provider || current.provider || ''
      current.total += toNum(patch.total)
      current.requests += toNum(patch.requests)
      current.input += toNum(patch.input)
      current.output += toNum(patch.output)
      current.cacheCreation += toNum(patch.cacheCreation)
      current.cacheRead += toNum(patch.cacheRead)
      dayModels[key] = current
    }
    const addMetric = (target: UsageMap, provider: string, patch: UsagePatch = {}) => {
      if (!provider) return
      const current = target[provider] || { total: 0, requests: 0, input: 0, output: 0, cacheCreation: 0, cacheRead: 0 }
      current.total += toNum(patch.total)
      current.requests += toNum(patch.requests)
      current.input += toNum(patch.input)
      current.output += toNum(patch.output)
      current.cacheCreation += toNum(patch.cacheCreation)
      current.cacheRead += toNum(patch.cacheRead)
      target[provider] = current
    }
    const reservedDayKeys = new Set(['date', 'total', 'input', 'output', 'cacheCreation', 'cacheRead', 'requests', 'models'])
    const providerLabel = (p: string): string => p === 'opencode' ? 'OpenCode' : p === 'glm' ? 'GLM' : p === 'dashscope' ? '阿里云' : p === 'deepseek' ? 'DeepSeek' : p === 'mimorium' ? 'MiMo' : p
    const days = Object.keys(data).sort().slice(-30).map((date): UsageDay => {
      const rawSource = data[date]
      const source = isRecord(rawSource) ? rawSource : {}
      const day: UsageDay = { date, total: 0, input: 0, output: 0, cacheCreation: 0, cacheRead: 0, requests: 0, models: {} }
      const sourceProviders = isRecord(source.providers) ? source.providers : null
      if (sourceProviders) {
        const providerTotals: Record<string, number> = {}
        const modelTotalsByProvider: UsageMap = {}
        for (const [prov, stat] of Object.entries(sourceProviders)) {
          const statObj: UsagePatch = isRecord(stat) ? stat : {}
          const value = isRecord(stat) ? toNum(statObj.total) : toNum(stat)
          providerTotals[prov] = value
          day[prov] = value
          addStat(providers, prov, {
            label: providerLabel(prov),
            total: value,
            requests: statObj.requests,
            input: statObj.input,
            output: statObj.output,
            cacheCreation: statObj.cacheCreation,
            cacheRead: statObj.cacheRead,
          })
        }
        const sourceModels = isRecord(source.models) ? source.models : {}
        for (const [model, stat] of Object.entries(sourceModels)) {
          const statObj: UsagePatch = isRecord(stat) ? stat : {}
          const provider = statObj.provider || String(model || '').split(':')[0]
          const modelKey = normalizeModelKey(model, provider)
          const modelTotal = toNum(statObj.total)
          if (provider) addMetric(modelTotalsByProvider, provider, {
            total: modelTotal,
            requests: statObj.requests,
            input: statObj.input,
            output: statObj.output,
            cacheCreation: statObj.cacheCreation,
            cacheRead: statObj.cacheRead,
          })
          addDayModelStat(day.models, modelKey, {
            provider,
            total: modelTotal,
            requests: toNum(statObj.requests),
            input: toNum(statObj.input),
            output: toNum(statObj.output),
            cacheCreation: toNum(statObj.cacheCreation),
            cacheRead: toNum(statObj.cacheRead),
          })
          addStat(models, modelKey, {
            label: /:(?:legacy|unknown)$/i.test(String(model || '')) ? `${providerLabel(provider)} 未分模型` : modelKey,
            provider,
            total: modelTotal,
            requests: statObj.requests,
            input: statObj.input,
            output: statObj.output,
            cacheCreation: statObj.cacheCreation,
            cacheRead: statObj.cacheRead,
          })
        }
        for (const [prov, total] of Object.entries(providerTotals)) {
          const modelStat: UsageStat = modelTotalsByProvider[prov] || { total: 0, requests: 0, input: 0, output: 0, cacheCreation: 0, cacheRead: 0 }
          const residual = total - toNum(modelStat.total)
          if (residual > 0) {
            const providerSource = sourceProviders[prov]
            const providerStat: UsagePatch = isRecord(providerSource) ? providerSource : {}
            const residualKey = unknownModelKey(prov)
            const residualPatch = {
              provider: prov,
              total: residual,
              requests: Math.max(0, toNum(providerStat.requests) - toNum(modelStat.requests)),
              input: Math.max(0, toNum(providerStat.input) - toNum(modelStat.input)),
              output: Math.max(0, toNum(providerStat.output) - toNum(modelStat.output)),
              cacheCreation: Math.max(0, toNum(providerStat.cacheCreation) - toNum(modelStat.cacheCreation)),
              cacheRead: Math.max(0, toNum(providerStat.cacheRead) - toNum(modelStat.cacheRead)),
            }
            addDayModelStat(day.models, residualKey, residualPatch)
            addStat(models, residualKey, {
              label: `${providerLabel(prov)} 未分模型`,
              ...residualPatch,
            })
          }
        }
        day.total = toNum(source.total) || Object.keys(day).reduce((sum, key) => sum + (reservedDayKeys.has(key) ? 0 : toNum(day[key])), 0)
        day.requests = toNum(source.requests)
        day.input = toNum(source.input)
        day.output = toNum(source.output)
        day.cacheCreation = toNum(source.cacheCreation)
        day.cacheRead = toNum(source.cacheRead)
      } else {
        for (const [prov, count] of Object.entries(source)) {
          const value = toNum(count)
          day[prov] = value
          day.total += value
          addStat(providers, prov, { label: providerLabel(prov), total: value })
          if (!reservedDayKeys.has(prov)) {
            const legacyKey = unknownModelKey(prov)
            addDayModelStat(day.models, legacyKey, { provider: prov, total: value })
            addStat(models, legacyKey, {
              label: `${providerLabel(prov)} 未分模型`,
              provider: prov,
              total: value,
            })
          }
        }
      }
      return day
    })
    return json(res, { days, providers: [...providers.values()], models: [...models.values()] })
  } catch { return json(res, { days: [], providers: [], models: [] }) }
}

function handlePutKeys(req: IncomingMessage, res: ServerResponse): void {
  if (!requireAdmin(req, res)) return
  collectBody(req, res, (body) => {
    try {
      const data = parseJsonObject(body)
      const file = data.file
      if (!isWritableKeyFile(file)) return json(res, { ok: false, message: '无效文件名' }, 400)
      writeFileSyncSafe(path.join(DATA_DIR, file), data.value)
      try { require(path.join(AI_LIB, 'core', 'runtime-config')).resetConfigCache() } catch { /* non-critical: cache reset best effort */ }
      json(res, { ok: true, message: 'Key 已更新' })
    } catch (e) { json(res, { ok: false, message: getErrorMessage(e) }, 400) }
  })
}

function handleGetCustomProviders(req: IncomingMessage, res: ServerResponse): void {
  if (!requireAdmin(req, res)) return
  try { return json(res, JSON.parse(fs.readFileSync(CUSTOM_PROVIDERS_FILE, 'utf8'))) }
  catch { return json(res, []) }
}

function handlePutCustomProviders(req: IncomingMessage, res: ServerResponse): void {
  if (!requireAdmin(req, res)) return
  collectBody(req, res, (body) => {
    try {
      const data: unknown = JSON.parse(body)
      if (!Array.isArray(data)) return json(res, { ok: false, message: '参数错误' }, 400)
      fs.writeFileSync(CUSTOM_PROVIDERS_FILE + '.tmp', JSON.stringify(data, null, 2), 'utf8')
      fs.renameSync(CUSTOM_PROVIDERS_FILE + '.tmp', CUSTOM_PROVIDERS_FILE)
      json(res, { ok: true, message: '自定义供应商已更新' })
    } catch (e) { json(res, { ok: false, message: getErrorMessage(e) }, 400) }
  })
}

function handleGetFallback(req: IncomingMessage, res: ServerResponse): void {
  if (!requireAdmin(req, res)) return
  function buildProviderMap(): ProviderMap {
    const ps: ProviderMap = {}
    const { PROVIDERS: pDefs } = require(path.join(AI_LIB, 'core', 'constants')) as { PROVIDERS: ProviderMap }
    for (const key of Object.keys(pDefs)) ps[key] = pDefs[key]
    try {
      const custom: unknown = JSON.parse(fs.readFileSync(CUSTOM_PROVIDERS_FILE, 'utf8'))
      if (Array.isArray(custom)) custom.forEach((p: CustomProviderCandidate) => { if (p.id) ps[String(p.id)] = p })
    } catch { /* non-critical: optional custom providers */ }
    return ps
  }
  try {
    const raw = fs.readFileSync(FALLBACK_CHAINS_FILE, 'utf8')
    const data: unknown = JSON.parse(raw)
    return json(res, { chains: data, defaults: DEFAULT_FALLBACK_CHAINS, providers: buildProviderMap() })
  } catch {
    return json(res, { chains: DEFAULT_FALLBACK_CHAINS, defaults: DEFAULT_FALLBACK_CHAINS, providers: buildProviderMap() })
  }
}

function handlePutFallback(req: IncomingMessage, res: ServerResponse): void {
  if (!requireAdmin(req, res)) return
  collectBody(req, res, (body) => {
    try {
      const { chains } = parseJsonObject(body)
      if (!isRecord(chains)) return json(res, { ok: false, message: '参数错误' }, 400)
      const tmp = FALLBACK_CHAINS_FILE + '.tmp'
      fs.writeFileSync(tmp, JSON.stringify(chains, null, 2), 'utf8')
      fs.renameSync(tmp, FALLBACK_CHAINS_FILE)
      json(res, { ok: true, message: 'Fallback 链已更新' })
    } catch (e) { json(res, { ok: false, message: getErrorMessage(e) }, 400) }
  })
}

function handleGetFeatures(req: IncomingMessage, res: ServerResponse): void {
  const root = require('../..') as DashboardRootExports
  return json(res, root.FEATURES_DATA || [])
}

function handleGetCommands(req: IncomingMessage, res: ServerResponse): void {
  const root = require('../..') as DashboardRootExports
  return json(res, root.COMMANDS_DATA || [])
}

function handleGetAdminIds(req: IncomingMessage, res: ServerResponse): void {
  if (!requireAdmin(req, res)) return
  try {
    const raw = fs.readFileSync(ADMIN_IDS_FILE, 'utf8')
    const ids: unknown = JSON.parse(raw)
    return json(res, { ids: Array.isArray(ids) ? ids : [] })
  } catch {
    return json(res, { ids: [] })
  }
}

function handlePutAdminIds(req: IncomingMessage, res: ServerResponse): void {
  if (!requireAdmin(req, res)) return
  collectBody(req, res, (body) => {
    try {
      const { ids } = parseJsonObject(body)
      if (!Array.isArray(ids)) return json(res, { ok: false, message: '参数错误' }, 400)
      const cleaned = ids.map(String).filter(Boolean)
      const tmp = ADMIN_IDS_FILE + '.tmp'
      fs.writeFileSync(tmp, JSON.stringify(cleaned, null, 2), 'utf8')
      fs.renameSync(tmp, ADMIN_IDS_FILE)
      try { require(path.join(AI_LIB, 'core', 'runtime-config')).resetConfigCache() } catch { /* non-critical: cache reset best effort */ }
      return json(res, { ok: true, message: '管理员列表已更新' })
    } catch { return json(res, { ok: false, message: '无效请求' }, 400) }
  })
}

function handleGetTools(req: IncomingMessage, res: ServerResponse): void {
  try {
    const registry = require(path.join(AI_LIB, 'agent', 'tools', 'registry')) as AgentToolRegistryModule
    const agentConfig = (require(path.join(AI_LIB, 'agent', 'config')) as AgentConfigModule).getAgentConfig(true)
    const tools = (Object.values(registry.toolRegistry) as ToolSummary[]).map(tool => {
      const definition = requireToolDefinition(tool)
      const name = definition.name
      return {
        name,
        description: definition.description || '',
        dangerous: !!tool.dangerous,
        external: name === 'web_search',
        defaultChannels: tool.defaultChannels || ['dashboard', 'qq'],
        channels: {
          qq: !!agentConfig.channels?.qq?.tools?.[String(name)],
          dashboard: !!agentConfig.channels?.dashboard?.tools?.[String(name)],
        },
      }
    })
    return json(res, { ok: true, tools })
  } catch (e) { return json(res, { ok: false, message: getErrorMessage(e) }, 500) }
}

function handleGetToolsPending(req: IncomingMessage, res: ServerResponse): void {
  if (!requireAdmin(req, res)) return
  try {
    const pendingModule = require(path.join(AI_LIB, 'agent', 'pending')) as PendingModule
    const p = pendingModule.getPendingTool('dashboard', 'dashboard')
    const pending = pendingModule.listPendingTools ? pendingModule.listPendingTools() : []
    return json(res, { ok: true, pending: pending.length ? pending : (p ? [{ id: p.id, toolName: p.toolName, expireAt: p.expireAt }] : []) })
  } catch (e) { return json(res, { ok: false, message: getErrorMessage(e) }, 500) }
}

const routes = {
  'GET /dashboard/api/whitelist': handleGetWhitelist,
  'PUT /dashboard/api/whitelist': handlePutWhitelist,
  'GET /dashboard/api/keys': handleGetKeys,
  'GET /dashboard/api/keys/usage': handleGetKeysUsage,
  'PUT /dashboard/api/keys': handlePutKeys,
  'GET /dashboard/api/providers/custom': handleGetCustomProviders,
  'PUT /dashboard/api/providers/custom': handlePutCustomProviders,
  'GET /dashboard/api/fallback': handleGetFallback,
  'PUT /dashboard/api/fallback': handlePutFallback,
  'GET /dashboard/api/features': handleGetFeatures,
  'GET /dashboard/api/commands': handleGetCommands,
  'GET /dashboard/api/admin-ids': handleGetAdminIds,
  'PUT /dashboard/api/admin-ids': handlePutAdminIds,
  'GET /dashboard/api/tools': handleGetTools,
  'GET /dashboard/api/tools/pending': handleGetToolsPending,
}

const regexRoutes: RegexRoute[] = [
  { pattern: /^\/dashboard\/api\/tools\/([^/]+)\/enabled$/, method: 'PUT', handler: (req, res, match) => {
    if (!requireAdmin(req, res)) return
    collectBody(req, res, async (body) => {
      try {
        const data = JSON.parse(body || '{}') as SettingsJsonBody
        const toolName = decodeURIComponent(match[1])
        const channel = normalizeToolChannel(data.channel)
        const registry = require(path.join(AI_LIB, 'agent', 'tools', 'registry')) as AgentToolRegistryModule
        if (!registry.toolRegistry[toolName]) return json(res, { ok: false, message: '未知工具' }, 404)
        const saved = await (require(path.join(AI_LIB, 'agent', 'config')) as AgentConfigModule).setToolEnabled(channel, toolName, !!data.enabled)
        return json(res, { ok: true, config: saved })
      } catch (e) { return json(res, { ok: false, message: getLegacyErrorMessage(e) }, 400) }
    })
  }},
  { pattern: /^\/dashboard\/api\/tools\/pending\/([^/]+)\/approve$/, method: 'POST', handler: async (req, res, match) => {
    if (!requireAdmin(req, res)) return
    try {
      const pending = require(path.join(AI_LIB, 'agent', 'pending')) as PendingModule
      const pendingId = decodeURIComponent(match[1])
      const findPendingById = pending.findPendingToolById || pending.getPendingToolById || ((id: unknown) => (pending.listPendingTools && pending.listPendingTools().find(item => item.id === id)) || null)
      const p = findPendingById(pendingId)
      if (!p) return json(res, { ok: false, message: '没有匹配的待确认工具' }, 404)
      const workerSubmission = require(path.join(AI_LIB, 'agent', 'worker-submission')) as WorkerSubmissionModule
      const agentPayload = require(path.join(AI_LIB, 'resource-workers', 'agent-payload')) as AgentPayloadModule
      const agentConfig = (require(path.join(AI_LIB, 'agent', 'config')) as AgentConfigModule).getAgentConfig()
      const resumeInput = { channelKey: p.channelKey, userId: p.userId, channel: p.channel || 'dashboard', expectedId: pendingId }
      const submission = workerSubmission.submitAgentWorkerTask({
        channel: p.channel || 'dashboard',
        channelKey: p.channelKey,
        userId: p.userId,
        timeoutMs: agentConfig.queue?.timeoutMs,
        maxActivePerUser: agentConfig.queue?.maxPendingPerUser,
        source: 'dashboard-standalone',
        payload: { entry: 'settings-pending-approve', pendingId, agentWorker: agentPayload.createAgentResumeWorkerPayload('settings-pending-approve', resumeInput, p) },
      })
      return json(res, {
        ok: submission.accepted,
        async: true,
        toolName: p.toolName,
        taskId: submission.taskId || '',
        status: submission.accepted ? 'accepted' : 'blocked',
        message: submission.message,
      }, submission.status || 202)
    } catch (e) { return json(res, { ok: false, message: getLegacyErrorMessage(e) }, 500) }
  }},
]

export = { routes, regexRoutes }
