const fs = require('fs')
const path = require('path')
const { SKILLS_DIR } = require('../../core/constants')

const PACKAGE_SKILLS_SEED_DIR = path.resolve(__dirname, '..', '..', '..', 'data', 'ai-skills')
const SKILL_SEED_PARTS = ['core', 'personas', 'modes', 'lore', 'docs']
const FRONTMATTER_RE = /^\uFEFF?---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/
let synced = false

function samePath(left, right) {
  try {
    const a = fs.realpathSync(left)
    const b = fs.realpathSync(right)
    return path.resolve(a) === path.resolve(b)
  } catch {
    return path.resolve(left) === path.resolve(right)
  }
}

function copyMissingTree(source, target) {
  let entries = []
  try { entries = fs.readdirSync(source, { withFileTypes: true }) } catch { return 0 }
  fs.mkdirSync(target, { recursive: true })
  let copied = 0
  for (const entry of entries) {
    const src = path.join(source, entry.name)
    const dst = path.join(target, entry.name)
    if (entry.isDirectory()) {
      copied += copyMissingTree(src, dst)
      continue
    }
    if (!entry.isFile()) continue
    if (fs.existsSync(dst)) continue
    fs.mkdirSync(path.dirname(dst), { recursive: true })
    fs.copyFileSync(src, dst)
    copied++
  }
  return copied
}

function extractFrontmatterText(content = '') {
  const match = String(content || '').match(FRONTMATTER_RE)
  return match ? match[0].replace(/\s*$/, '\n') : ''
}

function hasFrontmatter(content = '') {
  return !!extractFrontmatterText(content)
}

function backupRuntimeSkillFile(file) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const backup = `${file}.bak-frontmatter-${stamp}`
  fs.copyFileSync(file, backup)
  return backup
}

function migrateMissingLoreFrontmatter(sourceDir, targetDir) {
  let entries = []
  try { entries = fs.readdirSync(sourceDir, { withFileTypes: true }) } catch { return 0 }
  let migrated = 0
  for (const entry of entries) {
    if (!entry.isFile() || !/^SKILL(\.[^.]+)?\.md$/i.test(entry.name)) continue
    const src = path.join(sourceDir, entry.name)
    const dst = path.join(targetDir, entry.name)
    let sourceText = ''
    let targetText = ''
    try {
      if (!fs.existsSync(dst)) continue
      sourceText = fs.readFileSync(src, 'utf8')
      targetText = fs.readFileSync(dst, 'utf8')
    } catch {
      continue
    }
    const frontmatter = extractFrontmatterText(sourceText)
    if (!frontmatter || hasFrontmatter(targetText)) continue
    try {
      backupRuntimeSkillFile(dst)
      fs.writeFileSync(dst, frontmatter + targetText.replace(/^\uFEFF/, ''), 'utf8')
      migrated++
    } catch {}
  }
  return migrated
}

function ensureRuntimeSkillSeeds() {
  if (synced) return
  synced = true
  if (!fs.existsSync(PACKAGE_SKILLS_SEED_DIR)) return
  if (samePath(PACKAGE_SKILLS_SEED_DIR, SKILLS_DIR)) return
  for (const part of SKILL_SEED_PARTS) {
    copyMissingTree(path.join(PACKAGE_SKILLS_SEED_DIR, part), path.join(SKILLS_DIR, part))
  }
  migrateMissingLoreFrontmatter(
    path.join(PACKAGE_SKILLS_SEED_DIR, 'lore'),
    path.join(SKILLS_DIR, 'lore')
  )
}

function resetRuntimeSkillSeedSyncForTest() {
  synced = false
}

module.exports = {
  PACKAGE_SKILLS_SEED_DIR,
  SKILL_SEED_PARTS,
  extractFrontmatterText,
  hasFrontmatter,
  migrateMissingLoreFrontmatter,
  ensureRuntimeSkillSeeds,
  resetRuntimeSkillSeedSyncForTest,
}
