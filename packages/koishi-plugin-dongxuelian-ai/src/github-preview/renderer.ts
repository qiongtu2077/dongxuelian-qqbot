/**
 * MODULE: GitHub 共用卡片模板与仓库、用户渲染。
 * 职责: 统一工业风框架、转义官方字段、读取有界头像并复用现有模板渲染器。
 * 边界: 不获取或清理 Issue/PR 正文、不调用模型；仅拥有有界头像缓存。
 */
import type { GithubMetadata, GithubImageResult, GithubWorkContext } from './models'
import { GITHUB_LIMITS, assertGithubWork } from './models'
const sharp = require('sharp') as typeof import('sharp')
const { renderHtmlToImage } = require('../../../koishi-plugin-daily-report/lib/html-renderer') as { renderHtmlToImage(html: string, context: { signal: AbortSignal; deadlineMs: number; workDeadlineMs: number; taskId: string; source: string; networkPolicy: 'offline'; captureSelector: string }): Promise<Buffer> }
const avatarCache = new Map<string, { image: Buffer; capturedAt: number }>()

// Escape all official strings before inserting into fixed template text slots.
export function escapeGithubText(value: string): string { return value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]!)) }

// Read and resample a bounded public avatar without ever forwarding API credentials.
export async function loadGithubAvatar(raw: string, context: GithubWorkContext, transport: typeof fetch = fetch): Promise<Buffer | null> {
  let url: URL
  try { url = new URL(raw) } catch { return null }
  if (url.origin !== 'https://avatars.githubusercontent.com' || url.username || url.password) return null
  // Ask GitHub's avatar service for display-sized pixels instead of downloading the original.
  url.searchParams.set('s', '64')
  const cached = avatarCache.get(url.href)
  if (cached && Date.now() - cached.capturedAt < 86400000) return cached.image
  const controller = new AbortController()
  const cancelGithubAvatarRequest = (): void => controller.abort(context.signal.reason)
  context.signal.addEventListener('abort', cancelGithubAvatarRequest, { once: true })
  const timer = setTimeout(() => controller.abort(), Math.max(1, Math.min(GITHUB_LIMITS.assetMs, context.deadline - Date.now())))
  try {
    assertGithubWork(context)
    const response = await transport(url, { redirect: 'error', signal: controller.signal })
    if (!response.ok || !response.body) return null
    const reader = response.body.getReader(), chunks: Uint8Array[] = []
    let bytes = 0
    try {
      while (true) {
        const part = await reader.read()
        if (part.done) break
        bytes += part.value.length
        if (bytes > 2 * 1024 * 1024) return null
        chunks.push(part.value)
      }
    } finally { await reader.cancel().catch(() => {}) }
    const image = await sharp(Buffer.concat(chunks), { limitInputPixels: 4000000, animated: false }).resize(64, 64).png().toBuffer()
    assertGithubWork(context)
    avatarCache.set(url.href, { image, capturedAt: Date.now() })
    while (avatarCache.size > 100 || [...avatarCache.values()].reduce((sum, entry) => sum + entry.image.length, 0) > 10 * 1024 * 1024) avatarCache.delete(avatarCache.keys().next().value!)
    return image
  } catch { return null }
  finally { clearTimeout(timer); context.signal.removeEventListener('abort', cancelGithubAvatarRequest) }
}

