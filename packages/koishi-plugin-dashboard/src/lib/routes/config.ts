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
const { DATA_DIR, AI_LIB, PLUGIN_ROOT, CUSTOM_PROVIDERS_FILE, PERSONAS_DIR, CORE_DIR, MODES_DIR, LORES_DIR } = require('../paths') as {
  DATA_DIR: string
  AI_LIB: string
  PLUGIN_ROOT: string
  CUSTOM_PROVIDERS_FILE: string
  PERSONAS_DIR: string
  CORE_DIR: string
  MODES_DIR: string
  LORES_DIR: string
}
const { checkPortState } = require('../tools') as typeof import('../tools')

type LoreScope = 'always' | 'keyword' | 'none'
type LoreNumberValue = number | ''

interface ParsedDashboardFrontmatter {
  meta: FrontmatterMeta
  body: string
  raw: string
}

interface FrontmatterMeta {
  [key: string]: unknown
  name?: string
  description?: string
  lore?: string
  will?: string | number
  nsfw?: string
  voice?: string
  voice_id?: string
  voice_asset_id?: string
  voice_style?: string
  keywords?: string
  scope?: string
  summary?: string
  maxChars?: string | number
  max_chars?: string | number
  priority?: string | number
  content?: string
}

interface LorePayload extends FrontmatterMeta {
  content: string
}

interface LoreListItem {
  id: unknown
  description: unknown
  keywords?: unknown
  scope?: unknown
  summary?: unknown
  maxChars?: unknown
  priority?: unknown
  file: string
}

interface LoreDocument {
  name: unknown
  description: unknown
  keywords: unknown
  scope: unknown
  summary: unknown
  maxChars: unknown
  priority: unknown
  content: string
}

interface LoreDeleteBody {
  name?: unknown
}

interface PersonaDiagnostic {
  level?: string
  code?: string
  message?: string
  field?: string
}

interface ModeSummary {
  name: unknown
  file: string
  description: unknown
}

interface ProviderModel {
  id: string
  name: string
  vision: boolean
}

interface ProviderDefinition {
  name: string
  baseURL: string
  models: ProviderModel[]
}

interface ProviderRegistryEntry extends ProviderDefinition {
  id: string
  keyFile?: string
  custom: boolean
}

type ProviderMap = Record<string, ProviderDefinition>

interface ConfigJsonBody {
  provider?: unknown
  model?: unknown
  baseUrl?: unknown
}

interface RuntimeConfigModule {
  resetConfigCache(): void
}

interface PersonaListItem {
  name: string
  description?: string
  type?: string
}

interface PersonaModule {
  getAvailablePersonals(): PersonaListItem[]
  loadPersonalSkill(name: string): string | null
}

interface PersonaWriteBody extends FrontmatterMeta {
  content?: string
}

interface PersonaDeleteBody {
  name?: string
}

function getLegacyErrorMessage(error: unknown): unknown {
  return error && typeof error === 'object' && 'message' in error ? (error as { message?: unknown }).message : undefined
}

function parseFrontmatter(content: unknown): ParsedDashboardFrontmatter {
  const raw = String(content || '').replace(/\uFEFF/g, '')
  const { parseFrontmatterDocument } = require(path.join(AI_LIB, 'core', 'frontmatter')) as typeof import('koishi-plugin-dongxuelian-ai/lib/core/frontmatter')
  const parsed = parseFrontmatterDocument(raw)
  return { meta: parsed.meta, body: parsed.body, raw }
}

function cleanFrontmatterValue(value: unknown, maxLength = 240): string {
  return String(value || '').replace(/[\r\n]+/g, ' ').trim().slice(0, maxLength)
}

