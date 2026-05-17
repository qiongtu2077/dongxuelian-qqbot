/**
 * MODULE: Skill Workspace 管理。
 * 职责: 管理从 Pool 安装到 Workspace 的技能（安装/卸载/列表/启用状态）。
 * 边界: 不管理 Pool、不执行远程下载。
 * 状态: 无（manifest 文件持久化）。
 */
const fs = require('fs')
const fsp = require('fs/promises')
const path = require('path')
const { WORKSPACE_DIR, SKILL_POOL_DIR, ensureDir, atomicWriteJson, readJsonSafe, validateSkillName } = require('./store')
const { getPoolSkillInfo } = require('./pool-service')

const WORKSPACE_MANIFEST_FILE = path.join(WORKSPACE_DIR, 'manifest.json')
const EMPTY_WORKSPACE_MANIFEST = { schema: 'skill-workspace-manifest.v1', skills: {} }

async function readWorkspaceManifest() {
  const data = await readJsonSafe(WORKSPACE_MANIFEST_FILE, null)
  if (data && data.schema === 'skill-workspace-manifest.v1' && data.skills) return data
  return { ...EMPTY_WORKSPACE_MANIFEST }
}

async function writeWorkspaceManifest(manifest) {
  await ensureDir(WORKSPACE_DIR)
  await atomicWriteJson(WORKSPACE_MANIFEST_FILE, manifest)
}

async function installFromPool(name) {
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

async function removeFromWorkspace(name) {
  if (!validateSkillName(name)) return { ok: false, error: 'Invalid skill name' }
  const manifest = await readWorkspaceManifest()
  if (!manifest.skills[name]) return { ok: false, error: 'Skill not in workspace' }
  delete manifest.skills[name]
  await writeWorkspaceManifest(manifest)
  return { ok: true }
}

async function setSkillEnabled(name, enabled) {
  if (!validateSkillName(name)) return { ok: false, error: 'Invalid skill name' }
  const manifest = await readWorkspaceManifest()
  if (!manifest.skills[name]) return { ok: false, error: 'Skill not in workspace' }
  manifest.skills[name].enabled = !!enabled
  await writeWorkspaceManifest(manifest)
  return { ok: true }
}

async function listWorkspaceSkills() {
  const manifest = await readWorkspaceManifest()
  return Object.values(manifest.skills)
}

async function getWorkspaceSkillInfo(name) {
  const manifest = await readWorkspaceManifest()
  return manifest.skills[name] || null
}

async function getEnabledWorkspaceSkills() {
  const manifest = await readWorkspaceManifest()
  return Object.values(manifest.skills).filter(s => s.enabled)
}

async function getEffectiveSkillDirs() {
  const enabled = await getEnabledWorkspaceSkills()
  const dirs = []
  for (const skill of enabled) {
    const poolDir = path.join(SKILL_POOL_DIR, skill.name)
    if (fs.existsSync(poolDir)) dirs.push({ name: skill.name, dir: poolDir })
  }
  return dirs
}

module.exports = {
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
