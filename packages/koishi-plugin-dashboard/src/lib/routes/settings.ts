'use strict'

const fs = require('fs')
const path = require('path')
const { json, collectBody, readFileSyncSafe, writeFileSyncSafe } = require('../utils')
const { requireAdmin } = require('../auth')
const { DATA_DIR, AI_LIB, CUSTOM_PROVIDERS_FILE, FALLBACK_CHAINS_FILE } = require('../paths')

interface WhitelistConfig {
  file: string
  label: string
  type: string
  default?: unknown
}

interface UsagePatch {
  key?: string
  label?: string
  provider?: string
  total?: unknown
  requests?: unknown
  input?: unknown
  output?: unknown
  cacheCreation?: unknown
  cacheRead?: unknown
}

interface UsageStat {
  key?: string
  label?: string
  provider?: string
  total: number
  requests: number
  input: number
  output: number
  cacheCreation: number
  cacheRead: number
}

type UsageMap = Record<string, UsageStat>

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

const whitelistFiles: Record<string, WhitelistConfig> = {
  summary: { file: 'summary-whitelist.json', label: '解除上限群白名单', type: 'array' },
  random: { file: 'ai-random-whitelist.json', label: '群聊AI白名单', type: 'array' },
  userBlacklist: { file: 'ai-user-blacklist.json', label: '用户黑名单', type: 'array' },
  videoBlacklist: { file: 'video-blacklist.json', label: '视频黑名单', type: 'object', default: { groups: [], users: [] } },
}

function handleGetWhitelist(req, res) {
  if (!requireAdmin(req, res)) return
  const result = {}
  for (const [key, cfg] of Object.entries(whitelistFiles)) {
    try {
      result[key] = { label: cfg.label, data: JSON.parse(fs.readFileSync(path.join(DATA_DIR, cfg.file), 'utf8')) }
    } catch {
      result[key] = { label: cfg.label, data: cfg.default || [] }
    }
  }
  return json(res, result)
}

function handlePutWhitelist(req, res) {
  if (!requireAdmin(req, res)) return
  collectBody(req, res, (body) => {
    try {
      const { type, data } = JSON.parse(body)
      const cfg = whitelistFiles[type]
      if (!cfg) return json(res, { ok: false, message: '无效类型' }, 400)
      writeFileSyncSafe(path.join(DATA_DIR, cfg.file), JSON.stringify(data, null, 2))
      try { require(path.join(AI_LIB, 'core', 'runtime-config')).resetConfigCache() } catch { /* non-critical: cache reset best effort */ }
      json(res, { ok: true, message: cfg.label + ' 已更新' })
    } catch (e) { json(res, { ok: false, message: e.message }, 400) }
  })
}

function handleGetKeys(req, res) {
  if (!requireAdmin(req, res)) return
  const keyFiles = [
    { name: 'OpenAI/OpenCode', file: 'ai-openai-key.txt' },
    { name: 'DeepSeek 官方', file: 'ai-deepseek-key.txt' },
    { name: '阿里云 DashScope', file: 'ai-dashscope-key.txt' },
    { name: '智谱 GLM', file: 'ai-glm-key.txt' },
    { name: '小米 MiMo', file: 'ai-mimorium-key.txt' },
  ]
  return json(res, keyFiles.map(k => {
    const content = readFileSyncSafe(path.join(DATA_DIR, k.file))
    return { label: k.name, file: k.file, exists: !!content, prefix: content ? content.slice(0, 8) + '****' : '' }
  }))
}