function buildPersonaFrontmatter(meta: FrontmatterMeta, overrides: FrontmatterMeta = {}): string {
  const next = { ...meta, ...overrides }
  const knownKeys = new Set(['name', 'description', 'lore', 'will', 'nsfw', 'voice', 'voice_id', 'voice_asset_id', 'voice_style'])
  const lines = [
    `name: ${next.name}`,
    `description: ${next.description || ''}`,
  ]
  if (next.lore && next.lore !== 'none') lines.push(`lore: ${next.lore}`)
  lines.push(`will: ${next.will !== undefined && next.will !== '' ? parseFloat(String(next.will)) : 1.0}`)
  if (next.nsfw && next.nsfw !== 'none') lines.push(`nsfw: ${next.nsfw}`)
  if (next.voice_id || next.voice) lines.push(`voice_id: ${cleanFrontmatterValue(next.voice_id || next.voice, 80)}`)
  if (next.voice_asset_id) lines.push(`voice_asset_id: ${cleanFrontmatterValue(next.voice_asset_id, 120)}`)
  if (next.voice_style) lines.push(`voice_style: ${cleanFrontmatterValue(next.voice_style)}`)
  for (const [key, value] of Object.entries(next)) {
    if (knownKeys.has(key)) continue
    const clean = cleanFrontmatterValue(value)
    if (clean) lines.push(`${key}: ${clean}`)
  }
  return `---\n${lines.join('\n')}\n---\n\n`
}

function cleanLoreName(value: unknown): string {
  return String(value || '').replace(/[^a-zA-Z0-9\u4e00-\u9fff_-]/g, '').trim()
}

function normalizeLoreScope(value: unknown): LoreScope {
  const text = String(value || '').trim().toLowerCase()
  if (text === 'always' || text === 'keyword' || text === 'none') return text
  return 'keyword'
}

function normalizeLoreNumber(value: unknown, fallback: '', min: number, max: number): LoreNumberValue {
  if (value === undefined || value === null || value === '') return ''
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(min, Math.min(max, parsed))
}

function normalizeLorePayload(data: FrontmatterMeta = {}, existingName = ''): LorePayload {
  const name = cleanLoreName(data.name || existingName)
  return {
    name,
    description: cleanFrontmatterValue(data.description, 240),
    keywords: cleanFrontmatterValue(data.keywords, 500),
    scope: normalizeLoreScope(data.scope),
    summary: cleanFrontmatterValue(data.summary, 1200),
    maxChars: normalizeLoreNumber(data.maxChars ?? data.max_chars, '', 200, 12000),
    priority: normalizeLoreNumber(data.priority, '', -100, 100),
    content: String(data.content || ''),
  }
}

function buildLoreFrontmatter(meta: FrontmatterMeta, overrides: FrontmatterMeta = {}) {
  const next = { ...meta, ...overrides }
  const knownKeys = new Set(['name', 'description', 'keywords', 'scope', 'summary', 'max_chars', 'maxChars', 'priority', 'content'])
  const lines = [
    `name: ${cleanLoreName(next.name)}`,
    `description: ${cleanFrontmatterValue(next.description, 240)}`,
  ]
  const keywords = cleanFrontmatterValue(next.keywords, 500)
  if (keywords) lines.push(`keywords: ${keywords}`)
  const scope = normalizeLoreScope(next.scope)
  if (scope && scope !== 'keyword') lines.push(`scope: ${scope}`)
  const summary = cleanFrontmatterValue(next.summary, 1200)
  if (summary) lines.push(`summary: ${summary}`)
  const maxChars = normalizeLoreNumber(next.maxChars ?? next.max_chars, '', 200, 12000)
  if (maxChars !== '') lines.push(`max_chars: ${maxChars}`)
  const priority = normalizeLoreNumber(next.priority, '', -100, 100)
  if (priority !== '') lines.push(`priority: ${priority}`)
  for (const [key, value] of Object.entries(next)) {
    if (knownKeys.has(key)) continue
    const clean = cleanFrontmatterValue(value)
    if (clean) lines.push(`${key}: ${clean}`)
  }
  return `---\n${lines.join('\n')}\n---\n\n`
}

// Reads only non-sensitive release identity fields from the current immutable release.
function readReleaseMetadata(): Record<string, unknown> | null {
  try {
    const manifestPath = path.resolve(PLUGIN_ROOT, '..', '..', 'release-manifest.json')
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as Record<string, unknown>
    return {
      releaseId: String(manifest.releaseId || ''),
      version: String(manifest.version || ''),
      commit: String(manifest.commit || ''),
      builtAt: String(manifest.builtAt || ''),
      manifestHash: String(manifest.manifestHash || ''),
      contentHash: String(manifest.contentHash || ''),
    }
  } catch {
    return null
  }
}

