/**
 * MODULE: 人格管理。
 * 职责: 加载/保存/查询群组和个人人格配置。
 * 边界: 只操作人格配置文件和缓存，不调 AI API，不改 conversation。
 */
const { PERSONA_GROUPS_FILE, PERSONA_USERS_FILE, SKILLS_PERSONAS_DIR, SKILLS_CORE_DIR, SKILLS_MODES_DIR } = require('../core/constants') as typeof import('../core/constants')
const { readJsonFileSync, writeJsonFileSync } = require('../core/utils') as typeof import('../core/utils')
const { isDebugLogEnabled } = require('../core/logging-config') as typeof import('../core/logging-config')
const { parseFrontmatterDocument } = require('../core/frontmatter') as typeof import('../core/frontmatter')
const path = require('path')
const { ensureRuntimeSkillSeeds } = require('./skills/skill-seeds') as typeof import('./skills/skill-seeds')

interface PersonaGroupEntry {
  persona?: string
  [key: string]: unknown
}

interface PersonaMeta {
  name?: unknown
  description?: unknown
  [key: string]: unknown
}

interface AvailablePersona {
  name: unknown
  description: unknown
  file: string
  type: string
  dir: string
}

type PersonaGroupsCache = Record<string, PersonaGroupEntry>
type PersonaUsersCache = Record<string, string>

let personaGroupsCache: PersonaGroupsCache = {}
let personaUsersCache: PersonaUsersCache = {}
const MAX_PERSONA_CONFIG_BYTES = parsePersonaPositiveInt(process.env.DONGXUELIAN_PERSONA_CONFIG_MAX_BYTES, 256 * 1024, 4 * 1024, 1024 * 1024)
const MAX_PERSONA_SKILL_BYTES = parsePersonaPositiveInt(process.env.DONGXUELIAN_PERSONA_SKILL_MAX_BYTES, 256 * 1024, 8 * 1024, 2 * 1024 * 1024)

function parsePersonaPositiveInt(value: string | number | undefined, fallback: number, min: number, max: number): number {
  const parsed = parseInt(String(value), 10)
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(min, Math.min(max, parsed))
}

function readTextIfSmall(file: string, maxBytes: number): string {
  try {
    const fs = require('fs')
    const stat = fs.statSync(file)
    if (!stat.isFile() || stat.size > maxBytes) return ''
    return fs.readFileSync(file, 'utf8').trim()
  } catch { /* non-critical: optional persona/skill file may be absent or unreadable */
    return ''
  }
}

function loadPersonaGroups(): void {
  personaGroupsCache = readJsonFileSync(PERSONA_GROUPS_FILE, {}, { maxBytes: MAX_PERSONA_CONFIG_BYTES })
}

function getGroupPersona(channelKey: string): PersonaGroupEntry | null { const e = personaGroupsCache[String(channelKey)]; return e && e.persona ? e : null }

function setGroupPersona(channelKey: string, personaName: string | undefined): void {
  const key = String(channelKey)
  if (!personaGroupsCache[key]) personaGroupsCache[key] = {}
  if (personaName !== undefined) personaGroupsCache[key].persona = personaName
  writeJsonFileSync(PERSONA_GROUPS_FILE, personaGroupsCache)
}

function resetGroupPersona(channelKey: string): void { delete personaGroupsCache[String(channelKey)]; writeJsonFileSync(PERSONA_GROUPS_FILE, personaGroupsCache) }

function loadPersonaUsers(): void {
  personaUsersCache = readJsonFileSync(PERSONA_USERS_FILE, {}, { maxBytes: MAX_PERSONA_CONFIG_BYTES })
}

function getUserPersona(userId: string): string | null { return personaUsersCache[String(userId)] || null }

function setUserPersona(userId: string, personaName: string): void { personaUsersCache[String(userId)] = personaName; writeJsonFileSync(PERSONA_USERS_FILE, personaUsersCache) }

function resetUserPersona(userId: string): void { delete personaUsersCache[String(userId)]; writeJsonFileSync(PERSONA_USERS_FILE, personaUsersCache) }

function resolvePersona(channelKey: string, userId: string): { source: string; name: string | null } {
  const userPersona = getUserPersona(userId)
  if (userPersona) return { source: 'user', name: userPersona }
  const groupEntry = getGroupPersona(channelKey)
  if (groupEntry) return { source: 'group', name: groupEntry.persona as string }
  return { source: 'default', name: null }
}

function parsePersonaFrontmatter(content: string): PersonaMeta {
  return parseFrontmatterDocument(content, {
    normalizeValue(value: unknown) {
      const text = String(value ?? '').trim()
      return text === 'true' ? true : text === 'false' ? false : text
    },
  } as unknown as { normalizeValue: (value: string) => string }).meta as unknown as PersonaMeta
}

function getAvailablePersonals({ userFacing = false }: { userFacing?: boolean } = {}): AvailablePersona[] {
  ensureRuntimeSkillSeeds()
  const personas: AvailablePersona[] = []
  function scanDir(dir: string, type: string): void {
    try {
      const entries = require('fs').readdirSync(dir, { withFileTypes: true })
      for (const entry of entries) {
        if (!entry.isFile() || !/^SKILL(\.[^.]+)?\.md$/i.test(entry.name)) continue
        const content = readTextIfSmall(path.join(dir, entry.name), MAX_PERSONA_SKILL_BYTES)
        if (!content) continue
        const meta = parsePersonaFrontmatter(content)
        if (meta.name) personas.push({ name: meta.name, description: meta.description || '', file: entry.name, type, dir })
      }
    } catch { /* non-critical: optional persona directory may be absent or unreadable */
    }
  }
  scanDir(SKILLS_PERSONAS_DIR, 'persona')
  if (!userFacing) {
    scanDir(SKILLS_CORE_DIR, 'core')
    scanDir(SKILLS_MODES_DIR, 'mode')
  }
  return personas
}

function loadPersonalSkill(personaName: string): string | null {
  ensureRuntimeSkillSeeds()
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
    } catch { /* non-critical: skip unreadable persona directory and continue fallback search */
    }
  }
  if (isDebugLogEnabled('persona')) console.warn(`[dongxuelian-ai] persona skill not found: ${personaName}`)
  return null
}

export = {
  personaGroupsCache, personaUsersCache,
  atomicWriteJson: writeJsonFileSync,
  loadPersonaGroups, getGroupPersona, setGroupPersona, resetGroupPersona,
  loadPersonaUsers, getUserPersona, setUserPersona, resetUserPersona,
  resolvePersona,
  parsePersonaFrontmatter,
  getAvailablePersonals, loadPersonalSkill,
}
