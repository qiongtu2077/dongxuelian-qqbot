const fs = require('fs')
const path: typeof import('path') = require('path')
const { SKILLS_DIR } = require('../../core/constants') as typeof import('../../core/constants')

const PACKAGE_SKILLS_SEED_DIR = path.resolve(__dirname, '..', '..', '..', 'data', 'ai-skills')
const SKILL_SEED_PARTS = ['core', 'personas', 'modes', 'lore', 'docs']
const FRONTMATTER_RE = /^\uFEFF?---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/
let synced = false

interface DirentLike {
  name: string
  isDirectory(): boolean
  isFile(): boolean
}

function getSkillSeedErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function samePath(left: string, right: string): boolean {
  try {
    const a = fs.realpathSync(left)
    const b = fs.realpathSync(right)
    return path.resolve(a) === path.resolve(b)
  } catch { /* non-critical: missing seed/runtime directory falls back to resolved path comparison */
    return path.resolve(left) === path.resolve(right)
  }
}

function copyMissingTree(source: string, target: string): number {
  let entries: DirentLike[] = []
  try { entries = fs.readdirSync(source, { withFileTypes: true }) } catch { /* non-critical: optional packaged seed subdirectory may be absent */ return 0 }
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

function extractFrontmatterText(content: string = ''): string {
  const match = String(content || '').match(FRONTMATTER_RE)
  return match ? match[0].replace(/\s*$/, '\n') : ''
}

function hasFrontmatter(content: string = ''): boolean {
  return !!extractFrontmatterText(content)
}

function backupRuntimeSkillFile(file: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const backup = `${file}.bak-frontmatter-${stamp}`
  fs.copyFileSync(file, backup)
  return backup
}

function migrateMissingLoreFrontmatter(sourceDir: string, targetDir: string): number {
  let entries: DirentLike[] = []
  try { entries = fs.readdirSync(sourceDir, { withFileTypes: true }) } catch { /* non-critical: lore seed directory may be absent */ return 0 }
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
    } catch { /* non-critical: skip unreadable individual lore file during seed metadata migration */
      continue
    }
    const frontmatter = extractFrontmatterText(sourceText)
    if (!frontmatter || hasFrontmatter(targetText)) continue
    try {
      backupRuntimeSkillFile(dst)
      fs.writeFileSync(dst, frontmatter + targetText.replace(/^\uFEFF/, ''), 'utf8')
      migrated++
    } catch (error) {
      console.warn(`[dongxuelian-ai] skill seed lore frontmatter migration failed: ${entry.name} ${getSkillSeedErrorMessage(error)}`)
    }
  }
  return migrated
}

function ensureRuntimeSkillSeeds(): void {
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

function resetRuntimeSkillSeedSyncForTest(): void {
  synced = false
}

export = {
  PACKAGE_SKILLS_SEED_DIR,
  SKILL_SEED_PARTS,
  extractFrontmatterText,
  hasFrontmatter,
  migrateMissingLoreFrontmatter,
  ensureRuntimeSkillSeeds,
  resetRuntimeSkillSeedSyncForTest,
}
