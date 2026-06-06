/**
 * MODULE: Agent 路径边界校验。
 * 职责: 统一允许根目录、realpath 归一化和工作区内判断。
 * 边界: 不读写目标文件内容、不执行工具。
 * 状态: 无。
 */
const fsp = require('fs/promises')
const fs = require('fs')
const path = require('path')
const { DATA_DIR, SKILLS_DIR } = require('../core/constants') as typeof import('../core/constants')
const { getReadFileRoots } = require('./config') as typeof import('./config')
const { resolveAgentPathInput } = require('./workspace-context') as typeof import('./workspace-context')

const WRITE_BLOCKED_BASENAMES: Set<string> = new Set([
  // Agent 工具模式 / 工具配置 / 管理员列表
  'ai-tool-mode.txt',
  'ai-admin-ids.json',
  'ai-tool-config.json',
  // L34: 凭据与供应商运行配置——只能走专门设置入口写入，禁止通用文件上传覆盖
  // 文件名取自 core/constants（注意是 ai-enable-search.txt，非 ai-search-enabled.txt）
  'ai-openai-key.txt',
  'ai-deepseek-key.txt',
  'ai-dashscope-key.txt',
  'ai-glm-key.txt',
  'ai-mimorium-key.txt',
  'ai-provider.txt',
  'ai-model.txt',
  'ai-base-url.txt',
  'ai-enable-search.txt',
  'ai-providers-custom.json',
  'ai-fallback-chains.json',
])

interface ExistingPathGuardResult {
  abs: string
  real: string
  roots: string[]
}

interface NewPathGuardResult {
  abs: string
  realParent: string
  roots: string[]
}

function normalizeAgentPathCase(value: unknown): string {
  const resolved = path.resolve(String(value || ''))
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

function isAgentPathInside(target: unknown, root: unknown): boolean {
  const absTarget = normalizeAgentPathCase(target)
  const absRoot = normalizeAgentPathCase(root)
  return absTarget === absRoot || absTarget.startsWith(absRoot + path.sep)
}

function assertNotWriteBlockedBasename(target: unknown, label: string = '路径'): void {
  const basename = path.basename(path.resolve(String(target || '')))
  if (WRITE_BLOCKED_BASENAMES.has(basename)) throw new Error(`${label}禁止写入安全配置文件：${basename}`)
}

function getAgentPathConfiguredRoots(): string[] {
  const roots = getReadFileRoots()
  return roots.length > 0 ? mergeConfiguredAndDefaultRoots(roots) : getAgentPathDefaultRoots()
}

function pushUniqueRoot(result: string[], root: unknown): void {
  const value = path.resolve(String(root || ''))
  if (!value) return
  const key = normalizeAgentPathCase(value)
  if (!result.some(item => normalizeAgentPathCase(item) === key)) result.push(value)
}

function getAgentPathDefaultRoots(): string[] {
  const result: string[] = []
  pushUniqueRoot(result, process.env.KOISHI_DIR)
  pushUniqueRoot(result, process.cwd())
  pushUniqueRoot(result, path.resolve(__dirname, '..', '..', '..'))
  pushUniqueRoot(result, path.resolve(__dirname, '..', '..', '..', '..'))
  pushUniqueRoot(result, path.resolve(__dirname, '..', '..'))
  pushUniqueRoot(result, DATA_DIR)
  pushUniqueRoot(result, SKILLS_DIR)
  return result
}

function mergeConfiguredAndDefaultRoots(roots: unknown[] = []): string[] {
  const result: string[] = []
  for (const root of roots) pushUniqueRoot(result, root)
  for (const root of getAgentPathDefaultRoots()) pushUniqueRoot(result, root)
  return result
}

async function realpathOrResolvedAgentPath(target: string): Promise<string> {
  const resolved = path.resolve(target)
  if (fs.existsSync(resolved)) return resolved
  try { return await fsp.realpath(resolved) } catch { /* non-critical: non-existing root uses resolved path for later existence checks */ return resolved }
}

async function getAgentPathAllowedRoots(): Promise<string[]> {
  const result: string[] = []
  for (const root of getAgentPathConfiguredRoots()) {
    result.push(await realpathOrResolvedAgentPath(root))
  }
  return result
}

async function assertExistingAgentPathInsideRoots(target: unknown, label: string = '路径'): Promise<ExistingPathGuardResult> {
  const roots = await getAgentPathAllowedRoots()
  const resolved = resolveAgentPathInput(target, roots, { requireExisting: true })
  const abs = path.resolve(resolved.path)
  const real = await fsp.realpath(abs).catch((): null => null)
  if (!real) throw new Error(`${label}不存在：${abs}`)
  if (!roots.some(root => isAgentPathInside(real, root))) throw new Error(`${label}超出允许范围：${abs}`)
  return { abs, real, roots }
}

async function assertNewAgentPathInsideRoots(target: unknown, label: string = '路径', createDirectories: boolean = false): Promise<NewPathGuardResult> {
  const roots = await getAgentPathAllowedRoots()
  const resolved = resolveAgentPathInput(target, roots, { requireExisting: false })
  const abs = path.resolve(resolved.path)
  assertNotWriteBlockedBasename(abs, label)
  let parent = path.dirname(abs)
  let realParent = await fsp.realpath(parent).catch((): null => null)
  if (!realParent && createDirectories) {
    while (!realParent && parent !== path.dirname(parent)) {
      parent = path.dirname(parent)
      realParent = await fsp.realpath(parent).catch((): null => null)
    }
  }
  if (!realParent) throw new Error(`父目录不存在：${path.dirname(abs)}`)
  if (!roots.some(root => isAgentPathInside(realParent, root))) throw new Error(`${label}超出允许范围：${abs}`)
  return { abs, realParent, roots }
}

async function resolveAgentDefaultRoot(): Promise<string> {
  const roots = await getAgentPathAllowedRoots()
  return roots[0] || process.cwd()
}

export = {
  isAgentPathInside,
  getAgentPathAllowedRoots,
  getAgentPathDefaultRoots,
  assertNotWriteBlockedBasename,
  assertExistingAgentPathInsideRoots,
  assertNewAgentPathInsideRoots,
  resolveAgentDefaultRoot,
}
