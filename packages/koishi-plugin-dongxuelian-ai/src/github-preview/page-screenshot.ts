/**
 * MODULE: GitHub Issue/PR 页面截图。
 * 职责: 匿名打开官方页面、定位首条正文、限定加载时间并裁剪加留白。
 * 边界: 调用方负责全局资源准入，不调用模型；每次调用仅拥有自建浏览器和短期计时器。
 */
import fs = require('fs')
import type { Browser, Page, HTTPRequest } from 'puppeteer-core'
import type { GithubMetadata, GithubImageResult, GithubWorkContext } from './models'
import { GITHUB_LIMITS, assertGithubWork, waitGithubWork } from './models'
import { parseGithubTarget } from './input'
const puppeteer = require('puppeteer-core') as typeof import('puppeteer-core')
const sharp = require('sharp') as typeof import('sharp')
const { resolveAndValidateHostname } = require('../core/utils') as typeof import('../core/utils')
const { readLinuxMeminfo } = require('../resource-scheduler/resource-snapshot') as typeof import('../resource-scheduler/resource-snapshot')
const { acquireResourceActivityLease, readResourceActivityLease } = require('../resource-scheduler/resource-activity-lease') as typeof import('../resource-scheduler/resource-activity-lease')
const { terminateProcessTree, writeProcessCleanupEvent } = require('../resource-system/system-protection') as typeof import('../resource-system/system-protection')

export interface GithubRegion { x: number; y: number; width: number; height: number; ready: boolean; imageCount: number; title: string }
const GITHUB_IMAGE_HOSTS = new Set(['github.com', 'github.githubassets.com', 'avatars.githubusercontent.com', 'private-user-images.githubusercontent.com', 'user-images.githubusercontent.com', 'camo.githubusercontent.com', 'github-production-user-asset-6210df.s3.amazonaws.com'])

// --- 网络边界与目标区域 --- //
// Allow only observed official resources; nested navigation and arbitrary network types are denied.
export function allowGithubPageRequest(raw: string, type: string, mainNavigation: boolean): boolean {
  let url: URL
  try { url = new URL(raw) } catch { return false }
  if (url.protocol === 'data:' && type === 'image') return true
  if (url.protocol !== 'https:' || url.port || url.username || url.password) return false
  if (type === 'document') return mainNavigation && url.hostname === 'github.com' && /^\/[a-z\d_-]+\/[a-z\d_.-]+\/(issues|pull)\/[1-9]\d*\/?$/i.test(url.pathname)
  if (type === 'stylesheet' || type === 'script') return url.hostname === 'github.githubassets.com'
  if (type === 'image') return GITHUB_IMAGE_HOSTS.has(url.hostname)
  return type === 'fetch' && url.hostname === 'github.com'
}

