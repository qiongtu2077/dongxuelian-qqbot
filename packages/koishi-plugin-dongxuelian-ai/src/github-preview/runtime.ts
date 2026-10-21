/**
 * MODULE: GitHub 查询流程。
 * 职责: 管理群开关、串行任务、共享资源准入、图片缓存及发送前复核。
 * 边界: 不进入聊天模型；实例拥有有界队列、冷却、图片缓存和取消控制器。
 */
import type { GithubTarget, GithubMetadata, GithubImageResult, GithubWorkContext } from './models'
import { GITHUB_LIMITS, assertGithubWork, waitGithubWork } from './models'
import { GithubPreviewSettings, normalizeGithubGroup } from './settings'
import { extractGithubTargets, isGithubPreviewCommand } from './input'
import { GithubPreviewClient, GithubQueryError } from './client'
import { screenshotGithubPage } from './page-screenshot'
import { renderGithubCard, githubTextFallback } from './renderer'
const { h } = require('koishi') as typeof import('koishi')
const { hasAdminPermission } = require('../core/utils') as typeof import('../core/utils')
const { admitTask } = require('../resource-scheduler/admission') as typeof import('../resource-scheduler/admission')
const { acquireResourceGate, ResourceGateBusyTimeoutError } = require('../resource-gate/gate') as typeof import('../resource-gate/gate')

export interface GithubSession {
  guildId?: string; channelId?: string; userId?: string; selfId?: string; isDirect?: boolean; messageId?: string
  author?: { id?: string }; event?: { user?: { id?: string } }; send(message: unknown): Promise<unknown>
}
interface GithubRuntimeDependencies {
  lookup(target: GithubTarget, context: GithubWorkContext): Promise<GithubMetadata>
  screenshot(metadata: GithubMetadata, context: GithubWorkContext): Promise<GithubImageResult>
  render(metadata: GithubMetadata, context: GithubWorkContext): Promise<GithubImageResult>
  acquire(context: GithubWorkContext, group: string): Promise<() => void>
  log(message: string): void
}
interface GithubQueuedJob { group: string; session: GithubSession; targets: GithubTarget[]; version: number; controller: AbortController; finish(): void; timer?: ReturnType<typeof setTimeout>; overflow: boolean }
interface GithubStoredImage { result: GithubImageResult; metadata: GithubMetadata; bytes: number }

// Respect the existing global admission policy and S0 gate; no browser can bypass a report.
export async function acquireGithubResources(context: GithubWorkContext, group: string): Promise<() => void> {
  const budget = { taskId: context.taskId, kind: 'browser_action', source: 'github-preview', owner: 'github-preview', channelKey: group, userId: '', exclusive: true, priority: 60, minMemMb: GITHUB_LIMITS.minMemoryMb, degradable: true, deferable: false, queueTimeoutMs: GITHUB_LIMITS.queueMs, runTimeoutMs: GITHUB_LIMITS.runMs }
  const waitDeadline = Math.min(context.deadline, Date.now() + GITHUB_LIMITS.queueMs)
  while (Date.now() < waitDeadline) {
    assertGithubWork(context)
    const admission = admitTask(budget)
    if (['reject', 'downgrade', 'defer', 'silent_drop'].includes(admission.decision)) throw new Error('当前资源不足或处于维护模式，请稍后重试')
    try {
      const gate = await acquireResourceGate({ ...budget, waitTimeoutMs: 0, timeoutMs: GITHUB_LIMITS.runMs, step: 'github_preview' })
      if (context.signal.aborted) { gate.release('cancelled_before_run'); context.signal.throwIfAborted() }
      const checked = admitTask(budget)
      if (checked.decision !== 'run_now') { gate.release('admission_changed'); throw new Error('当前资源不足，请稍后重试') }
      return () => gate.release('github_preview_finished')
    } catch (error) {
      if (!(error instanceof ResourceGateBusyTimeoutError)) throw error
    }
    await waitGithubWork(Math.max(1, Math.min(200, waitDeadline - Date.now())), context.signal)
  }
  throw new Error('截图资源繁忙，请稍后重试')
}

