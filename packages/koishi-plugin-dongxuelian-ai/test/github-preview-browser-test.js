'use strict'
const assert = require('node:assert/strict')
const fs = require('fs'), os = require('os'), path = require('path')
const browserData = fs.mkdtempSync(path.join(os.tmpdir(), 'github-preview-browser-'))
process.env.DONGXUELIAN_AI_DATA_DIR = browserData
const puppeteer = require('puppeteer-core'), sharp = require('sharp')
const { cleanGithubBody, prepareGithubBody, isGithubBodyImageUrl } = require('../lib/github-preview/body-content')
const { buildGithubIssueHtml, renderGithubIssue } = require('../lib/github-preview/issue-renderer')
const { buildGithubPullHtml, renderGithubPullCard } = require('../lib/github-preview/pull-card')
const { renderGithubCard, splitGithubImage } = require('../lib/github-preview/renderer')
const { renderHtmlToImage } = require('../../koishi-plugin-daily-report/lib/html-renderer')
const { readResourceActivityLease } = require('../lib/resource-scheduler/resource-activity-lease')
const { GITHUB_LIMITS } = require('../lib/github-preview/models')

// Use the production target budget, with a fresh absolute deadline for each independent operation.
function context(ms = GITHUB_LIMITS.targetMs) { return { signal: new AbortController().signal, deadline: Date.now() + ms, taskId: 'github-local-browser' } }

// The initiating post is independent of replies and contains original public metadata only.
function metadata(kind = 'issue', bodyHtml = '<p>发起者原文，保留内容。</p>') {
  if (['repository', 'user'].includes(kind)) {
    const url = kind === 'repository' ? 'https://github.com/owner/repo' : 'https://github.com/owner'
    return { target: { kind, owner: 'owner', repo: kind === 'repository' ? 'repo' : undefined, url }, url, title: kind === 'repository' ? 'owner/repo' : '公开用户', author: 'owner', description: '原文简介，保留内容。', fetchedAt: Date.now(), facts: [['Stars', '123'], ['许可证', 'MIT']] }
  }
  const url = `https://github.com/owner/repo/${kind === 'pull' ? 'pull' : 'issues'}/1`
  const data = { target: { kind, owner: 'owner', repo: 'repo', number: 1, url }, url, title: '原文标题与黄色编号', state: kind === 'pull' ? '已合并' : '开启中', author: 'author', createdAt: '2026-10-21T00:00:00Z', fetchedAt: Date.now(), labels: [{ name: 'bug', color: 'f5d531' }], facts: [], bodyHtml }
  if (kind === 'pull') data.pull = { stats: { commits: 3, additions: 120, deletions: 40, changedFiles: 6, comments: 5, reviewComments: 8, headRef: 'feature', baseRef: 'main', headSha: 'abc123def4567890', mergeableState: 'clean', updatedAt: '2026-10-22T00:00:00Z', mergedAt: '2026-10-23T00:00:00Z', mergedBy: 'maintainer', assignees: ['dev1'], requestedReviewers: ['reviewer2'], milestone: 'v2' }, reviews: [{ login: 'reviewer1', state: 'APPROVED', submittedAt: '2026-10-21T01:00:00Z' }, { login: 'reviewer2', state: 'CHANGES_REQUESTED', submittedAt: '2026-10-21T03:00:00Z' }], reviewTotal: 2, checks: { overall: 'success', total: 3, counts: { failure: 0, pending: 1, success: 2, neutral: 0, skipped: 0 }, runs: [{ name: 'lint', status: 'completed', conclusion: 'success', bucket: 'success' }, { name: 'build', status: 'in_progress', bucket: 'pending' }, { name: 'audit', status: 'completed', conclusion: 'success', bucket: 'success' }] }, partial: [] }
  return data
}

