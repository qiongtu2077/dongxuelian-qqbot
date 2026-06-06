/**
 * MODULE: 技能文件加载 + 系统提示词构建。
 * 职责: 从 core/modes/lore 三目录加载 SKILL*.md 文件，缓存内容，提供提示词构建器。
 * 边界: 不调 AI API，不访问对话历史，不修改 messages 数组。
 * 状态: skillsCache (Array), skillsContentCache (Object), fingerprint refresh promise。
 */
const fs = require('fs/promises') as typeof import('fs/promises')
const path = require('path') as typeof import('path')
const {
  SKILLS_CORE_DIR, SKILLS_MODES_DIR, SKILLS_LORE_DIR,
  LORE_TRIGGER_SET, TERRA_LORE_TRIGGER_SET,
} = require('../../core/constants') as typeof import('../../core/constants')
const { isDebugLogEnabled } = require('../../core/logging-config') as typeof import('../../core/logging-config')
const { ensureRuntimeSkillSeeds } = require('./skill-seeds') as typeof import('./skill-seeds')
const { parsePersonaSchemaFrontmatter } = require('../persona-schema') as typeof import('../persona-schema')

let skillsCache: string[] = []
let skillsContentCache: Record<string, unknown> = {}
let skillsContentCacheFingerprint = ''
let skillsContentCacheRefreshPromise: Promise<void> | null = null
const MAX_SKILL_FILE_BYTES = parseSkillPositiveInt(process.env.DONGXUELIAN_CHAT_SKILL_FILE_MAX_BYTES || process.env.DONGXUELIAN_SKILL_FILE_MAX_BYTES, 256 * 1024, 8 * 1024, 2 * 1024 * 1024)

interface SkillDirent {
  name: string
  isDirectory(): boolean
  isFile(): boolean
}

interface SkillStat {
  isFile(): boolean
  size: number
  mtimeMs: number
}

interface ParsedPersonaFrontmatter {
  meta: Record<string, unknown>
  body: string
}

function getSkillErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function warnSkillCacheLoadFailed(scope: string, error: unknown): void {
  console.warn(`[dongxuelian-ai] ${scope} skill cache load failed: ${getSkillErrorMessage(error)}`)
}

function parseSkillPositiveInt(value: string | number | undefined, fallback: number, min: number, max: number): number {
  const parsed = parseInt(String(value), 10)
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(min, Math.min(max, parsed))
}

async function readSkillTextIfSmall(file: string): Promise<string> {
  const stat = await fs.stat(file).catch((): null => null) as SkillStat | null
  if (!stat || !stat.isFile() || stat.size > MAX_SKILL_FILE_BYTES) return ''
  return (await fs.readFile(file, 'utf8')).trim()
}

function stripSkillFrontmatter(text: string = ''): string {
  return String(text || '').replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n)*/, '').trim()
}

async function getSkillDirectoryFingerprint(dir: string): Promise<string> {
  let entries: SkillDirent[] = []
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch { /* non-critical: optional skill directory may not exist yet */
    return 'missing'
  }
  const stamps: string[] = []
  for (const entry of entries) {
    if (!entry.isFile() || !/^SKILL(\.[^.]+)?\.md$/i.test(entry.name)) continue
    const fullPath = path.join(dir, entry.name)
    const stat = await fs.stat(fullPath).catch((): null => null) as SkillStat | null
    if (!stat || !stat.isFile()) continue
    stamps.push(`${entry.name}:${stat.mtimeMs}:${stat.size}`)
  }
  stamps.sort()
  return stamps.join('|')
}

async function getSkillsContentFingerprint(): Promise<string> {
  const [core, modes, lore] = await Promise.all([
    getSkillDirectoryFingerprint(SKILLS_CORE_DIR),
    getSkillDirectoryFingerprint(SKILLS_MODES_DIR),
    getSkillDirectoryFingerprint(SKILLS_LORE_DIR),
  ])
  return `core=${core}\nmodes=${modes}\nlore=${lore}`
}

function shouldInjectLore(userText: string = ''): boolean {
  for (const keyword of LORE_TRIGGER_SET) {
    if (userText.includes(keyword)) return true
  }
  return false
}

