/**
 * MODULE: GitHub PR 前后风格对比卡片。
 * 职责: 离线渲染「前风格工业风卡片」与「后风格看板详情卡片」（明暗双主题），同一条消息按序发出两张图。
 * 边界: 不打开官网、不调用模型；调用方拥有全局资源门卫与官方字段合同。
 */
import type { GithubMetadata, GithubImageResult, GithubWorkContext, GithubCheckRun, GithubPullTheme } from './models'
import { GITHUB_LIMITS, assertGithubWork } from './models'
import { escapeGithubText as esc, loadGithubAvatar, splitGithubImage } from './renderer'
import { prepareGithubBody } from './body-content'
const { buildGithubIssueHtml } = require('./issue-renderer') as { buildGithubIssueHtml(metadata: GithubMetadata, body: string, avatar: Buffer | null, note?: string): string }
const { renderHtmlToImage } = require('../../../koishi-plugin-daily-report/lib/html-renderer') as {
  renderHtmlToImage(html: string, context: { signal: AbortSignal; deadlineMs: number; workDeadlineMs: number; taskId: string; source: string; networkPolicy: 'offline'; captureSelector: string }): Promise<Buffer>
}
const { readLinuxMeminfo } = require('../resource-scheduler/resource-snapshot') as typeof import('../resource-scheduler/resource-snapshot')

// --- 固定模板（看板详情两套皮肤令牌） --- //
const REVIEW_TEXT: Record<string, string> = { APPROVED: '✅ 已批准', CHANGES_REQUESTED: '⛔ 要求修改', COMMENTED: '💬 评论', DISMISSED: '已撤销', PENDING: '待提交' }
interface GithubPullTokens {
  page: string; root: string; tile: string; border: string; text: string; muted: string; accent: string; green: string; amber: string; red: string; purple: string
  code: string; quote: string; quoteText: string; chipText: string
  openBg: string; openBorder: string; mergedBg: string; mergedBorder: string; closedBg: string; closedBorder: string; draftBg: string; draftBorder: string
  noteBg: string; noteBorder: string; noteText: string
}
const GITHUB_PULL_THEMES: Record<GithubPullTheme, GithubPullTokens> = {
  dark: {
    page: '#ffffff', root: '#171a21', tile: '#1e2330', border: '#2a3142', text: '#e8eaed', muted: '#9aa3b2', accent: '#6ea8fe', green: '#3dd68c', amber: '#f5c542', red: '#f07178', purple: '#c792ea',
    code: '#10131a', quote: '#1e2330', quoteText: '#c3cad6', chipText: '#c9d2e0',
    openBg: 'rgba(61,214,140,.08)', openBorder: 'rgba(61,214,140,.35)', mergedBg: 'rgba(199,146,234,.12)', mergedBorder: 'rgba(199,146,234,.4)',
    closedBg: 'rgba(240,113,120,.1)', closedBorder: 'rgba(240,113,120,.4)', draftBg: 'rgba(245,197,66,.08)', draftBorder: 'rgba(245,197,66,.4)',
    noteBg: '#26200e', noteBorder: '#f5c542', noteText: '#f5c542',
  },
  light: {
    page: '#ffffff', root: '#ffffff', tile: '#e8edf5', border: '#c9d2e0', text: '#1a2030', muted: '#5a6578', accent: '#3b6fd4', green: '#1a9e64', amber: '#b8860b', red: '#d04550', purple: '#8b5cb8',
    code: '#f3f5f9', quote: '#e8edf5', quoteText: '#3c465c', chipText: '#2c3a55',
    openBg: 'rgba(26,158,100,.08)', openBorder: 'rgba(26,158,100,.35)', mergedBg: 'rgba(139,92,184,.12)', mergedBorder: 'rgba(139,92,184,.4)',
    closedBg: 'rgba(208,69,80,.08)', closedBorder: 'rgba(208,69,80,.35)', draftBg: 'rgba(184,134,11,.08)', draftBorder: 'rgba(184,134,11,.4)',
    noteBg: '#fdf6e3', noteBorder: '#b8860b', noteText: '#7a5a08',
  },
}

