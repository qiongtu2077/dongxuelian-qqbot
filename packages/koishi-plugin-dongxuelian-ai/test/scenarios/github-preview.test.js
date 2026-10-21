'use strict'
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const { withScenario } = require('./_setup')
const { AI_ROOT } = require('../fake/file')
const { flushAsync } = require('../fake/koishi')
const { parseGithubTarget, extractGithubTargets } = require('../../lib/github-preview/input')
const { GithubPreviewClient, GithubQueryError } = require('../../lib/github-preview/client')
const { allowGithubPageRequest, waitForGithubRegion } = require('../../lib/github-preview/page-screenshot')
const { buildGithubCardHtml, loadGithubAvatar } = require('../../lib/github-preview/renderer')

// Keep each failing behavior named without hiding later independent cases.
async function githubCase(t, name, fn) {
  try { await fn(); t.check('GitHub: ' + name, true) }
  catch (error) { t.check('GitHub: ' + name, false, error.stack) }
}

// A short real task deadline bounds every offline request.
function githubContext(ms = 10000) { return { signal: new AbortController().signal, deadline: Date.now() + ms, taskId: 'github-test' } }

// Provide only documented fields, including body text that must never reach cards or caches.
function githubFixture(kind = 'issue', patch = {}) {
  if (kind === 'repository') return { private: false, full_name: 'owner/repo', html_url: 'https://github.com/owner/repo', description: '<script>secret</script>', language: null, stargazers_count: 2, forks_count: 1, license: null, updated_at: '2026-10-21T00:00:00Z', archived: false, ...patch }
  if (kind === 'user') return { login: 'owner', name: null, html_url: 'https://github.com/owner', bio: null, type: 'Organization', avatar_url: 'https://avatars.githubusercontent.com/u/1', public_repos: 2, followers: 3, following: 0, created_at: '2020-01-01T00:00:00Z', ...patch }
  return { html_url: `https://github.com/owner/repo/${kind === 'pull' ? 'pull' : 'issues'}/1`, title: '原文标题', number: 1, state: 'open', user: { login: 'owner', avatar_url: 'https://avatars.githubusercontent.com/u/1' }, labels: [{ name: 'bug', color: 'ff0000' }], body: 'PRIVATE_BODY_DO_NOT_CACHE', ...(kind === 'pull' ? { merged: false, draft: false } : {}), ...patch }
}

// Node's real Response exercises streamed size limits, headers and JSON decoding.
function githubResponse(value, status = 200, headers = {}) { return new Response(status === 304 ? null : JSON.stringify(value), { status, headers }) }

// Return controllable work for cancellation and queue ordering without sleeping.
function githubDeferred() { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }

