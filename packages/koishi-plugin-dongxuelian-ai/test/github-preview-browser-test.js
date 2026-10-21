'use strict'
const assert = require('node:assert/strict')
const fs = require('fs'), os = require('os'), path = require('path')
const browserData = fs.mkdtempSync(path.join(os.tmpdir(), 'github-preview-browser-'))
process.env.DONGXUELIAN_AI_DATA_DIR = browserData
const puppeteer = require('puppeteer-core')
const sharp = require('sharp')
const { inspectGithubRegion, encodeGithubClips, findGithubBrowser, waitForGithubRegion, screenshotGithubPage } = require('../lib/github-preview/page-screenshot')
const { GITHUB_LIMITS } = require('../lib/github-preview/models')
const { parseGithubTarget } = require('../lib/github-preview/input')
const { acquireGithubResources } = require('../lib/github-preview/runtime')
const { readResourceActivityLease } = require('../lib/resource-scheduler/resource-activity-lease')

// Reproduce the independently verified issue and PR structures without accessing GitHub.
function githubPageFixture(kind, bodyHeight = 500, extra = '') {
  const issue = kind === 'issue'
  return `<!doctype html><html><head><meta charset="utf-8"><base href="https://github.com/"><style>
  *{box-sizing:border-box}body{margin:0;background:white;font:18px sans-serif}nav{height:200px;background:magenta}
  h1{position:absolute;left:40px;top:220px;margin:0;width:1200px;height:60px;font-size:30px}
  #opening{position:absolute;left:40px;top:330px;width:820px;background:#eee}header{height:70px}header img{width:40px;height:40px}
  #body{height:${bodyHeight}px;background:rgb(18,45,78);color:white;padding:10px}.labels{position:absolute;left:900px;top:360px;width:300px;height:90px;background:#bff}
  #reply{position:absolute;left:40px;top:${400 + bodyHeight}px;width:820px;height:400px;background:magenta}.hidden{display:none}
  </style></head><body><nav>EXCLUDED NAVIGATION</nav>
  <div class="hidden"><h1><bdi data-testid="issue-title">hidden duplicate</bdi><span class="markdown-title">hidden duplicate</span></h1><div data-testid="issue-body" class="js-command-palette-pull-body">hidden body</div></div>
  <h1>${issue ? '<bdi data-testid="issue-title">' : '<span class="markdown-title">'}Opening title${issue ? '</bdi>' : '</span>'}</h1>
  <div id="opening" ${issue ? 'data-testid="issue-body"' : 'class="js-command-palette-pull-body"'}><header><a href="${issue ? 'https://github.com/owner' : '/owner'}">owner</a><img alt="owner" src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='40' height='40'%3E%3Crect width='40' height='40' fill='blue'/%3E%3C/svg%3E"></header>
  <div ${issue ? 'id="issue-body-viewer"' : 'class="js-comment-body"'}><div id="body">Opening post only ${extra}</div></div></div>
  <aside class="labels ${issue ? '' : 'discussion-sidebar-item'}" ${issue ? 'data-testid="sidebar-labels-section"' : 'data-channel-event-name="labels_updated"'}>Labels <span>bug</span></aside>
  <div id="reply"><a href="/other">Other author</a>EXCLUDED LATER REPLY / REVIEW</div></body></html>`
}

// Every pixel in all four added strips must be white, while content remains byte-for-byte equal.
async function verifyGithubPadding(image, page, region, offset = 0, height = region.height) {
  const meta = await sharp(image).metadata()
  assert.equal(meta.width, region.width + 48); assert.equal(meta.height, height + 48)
  assert(meta.height <= 2000)
  const { data, info } = await sharp(image).removeAlpha().raw().toBuffer({ resolveWithObject: true })
  for (let y = 0; y < info.height; y++) for (let x = 0; x < info.width; x++) if (x < 24 || x >= info.width - 24 || y < 24 || y >= info.height - 24) {
    const at = (y * info.width + x) * info.channels
    assert.equal(data[at], 255); assert.equal(data[at + 1], 255); assert.equal(data[at + 2], 255)
  }
  const original = await page.screenshot({ type: 'png', captureBeyondViewport: true, clip: { x: region.x, y: region.y + offset, width: region.width, height } })
  assert.deepEqual(await sharp(image).extract({ left: 24, top: 24, width: region.width, height }).removeAlpha().raw().toBuffer(), await sharp(Buffer.from(original)).removeAlpha().raw().toBuffer())
}