export class GithubPreviewRuntime {
  readonly settings: GithubPreviewSettings
  private readonly deps: GithubRuntimeDependencies
  private queue: GithubQueuedJob[] = []
  private active: GithubQueuedJob | undefined
  private pumping = false
  private disposed = false
  private cooldowns = new Map<string, number>()
  private messages = new Map<string, number>()
  private images = new Map<string, GithubStoredImage>()
  private readonly unsubscribe: () => void

  // Own one bounded preview queue; dependencies are explicit for offline behavior tests.
  constructor(settings = new GithubPreviewSettings(), dependencies: Partial<GithubRuntimeDependencies> = {}) {
    this.settings = settings
    const client = new GithubPreviewClient()
    this.deps = { lookup: (target, context) => client.lookup(target, context), screenshot: screenshotGithubPage, render: renderGithubCard, acquire: acquireGithubResources, log: message => console.warn(message), ...dependencies }
    this.unsubscribe = settings.onRemoved(group => this.cancelGroup(group))
  }

  // Only enabled guild messages and reserved management commands enter this feature.
  accepts(session: GithubSession, plain: string): boolean {
    if (this.disposed || (session.selfId && String(session.userId || session.author?.id) === session.selfId)) return false
    return isGithubPreviewCommand(plain) || (!session.isDirect && !!session.guildId && this.settings.enabled(session.guildId) && extractGithubTargets(plain).length > 0)
  }

  // --- 管理与入队 --- //
  // Authenticate management, then apply durable, idempotent changes without model calls.
  private async command(session: GithubSession, plain: string): Promise<string> {
    if (/^GitHub查询状态$/i.test(plain)) return !session.isDirect && session.guildId ? `本群 GitHub 查询：${this.settings.enabled(session.guildId) ? '开启' : '关闭'}` : '请在群中查看 GitHub 查询状态。'
    if (!hasAdminPermission(session)) return '只有指定管理员能操作这个命令。'
    if (/^GitHub查询群查看$/i.test(plain)) {
      const groups = this.settings.list()
      return groups.length ? 'GitHub 查询群：\n' + groups.join('\n') : 'GitHub 查询群为空，所有群均关闭。'
    }
    const match = plain.match(/^GitHub查询群(添加|删除)\s*([1-9]\d*)$/i)
    if (!match || !normalizeGithubGroup(match[2])) return '用法：GitHub查询群添加 <群号> / GitHub查询群删除 <群号> / GitHub查询群查看 / GitHub查询状态'
    try {
      const enabled = match[1] === '添加', changed = await this.settings.update(match[2], enabled)
      return changed ? `已${enabled ? '开启' : '关闭'} GitHub 查询群：${match[2]}` : `该群 GitHub 查询已经${enabled ? '开启' : '关闭'}：${match[2]}`
    } catch { return 'GitHub 查询群配置保存失败，设置未更改。' }
  }