function githubPullStateHtml(metadata: GithubMetadata): string {
  const cls = metadata.state === '已合并' ? 'is-merged' : metadata.state === '已关闭' ? 'is-closed' : metadata.state === '草稿' ? 'is-draft' : 'is-open'
  return `<span class="state ${cls}"><i></i>${esc(metadata.state || '未知')}</span>`
}

// The checks pill mirrors the board header: overall verdict first, counts in the tooltip-free title text.
function githubPullChecksPill(metadata: GithubMetadata): string {
  const partial = metadata.pull?.partial || []
  const checks = metadata.pull?.checks
  if (checks) {
    const map: Record<string, [string, string]> = { success: ['is-open', '检查通过'], failure: ['is-closed', '检查失败'], pending: ['is-draft', '检查中'], neutral: ['', '检查完成'] }
    const [cls, text] = map[checks.overall] || ['', '检查']
    return `<span class="state ${cls}"><i></i>${text} ${checks.counts.success + checks.counts.failure}/${checks.total}</span>`
  }
  if (partial.includes('检查')) return '<span class="state"><i></i>检查不可用</span>'
  return '<span class="state"><i></i>无检查</span>'
}

function githubPullStatTile(value: number | undefined, label: string, prefix = '', cls = ''): string {
  if (value === undefined) return ''
  return `<div class="stat"><b${cls ? ` class="${cls}"` : ''}>${esc(prefix + value)}</b><span>${esc(label)}</span></div>`
}

function githubPullMetaRow(label: string, html: string): string {
  return html ? `<dt>${esc(label)}</dt><dd>${html}</dd>` : ''
}

function githubPullUserChip(login: string, avatar: Buffer | null): string {
  const image = avatar ? `<img src="data:image/png;base64,${avatar.toString('base64')}" alt="">` : ''
  return `<span class="user">${image}<span class="login">${esc(login)}</span></span>`
}

function githubPullTime(value: string | undefined): string {
  if (!value) return ''
  const time = new Date(value)
  return Number.isNaN(time.getTime()) ? esc(value) : esc(time.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }))
}