// Replay a fixed document response through real Chrome and the complete production lifecycle.
async function verifyGithubLifecycle(kind, status = 200, cancel = false, stuckClose = false) {
  const originalLaunch = puppeteer.launch
  let owned, abortTimer, closeOwned, cleanupStarted
  const controller = new AbortController()
  const target = parseGithubTarget(`https://github.com/owner/repo/${kind === 'issue' ? 'issues' : 'pull'}/1`)
  const context = { signal: controller.signal, deadline: Date.now() + 10000, taskId: 'github-browser-fixture' }
  puppeteer.launch = async options => {
    owned = await originalLaunch(options)
    closeOwned = owned.close.bind(owned)
    if (stuckClose) owned.close = () => { cleanupStarted = performance.now(); return new Promise(() => {}) }
    const newPage = owned.newPage.bind(owned)
    owned.newPage = async () => {
      const page = await newPage(); await page.setRequestInterception(true)
      page.on('request', request => {
        if (request.isInterceptResolutionHandled()) return
        if (request.isNavigationRequest() && request.url() === target.url) {
          void request.respond({ status, contentType: 'text/html', body: cancel ? '<h1>no opening post</h1>' : githubPageFixture(kind) })
          if (cancel) abortTimer = setTimeout(() => controller.abort(new Error('fixture group deleted')), 150)
        } else void request.abort()
      })
      return page
    }
    return owned
  }
  let release
  try {
    release = await acquireGithubResources(context, 'fixture')
    const task = screenshotGithubPage({ target, url: target.url, title: 'Opening title', author: 'owner', facts: [], fetchedAt: Date.now() }, context)
    if (cancel) await assert.rejects(task, /fixture group deleted/)
    else if (status !== 200) await assert.rejects(task, /页面状态/)
    else { const result = await task; assert.equal(result.incomplete, false); assert.equal(result.images.length, 1) }
    if (stuckClose) {
      await new Promise(resolve => setTimeout(resolve, 100))
      // Measure shutdown itself; browser startup and rendering do not belong to its budget.
      assert(performance.now() - cleanupStarted < 4500)
    }
    assert.equal(owned.connected, false)
    assert.equal(readResourceActivityLease('render_active'), null)
    console.log(`PASS ${kind}: complete lifecycle status=${status} cancelled=${cancel}, browser closed and render lease released`)
  } finally { clearTimeout(abortTimer); puppeteer.launch = originalLaunch; if (owned?.connected) await closeOwned(); if (release) release() }
}

