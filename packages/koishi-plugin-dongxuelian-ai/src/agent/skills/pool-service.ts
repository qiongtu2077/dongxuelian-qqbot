/**
 * MODULE: Skill Pool 管理。
 * 职责: 管理本地 Skill 池（安装/卸载/列表/同步内置）。
 * 边界: 不执行远程下载、不管理启用状态。
 * 状态: 无（manifest 文件持久化）。
 */
const fs = require('fs')
const fsp = require('fs/promises')
const path = require('path')
const { SKILL_POOL_DIR, validateSkillName, ensureDir, removeDir, isPathSafe } = require('./store') as typeof import('./store')
const { scanSkillDirectory, listScannedSkillFiles } = require('./scanner') as typeof import('./scanner')
const { DATA_DIR } = require('../../core/constants') as typeof import('../../core/constants')
const { readJsonFile, writeJsonFile } = require('../../core/utils') as typeof import('../../core/utils')
const { ensureRuntimeSkillSeeds } = require('../../persona/skills/skill-seeds') as typeof import('../../persona/skills/skill-seeds')
const { parseFrontmatterDocument } = require('../../core/frontmatter') as typeof import('../../core/frontmatter')

const POOL_MANIFEST_FILE: string = path.join(SKILL_POOL_DIR, 'manifest.json')
const BUILTIN_SKILLS_DIR: string = path.join(DATA_DIR, 'ai-skills', 'docs')

const EMPTY_MANIFEST = { schema: 'skill-pool-manifest.v1', skills: {} }

interface SkillPoolEntry {
  name: string
  description?: string
  version?: string
  source?: string
  installedAt?: string
  path?: string
  scanResult?: {
    safe?: boolean
    scannedAt?: string
  }
}

interface SkillPoolManifest {
  schema: 'skill-pool-manifest.v1'
  skills: Record<string, SkillPoolEntry>
}

interface SkillMeta {
  name: string
  description: string
  version?: string
  author?: string
  raw: string
}

interface InstallPoolOptions {
  source?: string
  force?: boolean
}

interface PoolScanResult {
  safe: boolean
  findings?: unknown[]
  whitelisted?: boolean
  maxSeverity?: string
  scannedAt: string
}

interface PoolOperationResult {
  ok: boolean
  name?: string
  error?: string
  scanResult?: PoolScanResult
}

function isPoolManifest(data: unknown): data is SkillPoolManifest {
  return !!data && typeof data === 'object' && (data as { schema?: unknown }).schema === 'skill-pool-manifest.v1' && !!(data as { skills?: unknown }).skills
}

async function readPoolManifest(): Promise<SkillPoolManifest> {
  const data = await readJsonFile<SkillPoolManifest | null>(POOL_MANIFEST_FILE, null, { maxBytes: 512 * 1024 })
  if (data && data.schema === 'skill-pool-manifest.v1' && data.skills) return data
  return { schema: EMPTY_MANIFEST.schema as 'skill-pool-manifest.v1', skills: {} }
}

async function writePoolManifest(manifest: SkillPoolManifest): Promise<void> {
  await writeJsonFile(POOL_MANIFEST_FILE, manifest)
}

function parseSkillMeta(skillDir: string): SkillMeta | null {
  const files = fs.readdirSync(skillDir).filter((f: string) => /^SKILL\./i.test(f) && f.endsWith('.md'))
  if (!files.length) return null
  const content = fs.readFileSync(path.join(skillDir, files[0]), 'utf8')
  const parsed = parseFrontmatterDocument(content)
  if (!parsed.hasFrontmatter) return { name: path.basename(skillDir), description: '', raw: content }
  const name = String(parsed.meta.name || path.basename(skillDir))
  const description = String(parsed.meta.description || '')
  const version = String(parsed.meta.version || '1.0.0')
  const author = String(parsed.meta.author || '')
  return { name, description, version, author, raw: content }
}

async function copyScannedSkillFiles(skillDir: string, destDir: string): Promise<void> {
  const { files } = listScannedSkillFiles(skillDir)
  await ensureDir(destDir)
  for (const file of files) {
    const relative = path.relative(skillDir, file)
    const target = path.join(destDir, relative)
    await ensureDir(path.dirname(target))
    await fsp.copyFile(file, target)
  }
}

async function installToPool(skillDir: string, { source = 'local', force = false }: InstallPoolOptions = {}): Promise<PoolOperationResult> {
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
  await copyScannedSkillFiles(skillDir, destDir)

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

async function removeFromPool(name: string): Promise<PoolOperationResult> {
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

async function listPoolSkills(): Promise<SkillPoolEntry[]> {
  const manifest = await readPoolManifest()
  return Object.values(manifest.skills)
}

async function getPoolSkillInfo(name: string): Promise<SkillPoolEntry | null> {
  const manifest = await readPoolManifest()
  return manifest.skills[name] || null
}

async function syncBuiltinSkills(): Promise<{ synced: number }> {
  ensureRuntimeSkillSeeds()
  if (!fs.existsSync(BUILTIN_SKILLS_DIR)) return { synced: 0 }
  let entries
  try {
    entries = fs.readdirSync(BUILTIN_SKILLS_DIR, { withFileTypes: true }) as import('fs').Dirent[]
  } catch {
    /* non-critical: builtin skill seed directory may be absent or unreadable */
    return { synced: 0 }
  }

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

export = {
  POOL_MANIFEST_FILE,
  readPoolManifest,
  installToPool,
  removeFromPool,
  listPoolSkills,
  getPoolSkillInfo,
  syncBuiltinSkills,
  parseSkillMeta,
}
