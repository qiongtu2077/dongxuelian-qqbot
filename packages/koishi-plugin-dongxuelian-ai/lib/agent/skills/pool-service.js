/**
 * MODULE: Skill Pool 管理。
 * 职责: 管理本地 Skill 池（安装/卸载/列表/同步内置）。
 * 边界: 不执行远程下载、不管理启用状态。
 * 状态: 无（manifest 文件持久化）。
 */
const fs = require('fs')
const fsp = require('fs/promises')
const path = require('path')
const { SKILL_POOL_DIR, validateSkillName, ensureDir, atomicWriteJson, readJsonSafe, copyDir, removeDir, isPathSafe } = require('./store')
const { scanSkillDirectory } = require('./scanner')
const { DATA_DIR } = require('../../constants')
const { ensureRuntimeSkillSeeds } = require('../../skill-seeds')

const POOL_MANIFEST_FILE = path.join(SKILL_POOL_DIR, 'manifest.json')
const BUILTIN_SKILLS_DIR = path.join(DATA_DIR, 'ai-skills', 'docs')

const EMPTY_MANIFEST = { schema: 'skill-pool-manifest.v1', skills: {} }

async function readPoolManifest() {
  const data = await readJsonSafe(POOL_MANIFEST_FILE, null)
  if (data && data.schema === 'skill-pool-manifest.v1' && data.skills) return data
  return { ...EMPTY_MANIFEST }
}

async function writePoolManifest(manifest) {
  await atomicWriteJson(POOL_MANIFEST_FILE, manifest)
}

function parseSkillMeta(skillDir) {
  const files = fs.readdirSync(skillDir).filter(f => /^SKILL\./i.test(f) && f.endsWith('.md'))
  if (!files.length) return null
  const content = fs.readFileSync(path.join(skillDir, files[0]), 'utf8')
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---/)
  if (!fmMatch) return { name: path.basename(skillDir), description: '', raw: content }
  const fm = fmMatch[1]
  const name = (fm.match(/^name:\s*(.+)$/m) || [])[1]?.trim() || path.basename(skillDir)
  const description = (fm.match(/^description:\s*(.+)$/m) || [])[1]?.trim() || ''
  const version = (fm.match(/^version:\s*(.+)$/m) || [])[1]?.trim() || '1.0.0'
  const author = (fm.match(/^author:\s*(.+)$/m) || [])[1]?.trim() || ''
  return { name, description, version, author, raw: content }
}

async function installToPool(skillDir, { source = 'local', force = false } = {}) {
  if (!fs.existsSync(skillDir) || !fs.statSync(skillDir).isDirectory()) {
    return { ok: false, error: 'Skill directory does not exist' }
  }

  const meta = parseSkillMeta(skillDir)
  if (!meta) return { ok: false, error: 'No SKILL.*.md file found in directory' }
  if (!validateSkillName(meta.name)) return { ok: false, error: `Invalid skill name: ${meta.name}` }

  const scanResult = scanSkillDirectory(skillDir)
  if (!scanResult.safe && !force) {
    return { ok: false, error: 'Security scan failed', scanResult }
  }

  const destDir = path.join(SKILL_POOL_DIR, meta.name)
  await ensureDir(SKILL_POOL_DIR)
  if (fs.existsSync(destDir)) await removeDir(destDir)
  await copyDir(skillDir, destDir)

  const manifest = await readPoolManifest()
  manifest.skills[meta.name] = {
    name: meta.name,
    description: meta.description,
    version: meta.version || '1.0.0',
    source,
    installedAt: new Date().toISOString(),
    path: meta.name + '/',
    scanResult: { safe: scanResult.safe, scannedAt: scanResult.scannedAt },
  }
  await writePoolManifest(manifest)
  return { ok: true, name: meta.name, scanResult }
}

async function removeFromPool(name) {
  if (!validateSkillName(name)) return { ok: false, error: 'Invalid skill name' }
  const manifest = await readPoolManifest()
  if (!manifest.skills[name]) return { ok: false, error: 'Skill not found in pool' }
  const skillDir = path.join(SKILL_POOL_DIR, name)
  if (!isPathSafe(skillDir, SKILL_POOL_DIR)) return { ok: false, error: 'Path safety violation' }
  await removeDir(skillDir)
  delete manifest.skills[name]
  await writePoolManifest(manifest)
  return { ok: true }
}

async function listPoolSkills() {
  const manifest = await readPoolManifest()
  return Object.values(manifest.skills)
}

async function getPoolSkillInfo(name) {
  const manifest = await readPoolManifest()
  return manifest.skills[name] || null
}

async function syncBuiltinSkills() {
  ensureRuntimeSkillSeeds()
  if (!fs.existsSync(BUILTIN_SKILLS_DIR)) return { synced: 0 }
  let entries
  try { entries = fs.readdirSync(BUILTIN_SKILLS_DIR, { withFileTypes: true }) } catch { return { synced: 0 } }

  let synced = 0
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const skillDir = path.join(BUILTIN_SKILLS_DIR, entry.name)
    const meta = parseSkillMeta(skillDir)
    if (!meta) continue
    const result = await installToPool(skillDir, { source: 'builtin', force: true })
    if (result.ok) synced++
  }
  return { synced }
}

module.exports = {
  POOL_MANIFEST_FILE,
  readPoolManifest,
  installToPool,
  removeFromPool,
  listPoolSkills,
  getPoolSkillInfo,
  syncBuiltinSkills,
  parseSkillMeta,
}
