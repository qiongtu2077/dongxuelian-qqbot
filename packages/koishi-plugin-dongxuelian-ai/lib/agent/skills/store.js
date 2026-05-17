/**
 * MODULE: Skill 文件存储。
 * 职责: 路径安全检查、原子写入、目录操作。
 * 边界: 不执行扫描、不管理 manifest。
 * 状态: 无。
 */
const fs = require('fs')
const fsp = require('fs/promises')
const path = require('path')
const { DATA_DIR } = require('../../constants')

const SKILL_POOL_DIR = path.join(DATA_DIR, 'skill-pool')
const WORKSPACE_DIR = path.join(DATA_DIR, 'ai-skills', 'workspace')

function isPathSafe(targetPath, baseDir) {
  const resolved = path.resolve(targetPath)
  const base = path.resolve(baseDir)
  return resolved.startsWith(base + path.sep) || resolved === base
}

function validateSkillName(name) {
  if (!name || typeof name !== 'string') return false
  if (name.length > 100) return false
  if (/[\/\\:*?"<>|]/.test(name)) return false
  if (name.startsWith('.') || name.includes('..')) return false
  return /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name)
}

async function ensureDir(dir) {
  await fsp.mkdir(dir, { recursive: true })
}

async function atomicWriteJson(filePath, data) {
  const dir = path.dirname(filePath)
  await ensureDir(dir)
  const tmp = filePath + '.tmp-' + process.pid + '-' + Date.now()
  await fsp.writeFile(tmp, JSON.stringify(data, null, 2), 'utf8')
  await fsp.rename(tmp, filePath)
}

async function readJsonSafe(filePath, fallback = null) {
  try {
    const stat = await fsp.stat(filePath)
    if (!stat.isFile() || stat.size > 512 * 1024) return fallback
    const raw = await fsp.readFile(filePath, 'utf8')
    return JSON.parse(raw)
  } catch {
    return fallback
  }
}

async function copyDir(src, dest) {
  await ensureDir(dest)
  const entries = await fsp.readdir(src, { withFileTypes: true })
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name)
    const destPath = path.join(dest, entry.name)
    if (entry.isDirectory()) {
      await copyDir(srcPath, destPath)
    } else if (entry.isFile()) {
      await fsp.copyFile(srcPath, destPath)
    }
  }
}

async function removeDir(dir) {
  try { await fsp.rm(dir, { recursive: true, force: true }) } catch {}
}

module.exports = {
  SKILL_POOL_DIR,
  WORKSPACE_DIR,
  isPathSafe,
  validateSkillName,
  ensureDir,
  atomicWriteJson,
  readJsonSafe,
  copyDir,
  removeDir,
}