// Run with a real installed browser; missing browsers fail this explicit release-verification entry.
async function main() {
  const browser = await puppeteer.launch({ executablePath: findGithubBrowser(), headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] })
  try {
    const page = await browser.newPage(); await page.setViewport({ width: 1280, height: 900, deviceScaleFactor: 1 })
    for (const kind of ['issue', 'pull']) {
      await page.setContent(githubPageFixture(kind))
      const region = await page.evaluate(inspectGithubRegion, kind, 'owner')
      assert(region?.ready); assert.equal(region.y, 220); assert.equal(region.height, 680); assert.equal(region.x, 40); assert.equal(region.width, 1200)
      assert.equal(region.imageCount, 1); assert.equal(region.title, 'Opening title')
      assert.equal(await page.evaluate(inspectGithubRegion, kind, 'other'), null)
      const images = await encodeGithubClips(page, region, performance.now() + 5000)
      assert.equal(images.length, 1); await verifyGithubPadding(images[0], page, region)
      console.log(`PASS ${kind}: exact opening boundaries, author/avatar/labels, hidden duplicates, 24px padding and unchanged content`)
      await page.setContent(githubPageFixture(kind, 4200))
      const longRegion = await page.evaluate(inspectGithubRegion, kind, 'owner')
      const split = await encodeGithubClips(page, longRegion, performance.now() + 5000)
      assert.equal(split.length, 3)
      const contentHeight = Math.ceil(longRegion.height / split.length)
      for (let i = 0; i < split.length; i++) await verifyGithubPadding(split[i], page, longRegion, i * contentHeight, Math.min(contentHeight, longRegion.height - i * contentHeight))
      await assert.rejects(encodeGithubClips(page, { ...longRegion, height: 6001 }, performance.now() + 5000), /正文过长/)
      console.log(`PASS ${kind}: contiguous split images and oversized-body fallback`)
      await page.setContent(githubPageFixture(kind, 34.5))
      await page.evaluate(() => {
        document.querySelector('.labels').style.top = '800px'; document.querySelector('.labels').style.height = '50px'
        const auxiliary = document.createElement('div')
        auxiliary.style.cssText = 'position:absolute;left:900px;top:330px;width:300px;height:300px;background:magenta'
        auxiliary.textContent = 'Other sidebar content must not overlap moved Labels'
        document.body.appendChild(auxiliary)
      })
      const short = await page.evaluate(inspectGithubRegion, kind, 'owner')
      assert(short?.ready); assert.equal(short.height, 215)
      const labelBottom = await page.$eval('.labels', element => element.getBoundingClientRect().bottom)
      assert(labelBottom <= short.y + short.height)
      assert.equal(await page.$eval('[data-github-preview-sidebar-backdrop]', element => element.getBoundingClientRect().height), 105)
      const shortImages = await encodeGithubClips(page, short, performance.now() + 5000)
      const pixel = await sharp(shortImages[0]).extract({ left: 900 - short.x + 24, top: 330 - short.y + 24, width: 1, height: 1 }).removeAlpha().raw().toBuffer()
      assert.deepEqual([...pixel], [255, 255, 255])
      const edge = await sharp(shortImages[0]).extract({ left: 900 - short.x + 24, top: short.height - 1 + 24, width: 1, height: 1 }).removeAlpha().raw().toBuffer()
      assert.deepEqual([...edge], [255, 255, 255])
      console.log(`PASS ${kind}: short/empty-state body keeps original labels inside exact lower edge`)
      await page.setContent(githubPageFixture(kind, 500, '<img src="https://example.invalid/never.png" loading="lazy" width="50" height="50">'), { waitUntil: 'domcontentloaded' })
      const incomplete = await page.evaluate(inspectGithubRegion, kind, 'owner')
      assert(incomplete); assert.equal(incomplete.ready, false)
      assert.equal(await page.$eval('#body img', image => image.loading), 'eager')
    }
    // One real 25-second incomplete-load wait verifies the upper bound without a fake wall clock.
    const metadata = { target: { kind: 'pull' }, author: 'owner' }, controller = new AbortController()
    const started = performance.now()
    const ready = await waitForGithubRegion(page, metadata, { signal: controller.signal, deadline: Date.now() + 35000, taskId: 'github-browser-test' }, started + GITHUB_LIMITS.loadMs)
    assert.equal(ready, false); assert(performance.now() - started >= 24900); assert(performance.now() - started < 26000)
    console.log('PASS shared 25-second loading deadline, incomplete image detection and lazy-load activation')
  } finally { await browser.close() }
  await verifyGithubLifecycle('issue')
  await verifyGithubLifecycle('pull')
  await verifyGithubLifecycle('issue', 404)
  await verifyGithubLifecycle('pull', 200, true)
  await verifyGithubLifecycle('issue', 200, false, true)
  console.log('PASS stuck graceful close reclaims only the recorded browser PID within the cleanup budget')
}
main().catch(error => { console.error(error.stack); process.exitCode = 1 }).finally(() => {
  if (path.dirname(path.resolve(browserData)) !== path.resolve(os.tmpdir()) || !path.basename(browserData).startsWith('github-preview-browser-')) throw new Error('unexpected browser fixture directory')
  fs.rmSync(browserData, { recursive: true, force: true })
})
