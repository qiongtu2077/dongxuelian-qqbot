/**
 * MODULE: Dashboard Agent workspace boundary.
 * 职责: 校验 Agent 工作区路径、列目录、预览文件并汇总环境文件状态。
 * 边界: 不注册 HTTP 路由、不写上传内容、不暴露密钥内容。
 */
const fs = require('fs') as typeof import('fs')
const path = require('path') as typeof import('path')
const { parsePositiveInt } = require('./utils') as typeof import('./utils')
const { isAgentPathInside } = require('./paths') as typeof import('./paths')
const { loadManagementModule } = require('koishi-plugin-dongxuelian-ai/lib/public/management-runtime') as typeof import('koishi-plugin-dongxuelian-ai/lib/public/management-runtime')

type ManagementModule<Name extends import('koishi-plugin-dongxuelian-ai/lib/public/management-runtime').ManagementModuleName> = import('koishi-plugin-dongxuelian-ai/lib/public/management-runtime').ManagementModule<Name>
type AgentPathGuardModule = ManagementModule<'agent.pathGuard'>
type ExistingAgentPath = Awaited<ReturnType<AgentPathGuardModule['assertExistingAgentPathInsideRoots']>>
type NewAgentPath = Awaited<ReturnType<AgentPathGuardModule['assertNewAgentPathInsideRoots']>>

interface AgentWorkspaceListOptions {
  root?: string
  query?: string
  limit?: string | number
}

type AgentWorkspaceFileType = 'dir' | 'file' | 'other'

interface AgentWorkspaceFileItem {
  path: string
  rel: string
  name: string
  type: AgentWorkspaceFileType
  size: number
  mtimeMs: number
  injectable: boolean
}

interface AgentWorkspaceListResult {
  root: string
  files: AgentWorkspaceFileItem[]
}

interface AgentFilePreview {
  path: string
  name: string
  size: number
  mtimeMs: number
  binary: boolean
  truncated: boolean
  content: string
}

export interface AgentEnvFileStatus {
  name: string
  exists: boolean
  configured: boolean
  size: number
}

const MAX_AGENT_PREVIEW_FILE_BYTES = parsePositiveInt(process.env.DASHBOARD_AGENT_PREVIEW_MAX_BYTES, 512 * 1024, 64 * 1024, 2 * 1024 * 1024)

// 校验一个已存在路径位于 Agent 允许根目录内。
export async function resolveAgentWorkspacePath(target: unknown): Promise<ExistingAgentPath> {
  const guard = loadManagementModule('agent.pathGuard') as AgentPathGuardModule
  return guard.assertExistingAgentPathInsideRoots(String(target || ''), '路径')
}

