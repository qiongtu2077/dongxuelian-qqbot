/**
 * MODULE: 人格管理。
 * 职责: 加载/保存/查询群组和个人人格配置。
 * 边界: 只操作人格配置文件和缓存，不调 AI API，不改 conversation。
 */
const { PERSONA_GROUPS_FILE, PERSONA_USERS_FILE, SKILLS_PERSONAS_DIR, SKILLS_CORE_DIR } = require('./constants')
const path = require('path')

let personaGroupsCache = {}
let personaUsersCache = {}

function atomicWriteJson(filePath, data) {
  const tmp = filePath + '.tmp'
  require('fs').writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8')
  require('fs').renameSync(tmp, filePath)
}

function loadPersonaGroups() {
  try { personaGroupsCache = JSON.parse(require('fs').readFileSync(PERSONA_GROUPS_FILE, 'utf8')) } catch { personaGroupsCache = {} }
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
  try { personaUsersCache = JSON.parse(require('fs').readFileSync(PERSONA_USERS_FILE, 'utf8')) } catch { personaUsersCache = {} }
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

function getAvailablePersonals() {
  const personas = []
  function scanDir(dir, type) {
    try {
      const entries = require('fs').readdirSync(dir, { withFileTypes: true })
      for (const entry of entries) {
        if (!entry.isFile() || !/^SKILL(\.[^.]+)?\.md$/i.test(entry.name)) continue
        const content = require('fs').readFileSync(path.join(dir, entry.name), 'utf8').trim()
        if (!content) continue
        const meta = parsePersonaFrontmatter(content)
        if (meta.name) personas.push({ name: meta.name, description: meta.description || '', file: entry.name, type, dir })
      }
    } catch {}
  }
  scanDir(SKILLS_PERSONAS_DIR, 'persona')
  scanDir(SKILLS_CORE_DIR, 'core')
  return personas
}

function loadPersonalSkill(personaName) {
  const dirs = [SKILLS_PERSONAS_DIR, SKILLS_CORE_DIR]
  for (const dir of dirs) {
    try {
      const entries = require('fs').readdirSync(dir)
      for (const entry of entries) {
        if (!/^SKILL(\.[^.]+)?\.md$/i.test(entry)) continue
        const content = require('fs').readFileSync(path.join(dir, entry), 'utf8').trim()
        const meta = parsePersonaFrontmatter(content)
        if (meta.name === personaName) { console.error(`[persona] loaded skill: ${entry} name=${meta.name}`); return content }
      }
    } catch {}
  }
  console.error(`[persona] no skill found for name=${personaName}`)
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