// Interpolate the board detail skin from theme tokens; structure stays identical across skins.
function githubPullStyles(t: GithubPullTokens): string {
  return `  *{box-sizing:border-box}body{margin:0;background:${t.page};color:${t.text};font-family:"Microsoft YaHei","Noto Sans CJK SC",sans-serif}
  #github-preview{width:880px;background:${t.root};border:1px solid ${t.border};padding:24px 26px}
  .kicker{display:flex;flex-wrap:wrap;align-items:center;gap:10px;font-size:14px;color:${t.muted}}.kind{font-weight:650;padding:3px 12px;border-radius:999px;border:1px solid ${t.border};background:${t.tile};color:${t.accent};letter-spacing:.5px}.repo{font-family:Consolas,monospace;overflow-wrap:anywhere}.num{color:${t.muted}}
  h1{font-size:26px;line-height:1.45;margin:12px 0 0;color:${t.text};overflow-wrap:anywhere;letter-spacing:.2px}
  .states{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin-top:12px}
  .state{display:inline-flex;align-items:center;gap:7px;padding:4px 12px;border-radius:999px;border:1px solid ${t.border};background:${t.tile};color:${t.muted};font-size:14px}.state i{width:8px;height:8px;border-radius:50%;background:currentColor}
  .state.is-open{color:${t.green};border-color:${t.openBorder};background:${t.openBg}}.state.is-merged{color:${t.purple};border-color:${t.mergedBorder};background:${t.mergedBg}}.state.is-closed{color:${t.red};border-color:${t.closedBorder};background:${t.closedBg}}.state.is-draft{color:${t.amber};border-color:${t.draftBorder};background:${t.draftBg}}
  .stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(96px,1fr));gap:8px;margin-top:18px}
  .stat{border:1px solid ${t.border};border-radius:10px;background:${t.tile};padding:9px 11px;min-width:0}.stat b{display:block;font-size:19px;line-height:1.25;font-variant-numeric:tabular-nums;color:${t.text};overflow-wrap:anywhere}.stat span{color:${t.muted};font-size:12px}.stat .add{color:${t.green}}.stat .del{color:${t.red}}
  .meta{display:grid;grid-template-columns:104px minmax(0,1fr);gap:8px 14px;margin-top:18px;font-size:15px}
  .meta dt{color:${t.muted};margin:0}.meta dd{margin:0;min-width:0;word-break:break-word;display:flex;flex-wrap:wrap;gap:6px 10px;align-items:center}
  .user{display:inline-flex;align-items:center;gap:7px;color:${t.text}}.user img{width:20px;height:20px;border-radius:50%;border:1px solid ${t.border}}.user .login{overflow-wrap:anywhere}
  .chip{display:inline-flex;align-items:center;padding:2px 10px;border-radius:999px;border:1px solid ${t.border};background:${t.tile};color:${t.chipText};font-size:13px;overflow-wrap:anywhere;max-width:100%}
  .tag{display:inline-flex;align-items:center;padding:1px 8px;border-radius:6px;border:1px solid ${t.border};background:${t.root};color:${t.muted};font-size:12.5px}
  .branch{font-family:Consolas,monospace;font-size:13.5px;color:${t.accent};overflow-wrap:anywhere}.arrow{color:${t.muted};margin:0 2px}
  .sec{margin-top:20px}.h-label{display:flex;align-items:center;gap:8px;color:${t.muted};font-size:13px;letter-spacing:1px;margin-bottom:9px}
  .checks{list-style:none;margin:0;padding:0;border:1px solid ${t.border};border-radius:10px;overflow:hidden}
  .checks li{display:flex;align-items:center;gap:9px;padding:8px 13px;font-size:14px;border-top:1px solid ${t.border};background:${t.tile}}.checks li:first-child{border-top:0}
  .checks li>i{width:8px;height:8px;border-radius:50%;flex:0 0 8px;background:${t.muted}}.checks li.b-success>i{background:${t.green}}.checks li.b-failure>i{background:${t.red}}.checks li.b-pending>i{background:${t.amber}}
  .checks .nm{flex:1 1 auto;min-width:0;overflow-wrap:anywhere;color:${t.text}}.checks .cc{color:${t.muted};font-size:12.5px;white-space:nowrap}
  .body{border-top:1px solid ${t.border};padding-top:10px;font-size:17px;line-height:1.7;overflow-wrap:anywhere}
  .body h1,.body h2,.body h3{font-size:21px;margin:22px 0 10px;padding-bottom:5px;border-bottom:1px solid ${t.border}}.body h4,.body h5,.body h6{font-size:18px;margin:18px 0 8px}.body p{margin:11px 0}.body a{color:${t.accent};text-decoration:underline;text-underline-offset:3px}
  .body blockquote{margin:14px 0;border-left:4px solid ${t.accent};background:${t.quote};padding:8px 16px;color:${t.quoteText}}.body ul,.body ol{padding-left:26px}
  .body pre{padding:14px;background:${t.code};border:1px solid ${t.border};white-space:pre-wrap;overflow-wrap:anywhere;word-break:break-word;line-height:1.55;font-size:14px;color:${t.text}}.body code,.body kbd{font-family:Consolas,monospace;font-size:.88em;background:${t.code};padding:2px 4px;color:${t.text}}.body pre code{padding:0;background:none}
  .body table{border-collapse:collapse;width:100%;table-layout:fixed;font-size:14px}.body th,.body td{border:1px solid ${t.border};padding:7px;overflow-wrap:anywhere}.body th{background:${t.tile}}
  .body img{display:block;max-width:100%;height:auto;border:1px solid ${t.border};border-radius:8px}.body figcaption{font-size:12.5px;color:${t.muted}}.body details{margin:12px 0;padding:8px 12px;border:1px solid ${t.border};border-radius:8px;background:${t.tile}}.body summary{font-weight:700;color:${t.muted}}.task-check{color:${t.green};margin-right:5px}
  .image-missing,.attachment-note{display:block;padding:10px 14px;background:${t.noteBg};border-left:3px solid ${t.noteBorder};font-size:14px;color:${t.noteText};margin:10px 0}
  footer{margin-top:20px;padding-top:14px;border-top:1px solid ${t.border};font-size:12.5px;color:${t.muted};line-height:1.8;overflow-wrap:anywhere}
  .source{font-family:Consolas,monospace;color:${t.accent};font-size:13px}.warn{color:${t.amber};font-weight:700}`
}