function handleGetStatus(req: IncomingMessage, res: ServerResponse): void {
  return json(res, {
    provider: readFileSyncSafe(path.join(DATA_DIR, 'ai-provider.txt')) || 'deepseek',
    model: readFileSyncSafe(path.join(DATA_DIR, 'ai-model.txt')) || '',
    release: readReleaseMetadata(),
  })
}

// Exposes a public, non-sensitive endpoint for release activation health checks.
function handleGetReleaseStatus(req: IncomingMessage, res: ServerResponse): void {
  const botPort = Number(process.env.KOISHI_PORT || 5140)
  return json(res, { ok: true, release: readReleaseMetadata(), bot: { port: botPort, listening: checkPortState(botPort).status === 'occupied' } })
}

function handleGetProviders(req: IncomingMessage, res: ServerResponse): void {
  try {
    const registry = require(path.join(AI_LIB, 'core', 'provider-registry')) as typeof import('koishi-plugin-dongxuelian-ai/lib/core/provider-registry')
    const merged = registry.getMergedProviderMapSync()
    const publicMap = {} as ProviderMap
    for (const [id, provider] of Object.entries(merged) as Array<[string, ProviderRegistryEntry]>) {
      publicMap[id] = {
        name: provider.name,
        baseURL: provider.baseURL,
        models: Array.isArray(provider.models) ? provider.models : [],
      }
    }
    return json(res, publicMap)
  } catch {
    const { PROVIDERS } = require(path.join(AI_LIB, 'core', 'constants')) as { PROVIDERS: ProviderMap }
    return json(res, PROVIDERS)
  }
}

function handleGetConfig(req: IncomingMessage, res: ServerResponse): void {
  return json(res, {
    provider: readFileSyncSafe(path.join(DATA_DIR, 'ai-provider.txt')) || 'deepseek',
    model: readFileSyncSafe(path.join(DATA_DIR, 'ai-model.txt')) || '',
    baseUrl: readFileSyncSafe(path.join(DATA_DIR, 'ai-base-url.txt')) || '',
  })
}

function handlePutConfig(req: IncomingMessage, res: ServerResponse): void {
  if (!requireAdmin(req, res)) return
  collectBody(req, res, (body) => {
    try {
      const data = JSON.parse(body) as ConfigJsonBody
      if (data.provider !== undefined) writeFileSyncSafe(path.join(DATA_DIR, 'ai-provider.txt'), data.provider)
      if (data.model !== undefined) writeFileSyncSafe(path.join(DATA_DIR, 'ai-model.txt'), data.model)
      if (data.baseUrl !== undefined) writeFileSyncSafe(path.join(DATA_DIR, 'ai-base-url.txt'), data.baseUrl)
      const { resetConfigCache } = require(path.join(AI_LIB, 'core', 'runtime-config')) as RuntimeConfigModule
      resetConfigCache()
      json(res, { ok: true, message: '配置已更新' })
    } catch (e) { json(res, { ok: false, message: getLegacyErrorMessage(e) }, 400) }
  })
}

function handleGetPersonas(req: IncomingMessage, res: ServerResponse, pathname: string, url: URL): void {
  try {
    const { getAvailablePersonals, loadPersonalSkill } = require(path.join(AI_LIB, 'persona', 'persona')) as PersonaModule
    const name = url.searchParams.get('name')
    if (name) {
      const content = loadPersonalSkill(name)
      if (!content) return json(res, { ok: false, message: '未找到人格' }, 404)
      const { meta, body: bodyContent } = parseFrontmatter(content)
      return json(res, { ok: true, data: { name, description: meta.description || '', lore: meta.lore || '', will: meta.will || 1.0, nsfw: meta.nsfw || 'none', content: bodyContent } })
    }
    return json(res, getAvailablePersonals().map(p => ({ name: p.name, description: p.description, type: p.type || 'persona' })))
  } catch { return json(res, []) }
}