// Verify white outer strips and ensure content pixels survive contiguous splitting unchanged.
async function verifyPadding(images, original) {
  const parts = []
  for (const image of images) {
    const { width, height } = await sharp(image).metadata()
    assert(height <= 2000)
    for (const rect of [{ left: 0, top: 0, width, height: 24 }, { left: 0, top: height - 24, width, height: 24 }, { left: 0, top: 24, width: 24, height: height - 48 }, { left: width - 24, top: 24, width: 24, height: height - 48 }]) {
      const pixels = await sharp(image).extract(rect).removeAlpha().raw().toBuffer()
      assert(pixels.every(value => value === 255))
    }
    parts.push(await sharp(image).extract({ left: 24, top: 24, width: width - 48, height: height - 48 }).removeAlpha().raw().toBuffer())
  }
  if (original) assert.deepEqual(Buffer.concat(parts), await sharp(original).removeAlpha().raw().toBuffer())
}

// Exercise parsing and bounded downloads without making DNS or HTTP calls to real services.
async function verifyBody() {
  const dirty = '<script>SECRET_EXECUTION</script><p onclick="evil()">原文</p><details><summary>展开</summary>细节</details><input type="checkbox" checked><table><tr><td>保留表格</td></tr></table><img src="https://user-images.githubusercontent.com/a.png" onerror="evil()"><a href="javascript:evil()">链接文字</a>'
  const clean = cleanGithubBody(dirty, metadata().url)
  assert(!clean.html.includes('SECRET_EXECUTION')); assert(!clean.html.includes('onclick')); assert(!clean.html.includes('javascript:'))
  assert(clean.html.includes('<details open>')); assert(clean.html.includes('☑')); assert(clean.html.includes('保留表格'))
  assert.equal(clean.images.length, 1)
  for (const url of ['http://127.0.0.1/x', 'https://user-images.githubusercontent.com.evil/x', 'data:image/png;base64,a', 'https://github.com/login', 'https://example.org/x']) assert.equal(isGithubBodyImageUrl(url), false)
  const png = await sharp({ create: { width: 50, height: 50, channels: 3, background: '#f5d531' } }).png().toBuffer()
  let calls = 0
  const url = 'https://user-images.githubusercontent.com/a.png'
  const body = await prepareGithubBody(`<img src="${url}" alt="原图"><img src="${url}"><img src="https://example.org/no.png"><p>尾部仍在</p>`, metadata().url, context(), async (_url, options) => {
    calls++; assert.equal(options.headers, undefined); assert.equal(options.redirect, 'manual')
    return new Response(png, { headers: { 'content-type': 'image/png' } })
  }, async () => [])
  assert.equal(calls, 1); assert.equal(body.missing, 1); assert(body.html.includes('data:image/webp;base64,')); assert(body.html.includes('尾部仍在'))
  calls = 0
  const redirect = await prepareGithubBody(`<img src="${url}">`, metadata().url, context(), async () => { calls++; return new Response(null, { status: 302, headers: { location: 'https://127.0.0.1/a.png' } }) }, async () => [])
  assert.equal(calls, 1); assert.equal(redirect.missing, 1)
  const dnsStart = performance.now()
  const dns = await prepareGithubBody(`<img src="${url}">`, metadata().url, context(5150), async () => { throw new Error('must not fetch') }, () => new Promise(() => {}))
  assert.equal(dns.missing, 1); assert(performance.now() - dnsStart < 1000)
  const oversized = await prepareGithubBody(`<img src="${url}">`, metadata().url, context(), async () => new Response(Buffer.alloc(2 * 1024 * 1024 + 1), { headers: { 'content-type': 'image/png' } }), async () => [])
  assert.equal(oversized.missing, 1)
  console.log('PASS official HTML structure, task state, expanded details, deduplicated assets, redirects, DNS cancellation and byte caps')
}

