/**
 * MODULE: 技能文件加载 + 系统提示词构建。
 * 职责: 从 core/modes/lore 三目录加载 SKILL*.md 文件，缓存内容，提供提示词构建器。
 * 边界: 不调 AI API，不访问对话历史，不修改 messages 数组。
 * 状态: skillsCache (Array), skillsContentCache (Object), fingerprint refresh promise。
 */
const fs = require('fs/promises')
const path = require('path')
const {
  SKILLS_CORE_DIR, SKILLS_MODES_DIR, SKILLS_LORE_DIR,
  LORE_TRIGGER_SET, TERRA_LORE_TRIGGER_SET,
} = require('./constants')
const { isDebugLogEnabled } = require('./core/logging-config')
const { ensureRuntimeSkillSeeds } = require('./skill-seeds')
const { parsePersonaSchemaFrontmatter } = require('./persona-schema')

let skillsCache = []
let skillsContentCache = {}
let skillsContentCacheFingerprint = ''
let skillsContentCacheRefreshPromise = null
const MAX_SKILL_FILE_BYTES = parseSkillPositiveInt(process.env.DONGXUELIAN_CHAT_SKILL_FILE_MAX_BYTES || process.env.DONGXUELIAN_SKILL_FILE_MAX_BYTES, 256 * 1024, 8 * 1024, 2 * 1024 * 1024)

function parseSkillPositiveInt(value, fallback, min, max) {
  const parsed = parseInt(value, 10)
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(min, Math.min(max, parsed))
}

async function readSkillTextIfSmall(file) {
  const stat = await fs.stat(file).catch(() => null)
  if (!stat || !stat.isFile() || stat.size > MAX_SKILL_FILE_BYTES) return ''
  return (await fs.readFile(file, 'utf8')).trim()
}

function stripSkillFrontmatter(text = '') {
  return String(text || '').replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n)*/, '').trim()
}

async function getSkillDirectoryFingerprint(dir) {
  let entries = []
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return 'missing'
  }
  const stamps = []
  for (const entry of entries) {
    if (!entry.isFile() || !/^SKILL(\.[^.]+)?\.md$/i.test(entry.name)) continue
    const fullPath = path.join(dir, entry.name)
    const stat = await fs.stat(fullPath).catch(() => null)
    if (!stat || !stat.isFile()) continue
    stamps.push(`${entry.name}:${stat.mtimeMs}:${stat.size}`)
  }
  stamps.sort()
  return stamps.join('|')
}

async function getSkillsContentFingerprint() {
  const [core, modes, lore] = await Promise.all([
    getSkillDirectoryFingerprint(SKILLS_CORE_DIR),
    getSkillDirectoryFingerprint(SKILLS_MODES_DIR),
    getSkillDirectoryFingerprint(SKILLS_LORE_DIR),
  ])
  return `core=${core}\nmodes=${modes}\nlore=${lore}`
}

function shouldInjectLore(userText = '') {
  for (const keyword of LORE_TRIGGER_SET) {
    if (userText.includes(keyword)) return true
  }
  return false
}

function shouldInjectTerraLore(userText = '') {
  for (const keyword of TERRA_LORE_TRIGGER_SET) {
    if (userText.includes(keyword)) return true
  }
  return false
}

async function loadSkills() {
  ensureRuntimeSkillSeeds()
  const skills = []

  async function walk(dir) {
    let entries = []
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        await walk(fullPath)
        continue
      }
      if (!/^SKILL(\.[^.]+)?\.md$/i.test(entry.name)) continue
      try {
        const content = await readSkillTextIfSmall(fullPath)
        if (content) skills.push(content)
      } catch (e) {
        if (isDebugLogEnabled('skills')) console.warn(`[dongxuelian-ai] skill load failed: ${path.basename(fullPath)} ${e.message}`)
      }
    }
  }

  await walk(SKILLS_CORE_DIR)
  skillsCache = skills
  return skills
}

async function loadSkillsContentCache() {
  ensureRuntimeSkillSeeds()
  const cache = {}
  try {
    const entries = await fs.readdir(SKILLS_CORE_DIR)
    for (const entry of entries) {
      if (!/^SKILL\.(.+)\.md$/i.test(entry)) continue
      const name = entry.match(/^SKILL\.(.+)\.md$/i)[1]
      const content = await readSkillTextIfSmall(path.join(SKILLS_CORE_DIR, entry))
      if (content) cache['core:' + name] = stripSkillFrontmatter(content)
    }
  } catch {}
  try {
    const entries = await fs.readdir(SKILLS_MODES_DIR)
    for (const entry of entries) {
      if (!/^SKILL\.(.+)\.md$/i.test(entry)) continue
      const name = entry.match(/^SKILL\.(.+)\.md$/i)[1]
      const content = await readSkillTextIfSmall(path.join(SKILLS_MODES_DIR, entry))
      if (content) cache['mode:' + name] = stripSkillFrontmatter(content)
    }
  } catch {}
  try {
    const entries = await fs.readdir(SKILLS_LORE_DIR)
    for (const entry of entries) {
      if (!/^SKILL\.(.+)\.md$/i.test(entry)) continue
      const name = entry.match(/^SKILL\.(.+)\.md$/i)[1]
      const content = await readSkillTextIfSmall(path.join(SKILLS_LORE_DIR, entry))
      if (content) {
        const parsed = parsePersonaSchemaFrontmatter(content)
        const loreName = String(parsed.meta.name || name).trim() || name
        cache['lore:' + loreName] = String(parsed.body || '').trim()
        cache['loreMeta:' + loreName] = parsed.meta || {}
        if (loreName !== name) {
          cache['lore:' + name] = String(parsed.body || '').trim()
          cache['loreMeta:' + name] = parsed.meta || {}
        }
      }
    }
  } catch {}
  skillsContentCache = cache
  skillsContentCacheFingerprint = await getSkillsContentFingerprint()
}

async function refreshSkillsContentCacheIfChanged() {
  const fingerprint = await getSkillsContentFingerprint()
  if (fingerprint === skillsContentCacheFingerprint && Object.keys(skillsContentCache).length > 0) return false
  if (!skillsContentCacheRefreshPromise) {
    skillsContentCacheRefreshPromise = loadSkillsContentCache().finally(() => {
      skillsContentCacheRefreshPromise = null
    })
  }
  await skillsContentCacheRefreshPromise
  return true
}

function getSkillsContentCache() {
  return skillsContentCache
}

function buildTestSystemPrompt() {
  return skillsContentCache['mode:persona-test'] || ''
}

function buildFriendlySystemPrompt() {
  const core = skillsContentCache['core:persona-core'] || ''
  const mode = skillsContentCache['mode:persona-friendly'] || ''
  return core + '\n\n' + mode
}

function buildFriendlySafetyFramework() {
  return skillsContentCache['core:persona-core'] || ''
}

function buildAbusiveSystemPrompt() {
  return skillsContentCache['mode:persona-abusive'] || ''
}

function getSkillsCount() {
  return skillsCache.length
}

module.exports = {
  parseSkillPositiveInt,
  readSkillTextIfSmall,
  stripSkillFrontmatter,
  getSkillDirectoryFingerprint,
  getSkillsContentFingerprint,
  loadSkills,
  loadSkillsContentCache,
  refreshSkillsContentCacheIfChanged,
  getSkillsCount,
  getSkillsContentCache,
  buildTestSystemPrompt,
  buildFriendlySystemPrompt,
  buildFriendlySafetyFramework,
  buildAbusiveSystemPrompt,
  shouldInjectLore,
  shouldInjectTerraLore,
}