  // Queue one message with a real expiry; deletion removes queued jobs immediately.
  async handle(session: GithubSession, plain: string): Promise<string | undefined> {
    if (!this.accepts(session, plain)) return undefined
    if (isGithubPreviewCommand(plain)) return this.command(session, plain)
    const group = session.guildId!, targets = extractGithubTargets(plain)
    const now = Date.now(), messageKey = session.messageId ? group + ':' + session.messageId : ''
    if (messageKey && this.messages.has(messageKey)) return undefined
    if (messageKey) this.messages.set(messageKey, now)
    for (const [key, time] of this.messages) if (now - time > 300000 || this.messages.size > 2000) this.messages.delete(key)
    const selected = targets.slice(0, GITHUB_LIMITS.maxTargets).filter(target => {
      const key = group + ':' + target.key, previous = this.cooldowns.get(key)
      if (previous && now - previous < GITHUB_LIMITS.cooldownMs) return false
      this.cooldowns.set(key, now)
      return true
    })
    for (const [key, time] of this.cooldowns) if (now - time > GITHUB_LIMITS.cooldownMs || this.cooldowns.size > 2000) this.cooldowns.delete(key)
    if (!selected.length) return undefined
    if (this.queue.length >= GITHUB_LIMITS.maxQueued) return 'GitHub 查询队列已满，请稍后重试。'
    await new Promise<void>(finish => {
      const job: GithubQueuedJob = { group, session, targets: selected, version: this.settings.version(group), controller: new AbortController(), finish, overflow: targets.length > GITHUB_LIMITS.maxTargets }
      job.timer = setTimeout(() => {
        const index = this.queue.indexOf(job)
        if (index < 0) return
        this.queue.splice(index, 1)
        if (this.valid(job)) void this.deliver(job, 'GitHub 查询排队超时，请稍后重试。', { signal: job.controller.signal, deadline: Date.now() + 5000, taskId: 'github-queue-expired' }).catch(() => {}).finally(finish)
        else finish()
      }, GITHUB_LIMITS.queueMs)
      this.queue.push(job)
      void this.pump()
    })
    return undefined
  }

  // --- 队列与取消 --- //
  // A generation check stops deleted/re-added groups and disposed runtimes from sending.
  private valid(job: GithubQueuedJob): boolean { return !this.disposed && !job.controller.signal.aborted && this.settings.enabled(job.group) && this.settings.version(job.group) === job.version }

  // Abort only this group's work; another group's generation is unaffected.
  private cancelGroup(group: string): void {
    for (const key of this.cooldowns.keys()) if (key.startsWith(group + ':')) this.cooldowns.delete(key)
    for (const job of [...this.queue]) if (job.group === group) {
      job.controller.abort(new Error('查询群已关闭')); clearTimeout(job.timer)
      this.queue.splice(this.queue.indexOf(job), 1); job.finish()
    }
    if (this.active?.group === group) this.active.controller.abort(new Error('查询群已关闭'))
  }

  // Drain globally in order; the in-memory queue never owns more than one running task.
  private async pump(): Promise<void> {
    if (this.pumping) return
    this.pumping = true
    try {
      while (this.queue.length && !this.disposed) {
        const job = this.queue.shift()!
        clearTimeout(job.timer)
        this.active = job
        try { if (this.valid(job)) await this.run(job) }
        catch (error) { this.deps.log('github-preview task_failed: ' + (error instanceof Error ? error.name : 'unknown')) }
        finally { job.finish(); this.active = undefined }
      }
    } finally { this.pumping = false }
  }

  // --- 缓存、发送与任务预算 --- //
  // Keep only complete images, bounded by item count and total encoded bytes.
  private cacheImage(key: string, entry: GithubStoredImage): void {
    if (entry.result.incomplete || entry.bytes > GITHUB_LIMITS.imageBytes) return
    this.images.delete(key); this.images.set(key, entry)
    while (this.images.size > GITHUB_LIMITS.cacheEntries || [...this.images.values()].reduce((sum, item) => sum + item.bytes, 0) > GITHUB_LIMITS.cacheBytes) this.images.delete(this.images.keys().next().value!)
  }

