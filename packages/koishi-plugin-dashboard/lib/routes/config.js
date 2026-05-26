'use strict'

const fs = require('fs')
const path = require('path')
const { json, collectBody, readFileSyncSafe, writeFileSyncSafe } = require('../utils')
const { requireAdmin } = require('../auth')
const { DATA_DIR, AI_LIB, CUSTOM_PROVIDERS_FILE, PERSONAS_DIR, CORE_DIR, MODES_DIR, LORES_DIR } = require('../paths')
const { parseFrontmatterDocument } = require(path.join(AI_LIB, 'core', 'frontmatter'))

function parseFrontmatter(content) {
  const raw = String(content || '').replace(/\uFEFF/g, '')
  const parsed = parseFrontmatterDocument(raw)
  return { meta: parsed.meta, body: parsed.body, raw }
}

function cleanFrontmatterValue(value, maxLength = 240) {
  return String(value || '').replace(/[\r\n]+/g, ' ').trim().slice(0, maxLength)
}

function buildPersonaFrontmatter(meta, overrides = {}) {
  const next = { ...meta, ...overrides }
  const knownKeys = new Set(['name', 'description', 'lore', 'will', 'nsfw', 'voice', 'voice_id', 'voice_asset_id', 'voice_style'])
  const lines = [
    `name: ${next.name}`,
    `description: ${next.description || ''}`,
  ]
  if (next.lore && next.lore !== 'none') lines.push(`lore: ${next.lore}`)
  lines.push(`will: ${next.will !== undefined && next.will !== '' ? parseFloat(next.will) : 1.0}`)
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

function cleanLoreName(value) {
  return String(value || '').replace(/[^a-zA-Z0-9\u4e00-\u9fff_-]/g, '').trim()
}

function normalizeLoreScope(value) {
  const text = String(value || '').trim().toLowerCase()
  if (text === 'always' || text === 'keyword' || text === 'none') return text
  return 'keyword'
}

function normalizeLoreNumber(value, fallback, min, max) {
  if (value === undefined || value === null || value === '') return ''
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(min, Math.min(max, parsed))
}

function normalizeLorePayload(data = {}, existingName = '') {
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

function buildLoreFrontmatter(meta, overrides = {}) {
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

function handleGetStatus(req, res) {
  return json(res, {
    provider: readFileSyncSafe(path.join(DATA_DIR, 'ai-provider.txt')) || 'deepseek',
    model: readFileSyncSafe(path.join(DATA_DIR, 'ai-model.txt')) || '',
  })
}

function handleGetProviders(req, res) {
  const { PROVIDERS } = require(path.join(AI_LIB, 'core', 'constants'))
  const merged = { ...PROVIDERS }
  try {
    const raw = fs.readFileSync(CUSTOM_PROVIDERS_FILE, 'utf8')
    const custom = JSON.parse(raw)
    if (Array.isArray(custom)) {
      for (const p of custom) {
        if (p.id && p.name && p.baseURL) {
          merged[p.id] = { name: p.name, baseURL: p.baseURL, models: Array.isArray(p.models) ? p.models : [] }
        }
      }
    }
  } catch {}
  return json(res, merged)
}

function handleGetConfig(req, res) {
  return json(res, {
    provider: readFileSyncSafe(path.join(DATA_DIR, 'ai-provider.txt')) || 'deepseek',
    model: readFileSyncSafe(path.join(DATA_DIR, 'ai-model.txt')) || '',
    baseUrl: readFileSyncSafe(path.join(DATA_DIR, 'ai-base-url.txt')) || '',
  })
}

function handlePutConfig(req, res) {
  if (!requireAdmin(req, res)) return
  collectBody(req, res, (body) => {
    try {
      const data = JSON.parse(body)
      if (data.provider !== undefined) writeFileSyncSafe(path.join(DATA_DIR, 'ai-provider.txt'), data.provider)
      if (data.model !== undefined) writeFileSyncSafe(path.join(DATA_DIR, 'ai-model.txt'), data.model)
      if (data.baseUrl !== undefined) writeFileSyncSafe(path.join(DATA_DIR, 'ai-base-url.txt'), data.baseUrl)
      const { resetConfigCache } = require(path.join(AI_LIB, 'core', 'runtime-config'))
      resetConfigCache()
      json(res, { ok: true, message: '配置已更新' })
    } catch (e) { json(res, { ok: false, message: e.message }, 400) }
  })
}

function handleGetPersonas(req, res, pathname, url) {
  try {
    const { getAvailablePersonals, loadPersonalSkill } = require(path.join(AI_LIB, 'persona', 'persona'))
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

function handlePostPersonas(req, res) {
  if (!requireAdmin(req, res)) return
  collectBody(req, res, (body) => {
    try {
      const { name, description, lore, will, nsfw, content } = JSON.parse(body)
      if (!name || !content) return json(res, { ok: false, message: '名称和内容不能为空' }, 400)
      const sanitized = name.replace(/[^a-zA-Z0-9\u4e00-\u9fff_-]/g, '')
      const filePath = path.join(PERSONAS_DIR, 'SKILL.' + sanitized + '.md')
      if (fs.existsSync(filePath)) return json(res, { ok: false, message: '同名人格已存在' }, 400)
      const md = buildPersonaFrontmatter({}, { name: sanitized, description, lore, will, nsfw }) + content
      fs.writeFileSync(filePath, md, 'utf8')
      json(res, { ok: true, message: '人格 ' + sanitized + ' 已创建' })
    } catch (e) { json(res, { ok: false, message: e.message }, 400) }
  })
}

function handleDeletePersonas(req, res) {
  if (!requireAdmin(req, res)) return
  collectBody(req, res, (body) => {
    try {
      const { name } = JSON.parse(body)
      if (!name) return json(res, { ok: false, message: '名称不能为空' }, 400)
      const all = require(path.join(AI_LIB, 'persona', 'persona')).getAvailablePersonals()
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
    } catch (e) { json(res, { ok: false, message: e.message }, 400) }
  })
}

function handlePutPersonas(req, res) {
  if (!requireAdmin(req, res)) return
  collectBody(req, res, (body) => {
    try {
      const { name, description, lore, will, nsfw, content } = JSON.parse(body)
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
    } catch (e) { json(res, { ok: false, message: e.message }, 400) }
  })
}

function handleGetLoreList(req, res) {
  try {
    const files = fs.readdirSync(LORES_DIR).filter(f => f.endsWith('.md'))
    const list = files.map(f => {
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

function handleGetLores(req, res) {
  try {
    const files = fs.readdirSync(LORES_DIR).filter(f => f.endsWith('.md'))
    return json(res, files.map(f => {
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

function handlePostLores(req, res) {
  if (!requireAdmin(req, res)) return
  collectBody(req, res, (body) => {
    try {
      const payload = normalizeLorePayload(JSON.parse(body))
      const { name, content } = payload
      if (!name || !content) return json(res, { ok: false, message: '名称和内容不能为空' }, 400)
      const filePath = path.join(LORES_DIR, 'SKILL.' + name + '.md')
      if (fs.existsSync(filePath)) return json(res, { ok: false, message: '同名世界观已存在' }, 400)
      const md = buildLoreFrontmatter({}, payload) + content
      fs.writeFileSync(filePath, md, 'utf8')
      json(res, { ok: true, message: '世界观 ' + name + ' 已创建' })
    } catch (e) { json(res, { ok: false, message: e.message }, 400) }
  })
}

function handlePutLores(req, res) {
  if (!requireAdmin(req, res)) return
  collectBody(req, res, (body) => {
    try {
      const payload = normalizeLorePayload(JSON.parse(body))
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
    } catch (e) { json(res, { ok: false, message: e.message }, 400) }
  })
}

function handleDeleteLores(req, res) {
  if (!requireAdmin(req, res)) return
  collectBody(req, res, (body) => {
    try {
      const { name } = JSON.parse(body)
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
    } catch (e) { json(res, { ok: false, message: e.message }, 400) }
  })
}

function handleGetModes(req, res) {
  try {
    const files = fs.readdirSync(MODES_DIR).filter(f => f.endsWith('.md'))
    return json(res, files.map(f => {
      const raw = String(fs.readFileSync(path.join(MODES_DIR, f), 'utf8') || '').replace(/^\uFEFF/, '')
      const parsed = parseFrontmatter(raw)
      const name = parsed.meta.name || f.replace('.md', '')
      const desc = parsed.meta.description || ''
      return { name, file: f, description: desc }
    }))
  } catch { return json(res, []) }
}

function toPublicPersonaDiagnostic(item = {}) {
  return {
    level: item.level || 'warning',
    code: item.code || 'unknown',
    message: item.message || '',
    field: item.field || '',
  }
}

function handleGetPersonaDiagnostics(req, res) {
  try {
    const diagnostics = require(path.join(AI_LIB, 'persona', 'persona-diagnostics'))
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
    return json(res, { ok: false, message: e.message || '人格诊断失败' }, 500)
  }
}

const routes = {
  'GET /dashboard/api/status': handleGetStatus,
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

module.exports = {
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