// Locate the two verified page structures, excluding hidden duplicates and later discussion.
export function inspectGithubRegion(kind: 'issue' | 'pull', author: string): GithubRegion | null {
  const visibleGithubElement = (element: Element | null | undefined): element is HTMLElement => !!element && element.getBoundingClientRect().width > 0 && element.getBoundingClientRect().height > 0 && getComputedStyle(element).visibility !== 'hidden'
  const titleNode = [...document.querySelectorAll(kind === 'issue' ? '[data-testid="issue-title"]' : 'h1 .markdown-title')].find(visibleGithubElement)
  const heading = titleNode?.closest('h1') || null
  const root = [...document.querySelectorAll(kind === 'issue' ? '[data-testid="issue-body"]' : '.js-command-palette-pull-body')].find(visibleGithubElement)
  const body = root && [...root.querySelectorAll(kind === 'issue' ? '#issue-body-viewer' : '.js-comment-body')].find(visibleGithubElement)
  const labels = [...document.querySelectorAll(kind === 'issue' ? '[data-testid="sidebar-labels-section"]' : '.discussion-sidebar-item[data-channel-event-name="labels_updated"]')].find(visibleGithubElement)
  if (!visibleGithubElement(heading) || !visibleGithubElement(root || null) || !visibleGithubElement(body || null) || !visibleGithubElement(labels)) return null
  const currentRoot = root as HTMLElement, currentBody = body as HTMLElement, currentLabels = labels as HTMLElement
  // The initiating author must occur in the opening post, never in a later comment.
  const authorLink = [...currentRoot.querySelectorAll('a')].find(link => link.origin === 'https://github.com' && link.pathname.toLowerCase() === '/' + author.toLowerCase())
  if (!authorLink) return null
  const top = heading.getBoundingClientRect(), post = currentRoot.getBoundingClientRect(), bottom = currentBody.getBoundingClientRect()
  let sidebar = currentLabels.getBoundingClientRect()
  if (sidebar.bottom > bottom.bottom) {
    const labelTop = Math.min(bottom.top, bottom.bottom - sidebar.height)
    if (labelTop < top.bottom || sidebar.left < post.right - 10) return null
    // Move only the original label panel, preserving its official content and colours.
    Object.assign(currentLabels.style, { position: 'absolute', top: `${labelTop + scrollY}px`, left: `${sidebar.left + scrollX}px`, width: `${sidebar.width}px`, margin: '0', background: '#ffffff', zIndex: '10' })
    document.body.appendChild(currentLabels)
    sidebar = currentLabels.getBoundingClientRect()
  }
  const images = [...currentRoot.querySelectorAll('img'), ...currentLabels.querySelectorAll('img')].filter(visibleGithubElement) as HTMLImageElement[]
  // Trigger only images inside the opening post, without traversing later comments.
  for (const image of images) if (image.loading === 'lazy') image.loading = 'eager'
  const stylesReady = [...document.querySelectorAll('link[rel="stylesheet"]')].every(link => !!(link as HTMLLinkElement).sheet)
  const ready = stylesReady && document.fonts.status === 'loaded' && images.every(image => image.complete && image.naturalWidth > 0 && image.naturalHeight > 0)
  const left = Math.min(top.left, post.left, sidebar.left), right = Math.max(top.right, post.right, sidebar.right)
  const x = Math.max(0, Math.floor(left + scrollX)), y = Math.max(0, Math.floor(top.top + scrollY))
  return { x, y, width: Math.ceil(right + scrollX) - x, height: Math.ceil(bottom.bottom + scrollY) - y, ready, imageCount: images.length, title: titleNode?.textContent || '' }
}

// All probes consume the caller's one navigation deadline, including transient evaluation failures.
export async function waitForGithubRegion(page: Pick<Page, 'evaluate'>, metadata: GithubMetadata, context: GithubWorkContext, loadDeadline: number): Promise<boolean> {
  let previous: GithubRegion | null = null
  while (performance.now() < loadDeadline) {
    assertGithubWork(context)
    let current: GithubRegion | null
    try { current = await withinGithubStage(page.evaluate(inspectGithubRegion, metadata.target.kind as 'issue' | 'pull', metadata.author!), loadDeadline) }
    catch (error) {
      console.warn(`github-preview page_probe_failed type=${metadata.target.kind} error=${error instanceof Error ? error.name + ': ' + error.message.slice(0, 180) : 'unknown'}`)
      if (performance.now() >= loadDeadline) break
      current = null
    }
    if (current?.ready && previous?.ready && JSON.stringify(current) === JSON.stringify(previous)) return true
    previous = current
    await waitGithubWork(Math.min(150, Math.max(1, loadDeadline - performance.now())), context.signal)
  }
  return false
}

// --- 时间预算与图片编码 --- //
// Apply one absolute stage deadline; timers never remain alive after fast completion.
async function withinGithubStage<T>(operation: Promise<T>, deadline: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try { return await Promise.race([operation, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('GitHub 页面阶段超时')), Math.max(1, deadline - performance.now())) })]) }
  finally { if (timer) clearTimeout(timer) }
}

// Select an installed browser using the project's existing environment conventions.
export function findGithubBrowser(): string {
  const candidates = [process.env.DONGXUELIAN_BROWSER_PATH, process.env.CHROME_PATH, process.env.PUPPETEER_EXECUTABLE_PATH, 'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium']
  const found = candidates.find((candidate): candidate is string => !!candidate && fs.existsSync(candidate))
  if (!found) throw new Error('未找到 Chrome/Chromium 浏览器')
  return found
}

