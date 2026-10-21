/**
 * MODULE: GitHub 群仓库绑定。
 * 职责: 每群持久化一个公开仓库，处理导入、查看、删除命令。
 * 边界: 不开启查询白名单、不渲染图片、不调用模型；实例拥有绑定快照、串行写入链和变更订阅。
 */
import fs = require('fs')
import path = require('path')
import type { GithubTarget, GithubMetadata, GithubWorkContext } from './models'
import { assertGithubWork } from './models'
import { parseGithubTarget } from './input'
import { normalizeGithubGroup } from './settings'
import { GithubQueryError } from './client'
const { DATA_DIR } = require('../core/constants') as typeof import('../core/constants')
const { writeJsonFile } = require('../core/utils') as typeof import('../core/utils')

// --- 独立绑定配置 --- //
export class GithubGroupRepositories {
  private bindings = new Map<string, string>()
  private updates: Promise<unknown> = Promise.resolve()
  private listeners = new Set<(group: string) => void>()
  readonly file: string

  // Reject an entire malformed snapshot rather than partially trusting group bindings.
  constructor(directory = DATA_DIR, private readonly save = writeJsonFile, private readonly warn: (message: string) => void = console.warn) {
    this.file = path.join(directory, 'github-preview-repositories.json')
    try {
      if (fs.statSync(this.file).size > 524288) throw new Error('绑定文件超过大小限制')
      const raw: unknown = JSON.parse(fs.readFileSync(this.file, 'utf8'))
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('绑定必须是群号与仓库链接的对象')
      const entries = Object.entries(raw)
      if (entries.length > 2000) throw new Error('绑定已达到容量限制')
      for (const [group, url] of entries) {
        const target = typeof url === 'string' ? parseGithubTarget(url) : null
        if (!normalizeGithubGroup(group) || target?.kind !== 'repository') throw new Error('群号或仓库链接格式不正确')
        this.bindings.set(group, target.url)
      }
    } catch (error) {
      this.bindings.clear()
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') warn('GitHub 群仓库绑定读取失败：' + (error as Error).message)
    }
  }

  // Return a new canonical target so callers cannot mutate the stored snapshot.
  get(group: string): GithubTarget | null { const url = this.bindings.get(group); return url ? parseGithubTarget(url) : null }

  // Notify the runtime only after the replacement or deletion is durable.
  onChanged(listener: (group: string) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener) }

  // Serialize atomic updates; a group always has zero or one repository.
  async update(group: string, repository: GithubTarget | null): Promise<boolean> {
    if (!normalizeGithubGroup(group)) throw new Error('群号格式不正确')
    const target = repository ? parseGithubTarget(repository.url) : null
    if (repository && target?.kind !== 'repository') throw new Error('必须使用仓库根链接')
    const operation = this.updates.catch(() => {}).then(async () => {
      const previous = this.get(group)
      if (previous?.key === target?.key || (!previous && !target)) return false
      const next = new Map(this.bindings)
      if (target) next.set(group, target.url); else next.delete(group)
      const snapshot = Object.fromEntries([...next].sort(([left], [right]) => left.localeCompare(right)))
      if (next.size > 2000 || Buffer.byteLength(JSON.stringify(snapshot)) > 524288) throw new Error('绑定已达到容量限制')
      await this.save(this.file, snapshot)
      this.bindings = next
      for (const listener of this.listeners) { try { listener(group) } catch (error) { this.warn('GitHub 绑定变更通知失败：' + (error as Error).message) } }
      return true
    })
    this.updates = operation
    return operation
  }
}

// --- 群内管理命令（调用方负责管理员鉴权） --- //
// Validate imports through the existing public API client and bound the whole command wait.
export async function handleGithubRepositoryCommand(group: string | undefined, isDirect: boolean | undefined, plain: string, repositories: GithubGroupRepositories, lookup: (target: GithubTarget, context: GithubWorkContext) => Promise<GithubMetadata>, signal: AbortSignal): Promise<string> {
  if (isDirect || !group || !normalizeGithubGroup(group)) return '请在需要绑定的群中使用 GitHub 群项目命令。'
  if (/^GitHub群项目查看$/i.test(plain)) return repositories.get(group) ? '本群 GitHub 项目：' + repositories.get(group)!.url : '本群尚未绑定 GitHub 项目。'
  if (/^GitHub群项目删除$/i.test(plain)) {
    try { return await repositories.update(group, null) ? '已删除本群 GitHub 项目绑定。' : '本群尚未绑定 GitHub 项目。' }
    catch { return 'GitHub 群项目配置保存失败，绑定未更改。' }
  }
  const match = plain.match(/^GitHub群项目导入\s*(\S+)$/i)
  const target = match ? parseGithubTarget(match[1]) : null
  if (target?.kind !== 'repository') return '用法：GitHub群项目导入 <公开仓库链接> / GitHub群项目查看 / GitHub群项目删除'
  const controller = new AbortController()
  const cancelGithubImport = (): void => controller.abort(signal.reason)
  signal.addEventListener('abort', cancelGithubImport, { once: true })
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const context = { signal: controller.signal, deadline: Date.now() + 10000, taskId: 'github-repository-import' }
    signal.throwIfAborted()
    let metadata: GithubMetadata
    try {
      metadata = await Promise.race([lookup(target, context), new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(new Error('仓库校验超时')); reject(new Error('仓库校验超时')) }, 10000) })])
      assertGithubWork(context)
      if (metadata.target.kind !== 'repository') throw new Error('仓库校验失败')
    } catch (error) { return 'GitHub 群项目导入失败：' + (error instanceof GithubQueryError ? error.message : '仓库校验失败或超时，请稍后重试。') }
    const previous = repositories.get(group)
    try {
      const changed = await repositories.update(group, metadata.target)
      return !changed ? '本群已绑定该 GitHub 项目：' + metadata.url : previous ? `本群 GitHub 项目已替换：\n原项目：${previous.url}\n新项目：${metadata.url}` : `已绑定本群 GitHub 项目：${metadata.url}\n开启 GitHub 查询后，发送 #数字 即可查询 Issue / PR。`
    } catch { return 'GitHub 群项目配置保存失败，绑定未更改。' }
  } finally { if (timer) clearTimeout(timer); controller.abort(); signal.removeEventListener('abort', cancelGithubImport) }
}
