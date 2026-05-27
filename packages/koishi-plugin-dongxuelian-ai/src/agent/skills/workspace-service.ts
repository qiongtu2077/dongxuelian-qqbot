/**
 * MODULE: Skill Workspace 管理。
 * 职责: 管理从 Pool 安装到 Workspace 的技能（安装/卸载/列表/启用状态）。
 * 边界: 不管理 Pool、不执行远程下载。
 * 状态: 无（manifest 文件持久化）。
 */
const fs = require('fs')
const fsp = require('fs/promises')
const path = require('path')
const { WORKSPACE_DIR, SKILL_POOL_DIR, ensureDir, atomicWriteJson, readJsonSafe, validateSkillName } = require('./store') as typeof import('./store')
const { getPoolSkillInfo } = require('./pool-service') as typeof import('./pool-service')

const WORKSPACE_MANIFEST_FILE: string = path.join(WORKSPACE_DIR, 'manifest.json')
const EMPTY_WORKSPACE_MANIFEST = { schema: 'skill-workspace-manifest.v1', skills: {} }

interface WorkspaceSkillEntry {
  name: string
  description?: string
  version?: string
  source?: string
  installedAt?: string
  enabled?: boolean
}

interface WorkspaceManifest {
  schema: 'skill-workspace-manifest.v1'
  skills: Record<string, WorkspaceSkillEntry>
}

interface WorkspaceOperationResult {
  ok: boolean
  name?: string
  error?: string
}

interface EffectiveSkillDir {
  name: string
  dir: string
}

async function readWorkspaceManifest(): Promise<WorkspaceManifest> {
  const data = await readJsonSafe<WorkspaceManifest | null>(WORKSPACE_MANIFEST_FILE, null)
  if (data && data.schema === 'skill-workspace-manifest.v1' && data.skills) return data
  return { schema: EMPTY_WORKSPACE_MANIFEST.schema as 'skill-workspace-manifest.v1', skills: {} }
}

async function writeWorkspaceManifest(manifest: WorkspaceManifest): Promise<void> {
  await ensureDir(WORKSPACE_DIR)
  await atomicWriteJson(WORKSPACE_MANIFEST_FILE, manifest)
}

async function installFromPool(name: string): Promise<WorkspaceOperationResult> {
  if (!validateSkillName(name)) return { ok: false, error: 'Invalid skill name' }
  const poolInfo = await getPoolSkillInfo(name)
  if (!poolInfo) return { ok: false, error: 'Skill not found in pool' }

  const manifest = await readWorkspaceManifest()
  manifest.skills[name] = {
    name,
    description: poolInfo.description || '',
    version: poolInfo.version || '1.0.0',
    source: poolInfo.source || 'local',
    installedAt: new Date().toISOString(),
    enabled: true,
  }
  await writeWorkspaceManifest(manifest)
  return { ok: true, name }
}

async function removeFromWorkspace(name: string): Promise<WorkspaceOperationResult> {
  if (!validateSkillName(name)) return { ok: false, error: 'Invalid skill name' }
  const manifest = await readWorkspaceManifest()
  if (!manifest.skills[name]) return { ok: false, error: 'Skill not in workspace' }
  delete manifest.skills[name]
  await writeWorkspaceManifest(manifest)
  return { ok: true }
}

async function setSkillEnabled(name: string, enabled: unknown): Promise<WorkspaceOperationResult> {
  if (!validateSkillName(name)) return { ok: false, error: 'Invalid skill name' }
  const manifest = await readWorkspaceManifest()
  if (!manifest.skills[name]) return { ok: false, error: 'Skill not in workspace' }
  manifest.skills[name].enabled = !!enabled
  await writeWorkspaceManifest(manifest)
  return { ok: true }
}

async function listWorkspaceSkills(): Promise<WorkspaceSkillEntry[]> {
  const manifest = await readWorkspaceManifest()
  return Object.values(manifest.skills)
}

async function getWorkspaceSkillInfo(name: string): Promise<WorkspaceSkillEntry | null> {
  const manifest = await readWorkspaceManifest()
  return manifest.skills[name] || null
}

async function getEnabledWorkspaceSkills(): Promise<WorkspaceSkillEntry[]> {
  const manifest = await readWorkspaceManifest()
  return Object.values(manifest.skills).filter(s => s.enabled)
}

async function getEffectiveSkillDirs(): Promise<EffectiveSkillDir[]> {
  const enabled = await getEnabledWorkspaceSkills()
  const dirs: EffectiveSkillDir[] = []
  for (const skill of enabled) {
    const poolDir = path.join(SKILL_POOL_DIR, skill.name)
    if (fs.existsSync(poolDir)) dirs.push({ name: skill.name, dir: poolDir })
  }
  return dirs
}

export = {
  WORKSPACE_MANIFEST_FILE,
  readWorkspaceManifest,
  installFromPool,
  removeFromWorkspace,
  setSkillEnabled,
  listWorkspaceSkills,
  getWorkspaceSkillInfo,
  getEnabledWorkspaceSkills,
  getEffectiveSkillDirs,
}
