'use strict'

const fs = require('fs')
const path = require('path')
const { json, collectBody, readFileSyncSafe, writeFileSyncSafe } = require('../utils')
const { requireAdmin } = require('../auth')
const { DATA_DIR, AI_LIB, CUSTOM_PROVIDERS_FILE, PERSONAS_DIR, CORE_DIR, MODES_DIR, LORES_DIR } = require('../paths')

function parseFrontmatter(content) {
  const raw = String(content || '').replace(/^\uFEFF/, '')
  const match = raw.match(/^---\n([\s\S]*?)\n---\n\n?/)
  if (!match) return { meta: {}, body: raw, raw }
  const meta = {}
  for (const line of match[1].split('\n')) {
    const kv = line.match(/^(\w[\w_-]*):\s*(.+)/)
    if (kv) meta[kv[1]] = kv[2].trim()
  }
  return { meta, body: raw.slice(match[0].length), raw }
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

function handleGetStatus(req, res) {
  return json(res, {
    provider: readFileSyncSafe(path.join(DATA_DIR, 'ai-provider.txt')) || 'deepseek',
    model: readFileSyncSafe(path.join(DATA_DIR, 'ai-model.txt')) || '',
  })
}

function handleGetProviders(req, res) {
  const { PROVIDERS } = require(path.join(AI_LIB, 'constants'))
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
      const { resetConfigCache } = require(path.join(AI_LIB, 'runtime-config'))
      resetConfigCache()
      json(res, { ok: true, message: '配置已更新' })
    } catch (e) { json(res, { ok: false, message: e.message }, 400) }
  })
}

function handleGetPersonas(req, res, pathname, url) {
  try {
    const { getAvailablePersonals, loadPersonalSkill } = require(path.join(AI_LIB, 'persona'))
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
      const all = require(path.join(AI_LIB, 'persona')).getAvailablePersonals()
      if (all.find(p => p.name === name)?.type === 'core') return json(res, { ok: false, message: '核心规则不可删除' }, 400)
      if (all.find(p => p.name === name)?.type === 'mode') return json(res, { ok: false, message: '默认人格不可删除' }, 400)
      const files = fs.readdirSync(PERSONAS_DIR).filter(f => /^SKILL(\.[^.]+)?\.md$/i.test(f))
      let deleted = false
      for (const f of files) {
        const raw = String(fs.readFileSync(path.join(PERSONAS_DIR, f), 'utf8') || '').replace(/^\uFEFF/, '')
        const m = raw.match(/^---\n([\s\S]*?)\n---/)
        const metaName = m?.[1]?.match(/name:\s*(.+)/)?.[1]?.trim()
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
      const m = raw.match(/^---\n([\s\S]*?)\n---/)
      const name = m?.[1]?.match(/name:\s*(\S+)/)?.[1] || f.replace('SKILL.', '').replace('.md', '')
      const desc = m?.[1]?.match(/description:\s*(.+)/)?.[1] || ''
      return { id: name, description: desc, file: f }
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
      const m = raw.match(/^---\n([\s\S]*?)\n---\n\n?/)
      let name = '', description = '', content = raw
      if (m) {
        for (const line of m[1].split('\n')) {
          const kv = line.match(/^(\w[\w_-]*):\s*(.+)/)
          if (kv) { if (kv[1] === 'name') name = kv[2].trim(); else if (kv[1] === 'description') description = kv[2].trim() }
        }
        content = raw.slice(m[0].length)
      } else {
        name = f.replace(/^SKILL\./, '').replace(/\.md$/, '')
      }
      return { name, description, content }
    }))
  } catch { return json(res, []) }
}

function handlePostLores(req, res) {
  if (!requireAdmin(req, res)) return
  collectBody(req, res, (body) => {
    try {
      const { name, description, content } = JSON.parse(body)
      if (!name || !content) return json(res, { ok: false, message: '名称和内容不能为空' }, 400)
      const filePath = path.join(LORES_DIR, 'SKILL.' + name.replace(/[^a-zA-Z0-9\u4e00-\u9fff_-]/g, '') + '.md')
      if (fs.existsSync(filePath)) return json(res, { ok: false, message: '同名世界观已存在' }, 400)
      const md = '---\nname: ' + name + '\ndescription: ' + (description || '') + '\n---\n\n' + content
      fs.writeFileSync(filePath, md, 'utf8')
      json(res, { ok: true, message: '世界观 ' + name + ' 已创建' })
    } catch (e) { json(res, { ok: false, message: e.message }, 400) }
  })
}

function handlePutLores(req, res) {
  if (!requireAdmin(req, res)) return
  collectBody(req, res, (body) => {
    try {
      const { name, description, content } = JSON.parse(body)
      if (!name || !content) return json(res, { ok: false, message: '名称和内容不能为空' }, 400)
      const files = fs.readdirSync(LORES_DIR).filter(f => f.endsWith('.md'))
      let found = false
      for (const f of files) {
        const raw = String(fs.readFileSync(path.join(LORES_DIR, f), 'utf8') || '').replace(/^\uFEFF/, '')
        const m = raw.match(/^---\n([\s\S]*?)\n---/)
        const metaName = m?.[1]?.match(/name:\s*(.+)/)?.[1]?.trim()
        if (metaName === name) {
          const md = '---\nname: ' + name + '\ndescription: ' + (description || '') + '\n---\n\n' + content
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
        const m = raw.match(/^---\n([\s\S]*?)\n---/)
        const metaName = m?.[1]?.match(/name:\s*(.+)/)?.[1]?.trim()
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
      const m = raw.match(/^---\n([\s\S]*?)\n---/)
      const name = m?.[1]?.match(/name:\s*(\S+)/)?.[1] || f.replace('.md', '')
      const desc = m?.[1]?.match(/description:\s*(.+)/)?.[1] || ''
      return { name, file: f, description: desc }
    }))
  } catch { return json(res, []) }
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
}

module.exports = { routes }
