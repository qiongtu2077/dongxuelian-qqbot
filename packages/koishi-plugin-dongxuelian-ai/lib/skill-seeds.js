const fs = require('fs')
const path = require('path')
const { SKILLS_DIR } = require('./constants')

const PACKAGE_SKILLS_SEED_DIR = path.resolve(__dirname, '..', 'data', 'ai-skills')
const SKILL_SEED_PARTS = ['core', 'personas', 'modes', 'lore', 'docs']
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

function ensureRuntimeSkillSeeds() {
  if (synced) return
  synced = true
  if (!fs.existsSync(PACKAGE_SKILLS_SEED_DIR)) return
  if (samePath(PACKAGE_SKILLS_SEED_DIR, SKILLS_DIR)) return
  for (const part of SKILL_SEED_PARTS) {
    copyMissingTree(path.join(PACKAGE_SKILLS_SEED_DIR, part), path.join(SKILLS_DIR, part))
  }
}

function resetRuntimeSkillSeedSyncForTest() {
  synced = false
}

module.exports = {
  PACKAGE_SKILLS_SEED_DIR,
  SKILL_SEED_PARTS,
  ensureRuntimeSkillSeeds,
  resetRuntimeSkillSeedSyncForTest,
}