// Run the production browser lifecycle, observing attempted requests and owned-browser cleanup.
async function verifyRender(kind, options = {}) {
  const originalLaunch = puppeteer.launch
  const originalFetch = global.fetch
  const avatarPng = await sharp({ create: { width: 32, height: 32, channels: 3, background: '#f5d531' } }).png().toBuffer()
  global.fetch = async (url, requestOptions) => {
    assert.equal(new URL(url).origin, 'https://avatars.githubusercontent.com')
    assert.equal(requestOptions.headers, undefined)
    return options.avatarFailure ? new Response(null, { status: 503 }) : new Response(avatarPng)
  }
  let owned, closeOwned, cleanupStarted, requests = 0, screenshotStarted = false
  const layouts = []
  const controller = new AbortController()
  let abortTimer
  puppeteer.launch = async launchOptions => {
    owned = await originalLaunch(launchOptions)
    closeOwned = owned.close.bind(owned)
    if (options.stuckClose) owned.close = () => { cleanupStarted = performance.now(); return new Promise(() => {}) }
    const newPage = owned.newPage.bind(owned)
    owned.newPage = async () => {
      const page = await newPage()
      page.on('request', request => { if (/^https?:/.test(request.url())) requests++ })
      const screenshot = page.screenshot.bind(page)
      page.screenshot = async (...args) => {
        layouts.push(await page.evaluate(() => ({ yellow: document.querySelector('.masthead') ? getComputedStyle(document.querySelector('.masthead')).borderBottomColor : '', dark: document.querySelector('#github-preview') ? getComputedStyle(document.querySelector('#github-preview')).backgroundColor : '', tile: document.querySelector('.stat') ? getComputedStyle(document.querySelector('.stat')).backgroundColor : '', pills: document.querySelectorAll('.state').length, avatar: document.querySelector('img.avatar, .user img')?.naturalWidth || 0, placeholder: Boolean(document.querySelector('.avatar-placeholder')) })))
        return screenshot(...args)
      }
      if (options.stall) page.screenshot = () => { screenshotStarted = true; return new Promise(() => {}) }
      if (options.guardFailure) page.setRequestInterception = async () => { throw new Error('guard setup failed') }
      if (options.cancel) abortTimer = setTimeout(() => controller.abort(new Error('group removed')), 100)
      return page
    }
    return owned
  }
  const started = performance.now(), work = { ...context(), signal: controller.signal }
  try {
    const data = metadata(kind)
    data.avatar = 'https://avatars.githubusercontent.com/u/browser-' + kind + (options.avatarFailure ? '-failed' : '-ok')
    const promise = ['repository', 'user'].includes(kind) ? renderGithubCard(data, work) : kind === 'pull' ? renderGithubPullCard(data, work, options.light ? 'light' : 'dark') : renderGithubIssue(data, work)
    if (options.stall) {
      await assert.rejects(promise, /超时|总时限已耗尽/)
      assert.equal(screenshotStarted, true, 'timeout case must reach the intentionally stalled screenshot')
      assert(performance.now() - started >= 29500); assert(performance.now() - started < 34000)
    }
    else if (options.cancel) await assert.rejects(promise, /group removed/)
    else if (options.guardFailure) await assert.rejects(promise, /guard setup failed/)
    else {
      const result = await promise
      assert.equal(result.incomplete, Boolean(options.avatarFailure)); assert(result.images.length >= (kind === 'pull' ? 2 : 1) && result.images.length <= 6)
      if (kind === 'pull') {
        assert.equal(layouts.length, 2)
        assert.equal(layouts[0].yellow, 'rgb(245, 213, 49)', 'first image keeps the industrial before-card')
        assert.equal(layouts[1].dark, options.light ? 'rgb(255, 255, 255)' : 'rgb(23, 26, 33)', 'second image is the board after-card')
        assert.equal(layouts[1].tile, options.light ? 'rgb(232, 237, 245)' : 'rgb(30, 35, 48)', 'board skin follows the group theme')
        assert(layouts[1].pills >= 2, 'board card carries state pills')
        assert(layouts.every(item => !item.placeholder))
        assert(layouts.some(item => item.avatar === (options.avatarFailure ? 0 : 64)))
      }
      else {
        assert.equal(layouts[0].yellow, 'rgb(245, 213, 49)'); assert.equal(layouts[0].placeholder, Boolean(options.avatarFailure))
        assert.equal(layouts[0].avatar, options.avatarFailure ? 0 : 64)
      }
      if (options.avatarFailure) assert.match(result.note, /头像暂未载入/)
      const dimensions = await sharp(result.images[0]).metadata()
      assert.equal(dimensions.width, 928); assert(dimensions.height < (kind === 'pull' ? 2000 : 800))
      await verifyPadding(result.images)
    }
    if (options.stuckClose) await new Promise(resolve => setTimeout(resolve, 150))
    assert.equal(requests, 0); assert.equal(owned.connected, false)
    assert.equal(readResourceActivityLease('render_active'), null)
    if (options.stuckClose) assert(performance.now() - cleanupStarted < 4500)
    console.log(`PASS ${kind} local rendering ${JSON.stringify(options)}: elapsed=${Math.round(performance.now() - started)}ms, offline and reclaimed`)
  } finally { clearTimeout(abortTimer); puppeteer.launch = originalLaunch; global.fetch = originalFetch; if (owned?.connected) await closeOwned() }
}

