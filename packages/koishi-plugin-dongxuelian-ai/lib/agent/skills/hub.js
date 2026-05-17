/**
 * MODULE: Skill Hub 远程下载调度器。
 * 职责: 根据来源类型分发下载请求到对应 adapter。
 * 边界: 不执行安装、不管理 Pool/Workspace。
 * 状态: 无。
 */
const path = require('path')
const fs = require('fs')
const fsp = require('fs/promises')
const { DATA_DIR } = require('../../constants')
const { ensureDir, removeDir } = require('./store')

const HUB_TEMP_DIR = path.join(DATA_DIR, 'skill-hub-tmp')

const ADAPTERS = {}

function registerAdapter(type, adapter) {
  if (!type || typeof adapter !== 'function') throw new Error('Invalid adapter')
  ADAPTERS[type] = adapter
}

async function cleanTempDir() {
  await removeDir(HUB_TEMP_DIR)
  await ensureDir(HUB_TEMP_DIR)
}

async function downloadSkill({ source, url, owner, repo, skillPath, branch }) {
  const type = source || detectSourceType(url)
  if (!type) return { ok: false, error: 'Cannot detect source type from URL' }
  const adapter = ADAPTERS[type]
  if (!adapter) return { ok: false, error: `No adapter for source type: ${type}` }

  await cleanTempDir()
  const tempDir = path.join(HUB_TEMP_DIR, 'download-' + Date.now())
  await ensureDir(tempDir)

  try {
    const result = await adapter({ url, owner, repo, skillPath, branch, tempDir })
    if (!result || !result.ok) {
      await removeDir(tempDir)
      return { ok: false, error: result?.error || 'Download failed' }
    }
    return { ok: true, tempDir: result.dir || tempDir, meta: result.meta || {} }
  } catch (err) {
    await removeDir(tempDir)
    return { ok: false, error: err.message || 'Download error' }
  }
}

function detectSourceType(url) {
  if (!url) return null
  if (/github\.com/i.test(url)) return 'github'
  if (/\.zip$/i.test(url)) return 'zip'
  if (/^https?:\/\//i.test(url)) return 'url'
  return null
}

module.exports = {
  registerAdapter,
  downloadSkill,
  detectSourceType,
  cleanTempDir,
  HUB_TEMP_DIR,
}
