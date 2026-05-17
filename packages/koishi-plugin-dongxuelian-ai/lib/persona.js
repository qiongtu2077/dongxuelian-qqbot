/**
 * MODULE: 人格管理。
 * 职责: 加载/保存/查询群组和个人人格配置。
 * 边界: 只操作人格配置文件和缓存，不调 AI API，不改 conversation。
 */
const { PERSONA_GROUPS_FILE, PERSONA_USERS_FILE, SKILLS_PERSONAS_DIR, SKILLS_CORE_DIR, SKILLS_MODES_DIR } = require('./constants')
const { isDebugLogEnabled } = require('./logging-config')
const path = require('path')

let personaGroupsCache = {}
let personaUsersCache = {}
const MAX_PERSONA_CONFIG_BYTES = parsePersonaPositiveInt(process.env.DONGXUELIAN_PERSONA_CONFIG_MAX_BYTES, 256 * 1024, 4 * 1024, 1024 * 1024)
const MAX_PERSONA_SKILL_BYTES = parsePersonaPositiveInt(process.env.DONGXUELIAN_PERSONA_SKILL_MAX_BYTES, 256 * 1024, 8 * 1024, 2 * 1024 * 1024)

function parsePersonaPositiveInt(value, fallback, min, max) {
  const parsed = parseInt(value, 10)
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(min, Math.min(max, parsed))
}

function readTextIfSmall(file, maxBytes) {
  try {
    const fs = require('fs')
    const stat = fs.statSync(file)
    if (!stat.isFile() || stat.size > maxBytes) return ''
    return fs.readFileSync(file, 'utf8').trim()
  } catch {
    return ''
  }
}

function readJsonIfSmall(file, fallback) {
  try {
    const text = readTextIfSmall(file, MAX_PERSONA_CONFIG_BYTES)
    return text ? JSON.parse(text) : fallback
  } catch {
    return fallback
  }
}

function atomicWriteJson(filePath, data) {
  const tmp = filePath + '.tmp'
  require('fs').writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8')
  require('fs').renameSync(tmp, filePath)
}

function loadPersonaGroups() {
  personaGroupsCache = readJsonIfSmall(PERSONA_GROUPS_FILE, {})
}

function getGroupPersona(channelKey) { const e = personaGroupsCache[String(channelKey)]; return e && e.persona ? e : null }

function setGroupPersona(channelKey, personaName) {
  const key = String(channelKey)
  if (!personaGroupsCache[key]) personaGroupsCache[key] = {}
  if (personaName !== undefined) personaGroupsCache[key].persona = personaName
  atomicWriteJson(PERSONA_GROUPS_FILE, personaGroupsCache)
}

function resetGroupPersona(channelKey) { delete personaGroupsCache[String(channelKey)]; atomicWriteJson(PERSONA_GROUPS_FILE, personaGroupsCache) }

function loadPersonaUsers() {
  personaUsersCache = readJsonIfSmall(PERSONA_USERS_FILE, {})
}

function getUserPersona(userId) { return personaUsersCache[String(userId)] || null }

function setUserPersona(userId, personaName) { personaUsersCache[String(userId)] = personaName; atomicWriteJson(PERSONA_USERS_FILE, personaUsersCache) }

function resetUserPersona(userId) { delete personaUsersCache[String(userId)]; atomicWriteJson(PERSONA_USERS_FILE, personaUsersCache) }

function resolvePersona(channelKey, userId) {
  const userPersona = getUserPersona(userId)
  if (userPersona) return { source: 'user', name: userPersona }
  const groupEntry = getGroupPersona(channelKey)
  if (groupEntry) return { source: 'group', name: groupEntry.persona }
  return { source: 'default', name: null }
}

function parsePersonaFrontmatter(content) {
  const m = content.match(/^---\n([\s\S]*?)\n---/)
  if (!m) return {}
  const meta = {}
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^(\w[\w_-]*):\s*(.+)$/)
    if (kv) meta[kv[1]] = kv[2].trim() === 'true' ? true : kv[2].trim() === 'false' ? false : kv[2].trim()
  }
  return meta
}

function getAvailablePersonals({ userFacing = false } = {}) {
  const personas = []
  function scanDir(dir, type) {
    try {
      const entries = require('fs').readdirSync(dir, { withFileTypes: true })
      for (const entry of entries) {
        if (!entry.isFile() || !/^SKILL(\.[^.]+)?\.md$/i.test(entry.name)) continue
        const content = readTextIfSmall(path.join(dir, entry.name), MAX_PERSONA_SKILL_BYTES)
        if (!content) continue
        const meta = parsePersonaFrontmatter(content)
        if (meta.name) personas.push({ name: meta.name, description: meta.description || '', file: entry.name, type, dir })
      }
    } catch {}
  }
  scanDir(SKILLS_PERSONAS_DIR, 'persona')
  if (!userFacing) {
    scanDir(SKILLS_CORE_DIR, 'core')
    scanDir(SKILLS_MODES_DIR, 'mode')
  }
  return personas
}

function loadPersonalSkill(personaName) {
  const dirs = [SKILLS_PERSONAS_DIR, SKILLS_CORE_DIR, SKILLS_MODES_DIR]
  for (const dir of dirs) {
    try {
      const entries = require('fs').readdirSync(dir)
      for (const entry of entries) {
        if (!/^SKILL(\.[^.]+)?\.md$/i.test(entry)) continue
        const content = readTextIfSmall(path.join(dir, entry), MAX_PERSONA_SKILL_BYTES)
        const meta = parsePersonaFrontmatter(content)
        if (meta.name === personaName) {
          if (isDebugLogEnabled('persona')) console.warn(`[dongxuelian-ai] persona skill loaded: ${entry} name=${meta.name}`)
          return content
        }
      }
    } catch {}
  }
  if (isDebugLogEnabled('persona')) console.warn(`[dongxuelian-ai] persona skill not found: ${personaName}`)
  return null
}

module.exports = {
  personaGroupsCache, personaUsersCache,
  atomicWriteJson,
  loadPersonaGroups, getGroupPersona, setGroupPersona, resetGroupPersona,
  loadPersonaUsers, getUserPersona, setUserPersona, resetUserPersona,
  resolvePersona,
  parsePersonaFrontmatter,
  getAvailablePersonals, loadPersonalSkill,
}