function handlePostPersonas(req: IncomingMessage, res: ServerResponse): void {
  if (!requireAdmin(req, res)) return
  collectBody(req, res, (body) => {
    try {
      const { name, description, lore, will, nsfw, content } = JSON.parse(body) as PersonaWriteBody
      if (!name || !content) return json(res, { ok: false, message: '名称和内容不能为空' }, 400)
      const sanitized = name.replace(/[^a-zA-Z0-9\u4e00-\u9fff_-]/g, '')
      const filePath = path.join(PERSONAS_DIR, 'SKILL.' + sanitized + '.md')
      if (fs.existsSync(filePath)) return json(res, { ok: false, message: '同名人格已存在' }, 400)
      const md = buildPersonaFrontmatter({}, { name: sanitized, description, lore, will, nsfw }) + content
      fs.writeFileSync(filePath, md, 'utf8')
      json(res, { ok: true, message: '人格 ' + sanitized + ' 已创建' })
    } catch (e) { json(res, { ok: false, message: getLegacyErrorMessage(e) }, 400) }
  })
}

function handleDeletePersonas(req: IncomingMessage, res: ServerResponse): void {
  if (!requireAdmin(req, res)) return
  collectBody(req, res, (body) => {
    try {
      const { name } = JSON.parse(body) as PersonaDeleteBody
      if (!name) return json(res, { ok: false, message: '名称不能为空' }, 400)
      const all = (require(path.join(AI_LIB, 'persona', 'persona')) as PersonaModule).getAvailablePersonals()
      if (all.find(p => p.name === name)?.type === 'core') return json(res, { ok: false, message: '核心规则不可删除' }, 400)
      if (all.find(p => p.name === name)?.type === 'mode') return json(res, { ok: false, message: '默认人格不可删除' }, 400)
      const files = fs.readdirSync(PERSONAS_DIR).filter(f => /^SKILL(\.[^.]+)?\.md$/i.test(f))
      let deleted = false
      for (const f of files) {
        const raw = String(fs.readFileSync(path.join(PERSONAS_DIR, f), 'utf8') || '').replace(/^\uFEFF/, '')
        const metaName = parseFrontmatter(raw).meta.name || ''
        if (metaName === name) {
          fs.unlinkSync(path.join(PERSONAS_DIR, f))
          deleted = true
          break
        }
      }
      if (!deleted) return json(res, { ok: false, message: '未找到人格 ' + name }, 404)
      json(res, { ok: true, message: '人格 ' + name + ' 已删除' })
    } catch (e) { json(res, { ok: false, message: getLegacyErrorMessage(e) }, 400) }
  })
}

function handlePutPersonas(req: IncomingMessage, res: ServerResponse): void {
  if (!requireAdmin(req, res)) return
  collectBody(req, res, (body) => {
    try {
      const { name, description, lore, will, nsfw, content } = JSON.parse(body) as PersonaWriteBody
      if (!name || !content) return json(res, { ok: false, message: '名称和内容不能为空' }, 400)
      const searchDirs = [PERSONAS_DIR, CORE_DIR, MODES_DIR]
      let found = false
      for (const dir of searchDirs) {
        const files = fs.readdirSync(dir).filter(f => /^SKILL(\.[^.]+)?\.md$/i.test(f))
        for (const f of files) {
          const parsed = parseFrontmatter(fs.readFileSync(path.join(dir, f), 'utf8'))
          const metaName = parsed.meta.name || ''
          if (metaName === name) {
            const md = buildPersonaFrontmatter(parsed.meta, { name, description, lore, will, nsfw }) + content
            fs.writeFileSync(path.join(dir, f), md, 'utf8')
            found = true
            break
          }
        }
        if (found) break
      }
      if (!found) return json(res, { ok: false, message: '未找到人格 ' + name }, 404)
      json(res, { ok: true, message: '人格 ' + name + ' 已更新' })
    } catch (e) { json(res, { ok: false, message: getLegacyErrorMessage(e) }, 400) }
  })
}