// Build the fixed board-style document from already validated official fields only.
export function buildGithubPullHtml(metadata: GithubMetadata, body: string, avatar: Buffer | null, note = '', theme: GithubPullTheme = 'dark'): string {
  const t = GITHUB_PULL_THEMES[theme]
  const pull = metadata.pull
  const stats = pull?.stats
  const mergeable = stats?.mergeableState && stats.mergeableState !== 'unknown' && metadata.state === '开启中' ? `<span class="chip">${esc(stats.mergeableState)}</span>` : ''
  const labels = (metadata.labels || []).map(label => `<span class="chip"${/^[0-9a-f]{6}$/i.test(label.color) ? ` style="border-color:#${label.color}aa;background:#${label.color}22"` : ''}>${esc(label.name)}</span>`).join('')
  const verdicts = (pull?.reviews || []).map(review => `${githubPullUserChip(review.login, null)}<span class="tag">${esc(REVIEW_TEXT[review.state] || review.state)}</span>`).join('')
  const assignees = (stats?.assignees || []).map(login => githubPullUserChip(login, null)).join('')
  const requested = (stats?.requestedReviewers || []).map(login => githubPullUserChip(login, null)).join('')
  const statsHtml = [
    githubPullStatTile(stats?.comments, '评论'),
    githubPullStatTile(pull?.reviewTotal, '评审'),
    githubPullStatTile(stats?.reviewComments, '行内评论'),
    githubPullStatTile(stats?.commits, '提交'),
    githubPullStatTile(stats?.changedFiles, '文件'),
    githubPullStatTile(stats?.additions, '新增行', '+', 'add'),
    githubPullStatTile(stats?.deletions, '删除行', '−', 'del'),
  ].filter(Boolean).join('')
  const checksList = pull?.checks?.runs.length ? `<section class="sec"><div class="h-label">检查 · 头提交 <span class="branch">${esc((stats?.headSha || '').slice(0, 7))}</span></div><ul class="checks">${pull.checks.runs.map(run => `<li class="b-${run.bucket}"><i></i><span class="nm">${esc(run.name)}</span><span class="cc">${esc(run.status === 'completed' ? run.conclusion || '' : run.status)}</span></li>`).join('')}</ul></section>` : ''
  const meta = [
    githubPullMetaRow('作者', githubPullUserChip(metadata.author || '', avatar)),
    githubPullMetaRow('指派', assignees),
    githubPullMetaRow('请求评审', requested),
    githubPullMetaRow('评审结论', verdicts),
    githubPullMetaRow('标签', labels),
    githubPullMetaRow('里程碑', stats?.milestone ? `<span class="chip">${esc(stats.milestone)}</span>` : ''),
    githubPullMetaRow('分支', stats?.headRef ? `<span class="branch">${esc(stats.headRef)}</span><span class="arrow">→</span><span class="branch">${esc(stats.baseRef || '')}</span>` : ''),
    githubPullMetaRow('可合并状态', mergeable),
    githubPullMetaRow('创建', githubPullTime(metadata.createdAt)),
    githubPullMetaRow('更新', githubPullTime(stats?.updatedAt)),
    githubPullMetaRow('合并', stats?.mergedAt ? githubPullTime(stats.mergedAt) + (stats.mergedBy ? `<span class="tag">by</span>${esc(stats.mergedBy)}` : '') : ''),
  ].filter(Boolean).join('')
  const partial = pull?.partial?.length ? `<div class="warn">部分数据获取失败：${esc(pull.partial.join('、'))}，请查看原文。</div>` : ''
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><style>
${githubPullStyles(t)}
  </style></head><body><main id="github-preview"><div class="kicker"><span class="kind">PULL REQUEST</span><span class="repo">${esc(metadata.target.owner + '/' + metadata.target.repo)}</span><span class="num">#${esc(String(metadata.target.number ?? ''))}</span></div><h1>${esc(metadata.title)}</h1><div class="states">${githubPullStateHtml(metadata)}${githubPullChecksPill(metadata)}</div>${statsHtml ? `<section class="stats">${statsHtml}</section>` : ''}${meta ? `<dl class="meta">${meta}</dl>` : ''}${checksList}<section class="sec"><div class="h-label">描述 · 发起者原文</div><article class="body">${body || '<p class="empty">作者未填写正文</p>'}</article></section><footer>${partial}${note ? `<div class="warn">${esc(note)}</div>` : ''}<div class="source">${esc(metadata.url)}</div><div>官方公开数据 · ${esc(new Date(metadata.fetchedAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }))}（北京时间）</div></footer></main></body></html>`
}