// Split continuous content and add true blank padding, respecting final image dimensions.
export async function encodeGithubClips(page: Page, region: GithubRegion, deadline: number): Promise<Buffer[]> {
  const contentHeight = GITHUB_LIMITS.imageHeight - GITHUB_LIMITS.padding * 2
  const count = Math.ceil(region.height / contentHeight)
  if (![region.x, region.y, region.width, region.height].every(Number.isFinite) || region.x < 0 || region.y < 0 || region.height <= 0 || region.width <= 0 || region.width > GITHUB_LIMITS.viewportWidth || count > GITHUB_LIMITS.maxImages) throw new Error('正文过长或截图范围无效，请查看原文')
  const sliceHeight = Math.ceil(region.height / count)
  const images: Buffer[] = []
  let totalBytes = 0
  for (let offset = 0; offset < region.height; offset += sliceHeight) {
    const raw = await withinGithubStage(page.screenshot({ type: 'png', clip: { x: region.x, y: region.y + offset, width: region.width, height: Math.min(sliceHeight, region.height - offset) }, captureBeyondViewport: true, optimizeForSpeed: true }), deadline)
    const image = await withinGithubStage(sharp(Buffer.from(raw)).extend({ top: GITHUB_LIMITS.padding, bottom: GITHUB_LIMITS.padding, left: GITHUB_LIMITS.padding, right: GITHUB_LIMITS.padding, background: '#ffffff' }).png().toBuffer(), deadline)
    totalBytes += image.length
    if (totalBytes > GITHUB_LIMITS.imageBytes) throw new Error('正文图片超过大小限制，请查看原文')
    images.push(image)
  }
  return images
}