  // Verify permission immediately before each send and never retry an uncertain adapter result.
  private async deliver(job: GithubQueuedJob, content: unknown, context: GithubWorkContext): Promise<void> {
    assertGithubWork(context)
    if (!this.valid(job)) return
    let timer: ReturnType<typeof setTimeout> | undefined
    try { await Promise.race([job.session.send(content), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('GitHub 消息发送结果未知')), Math.max(1, context.deadline - Date.now())) })]) }
    catch (error) { this.deps.log('github-preview send_failed_or_unknown: ' + (error as Error).name); throw error }
    finally { if (timer) clearTimeout(timer) }
  }

  // Process all targets under one absolute task budget, with safe text fallbacks by stage.
  private async run(job: GithubQueuedJob): Promise<void> {
    const context: GithubWorkContext = { signal: job.controller.signal, deadline: Date.now() + GITHUB_LIMITS.runMs, taskId: 'github-preview-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8) }
    const timer = setTimeout(() => job.controller.abort(new Error('GitHub 查询处理超时')), GITHUB_LIMITS.runMs)
    const started = Date.now()
    this.deps.log(`github-preview started task=${context.taskId} group=${job.group} targets=${job.targets.map(target => target.key).join(',')}`)
    let release: (() => void) | undefined
    try {
      if (job.overflow) await this.deliver(job, '每条消息最多处理前 3 个不同的 GitHub 链接。', context)
      for (const target of job.targets) {
        if (!this.valid(job)) break
        if (context.deadline - Date.now() < 1000) { await this.deliver(job, '剩余链接未处理：本次查询已到处理时限。', context); break }
        const cacheKey = target.key + ':page-v1:padding-' + GITHUB_LIMITS.padding
        const cached = this.images.get(cacheKey)
        let metadata: GithubMetadata | undefined, result: GithubImageResult | undefined, note = '', text = ''
        if (cached && Date.now() - cached.result.capturedAt < GITHUB_LIMITS.cacheMs) { metadata = cached.metadata; result = cached.result; note = '缓存数据，捕获于 ' + new Date(result.capturedAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }) }
        else {
          try {
            metadata = await this.deps.lookup(target, context)
            assertGithubWork(context)
            if (!release) release = await this.deps.acquire(context, job.group)
            assertGithubWork(context)
            result = ['issue', 'pull'].includes(metadata.target.kind) ? await this.deps.screenshot(metadata, context) : await this.deps.render(metadata, context)
            assertGithubWork(context)
            this.cacheImage(cacheKey, { result, metadata, bytes: result.images.reduce((sum, image) => sum + image.length, 0) })
            if (result.incomplete) note = '页面未完整加载，以下为当前截图。'
          } catch (error) {
            if (!this.valid(job)) break
            if (error instanceof GithubQueryError && error.transient && cached && Date.now() - cached.result.capturedAt < GITHUB_LIMITS.staleMs) { result = cached.result; metadata = cached.metadata; note = '缓存数据，捕获于 ' + new Date(result.capturedAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }) }
            else text = `${metadata ? githubTextFallback(metadata) : target.url}\n${error instanceof GithubQueryError ? error.message : error instanceof Error ? error.message : '查询失败'}${metadata ? '\n图片生成失败，已返回文字信息。' : ''}`
            this.deps.log(`github-preview stage_failed target=${target.key} stage=${metadata ? 'render' : 'metadata'} status=${error instanceof GithubQueryError ? error.status : 0}`)
          }
        }
        if (!this.valid(job)) break
        // Sending lives outside processing catches: adapter errors cannot trigger duplicate fallbacks.
        await this.deliver(job, result && metadata ? [note ? h.text(note + '\n') : h.text(''), ...result.images.map(image => h.image(image, 'image/png')), h.text('\n' + metadata.url)] : text, context)
      }
    } finally {
      clearTimeout(timer); if (release) release()
      this.deps.log(`github-preview finished task=${context.taskId} group=${job.group} elapsedMs=${Date.now() - started} cancelled=${context.signal.aborted}`)
    }
  }

  // Plugin disposal cancels every task and releases the removal subscription.
  dispose(): void {
    this.disposed = true
    this.unsubscribe()
    for (const group of new Set([...this.queue.map(job => job.group), ...(this.active ? [this.active.group] : [])])) this.cancelGroup(group)
    this.images.clear()
    this.messages.clear(); this.cooldowns.clear()
  }
}