// Validate real layout, external-resource blocking, clipping and the hard timeout without GitHub access.
async function main() {
  await verifyBody()
  for (const kind of ['issue', 'pull', 'repository', 'user']) await verifyRender(kind)
  await verifyRender('pull', { light: true })
  await verifyRender('repository', { avatarFailure: true })
  await verifyRender('issue', { avatarFailure: true })
  const raw = await sharp({ create: { width: 100, height: 4500, channels: 3, background: '#f5d531' } }).png().toBuffer()
  const split = await splitGithubImage(raw, context())
  assert.equal(split.length, 3); await verifyPadding(split, raw)
  const huge = await sharp({ create: { width: 100, height: 5857, channels: 3, background: '#fff' } }).png().toBuffer()
  await assert.rejects(splitGithubImage(huge, context()), /正文过长/)
  const work = context()
  const html = buildGithubIssueHtml(metadata('pull'), '<pre><code>' + 'very-long-code-'.repeat(80) + '</code></pre><table><tr><td>' + 'long-cell'.repeat(80) + '</td></tr></table>', null)
  const pullWork = context()
  const pullHtml = buildGithubPullHtml(metadata('pull'), '<pre><code>' + 'very-long-pull-code-'.repeat(80) + '</code></pre><p>看板风格正文保留</p>', null)
  const pullImage = await renderHtmlToImage(pullHtml, { signal: pullWork.signal, deadlineMs: pullWork.deadline, networkPolicy: 'offline', captureSelector: '#github-preview' })
  assert((await sharp(pullImage).metadata()).height > 400)
  const image = await renderHtmlToImage(html, { signal: work.signal, deadlineMs: work.deadline, networkPolicy: 'offline', captureSelector: '#github-preview' })
  assert((await sharp(image).metadata()).height > 400)
  const missingRootWork = context()
  await assert.rejects(renderHtmlToImage(html, { signal: missingRootWork.signal, deadlineMs: missingRootWork.deadline, networkPolicy: 'offline', captureSelector: '#missing-root' }), /根元素不存在/)
  await verifyRender('pull', { cancel: true })
  await verifyRender('issue', { guardFailure: true })
  await verifyRender('issue', { stuckClose: true })
  await verifyRender('issue', { stall: true })
  console.log('PASS continuous splits, 24px white margins, original pixels, wrapped tables/code, missing roots, cancellation, stuck close and real 30-second deadline')
}
main().catch(error => { console.error(error.stack); process.exitCode = 1 }).finally(() => {
  if (path.dirname(path.resolve(browserData)) !== path.resolve(os.tmpdir()) || !path.basename(browserData).startsWith('github-preview-browser-')) throw new Error('unexpected browser fixture directory')
  fs.rmSync(browserData, { recursive: true, force: true })
})