// Render through the existing browser lifecycle while preserving cancellation and memory protection.
export async function renderGithubPullCard(metadata: GithubMetadata, context: GithubWorkContext, theme: GithubPullTheme = 'dark'): Promise<GithubImageResult> {
  assertGithubWork(context)
  if (typeof metadata.bodyHtml !== 'string') throw new Error('官方正文数据不可用')
  const available = readLinuxMeminfo().availableMb
  if (available !== null && available < GITHUB_LIMITS.minMemoryMb) throw new Error('可用内存不足，改用文字信息')
  const controller = new AbortController()
  // Preserve the outer cancellation reason for downloads and the owned browser lifecycle.
  const cancelGithubPullRender = (): void => controller.abort(context.signal.reason)
  context.signal.addEventListener('abort', cancelGithubPullRender, { once: true })
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
    const classicHtml = buildGithubIssueHtml(metadata, body.html, avatar, note)
    const boardHtml = buildGithubPullHtml(metadata, body.html, avatar, note, theme)
    if ([classicHtml, boardHtml].some(html => Buffer.byteLength(html, 'utf8') > GITHUB_LIMITS.htmlBytes)) throw new Error('正文模板超过大小限制，请查看原文')
    const render = { signal: work.signal, deadlineMs: work.deadline, workDeadlineMs: work.deadline, taskId: work.taskId, source: 'github-preview', networkPolicy: 'offline' as const, captureSelector: '#github-preview' }
    // Sequential captures keep at most one owned browser alive at a time; both cards ship as separate images.
    const before = await splitGithubImage(await renderHtmlToImage(classicHtml, render), work)
    assertGithubWork(work)
    const after = await splitGithubImage(await renderHtmlToImage(boardHtml, render), work)
    const images = [...before, ...after]
    assertGithubWork(work)
    return { images, capturedAt: Date.now(), incomplete: body.missing > 0 || avatarMissing, note }
  } catch (error) {
    if (work.signal.aborted) throw work.signal.reason
    if (Date.now() >= work.deadline) throw new Error('GitHub 正文渲染超时（最多30秒）')
    throw error
  } finally { clearInterval(monitor); context.signal.removeEventListener('abort', cancelGithubPullRender) }
}