// 生成并校验上传目标，文件名只保留安全 basename。
export async function resolveAgentUploadTarget(root: unknown, name: unknown): Promise<NewAgentPath> {
  const guard = loadManagementModule('agent.pathGuard') as AgentPathGuardModule
  const base = String(root || '').trim() || await guard.resolveAgentDefaultRoot()
  const safeName = path.basename(String(name || '').replace(/[\\/:*?"<>|]+/g, '_')).slice(0, 160)
  if (!safeName) throw new Error('文件名不能为空')
  return guard.assertNewAgentPathInsideRoots(path.join(base, safeName), '上传文件', true)
}

// 递归列出允许根目录内的有限工作区条目。
export async function listAgentWorkspaceFiles({ root, query = '', limit = 120 }: AgentWorkspaceListOptions = {}): Promise<AgentWorkspaceListResult> {
  const guard = loadManagementModule('agent.pathGuard') as AgentPathGuardModule
  const base = root ? String(root) : await guard.resolveAgentDefaultRoot()
  const { abs } = await guard.assertExistingAgentPathInsideRoots(base, '目录')
  const stat = await fs.promises.stat(abs)
  if (!stat.isDirectory()) throw new Error('不是目录：' + abs)
  const max = Math.max(1, Math.min(300, parseInt(String(limit), 10) || 120))
  const needle = String(query || '').trim().toLowerCase()
  const ignored = new Set(['.git', 'node_modules', 'dist', 'dist-portable', 'tmp'])
  const items: AgentWorkspaceFileItem[] = []

  // 深度和条目数双重限流，且每个候选仍需通过根目录检查。
  async function walk(dir: string, depth: number): Promise<void> {
    if (items.length >= max || depth > 4) return
    const entries = await fs.promises.readdir(dir, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (items.length >= max) return
      if (entry.isDirectory() && ignored.has(entry.name)) continue
      const full = path.join(dir, entry.name)
      if (!isAgentPathInside(full, abs)) continue
      const rel = path.relative(abs, full) || entry.name
      const matches = !needle || rel.toLowerCase().includes(needle)
      const itemStat = matches ? await fs.promises.stat(full).catch(() => null) : null
      if (matches && itemStat) {
        items.push({
          path: full,
          rel,
          name: entry.name,
          type: entry.isDirectory() ? 'dir' : entry.isFile() ? 'file' : 'other',
          size: itemStat.size,
          mtimeMs: itemStat.mtimeMs,
          injectable: entry.isFile() && itemStat.size <= MAX_AGENT_PREVIEW_FILE_BYTES,
        })
      }
      if (entry.isDirectory()) await walk(full, depth + 1)
    }
  }

  await walk(abs, 0)
  return { root: abs, files: items }
}

// 读取受大小限制的文本预览，二进制文件只返回元数据。
export async function previewAgentWorkspaceFile(target: unknown): Promise<AgentFilePreview> {
  const { abs } = await resolveAgentWorkspacePath(target)
  const stat = await fs.promises.stat(abs)
  if (!stat.isFile()) throw new Error('不是文件：' + abs)
  const meta: AgentFilePreview = { path: abs, name: path.basename(abs), size: stat.size, mtimeMs: stat.mtimeMs, binary: false, truncated: false, content: '' }
  if (stat.size > MAX_AGENT_PREVIEW_FILE_BYTES) {
    meta.truncated = true
    return meta
  }
  const buffer = await fs.promises.readFile(abs)
  if (buffer.includes(0)) {
    meta.binary = true
    return meta
  }
  const content = buffer.toString('utf8')
  meta.truncated = content.length > 12000
  meta.content = content.slice(0, 12000)
  return meta
}

// 返回 Agent 当前生效的读取根目录。
export async function getAgentEffectiveReadRoots(): Promise<string[]> {
  return (loadManagementModule('agent.pathGuard') as AgentPathGuardModule).getAgentPathAllowedRoots()
}

// 只汇总环境文件是否存在和是否配置，不读取返回敏感内容。
export function getAgentEnvStatus(): AgentEnvFileStatus[] {
  const constants = loadManagementModule('core.constants')
  const files: Array<[string, string]> = [
    ['ai-openai-key.txt', constants.KEY_FILE],
    ['ai-deepseek-key.txt', constants.DEEPSEEK_KEY_FILE],
    ['ai-dashscope-key.txt', constants.DASHSCOPE_KEY_FILE],
    ['ai-glm-key.txt', constants.GLM_KEY_FILE],
    ['ai-mimorium-key.txt', constants.MIMORIUM_KEY_FILE],
    ['ai-provider.txt', constants.PROVIDER_FILE],
    ['ai-model.txt', constants.MODEL_FILE],
    ['ai-base-url.txt', constants.BASE_URL_FILE],
    ['ai-enable-search.txt', constants.SEARCH_ENABLED_FILE],
  ]
  return files.map(([name, file]) => {
    const exists = fs.existsSync(file)
    let size = 0
    let configured = false
    try {
      const stat = fs.statSync(file)
      size = stat.size
      configured = stat.size > 0 && String(fs.readFileSync(file, 'utf8')).trim().length > 0
    } catch { /* optional env file probe may fail without breaking status */ }
    return { name, exists, configured, size }
  })
}