function handleGetLoreList(req: IncomingMessage, res: ServerResponse): void {
  try {
    const files = fs.readdirSync(LORES_DIR).filter(f => f.endsWith('.md'))
    const list: LoreListItem[] = files.map(f => {
      const raw = String(fs.readFileSync(path.join(LORES_DIR, f), 'utf8') || '').replace(/^\uFEFF/, '')
      const parsed = parseFrontmatter(raw)
      const name = parsed.meta.name || f.replace('SKILL.', '').replace('.md', '')
      const desc = parsed.meta.description || ''
      return {
        id: name,
        description: desc,
        keywords: parsed.meta.keywords || '',
        scope: parsed.meta.scope || 'keyword',
        summary: parsed.meta.summary || '',
        maxChars: parsed.meta.max_chars || parsed.meta.maxChars || '',
        priority: parsed.meta.priority || '',
        file: f,
      }
    })
    list.unshift({ id: 'none', description: '不绑定任何世界观', file: '' })
    return json(res, list)
  } catch { return json(res, [{ id: 'none', description: '不绑定任何世界观', file: '' }]) }
}

function handleGetLores(req: IncomingMessage, res: ServerResponse): void {
  try {
    const files = fs.readdirSync(LORES_DIR).filter(f => f.endsWith('.md'))
    return json(res, files.map((f): LoreDocument => {
      const raw = String(fs.readFileSync(path.join(LORES_DIR, f), 'utf8') || '').replace(/^\uFEFF/, '')
      const parsed = parseFrontmatter(raw)
      const name = parsed.meta.name || f.replace(/^SKILL\./, '').replace(/\.md$/, '')
      return {
        name,
        description: parsed.meta.description || '',
        keywords: parsed.meta.keywords || '',
        scope: parsed.meta.scope || 'keyword',
        summary: parsed.meta.summary || '',
        maxChars: parsed.meta.max_chars || parsed.meta.maxChars || '',
        priority: parsed.meta.priority || '',
        content: parsed.body,
      }
    }))
  } catch { return json(res, []) }
}

function handlePostLores(req: IncomingMessage, res: ServerResponse): void {
  if (!requireAdmin(req, res)) return
  collectBody(req, res, (body) => {
    try {
      const payload = normalizeLorePayload(JSON.parse(body) as FrontmatterMeta)
      const { name, content } = payload
      if (!name || !content) return json(res, { ok: false, message: '名称和内容不能为空' }, 400)
      const filePath = path.join(LORES_DIR, 'SKILL.' + name + '.md')
      if (fs.existsSync(filePath)) return json(res, { ok: false, message: '同名世界观已存在' }, 400)
      const md = buildLoreFrontmatter({}, payload) + content
      fs.writeFileSync(filePath, md, 'utf8')
      json(res, { ok: true, message: '世界观 ' + name + ' 已创建' })
    } catch (e) { json(res, { ok: false, message: getLegacyErrorMessage(e) }, 400) }
  })
}

function handlePutLores(req: IncomingMessage, res: ServerResponse): void {
  if (!requireAdmin(req, res)) return
  collectBody(req, res, (body) => {
    try {
      const payload = normalizeLorePayload(JSON.parse(body) as FrontmatterMeta)
      const { name, content } = payload
      if (!name || !content) return json(res, { ok: false, message: '名称和内容不能为空' }, 400)
      const files = fs.readdirSync(LORES_DIR).filter(f => f.endsWith('.md'))
      let found = false
      for (const f of files) {
        const raw = String(fs.readFileSync(path.join(LORES_DIR, f), 'utf8') || '').replace(/^\uFEFF/, '')
        const parsed = parseFrontmatter(raw)
        const metaName = parsed.meta.name || f.replace(/^SKILL\./, '').replace(/\.md$/, '')
        if (metaName === name) {
          const md = buildLoreFrontmatter(parsed.meta, payload) + content
          fs.writeFileSync(path.join(LORES_DIR, f), md, 'utf8')
          found = true
          break
        }
      }
      if (!found) return json(res, { ok: false, message: '未找到世界观 ' + name }, 404)
      json(res, { ok: true, message: '世界观 ' + name + ' 已更新' })
    } catch (e) { json(res, { ok: false, message: getLegacyErrorMessage(e) }, 400) }
  })
}