// --- 共用工业风模板 --- //
// Share the fixed shell, colors and typography across all four public resource types.
export function buildGithubCardFrame(metadata: GithubMetadata, kind: 'ISSUE' | 'PULL REQUEST' | 'REPOSITORY' | 'USER', content: string, note = ''): string {
  const esc = escapeGithubText
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><style>
  *{box-sizing:border-box}body{margin:0;background:white;color:#1c1d1f;font-family:"Microsoft YaHei","Noto Sans CJK SC",sans-serif}
  #github-preview{width:880px;background:#fafaf7;border:1px solid #26282a}.masthead{background:#202224;color:#f7f7f0;padding:20px 28px;display:flex;align-items:center;justify-content:space-between;border-bottom:7px solid #f5d531;font:700 15px monospace;letter-spacing:2px}.masthead b{color:#f5d531;font-size:21px}.marks{color:#9da19f;letter-spacing:5px}
  .heading{padding:28px 30px 22px}.eyebrow{display:flex;gap:12px;align-items:center;font:700 16px monospace;color:#656865;margin-bottom:17px}.number{background:#f5d531;color:#18191b;padding:5px 11px}.state{border:1px solid #9b9e97;padding:4px 10px;font:600 15px sans-serif}h1{font-size:30px;line-height:1.4;margin:0;overflow-wrap:anywhere;letter-spacing:.2px}
  .author-row{display:flex;gap:13px;align-items:center;padding:16px 30px;background:#e8e9e3;border-top:1px solid #c8cac2;border-bottom:1px solid #c8cac2}.avatar{width:48px;height:48px;object-fit:cover;border-radius:2px}.avatar-placeholder{display:grid;place-items:center;background:#2a2d2d;color:#f5d531;font:700 18px monospace}.author{font-size:18px;font-weight:700;overflow-wrap:anywhere}.date{font-size:13px;color:#676c67;margin-top:5px}.labels{display:flex;gap:8px;flex-wrap:wrap;padding:0 30px 20px}.label{background:#e8e9e3;border:1px solid #d2d4cc;border-left:5px solid #757970;padding:5px 9px;font-size:13px;overflow-wrap:anywhere;max-width:100%}
  .body{padding:10px 30px 24px;font-size:19px;line-height:1.75;overflow-wrap:anywhere}.body>:first-child{margin-top:15px}.body h1,.body h2,.body h3{font-size:23px;margin:26px 0 12px;padding-bottom:6px;border-bottom:1px solid #d9dbd2}.body h4,.body h5,.body h6{font-size:20px;margin:22px 0 10px}.body p{margin:13px 0}.body a{color:#555d4f;text-decoration:underline;text-underline-offset:3px}.body blockquote{margin:16px 0;border-left:4px solid #e6c72e;background:#efefe8;padding:8px 18px;color:#50554e}.body ul,.body ol{padding-left:28px}.body pre{padding:16px;background:#e9eae4;border:1px solid #d3d5cc;white-space:pre-wrap;overflow-wrap:anywhere;word-break:break-word;line-height:1.55;font-size:14px}.body code,.body kbd{font-family:Consolas,monospace;font-size:.88em;background:#e9eae4;padding:2px 4px}.body pre code{padding:0;background:none}.body table{border-collapse:collapse;width:100%;table-layout:fixed;font-size:15px}.body th,.body td{border:1px solid #bfc3b8;padding:8px;overflow-wrap:anywhere}.body th{background:#e5e7dc}.body figure{margin:16px 0}.body img{display:block;max-width:100%;height:auto;border:1px solid #d5d8ce}.body figcaption{font-size:13px;color:#676c67}.body details{border-left:2px solid #c1c5b8;padding-left:14px}.body summary{font-weight:700}.task-check{color:#626b42;margin-right:5px}.image-missing,.attachment-note{display:block;padding:12px 15px;background:#f1edcf;border-left:3px solid #d1b72d;font-size:15px;color:#655c37;margin:12px 0}
  footer{padding:17px 30px 20px;border-top:1px solid #c7cabf;background:#e9eae4;font-size:12px;color:#61665e;line-height:1.8;overflow-wrap:anywhere}.source{font-family:Consolas,monospace;color:#363c33;font-size:13px}.warning{color:#776220;font-weight:700}.footer-row{display:flex;justify-content:space-between;gap:15px}.slash{color:#959a8c;letter-spacing:3px}
  .eyebrow{flex-wrap:wrap;overflow-wrap:anywhere}.author-row>div{min-width:0}.avatar{flex-shrink:0}.description{white-space:pre-wrap}.facts{display:grid;grid-template-columns:190px minmax(0,1fr);margin:20px 0 0;border-top:1px solid #c7cabf;font-size:17px;line-height:1.7}.facts dt,.facts dd{margin:0;padding:10px 12px;border-bottom:1px solid #d9dbd2;overflow-wrap:anywhere}.facts dt{color:#61665e;background:#e9eae4}.facts dd{background:#f4f4ed}
  </style></head><body><main id="github-preview"><div class="masthead"><b>GITHUB / ${kind}</b><span class="marks">// PUBLIC RECORD</span></div>${content}<footer>${note ? `<div class="warning">${esc(note)}</div>` : ''}<div class="source">${esc(metadata.url)}</div><div class="footer-row"><span>${['issue', 'pull'].includes(metadata.target.kind) ? '官方公开原文' : '官方公开数据'} · ${esc(new Date(metadata.fetchedAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }))}（北京时间）</span><span class="slash">/////</span></div></footer></main></body></html>`
}

// Render original descriptions and verified metadata without a summary/model branch.
export function buildGithubCardHtml(metadata: GithubMetadata, avatar: Buffer | null, note = ''): string {
  const esc = escapeGithubText
  const repository = metadata.target.kind === 'repository'
  const owner = metadata.author || metadata.target.owner || ''
  const description = metadata.description || '未提供公开简介'
  const image = avatar ? `<img class="avatar" src="data:image/png;base64,${avatar.toString('base64')}" alt="${esc(owner)}">` : '<span class="avatar avatar-placeholder">GH</span>'
  const content = `<section class="heading"><div class="eyebrow"><span class="number">${repository ? '项目' : '用户'}</span><span>${esc(metadata.target.owner || '')}</span></div><h1>${esc(metadata.title)}</h1></section><div class="author-row">${image}<div><div class="author">${esc(owner)}</div><div class="date">${repository ? '仓库所有者' : '公开账户'}</div></div></div><article class="body"><p class="description">${esc(description.slice(0, 600))}${description.length > 600 ? '…（原文已截断，请查看来源）' : ''}</p><dl class="facts">${metadata.facts.map(([label, value]) => `<dt>${esc(label)}</dt><dd>${esc(value)}</dd>`).join('')}</dl></article>`
  return buildGithubCardFrame(metadata, repository ? 'REPOSITORY' : 'USER', content, note)
}

// Split continuous rendered pixels and apply the existing white margins and output limits.
export async function splitGithubImage(raw: Buffer, context: GithubWorkContext): Promise<Buffer[]> {
  assertGithubWork(context)
  const { width, height } = await sharp(raw).metadata()
  if (!width || !height) throw new Error('正文图片尺寸无效')
  const count = Math.ceil(height / (GITHUB_LIMITS.imageHeight - GITHUB_LIMITS.padding * 2))
  if (count > GITHUB_LIMITS.maxImages) throw new Error('正文过长，请查看原文')
  const sliceHeight = Math.ceil(height / count), images: Buffer[] = []
  let bytes = 0
  for (let top = 0; top < height; top += sliceHeight) {
    assertGithubWork(context)
    const padding = GITHUB_LIMITS.padding
    const image = await sharp(raw).extract({ left: 0, top, width, height: Math.min(sliceHeight, height - top) }).extend({ top: padding, bottom: padding, left: padding, right: padding, background: '#fff' }).png().toBuffer()
    assertGithubWork(context)
    bytes += image.length
    if (bytes > GITHUB_LIMITS.imageBytes) throw new Error('正文图片超过大小限制，请查看原文')
    images.push(image)
  }
  return images
}
// Render all cards through the same offline, cropped and padded browser lifecycle.
export async function renderGithubCard(metadata: GithubMetadata, context: GithubWorkContext): Promise<GithubImageResult> {
  assertGithubWork(context)
  const avatar = metadata.avatar ? await loadGithubAvatar(metadata.avatar, context) : null
  assertGithubWork(context)
  const incomplete = Boolean(metadata.avatar && !avatar)
  const note = incomplete ? '头像暂未载入，请查看原文。' : ''
  const raw = await renderHtmlToImage(buildGithubCardHtml(metadata, avatar, note), { signal: context.signal, deadlineMs: context.deadline, workDeadlineMs: context.deadline, taskId: context.taskId, source: 'github-preview', networkPolicy: 'offline', captureSelector: '#github-preview' })
  const images = await splitGithubImage(raw, context)
  return { images, capturedAt: Date.now(), incomplete, note }
}

// A readable official-field fallback never invents an answer or exposes response bodies.
export function githubTextFallback(metadata: GithubMetadata): string {
  return [metadata.title, metadata.state ? `${metadata.target.owner}/${metadata.target.repo} #${metadata.target.number} · ${metadata.state}` : '', metadata.description || '', ...metadata.facts.map(([label, value]) => `${label}：${value}`), metadata.url].filter(Boolean).join('\n')
}