function handleGetKeysUsage(req, res) {
  if (!requireAdmin(req, res)) return
  try {
    const usageFile = path.join(DATA_DIR, 'token-usage.json')
    if (!fs.existsSync(usageFile)) return json(res, { days: [], providers: [], models: [] })
    const raw = fs.readFileSync(usageFile, 'utf8')
    const data = JSON.parse(raw)
    const providers = new Map()
    const models = new Map()
    const toNum = value => {
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
    const unknownModelKey = provider => `${provider || 'unknown'}:unknown`
    const normalizeModelKey = (model, provider = '') => {
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
    const providerLabel = p => p === 'opencode' ? 'OpenCode' : p === 'glm' ? 'GLM' : p === 'dashscope' ? '阿里云' : p === 'deepseek' ? 'DeepSeek' : p === 'mimorium' ? 'MiMo' : p
    const days = Object.keys(data).sort().slice(-30).map(date => {
      const source = data[date] || {}
      const day = { date, total: 0, input: 0, output: 0, cacheCreation: 0, cacheRead: 0, requests: 0, models: {} }
      if (source.providers && typeof source.providers === 'object') {
        const providerTotals: Record<string, number> = {}
        const modelTotalsByProvider: UsageMap = {}
        for (const [prov, stat] of Object.entries(source.providers)) {
          const statObj = stat && typeof stat === 'object' ? stat as UsagePatch : {}
          const value = typeof stat === 'object' ? toNum(statObj.total) : toNum(stat)
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
        for (const [model, stat] of Object.entries(source.models || {})) {
          const statObj = stat && typeof stat === 'object' ? stat as UsagePatch : {}
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
            const providerStat = (source.providers[prov] || {}) as UsagePatch
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
              provider: prov,
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

function handlePutKeys(req, res) {
  if (!requireAdmin(req, res)) return
  collectBody(req, res, (body) => {
    try {
      const data = JSON.parse(body)
      const file = data.file
      if (!file || file.includes('..') || !file.endsWith('-key.txt')) return json(res, { ok: false, message: '无效文件名' }, 400)
      writeFileSyncSafe(path.join(DATA_DIR, file), data.value)
      try { require(path.join(AI_LIB, 'core', 'runtime-config')).resetConfigCache() } catch { /* non-critical: cache reset best effort */ }
      json(res, { ok: true, message: 'Key 已更新' })
    } catch (e) { json(res, { ok: false, message: e.message }, 400) }
  })
}

function handleGetCustomProviders(req, res) {
  if (!requireAdmin(req, res)) return
  try { return json(res, JSON.parse(fs.readFileSync(CUSTOM_PROVIDERS_FILE, 'utf8'))) }
  catch { return json(res, []) }
}

function handlePutCustomProviders(req, res) {
  if (!requireAdmin(req, res)) return
  collectBody(req, res, (body) => {
    try {
      const data = JSON.parse(body)
      if (!Array.isArray(data)) return json(res, { ok: false, message: '参数错误' }, 400)
      fs.writeFileSync(CUSTOM_PROVIDERS_FILE + '.tmp', JSON.stringify(data, null, 2), 'utf8')
      fs.renameSync(CUSTOM_PROVIDERS_FILE + '.tmp', CUSTOM_PROVIDERS_FILE)
      json(res, { ok: true, message: '自定义供应商已更新' })
    } catch (e) { json(res, { ok: false, message: e.message }, 400) }
  })
}

function handleGetFallback(req, res) {
  if (!requireAdmin(req, res)) return
  function buildProviderMap() {
    const ps = {}
    const pDefs = require(path.join(AI_LIB, 'core', 'constants')).PROVIDERS
    for (const key of Object.keys(pDefs)) ps[key] = pDefs[key]
    try {
      const custom = JSON.parse(fs.readFileSync(CUSTOM_PROVIDERS_FILE, 'utf8'))
      if (Array.isArray(custom)) custom.forEach(p => { if (p.id) ps[p.id] = p })
    } catch { /* non-critical: optional custom providers */ }
    return ps
  }
  try {
    const raw = fs.readFileSync(FALLBACK_CHAINS_FILE, 'utf8')
    const data = JSON.parse(raw)
    return json(res, { chains: data, defaults: DEFAULT_FALLBACK_CHAINS, providers: buildProviderMap() })
  } catch {
    return json(res, { chains: DEFAULT_FALLBACK_CHAINS, defaults: DEFAULT_FALLBACK_CHAINS, providers: buildProviderMap() })
  }
}

function handlePutFallback(req, res) {
  if (!requireAdmin(req, res)) return
  collectBody(req, res, (body) => {
    try {
      const { chains } = JSON.parse(body)
      if (!chains || typeof chains !== 'object') return json(res, { ok: false, message: '参数错误' }, 400)
      const tmp = FALLBACK_CHAINS_FILE + '.tmp'
      fs.writeFileSync(tmp, JSON.stringify(chains, null, 2), 'utf8')
      fs.renameSync(tmp, FALLBACK_CHAINS_FILE)
      json(res, { ok: true, message: 'Fallback 链已更新' })
    } catch (e) { json(res, { ok: false, message: e.message }, 400) }
  })
}

function handleGetFeatures(req, res) {
  return json(res, require('../..').FEATURES_DATA || [])
}

function handleGetCommands(req, res) {
  return json(res, require('../..').COMMANDS_DATA || [])
}

function handleGetAdminIds(req, res) {
  if (!requireAdmin(req, res)) return
  try {
    const raw = fs.readFileSync(ADMIN_IDS_FILE, 'utf8')
    const ids = JSON.parse(raw)
    return json(res, { ids: Array.isArray(ids) ? ids : [] })
  } catch {
    return json(res, { ids: [] })
  }
}

function handlePutAdminIds(req, res) {
  if (!requireAdmin(req, res)) return
  collectBody(req, res, (body) => {
    try {
      const { ids } = JSON.parse(body)
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

function handleGetTools(req, res) {
  try {
    const registry = require(path.join(AI_LIB, 'agent', 'tools', 'registry'))
    const agentConfig = require(path.join(AI_LIB, 'agent', 'config')).getAgentConfig(true)
    const tools = (Object.values(registry.toolRegistry) as ToolSummary[]).map(tool => ({
      name: tool.definition.name,
      description: tool.definition.description || '',
      dangerous: !!tool.dangerous,
      external: tool.definition.name === 'web_search',
      defaultChannels: tool.defaultChannels || ['dashboard', 'qq'],
      channels: {
        qq: !!agentConfig.channels?.qq?.tools?.[tool.definition.name],
        dashboard: !!agentConfig.channels?.dashboard?.tools?.[tool.definition.name],
      },
    }))
    return json(res, { ok: true, tools })
  } catch (e) { return json(res, { ok: false, message: e.message }, 500) }
}

function handleGetToolsPending(req, res) {
  if (!requireAdmin(req, res)) return
  try {
    const p = require(path.join(AI_LIB, 'agent', 'pending')).getPendingTool('dashboard', 'dashboard')
    const pending = require(path.join(AI_LIB, 'agent', 'pending')).listPendingTools()
    return json(res, { ok: true, pending: pending.length ? pending : (p ? [{ id: p.id, toolName: p.toolName, expireAt: p.expireAt }] : []) })
  } catch (e) { return json(res, { ok: false, message: e.message }, 500) }
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

const regexRoutes = [
  { pattern: /^\/dashboard\/api\/tools\/([^/]+)\/enabled$/, method: 'PUT', handler: (req, res, match) => {
    if (!requireAdmin(req, res)) return
    collectBody(req, res, async (body) => {
      try {
        const data = JSON.parse(body || '{}')
        const toolName = decodeURIComponent(match[1])
        const channel = ['qq', 'dashboard'].includes(data.channel) ? data.channel : 'dashboard'
        const registry = require(path.join(AI_LIB, 'agent', 'tools', 'registry'))
        if (!registry.toolRegistry[toolName]) return json(res, { ok: false, message: '未知工具' }, 404)
        const saved = await require(path.join(AI_LIB, 'agent', 'config')).setToolEnabled(channel, toolName, !!data.enabled)
        return json(res, { ok: true, config: saved })
      } catch (e) { return json(res, { ok: false, message: e.message }, 400) }
    })
  }},
  { pattern: /^\/dashboard\/api\/tools\/pending\/([^/]+)\/approve$/, method: 'POST', handler: async (req, res, match) => {
    if (!requireAdmin(req, res)) return
    try {
      const pending = require(path.join(AI_LIB, 'agent', 'pending'))
      const pendingId = decodeURIComponent(match[1])
      const findPendingById = pending.findPendingToolById || pending.getPendingToolById || (id => (pending.listPendingTools && pending.listPendingTools().find(item => item.id === id)) || null)
      const p = findPendingById(pendingId)
      if (!p) return json(res, { ok: false, message: '没有匹配的待确认工具' }, 404)
      const workerSubmission = require(path.join(AI_LIB, 'agent', 'worker-submission'))
      const agentPayload = require(path.join(AI_LIB, 'resource-workers', 'agent-payload'))
      const agentConfig = require(path.join(AI_LIB, 'agent', 'config')).getAgentConfig()
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
    } catch (e) { return json(res, { ok: false, message: e.message }, 500) }
  }},
]

export = { routes, regexRoutes }