function handleDeleteLores(req: IncomingMessage, res: ServerResponse): void {
  if (!requireAdmin(req, res)) return
  collectBody(req, res, (body) => {
    try {
      const { name } = JSON.parse(body) as LoreDeleteBody
      if (!name) return json(res, { ok: false, message: '名称不能为空' }, 400)
      const files = fs.readdirSync(LORES_DIR).filter(f => f.endsWith('.md'))
      let deleted = false
      for (const f of files) {
        const raw = String(fs.readFileSync(path.join(LORES_DIR, f), 'utf8') || '').replace(/^\uFEFF/, '')
        const parsed = parseFrontmatter(raw)
        const metaName = parsed.meta.name || f.replace(/^SKILL\./, '').replace(/\.md$/, '')
        if (metaName === name) {
          fs.unlinkSync(path.join(LORES_DIR, f))
          deleted = true
          break
        }
      }
      if (!deleted) return json(res, { ok: false, message: '未找到世界观 ' + name }, 404)
      json(res, { ok: true, message: '世界观 ' + name + ' 已删除' })
    } catch (e) { json(res, { ok: false, message: getLegacyErrorMessage(e) }, 400) }
  })
}

function handleGetModes(req: IncomingMessage, res: ServerResponse): void {
  try {
    const files = fs.readdirSync(MODES_DIR).filter(f => f.endsWith('.md'))
    return json(res, files.map((f): ModeSummary => {
      const raw = String(fs.readFileSync(path.join(MODES_DIR, f), 'utf8') || '').replace(/^\uFEFF/, '')
      const parsed = parseFrontmatter(raw)
      const name = parsed.meta.name || f.replace('.md', '')
      const desc = parsed.meta.description || ''
      return { name, file: f, description: desc }
    }))
  } catch { return json(res, []) }
}

function toPublicPersonaDiagnostic(item: PersonaDiagnostic = {}) {
  return {
    level: item.level || 'warning',
    code: item.code || 'unknown',
    message: item.message || '',
    field: item.field || '',
  }
}

function handleGetPersonaDiagnostics(req: IncomingMessage, res: ServerResponse): void {
  try {
    const diagnostics = require(path.join(AI_LIB, 'persona', 'persona-diagnostics')) as typeof import('koishi-plugin-dongxuelian-ai/lib/persona/persona-diagnostics')
    const result = diagnostics.scanPersonaDocuments()
    const documents = Array.isArray(result.documents) ? result.documents : []
    return json(res, {
      ok: !!result.ok,
      summary: result.summary || { totalDocuments: 0, totals: { error: 0, warning: 0, info: 0 }, byType: {} },
      documents: documents.map(doc => ({
        type: doc.type || '',
        name: diagnostics.getPersonaDocumentName(doc),
        file: path.basename(doc.file || ''),
        hasFrontmatter: !!doc.hasFrontmatter,
        schemaVersion: Number(doc.schemaVersion) || 0,
        diagnostics: (doc.diagnostics || []).map(toPublicPersonaDiagnostic),
      })),
    })
  } catch (e) {
    return json(res, { ok: false, message: getLegacyErrorMessage(e) || '人格诊断失败' }, 500)
  }
}

const routes = {
  'GET /dashboard/api/status': handleGetStatus,
  'GET /dashboard/api/release-status': handleGetReleaseStatus,
  'GET /dashboard/api/providers': handleGetProviders,
  'GET /dashboard/api/config': handleGetConfig,
  'PUT /dashboard/api/config': handlePutConfig,
  'GET /dashboard/api/personas': handleGetPersonas,
  'POST /dashboard/api/personas': handlePostPersonas,
  'DELETE /dashboard/api/personas': handleDeletePersonas,
  'PUT /dashboard/api/personas': handlePutPersonas,
  'GET /dashboard/api/lore-list': handleGetLoreList,
  'GET /dashboard/api/lores': handleGetLores,
  'POST /dashboard/api/lores': handlePostLores,
  'PUT /dashboard/api/lores': handlePutLores,
  'DELETE /dashboard/api/lores': handleDeleteLores,
  'GET /dashboard/api/modes': handleGetModes,
  'GET /dashboard/api/persona-diagnostics': handleGetPersonaDiagnostics,
}

export = {
  routes,
  _test: {
    parseFrontmatter,
    buildPersonaFrontmatter,
    parseModeFrontmatter: parseFrontmatter,
    cleanLoreName,
    normalizeLoreScope,
    normalizeLorePayload,
    buildLoreFrontmatter,
  },
}