function shouldInjectTerraLore(userText: string = ''): boolean {
  for (const keyword of TERRA_LORE_TRIGGER_SET) {
    if (userText.includes(keyword)) return true
  }
  return false
}

async function loadSkills(): Promise<string[]> {
  ensureRuntimeSkillSeeds()
  const skills: string[] = []

  async function walk(dir: string): Promise<void> {
    let entries: SkillDirent[] = []
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch { /* non-critical: optional skill directory may not exist yet */
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
        if (isDebugLogEnabled('skills')) console.warn(`[dongxuelian-ai] skill load failed: ${path.basename(fullPath)} ${getSkillErrorMessage(e)}`)
      }
    }
  }

  await walk(SKILLS_CORE_DIR)
  skillsCache = skills
  return skills
}

async function loadSkillsContentCache(): Promise<void> {
  ensureRuntimeSkillSeeds()
  const cache: Record<string, unknown> = {}
  try {
    const entries = await fs.readdir(SKILLS_CORE_DIR)
    for (const entry of entries) {
      if (!/^SKILL\.(.+)\.md$/i.test(entry)) continue
      const name = (entry.match(/^SKILL\.(.+)\.md$/i) || [])[1]
      if (!name) continue
      const content = await readSkillTextIfSmall(path.join(SKILLS_CORE_DIR, entry))
      if (content) cache['core:' + name] = stripSkillFrontmatter(content)
    }
  } catch (error) {
    warnSkillCacheLoadFailed('core', error)
  }
  try {
    const entries = await fs.readdir(SKILLS_MODES_DIR)
    for (const entry of entries) {
      if (!/^SKILL\.(.+)\.md$/i.test(entry)) continue
      const name = (entry.match(/^SKILL\.(.+)\.md$/i) || [])[1]
      if (!name) continue
      const content = await readSkillTextIfSmall(path.join(SKILLS_MODES_DIR, entry))
      if (content) cache['mode:' + name] = stripSkillFrontmatter(content)
    }
  } catch (error) {
    warnSkillCacheLoadFailed('mode', error)
  }
  try {
    const entries = await fs.readdir(SKILLS_LORE_DIR)
    for (const entry of entries) {
      if (!/^SKILL\.(.+)\.md$/i.test(entry)) continue
      const name = (entry.match(/^SKILL\.(.+)\.md$/i) || [])[1]
      if (!name) continue
      const content = await readSkillTextIfSmall(path.join(SKILLS_LORE_DIR, entry))
      if (content) {
        const parsed = parsePersonaSchemaFrontmatter(content) as ParsedPersonaFrontmatter
        const loreName = String(parsed.meta.name || name).trim() || name
        cache['lore:' + loreName] = String(parsed.body || '').trim()
        cache['loreMeta:' + loreName] = parsed.meta || {}
        if (loreName !== name) {
          cache['lore:' + name] = String(parsed.body || '').trim()
          cache['loreMeta:' + name] = parsed.meta || {}
        }
      }
    }
  } catch (error) {
    warnSkillCacheLoadFailed('lore', error)
  }
  skillsContentCache = cache
  skillsContentCacheFingerprint = await getSkillsContentFingerprint()
}

async function refreshSkillsContentCacheIfChanged(): Promise<boolean> {
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

function getSkillsContentCache(): Record<string, unknown> {
  return skillsContentCache
}

function buildTestSystemPrompt(): string {
  return String(skillsContentCache['mode:persona-test'] || '')
}

function buildFriendlySystemPrompt(): string {
  const core = String(skillsContentCache['core:persona-core'] || '')
  const mode = String(skillsContentCache['mode:persona-friendly'] || '')
  return core + '\n\n' + mode
}

function buildFriendlySafetyFramework(): string {
  return String(skillsContentCache['core:persona-core'] || '')
}

function buildAbusiveSystemPrompt(): string {
  return String(skillsContentCache['mode:persona-abusive'] || '')
}

function getSkillsCount(): number {
  return skillsCache.length
}

export = {
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