// --- 浏览器生命周期 --- //
// Open a single anonymous official page under the caller's gate; always reclaim our process tree.
export async function screenshotGithubPage(metadata: GithubMetadata, context: GithubWorkContext): Promise<GithubImageResult> {
  assertGithubWork(context)
  if (!['issue', 'pull'].includes(metadata.target.kind) || !metadata.author) throw new Error('截图类型或发起者信息无效')
  if (readResourceActivityLease('tool_active')) throw new Error('浏览器工具正在使用资源，请稍后重试')
  const memory = readLinuxMeminfo().availableMb
  if (memory !== null && memory < GITHUB_LIMITS.minMemoryMb) throw new Error('可用内存不足，改用文字信息')
  const releaseActivity = acquireResourceActivityLease('render_active', { owner: 'github-preview', taskId: context.taskId, ttlMs: 60000 })
  let browser: Browser | undefined
  let browserPid: number | undefined
  let closing: Promise<void> | undefined
  let stoppedForMemory = false
  let cleanupSucceeded = true
  // Stop only this task's browser and bound graceful shutdown before exact-PID cleanup.
  const close = (): Promise<void> => {
    if (!browser) return Promise.resolve()
    if (closing) return closing
    closing = (async () => {
      if (!browser) return
      let timer: ReturnType<typeof setTimeout> | undefined
      try { await Promise.race([browser.close(), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('browser close timeout')), 2500) })]) }
      catch {
        const result = browserPid ? terminateProcessTree(browserPid, { source: 'github-preview', taskId: context.taskId, reason: 'github_browser_close_timeout', timeoutMs: 1000 }) : undefined
        cleanupSucceeded = result?.event === 'process_tree_terminated' || result?.event === 'process_tree_not_running'
        if (!cleanupSucceeded) throw new Error('本任务浏览器清理失败，已记录进程以供回收')
      }
      finally { if (timer) clearTimeout(timer) }
    })()
    return closing
  }
  const closeCancelledGithubBrowser = (): void => { void close().catch(() => console.warn('github-preview cancellation_cleanup_failed')) }
  context.signal.addEventListener('abort', closeCancelledGithubBrowser, { once: true })
  const monitor = setInterval(() => { const available = readLinuxMeminfo().availableMb; if (available !== null && available < GITHUB_LIMITS.stopMemoryMb) { stoppedForMemory = true; void close().catch(() => console.warn('github-preview memory_cleanup_failed')) } }, 500)
  let page: Page | undefined
  let blocked = false
  try {
    browser = await puppeteer.launch({ executablePath: findGithubBrowser(), headless: true, timeout: Math.max(1, Math.min(8000, context.deadline - Date.now())), protocolTimeout: 5000, args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--disable-extensions', '--disable-background-networking'] })
    browserPid = browser.process()?.pid
    writeProcessCleanupEvent({ event: 'chromium_launched', source: 'github-preview', taskId: context.taskId, browserPid, parentPid: process.pid })
    assertGithubWork(context)
    if (stoppedForMemory) throw new Error('运行中可用内存不足，改用文字信息')
    if (closing) throw new Error('截图任务已中止')
    page = await browser.newPage()
    await page.setViewport({ width: GITHUB_LIMITS.viewportWidth, height: 900, deviceScaleFactor: 1 })
    const cdp = await page.createCDPSession()
    await cdp.send('Browser.setDownloadBehavior', { behavior: 'deny' })
    const dnsChecks = new Map<string, Promise<unknown>>()
    await page.setRequestInterception(true)
    // The allowlist also applies to redirects, frames and scripts initiating fetches.
    page.on('request', (request: HTTPRequest) => {
      void (async () => {
        if (request.isInterceptResolutionHandled()) return
        if (blocked || context.signal.aborted || !allowGithubPageRequest(request.url(), request.resourceType(), request.frame() === page!.mainFrame())) { await request.abort(); return }
        if (request.url().startsWith('https:')) {
          const url = new URL(request.url())
          if (!dnsChecks.has(url.hostname)) dnsChecks.set(url.hostname, resolveAndValidateHostname(url))
          await dnsChecks.get(url.hostname)
        }
        if (blocked || context.signal.aborted) await request.abort(); else await request.continue()
      })().catch(() => { void request.abort().catch(() => {}) })
    })
    page.on('popup', popup => { if (popup) void popup.close() })
    const loadStarted = performance.now()
    const loadDeadline = loadStarted + Math.min(GITHUB_LIMITS.loadMs, Math.max(1, context.deadline - Date.now() - GITHUB_LIMITS.captureMs))
    let navigationStatus = 0
    page.on('response', response => { if (response.request().isNavigationRequest() && response.frame() === page!.mainFrame()) navigationStatus = response.status() })
    // A short navigation wait yields to target readiness; it never starts a second navigation.
    await page.goto(metadata.url, { waitUntil: 'domcontentloaded', timeout: Math.max(1, Math.min(1500, loadDeadline - performance.now())) }).catch(error => { if (error.name !== 'TimeoutError') throw error })
    const ready = await waitForGithubRegion(page, metadata, context, loadDeadline)
    console.info(`github-preview page_loaded task=${context.taskId} type=${metadata.target.kind} status=${navigationStatus} elapsedMs=${Math.round(performance.now() - loadStarted)} ready=${ready} availableMb=${readLinuxMeminfo().availableMb}`)
    blocked = true
    const captureDeadline = performance.now() + Math.min(GITHUB_LIMITS.captureMs, Math.max(1, context.deadline - Date.now()))
    await withinGithubStage(cdp.send('Page.stopLoading'), captureDeadline)
    assertGithubWork(context)
    const actual = parseGithubTarget(page.url())
    if (navigationStatus !== 200 || actual?.key !== metadata.target.key) throw new Error('页面状态或资源身份不匹配，改用文字信息')
    // Stop animations and remeasure after loading stops; stale pre-freeze coordinates are unsafe.
    await withinGithubStage(page.evaluate(() => {
      const style = document.createElement('style')
      style.textContent = '*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}'
      document.head.appendChild(style)
      for (const media of document.querySelectorAll('video,audio')) (media as HTMLMediaElement).pause()
    }), captureDeadline)
    const region = await withinGithubStage(page.evaluate(inspectGithubRegion, metadata.target.kind as 'issue' | 'pull', metadata.author), captureDeadline)
    if (!region) throw new Error('页面标题或发起者正文未就绪，改用文字信息')
    const images = await encodeGithubClips(page, region, captureDeadline)
    // Recheck the frozen target after capture without waiting for more network resources.
    const after = await withinGithubStage(page.evaluate(inspectGithubRegion, metadata.target.kind as 'issue' | 'pull', metadata.author), captureDeadline)
    if (!after || (['x', 'y', 'width', 'height', 'title', 'imageCount'] as const).some(field => after[field] !== region[field])) throw new Error('截屏期间页面布局发生变化，改用文字信息')
    const incomplete = !region.ready || !after.ready
    console.info(`github-preview captured type=${metadata.target.kind} width=${region.width} height=${region.height} images=${images.length} incomplete=${incomplete} earlyReady=${ready}`)
    return { images, incomplete, capturedAt: Date.now() }
  } catch (error) {
    if (stoppedForMemory) throw new Error('运行中可用内存不足，改用文字信息')
    if (context.signal.aborted) throw context.signal.reason
    throw error
  } finally {
    clearInterval(monitor)
    context.signal.removeEventListener('abort', closeCancelledGithubBrowser)
    try { await close() }
    finally {
      releaseActivity('github-preview-finished')
      writeProcessCleanupEvent({ event: cleanupSucceeded ? 'chromium_closed' : 'chromium_cleanup_failed', source: 'github-preview', taskId: context.taskId, browserPid, cancelled: context.signal.aborted, stoppedForMemory })
    }
  }
}
