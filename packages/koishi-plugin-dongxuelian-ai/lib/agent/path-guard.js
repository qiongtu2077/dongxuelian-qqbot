/**
 * MODULE: Agent 路径边界校验。
 * 职责: 统一允许根目录、realpath 归一化和工作区内判断。
 * 边界: 不读写目标文件内容、不执行工具。
 * 状态: 无。
 */
const fs = require('fs/promises')
const path = require('path')
const { DATA_DIR, SKILLS_DIR } = require('../constants')
const { getReadFileRoots } = require('./config')
const { resolveAgentPathInput } = require('./workspace-context')

function normalizeAgentPathCase(value) {
  const resolved = path.resolve(String(value || ''))
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

function isAgentPathInside(target, root) {
  const absTarget = normalizeAgentPathCase(target)
  const absRoot = normalizeAgentPathCase(root)
  return absTarget === absRoot || absTarget.startsWith(absRoot + path.sep)
}

function getAgentPathConfiguredRoots() {
  const roots = getReadFileRoots()
  return roots.length > 0 ? mergeConfiguredAndDefaultRoots(roots) : getAgentPathDefaultRoots()
}

function pushUniqueRoot(result, root) {
  const value = path.resolve(String(root || ''))
  if (!value) return
  const key = normalizeAgentPathCase(value)
  if (!result.some(item => normalizeAgentPathCase(item) === key)) result.push(value)
}

function getAgentPathDefaultRoots() {
  const result = []
  pushUniqueRoot(result, process.env.KOISHI_DIR)
  pushUniqueRoot(result, process.cwd())
  pushUniqueRoot(result, path.resolve(__dirname, '..', '..', '..'))
  pushUniqueRoot(result, path.resolve(__dirname, '..', '..', '..', '..'))
  pushUniqueRoot(result, path.resolve(__dirname, '..', '..'))
  pushUniqueRoot(result, DATA_DIR)
  pushUniqueRoot(result, SKILLS_DIR)
  return result
}

function mergeConfiguredAndDefaultRoots(roots = []) {
  const result = []
  for (const root of roots) pushUniqueRoot(result, root)
  for (const root of getAgentPathDefaultRoots()) pushUniqueRoot(result, root)
  return result
}

async function realpathOrResolvedAgentPath(target) {
  try { return await fs.realpath(path.resolve(target)) } catch { return path.resolve(target) }
}

async function getAgentPathAllowedRoots() {
  const result = []
  for (const root of getAgentPathConfiguredRoots()) {
    result.push(await realpathOrResolvedAgentPath(root))
  }
  return result
}

async function assertExistingAgentPathInsideRoots(target, label = '路径') {
  const roots = await getAgentPathAllowedRoots()
  const resolved = resolveAgentPathInput(target, roots, { requireExisting: true })
  const abs = path.resolve(resolved.path)
  const real = await fs.realpath(abs).catch(() => null)
  if (!real) throw new Error(`${label}不存在：${abs}`)
  if (!roots.some(root => isAgentPathInside(real, root))) throw new Error(`${label}超出允许范围：${abs}`)
  return { abs, real, roots }
}

async function assertNewAgentPathInsideRoots(target, label = '路径', createDirectories = false) {
  const roots = await getAgentPathAllowedRoots()
  const resolved = resolveAgentPathInput(target, roots, { requireExisting: false })
  const abs = path.resolve(resolved.path)
  let parent = path.dirname(abs)
  let realParent = await fs.realpath(parent).catch(() => null)
  if (!realParent && createDirectories) {
    while (!realParent && parent !== path.dirname(parent)) {
      parent = path.dirname(parent)
      realParent = await fs.realpath(parent).catch(() => null)
    }
  }
  if (!realParent) throw new Error(`父目录不存在：${path.dirname(abs)}`)
  if (!roots.some(root => isAgentPathInside(realParent, root))) throw new Error(`${label}超出允许范围：${abs}`)
  return { abs, realParent, roots }
}

async function resolveAgentDefaultRoot() {
  const roots = await getAgentPathAllowedRoots()
  return roots[0] || process.cwd()
}

module.exports = {
  isAgentPathInside,
  getAgentPathAllowedRoots,
  getAgentPathDefaultRoots,
  assertExistingAgentPathInsideRoots,
  assertNewAgentPathInsideRoots,
  resolveAgentDefaultRoot,
}
