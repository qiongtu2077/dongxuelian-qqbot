/**
 * MODULE: 技能文件加载 + 系统提示词构建。
 * 职责: 从 core/modes/lore 三目录加载 SKILL*.md 文件，缓存内容，提供提示词构建器。
 * 边界: 不调 AI API，不访问对话历史，不修改 messages 数组。
 * 状态: skillsCache (Array), skillsContentCache (Object)。
 */
const fs = require('fs/promises')
const path = require('path')
const {
  SKILLS_CORE_DIR, SKILLS_MODES_DIR, SKILLS_LORE_DIR,
  LORE_TRIGGER_SET, TERRA_LORE_TRIGGER_SET,
} = require('./constants')
const { isDebugLogEnabled } = require('./logging-config')
const { ensureRuntimeSkillSeeds } = require('./skill-seeds')

let skillsCache = []
let skillsContentCache = {}
const MAX_SKILL_FILE_BYTES = parseSkillPositiveInt(process.env.DONGXUELIAN_SKILL_FILE_MAX_BYTES, 256 * 1024, 8 * 1024, 2 * 1024 * 1024)

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
      if (content) cache['core:' + name] = content.replace(/^---\n[\s\S]*?\n---\n*/, '').trim()
    }
  } catch {}
  try {
    const entries = await fs.readdir(SKILLS_MODES_DIR)
    for (const entry of entries) {
      if (!/^SKILL\.(.+)\.md$/i.test(entry)) continue
      const name = entry.match(/^SKILL\.(.+)\.md$/i)[1]
      const content = await readSkillTextIfSmall(path.join(SKILLS_MODES_DIR, entry))
      if (content) cache['mode:' + name] = content.replace(/^---\n[\s\S]*?\n---\n*/, '').trim()
    }
  } catch {}
  try {
    const entries = await fs.readdir(SKILLS_LORE_DIR)
    for (const entry of entries) {
      if (!/^SKILL\.(.+)\.md$/i.test(entry)) continue
      const name = entry.match(/^SKILL\.(.+)\.md$/i)[1]
      const content = await readSkillTextIfSmall(path.join(SKILLS_LORE_DIR, entry))
      if (content) cache['lore:' + name] = content.replace(/^---\n[\s\S]*?\n---\n*/, '').trim()
    }
  } catch {}
  skillsContentCache = cache
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
  loadSkills,
  loadSkillsContentCache,
  getSkillsCount,
  getSkillsContentCache,
  buildTestSystemPrompt,
  buildFriendlySystemPrompt,
  buildFriendlySafetyFramework,
  buildAbusiveSystemPrompt,
  shouldInjectLore,
  shouldInjectTerraLore,
}
