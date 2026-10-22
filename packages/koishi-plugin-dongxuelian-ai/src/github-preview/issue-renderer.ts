/**
 * MODULE: 议题与合并请求本地卡片。
 * 职责: 官方正文工业风排版、共用渲染器调用与连续图片输出。
 * 边界: 不打开官网、不调用模型；调用方拥有全局资源门卫。
 */
import type { GithubMetadata, GithubImageResult, GithubWorkContext } from './models'
import { GITHUB_LIMITS, assertGithubWork } from './models'
import { escapeGithubText as esc, loadGithubAvatar, buildGithubCardFrame, splitGithubImage } from './renderer'
import { prepareGithubBody } from './body-content'
const { renderHtmlToImage } = require('../../../koishi-plugin-daily-report/lib/html-renderer') as {
  renderHtmlToImage(html: string, context: { signal: AbortSignal; deadlineMs: number; workDeadlineMs: number; taskId: string; source: string; networkPolicy: 'offline'; captureSelector: string }): Promise<Buffer>
}
const { readLinuxMeminfo } = require('../resource-scheduler/resource-snapshot') as typeof import('../resource-scheduler/resource-snapshot')

// --- 固定模板 --- //
// Build the yellow/gray/white/black card with original metadata and already cleaned HTML only.
export function buildGithubIssueHtml(metadata: GithubMetadata, body: string, avatar: Buffer | null, note = ''): string {
  const kind = metadata.target.kind === 'pull' ? 'PULL REQUEST' : 'ISSUE'
  const author = metadata.author || ''
  const image = avatar ? `<img class="avatar" alt="${esc(author)}" src="data:image/png;base64,${avatar.toString('base64')}">` : '<span class="avatar avatar-placeholder">GH</span>'
  const labels = (metadata.labels || []).map(label => `<span class="label"${/^[0-9a-f]{6}$/i.test(label.color) ? ` style="border-left-color:#${label.color}"` : ''}>${esc(label.name)}</span>`).join('')
  const date = metadata.createdAt ? new Date(metadata.createdAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }) : ''
  return buildGithubCardFrame(metadata, kind, `<section class="heading"><div class="eyebrow"><span>${esc(metadata.target.owner + '/' + metadata.target.repo)}</span><span class="number">#${metadata.target.number}</span><span class="state">${esc(metadata.state || '')}</span></div><h1>${esc(metadata.title)}</h1></section>${labels ? `<div class="labels">${labels}</div>` : ''}<div class="author-row">${image}<div><div class="author">${esc(author)}</div><div class="date">${esc(date)} · 发起者正文</div></div></div><article class="body">${body || '<p>作者未填写正文</p>'}</article>`, note)
}

// Render through the existing browser lifecycle while preserving cancellation and memory protection.
export async function renderGithubIssue(metadata: GithubMetadata, context: GithubWorkContext): Promise<GithubImageResult> {
  assertGithubWork(context)
  if (typeof metadata.bodyHtml !== 'string') throw new Error('官方正文数据不可用')
  const available = readLinuxMeminfo().availableMb
  if (available !== null && available < GITHUB_LIMITS.minMemoryMb) throw new Error('可用内存不足，改用文字信息')
  const controller = new AbortController()
  // Preserve the outer cancellation reason for downloads and the owned browser lifecycle.
  const cancelGithubIssueRender = (): void => controller.abort(context.signal.reason)
  context.signal.addEventListener('abort', cancelGithubIssueRender, { once: true })
  const work = { ...context, signal: controller.signal }
  const monitor = setInterval(() => {
    const memory = readLinuxMeminfo().availableMb
    if (memory !== null && memory < GITHUB_LIMITS.stopMemoryMb) controller.abort(new Error('可用内存过低，已停止正文渲染'))
  }, 500)
  try {
    const [body, avatar] = await Promise.all([prepareGithubBody(metadata.bodyHtml, metadata.url, work), metadata.avatar ? loadGithubAvatar(metadata.avatar, work) : Promise.resolve(null)])
    assertGithubWork(work)
    const avatarMissing = Boolean(metadata.avatar && !avatar)
    const note = [body.missing ? `正文附件未完整载入：${body.missing} 处图片未载入，请查看原文。` : '', avatarMissing ? '头像暂未载入，请查看原文。' : ''].filter(Boolean).join(' ')
    const html = buildGithubIssueHtml(metadata, body.html, avatar, note)
    if (Buffer.byteLength(html, 'utf8') > GITHUB_LIMITS.htmlBytes) throw new Error('正文模板超过大小限制，请查看原文')
    const raw = await renderHtmlToImage(html, { signal: work.signal, deadlineMs: work.deadline, workDeadlineMs: work.deadline, taskId: work.taskId, source: 'github-preview', networkPolicy: 'offline', captureSelector: '#github-preview' })
    const images = await splitGithubImage(raw, work)
    assertGithubWork(work)
    return { images, capturedAt: Date.now(), incomplete: body.missing > 0 || avatarMissing, note }
  } catch (error) {
    if (work.signal.aborted) throw work.signal.reason
    if (Date.now() >= work.deadline) throw new Error('GitHub 正文渲染超时（最多30秒）')
    throw error
  } finally { clearInterval(monitor); context.signal.removeEventListener('abort', cancelGithubIssueRender) }
}