// Exercise official protocol, durable settings, actual middleware and cancellation behavior.
async function run(t) {
  t.section('scenario: GitHub public previews')
  await githubCase(t, 'canonical routes, punctuation, deduplication and rejected origins', async () => {
    const urls = ['https://github.com/Owner/repo/issues/1?x=1#comment', 'https://github.com/owner/repo/pull/2/', 'https://github.com/owner/repo', 'https://github.com/owner']
    assert.deepEqual(urls.map(url => parseGithubTarget(url).kind), ['issue', 'pull', 'repository', 'user'])
    for (const url of ['http://github.com/owner/repo', 'https://github.com.evil/owner/repo', 'https://x@github.com/owner/repo', 'https://github.com/owner/repo/issues/0', 'https://github.com/owner/repo/pull/1/files', 'https://github.com/owner/repo/tree/main', 'https://github.com/settings', 'https://github.com/owner/repo/issues/9007199254740992']) assert.equal(parseGithubTarget(url), null, url)
    assert.equal(extractGithubTargets('看这个（https://github.com/owner/repo/issues/1）。https://github.com/OWNER/repo/issues/1#x').length, 1)
  })
  await githubCase(t, 'publicness, issue labels, PR aliases and all PR states', async () => {
    const calls = []
    const client = new GithubPreviewClient(async url => { calls.push(String(url)); return githubResponse(String(url).endsWith('/repos/owner/repo') ? githubFixture('repository') : String(url).includes('/issues/') ? githubFixture('issue', { pull_request: { url: 'official' } }) : githubFixture('pull', { merged: true, state: 'closed' })) })
    const metadata = await client.lookup(parseGithubTarget('https://github.com/owner/repo/issues/1'), githubContext())
    assert.equal(metadata.target.kind, 'pull'); assert.equal(metadata.state, '已合并'); assert.equal(metadata.author, 'owner')
    assert.deepEqual(metadata.labels, [{ name: 'bug', color: 'ff0000' }]); assert(!JSON.stringify(metadata).includes('PRIVATE_BODY'))
    assert.equal(calls.length, 3); assert(calls.every(url => !url.includes('/comments')))
    for (const [fields, expected] of [[{ draft: true }, '草稿'], [{}, '开启中'], [{ state: 'closed', draft: true }, '已关闭']]) {
      const stateClient = new GithubPreviewClient(async url => githubResponse(String(url).endsWith('/repos/owner/repo') ? githubFixture('repository') : githubFixture('pull', fields)))
      assert.equal((await stateClient.lookup(parseGithubTarget('https://github.com/owner/repo/pull/1'), githubContext())).state, expected)
    }
    let count = 0
    const privateClient = new GithubPreviewClient(async () => { count++; return githubResponse({ private: true }) })
    await assert.rejects(privateClient.lookup(parseGithubTarget('https://github.com/owner/repo/issues/1'), githubContext()), /仅支持公开仓库/)
    assert.equal(count, 1)
  })
  await githubCase(t, 'request coalescing, conditional metadata and original fetch time', async () => {
    const originalNow = Date.now; let offset = 0; Date.now = () => originalNow() + offset
    const calls = []
    try {
      const client = new GithubPreviewClient(async (url, options) => { calls.push(options); return calls.length === 1 ? githubResponse(githubFixture('user'), 200, { etag: 'v1' }) : githubResponse(null, 304) }, 'test-token')
      const target = parseGithubTarget('https://github.com/owner')
      const [one, two] = await Promise.all([client.lookup(target, githubContext()), client.lookup(target, githubContext())])
      assert.equal(calls.length, 1); assert.equal(one.fetchedAt, two.fetchedAt)
      offset = 300001
      const three = await client.lookup(target, githubContext())
      assert.equal(calls.length, 2); assert.equal(calls[1].headers['If-None-Match'], 'v1'); assert.equal(three.fetchedAt, one.fetchedAt)
      assert.equal(calls[0].redirect, 'manual'); assert.equal(calls[0].headers['X-GitHub-Api-Version'], '2022-11-28')
    } finally { Date.now = originalNow }
  })
  await githubCase(t, 'one retry, safe redirects, negative cache and rate suspension', async () => {
    let requests = 0
    const client = new GithubPreviewClient(async () => { if (++requests === 1) throw new TypeError('secret network error'); return githubResponse(githubFixture('user')) })
    assert.equal((await client.lookup(parseGithubTarget('https://github.com/owner'), githubContext())).title, 'owner'); assert.equal(requests, 2)
    const redirect = new GithubPreviewClient(async () => githubResponse({}, 302, { location: 'https://evil.example/' }), 'NEVER_FORWARD')
    await assert.rejects(redirect.lookup(parseGithubTarget('https://github.com/owner'), githubContext()), /不受信任/)
    requests = 0
    const missing = new GithubPreviewClient(async () => { requests++; return githubResponse({}, 404) })
    for (let i = 0; i < 2; i++) await assert.rejects(missing.lookup(parseGithubTarget('https://github.com/owner'), githubContext()), error => error.status === 404)
    assert.equal(requests, 1)
    requests = 0
    const rate = new GithubPreviewClient(async () => { requests++; return githubResponse({ message: 'secondary rate limit' }, 403, { 'retry-after': '60' }) })
    await assert.rejects(rate.lookup(parseGithubTarget('https://github.com/owner'), githubContext()), error => error.transient)
    await assert.rejects(rate.lookup(parseGithubTarget('https://github.com/another'), githubContext()), error => error.status === 429)
    assert.equal(requests, 1)
    const denied = new GithubPreviewClient(async () => githubResponse({ message: 'permission denied SECRET' }, 403))
    await assert.rejects(denied.lookup(parseGithubTarget('https://github.com/owner'), githubContext()), error => !error.transient && !error.message.includes('SECRET'))
    const unauthorized = new GithubPreviewClient(async () => githubResponse({}, 401, { 'x-ratelimit-remaining': '0' }))
    await assert.rejects(unauthorized.lookup(parseGithubTarget('https://github.com/owner'), githubContext()), error => error.status === 401 && !error.transient)
  })
  await githubCase(t, 'bounded JSON and strict official field contracts', async () => {
    for (const value of ['x'.repeat(2 * 1024 * 1024 + 1), [], { ...githubFixture('user'), followers: '3' }]) {
      const client = new GithubPreviewClient(async () => githubResponse(value))
      await assert.rejects(client.lookup(parseGithubTarget('https://github.com/owner'), githubContext()), GithubQueryError)
    }
    const controller = new AbortController(); controller.abort(new Error('cancelled'))
    let requests = 0
    await assert.rejects(new GithubPreviewClient(async () => { requests++; return githubResponse({}) }).lookup(parseGithubTarget('https://github.com/owner'), { ...githubContext(), signal: controller.signal }), /cancelled/)
    assert.equal(requests, 0)
  })
  await githubCase(t, 'fixed cards escape original text and avatar requests carry no token', async () => {
    const html = buildGithubCardHtml({ target: { kind: 'repository' }, title: '<img onerror=x>', description: '<script>x</script>', facts: [['<k>', '<v>']], url: 'https://github.com/owner/repo', fetchedAt: Date.now() }, null)
    assert(html.includes('&lt;script&gt;')); assert(!html.includes('<script>')); assert(html.includes('&lt;img onerror=x&gt;'))
    let calls = 0
    assert.equal(await loadGithubAvatar('https://evil.example/avatar.png', githubContext(), async () => { calls++ }), null); assert.equal(calls, 0)
    assert.equal(await loadGithubAvatar('invalid-url', githubContext()), null)
    await loadGithubAvatar('https://avatars.githubusercontent.com/u/77', githubContext(), async (url, options) => { calls++; assert.equal(options.redirect, 'error'); assert.equal(options.headers, undefined); return new Response('bad image') })
    assert.equal(calls, 1)
  })
  await githubCase(t, 'resource allowlist rejects frames, downloads, media and lookalike hosts', async () => {
    assert(allowGithubPageRequest('https://github.com/owner/repo/issues/1', 'document', true))
    assert(allowGithubPageRequest('https://github.githubassets.com/assets/main.js', 'script', false))
    for (const [url, type, main] of [['https://github.com/owner/repo/issues/1', 'document', false], ['https://github.com/login', 'document', true], ['http://127.0.0.1/x', 'image', false], ['https://github.githubassets.com.evil/x', 'script', false], ['https://avatars.githubusercontent.com/x', 'media', false], ['https://github.com/owner/repo/releases/download/x', 'document', true]]) assert(!allowGithubPageRequest(url, type, main))
  })
  await githubCase(t, 'one readiness deadline, early completion, layout changes and protocol timeout', async () => {
    const metadata = { target: { kind: 'issue' }, author: 'owner' }, region = { ready: true, x: 1, y: 1, width: 100, height: 100 }
    let calls = 0, start = performance.now()
    assert(await waitForGithubRegion({ evaluate: async () => { calls++; return region } }, metadata, githubContext(), start + 1000))
    assert.equal(calls, 2); assert(performance.now() - start < 800)
    calls = 0; start = performance.now()
    assert.equal(await waitForGithubRegion({ evaluate: async () => ({ ...region, height: ++calls }) }, metadata, githubContext(), start + 350), false)
    assert(performance.now() - start < 650)
    start = performance.now()
    assert.equal(await waitForGithubRegion({ evaluate: () => new Promise(() => {}) }, metadata, githubContext(), start + 200), false)
    assert(performance.now() - start < 500)
  })

  await withScenario({}, async ({ data, makeSession, run: middleware }) => {
    await githubCase(t, 'real middleware default off, admin management, current state, blacklist and private fallback', async () => {
      const originalFetch = global.fetch; let calls = 0
      global.fetch = async url => { calls++; assert(String(url).startsWith('https://api.github.com/repos/')); return githubResponse({ private: true }) }
      try {
        const disabled = await middleware(makeSession({ content: 'https://github.com/owner/repo/issues/1' }))
        assert(disabled.nextCalled); assert.equal(calls, 0)
        const denied = await middleware(makeSession({ userId: '300000000', content: 'GitHub查询群添加 10001' }))
        assert(denied.sent.join('').includes('指定管理员')); assert.equal(calls, 0)
        const enabled = await middleware(makeSession({ content: 'GitHub查询群添加 10001' }))
        assert(enabled.sent.join('').includes('开启')); assert.deepEqual(data.readJson('github-preview-groups.json'), ['10001'])
        const status = await middleware(makeSession({ userId: '300000000', content: 'GitHub查询状态' }))
        assert(status.sent.join('').includes('开启'))
        data.writeJson('ai-user-blacklist.json', ['300000000'])
        await middleware(makeSession({ userId: '300000000', messageId: 'blocked', content: 'https://github.com/owner/repo/issues/1' }))
        assert.equal(calls, 0)
        const result = await middleware(makeSession({ messageId: 'public-check', content: 'https://github.com/owner/repo/issues/1' }))
        assert.equal(calls, 1); assert(result.sent.join('').includes('仅支持公开仓库')); assert(!result.nextCalled)
        await middleware(makeSession({ content: 'GitHub查询群删除 10001' }))
        assert.deepEqual(data.readJson('github-preview-groups.json'), [])
      } finally { global.fetch = originalFetch }
    })
  })
  await withScenario({}, async ({ data, makeSession }) => {
    const { GithubPreviewSettings } = require(path.join(AI_ROOT, 'lib/github-preview/settings'))
    const { GithubPreviewRuntime } = require(path.join(AI_ROOT, 'lib/github-preview/runtime'))
    await githubCase(t, 'atomic settings, malformed input, serialized changes and restart', async () => {
      const settings = new GithubPreviewSettings(data.pathFor('settings'))
      assert.deepEqual(settings.list(), [])
      await Promise.all([settings.update('10001', true), settings.update('10002', true), settings.update('10001', false)])
      assert.deepEqual(new GithubPreviewSettings(data.pathFor('settings')).list(), ['10002'])
      let removed = 0; const failure = new GithubPreviewSettings(data.pathFor('settings'), async () => { throw new Error('disk full') })
      failure.onRemoved(() => removed++)
      await assert.rejects(failure.update('10002', false), /disk full/); assert(failure.enabled('10002')); assert.equal(removed, 0)
      data.writeJson('invalid/github-preview-groups.json', [10001]); const warnings = []
      assert.deepEqual(new GithubPreviewSettings(data.pathFor('invalid'), undefined, text => warnings.push(text)).list(), []); assert.equal(warnings.length, 1)
      assert(fs.existsSync(settings.file))
    })
    await githubCase(t, 'same-message and group cooldown, cached images, max three targets, no duplicate fallback on send failure', async () => {
      const settings = new GithubPreviewSettings(data.pathFor('runtime')); await settings.update('10001', true); await settings.update('10002', true)
      let lookups = 0, renders = 0, releases = 0
      const runtime = new GithubPreviewRuntime(settings, { lookup: async target => { lookups++; return { target, title: 'title', author: 'owner', url: target.url, facts: [], fetchedAt: Date.now() } }, screenshot: async () => { renders++; return { images: [Buffer.from('image')], capturedAt: Date.now() } }, acquire: async () => () => { releases++ }, log: () => {} })
      try {
        const first = makeSession({ messageId: 'one' }); const url = 'https://github.com/owner/repo/issues/1'
        await runtime.handle(first, url); await runtime.handle(first, url)
        await runtime.handle(makeSession({ messageId: 'two' }), url)
        assert.equal(lookups, 1); assert.equal(renders, 1); assert.equal(first.sent.length, 1); assert.equal(releases, 1)
        const second = makeSession({ guildId: '10002', messageId: 'three' }); await runtime.handle(second, url)
        assert.equal(lookups, 1); assert(second.sent.join('').includes('缓存数据'))
        const many = makeSession({ messageId: 'many' }); await runtime.handle(many, [2, 3, 4, 5].map(id => `https://github.com/owner/repo/issues/${id}`).join(' '))
        assert.equal(many.sent.length, 4); assert(many.sent[0].includes('前 3 个'))
        let sends = 0
        await runtime.handle(makeSession({ messageId: 'failure', send: async () => { sends++; throw new Error('adapter uncertain') } }), 'https://github.com/owner/repo/issues/9')
        assert.equal(sends, 1)
      } finally { runtime.dispose() }
    })
    await githubCase(t, 'deleting and re-adding cancels queued and active generations without sending', async () => {
      const settings = new GithubPreviewSettings(data.pathFor('cancel')); await settings.update('10001', true)
      const started = githubDeferred(), release = githubDeferred(); let cancelled = false, gates = 0
      const runtime = new GithubPreviewRuntime(settings, { lookup: async (target, context) => { started.resolve(); await new Promise(resolve => { context.signal.addEventListener('abort', () => { cancelled = true; resolve() }, { once: true }); release.promise.then(resolve) }); return { target, url: target.url, title: 'title', facts: [], fetchedAt: Date.now() } }, screenshot: async () => ({ images: [Buffer.from('fresh')], capturedAt: Date.now() }), acquire: async () => { gates++; return () => {} }, log: () => {} })
      const active = makeSession({ messageId: 'active' }), queued = makeSession({ messageId: 'queued' })
      try {
        const first = runtime.handle(active, 'https://github.com/owner/repo/issues/1'); await started.promise
        const next = runtime.handle(queued, 'https://github.com/owner/repo/issues/2')
        await settings.update('10001', false); await settings.update('10001', true); release.resolve()
        await Promise.all([first, next]); assert(cancelled); assert.equal(gates, 0); assert.equal(active.sent.length + queued.sent.length, 0)
        const fresh = makeSession({ messageId: 'after-reenable' })
        await runtime.handle(fresh, 'https://github.com/owner/repo/issues/1'); assert.equal(gates, 1); assert.equal(fresh.sent.length, 1)
      } finally { release.resolve(); runtime.dispose() }
    })
    await githubCase(t, 'incomplete images never enter normal cache', async () => {
      const settings = new GithubPreviewSettings(data.pathFor('partial')); await settings.update('10001', true); await settings.update('10002', true)
      let captures = 0
      const runtime = new GithubPreviewRuntime(settings, { lookup: async target => ({ target, url: target.url, title: 'title', facts: [], fetchedAt: Date.now() }), screenshot: async () => { captures++; return { images: [Buffer.from('partial')], capturedAt: Date.now(), incomplete: true } }, acquire: async () => () => {}, log: () => {} })
      try {
        const first = makeSession({ messageId: 'partial-one' }), second = makeSession({ guildId: '10002', messageId: 'partial-two' })
        await runtime.handle(first, 'https://github.com/owner/repo/issues/1'); await runtime.handle(second, 'https://github.com/owner/repo/issues/1')
        assert.equal(captures, 2); assert(first.sent.join('').includes('页面未完整加载'))
      } finally { runtime.dispose() }
    })
    await githubCase(t, 'shared S0 gate preserves report ownership and enforces memory admission', async () => {
      const { acquireGithubResources } = require(path.join(AI_ROOT, 'lib/github-preview/runtime'))
      const { acquireResourceGate } = require(path.join(AI_ROOT, 'lib/resource-gate/gate'))
      const available = process.env.RESOURCE_SCHEDULER_MEM_AVAILABLE_MB_OVERRIDE, total = process.env.RESOURCE_SCHEDULER_MEM_TOTAL_MB_OVERRIDE
      process.env.RESOURCE_SCHEDULER_MEM_AVAILABLE_MB_OVERRIDE = '1200'; process.env.RESOURCE_SCHEDULER_MEM_TOTAL_MB_OVERRIDE = '1600'
      let report
      try {
        const release = await acquireGithubResources(githubContext(), '10001')
        assert(fs.existsSync(data.pathFor('resource-gate/lock/meta.json'))); release()
        report = await acquireResourceGate({ taskId: 'github-report-fixture', kind: 'daily_report', owner: 'test', timeoutMs: 5000, waitTimeoutMs: 0 })
        await assert.rejects(acquireGithubResources(githubContext(150), '10001'), /繁忙/)
        assert.equal(data.readJson('resource-gate/lock/meta.json').taskId, 'github-report-fixture')
        report.release('fixture-end'); report = null
        process.env.RESOURCE_SCHEDULER_MEM_AVAILABLE_MB_OVERRIDE = '600'
        await assert.rejects(acquireGithubResources(githubContext(), '10001'), /资源不足/)
        assert(!fs.existsSync(data.pathFor('resource-gate/lock/meta.json')))
      } finally {
        if (report) report.release('fixture-end')
        if (available === undefined) delete process.env.RESOURCE_SCHEDULER_MEM_AVAILABLE_MB_OVERRIDE; else process.env.RESOURCE_SCHEDULER_MEM_AVAILABLE_MB_OVERRIDE = available
        if (total === undefined) delete process.env.RESOURCE_SCHEDULER_MEM_TOTAL_MB_OVERRIDE; else process.env.RESOURCE_SCHEDULER_MEM_TOTAL_MB_OVERRIDE = total
      }
    })
    await githubCase(t, 'expired images refresh independently and stale fallback excludes authentication and visibility failures', async () => {
      const { GithubQueryError: QueryError } = require(path.join(AI_ROOT, 'lib/github-preview/client'))
      const settings = new GithubPreviewSettings(data.pathFor('stale'))
      for (let group = 10001; group <= 10008; group++) await settings.update(String(group), true)
      const originalNow = Date.now; let offset = 0, mode = 0, captures = 0
      Date.now = () => originalNow() + offset
      const fetchedAt = Date.now()
      const runtime = new GithubPreviewRuntime(settings, { lookup: async target => { if (mode) throw new QueryError('official failure', mode, mode === 503 || mode === 429); return { target, url: target.url, title: 'title', facts: [], fetchedAt } }, screenshot: async () => { captures++; return { images: [Buffer.from('complete')], capturedAt: Date.now() } }, acquire: async () => () => {}, log: () => {} })
      try {
        const url = 'https://github.com/owner/repo/issues/1'
        await runtime.handle(makeSession({ messageId: 'original' }), url)
        offset = 300001; mode = 503
        const stale = makeSession({ guildId: '10002', messageId: 'stale' }); await runtime.handle(stale, url)
        assert(stale.sent.join('').includes('缓存数据')); assert(stale.sent.join('').includes('data:image/png')); assert.equal(captures, 1)
        for (const [index, status] of [401, 403, 404].entries()) {
          mode = status
          const denied = makeSession({ guildId: String(10003 + index), messageId: 'denied-' + status }); await runtime.handle(denied, url)
          assert(!denied.sent.join('').includes('data:image/png')); assert(!denied.sent.join('').includes('缓存数据'))
        }
        offset = 1800001; mode = 503
        const expired = makeSession({ guildId: '10006', messageId: 'too-old' }); await runtime.handle(expired, url)
        assert(!expired.sent.join('').includes('data:image/png'))
        mode = 0
        await runtime.handle(makeSession({ guildId: '10007', messageId: 'refresh' }), url)
        assert.equal(captures, 2) // Unchanged metadata fetch time does not renew a screenshot.
      } finally { runtime.dispose(); Date.now = originalNow }
    })
  })
  // Fake timers are explicit here because this case verifies real queue-expiry scheduling.
  await withScenario({ fakeTimers: true }, async ({ data, clock, makeSession }) => {
    await githubCase(t, 'bounded queue and expired tasks never execute later', async () => {
      const { GithubPreviewSettings } = require(path.join(AI_ROOT, 'lib/github-preview/settings'))
      const { GithubPreviewRuntime } = require(path.join(AI_ROOT, 'lib/github-preview/runtime'))
      const settings = new GithubPreviewSettings(data.pathFor('queue')); await settings.update('10001', true)
      const started = githubDeferred(), hold = githubDeferred(); let lookups = 0
      const runtime = new GithubPreviewRuntime(settings, { lookup: async target => { lookups++; started.resolve(); await hold.promise; return { target, title: 'title', url: target.url, facts: [], fetchedAt: Date.now() } }, screenshot: async () => ({ images: [Buffer.from('image')], capturedAt: Date.now() }), acquire: async () => () => {}, log: () => {} })
      const tasks = [], sessions = []
      try {
        tasks.push(runtime.handle(makeSession({ messageId: 'running' }), 'https://github.com/owner/repo/issues/1')); await started.promise
        for (let id = 2; id <= 21; id++) { const session = makeSession({ messageId: String(id) }); sessions.push(session); tasks.push(runtime.handle(session, `https://github.com/owner/repo/issues/${id}`)) }
        const full = await runtime.handle(makeSession({ messageId: 'full' }), 'https://github.com/owner/repo/issues/22'); assert(full.includes('队列已满'))
        await clock.tick(15001); await flushAsync(); assert(sessions.every(session => session.sent.join('').includes('排队超时')))
        hold.resolve(); await Promise.all(tasks); assert.equal(lookups, 1)
      } finally { hold.resolve(); runtime.dispose() }
    })
    await githubCase(t, '45-second execution aborts in-flight work, releases its gate and does not send after deletion', async () => {
      const { GithubPreviewSettings } = require(path.join(AI_ROOT, 'lib/github-preview/settings'))
      const { GithubPreviewRuntime } = require(path.join(AI_ROOT, 'lib/github-preview/runtime'))
      const settings = new GithubPreviewSettings(data.pathFor('deadline')); await settings.update('10001', true)
      const started = githubDeferred(); let cancelled = false, released = false
      const runtime = new GithubPreviewRuntime(settings, { lookup: async target => ({ target, title: 'title', url: target.url, facts: [], fetchedAt: Date.now() }), acquire: async () => () => { released = true }, screenshot: async (_metadata, context) => { started.resolve(); await new Promise(resolve => context.signal.addEventListener('abort', () => { cancelled = true; resolve() }, { once: true })); return { images: [Buffer.from('late')], capturedAt: Date.now() } }, log: () => {} })
      const session = makeSession({ messageId: 'deadline' })
      try {
        const task = runtime.handle(session, 'https://github.com/owner/repo/issues/1'); await started.promise
        await clock.tick(45001); await task; assert(cancelled); assert(released); assert.equal(session.sent.length, 0)
      } finally { runtime.dispose() }
    })
  })
}
module.exports = { run }
