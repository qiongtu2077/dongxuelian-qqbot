'use strict'
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const { withScenario } = require('./_setup')
const { AI_ROOT } = require('../fake/file')
const { flushAsync } = require('../fake/koishi')
const { parseGithubTarget, extractGithubTargets, resolveGithubNumber } = require('../../lib/github-preview/input')
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

// Keep raw Markdown separate from the explicitly requested official HTML representation.
function githubFixture(kind = 'issue', patch = {}) {
  if (kind === 'repository') return { private: false, full_name: 'owner/repo', owner: { login: 'owner', avatar_url: 'https://avatars.githubusercontent.com/u/1' }, html_url: 'https://github.com/owner/repo', description: '<script>secret</script>', language: null, stargazers_count: 2, forks_count: 1, license: null, updated_at: '2026-10-21T00:00:00Z', archived: false, ...patch }
  if (kind === 'user') return { login: 'owner', name: null, html_url: 'https://github.com/owner', bio: null, type: 'Organization', avatar_url: 'https://avatars.githubusercontent.com/u/1', public_repos: 2, followers: 3, following: 0, created_at: '2020-01-01T00:00:00Z', ...patch }
  return { html_url: `https://github.com/owner/repo/${kind === 'pull' ? 'pull' : 'issues'}/1`, title: '原文标题', number: 1, state: 'open', created_at: '2026-10-21T00:00:00Z', user: { login: 'owner', avatar_url: 'https://avatars.githubusercontent.com/u/1' }, labels: [{ name: 'bug', color: 'ff0000' }], body: 'PRIVATE_BODY_DO_NOT_CACHE', body_html: '<p>发起者原文</p>', ...(kind === 'pull' ? { merged: false, draft: false } : {}), ...patch }
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
    const repository = parseGithubTarget('https://github.com/owner/repo')
    assert.equal(resolveGithubNumber('#123', repository).url, 'https://github.com/owner/repo/issues/123')
    for (const text of ['看看 #123', '#123 看看', '#123\n#124', '#123\n', ' #123', '#123 ', '#0', '#01', '#-1', '#1.2', '#１２３', '#9007199254740992']) assert.equal(resolveGithubNumber(text, repository), null, text)
    assert.equal(resolveGithubNumber('#123', null), null)
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
  await githubCase(t, 'repository owner avatar survives field projection without another API request', async () => {
    let calls = 0
    const client = new GithubPreviewClient(async () => { calls++; return githubResponse(githubFixture('repository')) })
    const target = parseGithubTarget('https://github.com/owner/repo')
    const metadata = await client.lookup(target, githubContext())
    assert.equal(metadata.avatar, 'https://avatars.githubusercontent.com/u/1'); assert.equal(metadata.author, 'owner')
    await client.lookup(target, githubContext()); assert.equal(calls, 1)
    for (const owner of [undefined, { login: 'owner', avatar_url: 7 }]) {
      const invalid = new GithubPreviewClient(async () => githubResponse(githubFixture('repository', { owner })))
      await assert.rejects(invalid.lookup(target, githubContext()), /owner|avatar_url/)
    }
  })
  await githubCase(t, 'official rendered HTML is requested explicitly, preserved, bounded and type checked', async () => {
    const headers = []
    const client = new GithubPreviewClient(async (url, options) => {
      headers.push(options.headers.Accept)
      return githubResponse(String(url).endsWith('/repos/owner/repo') ? githubFixture('repository') : githubFixture('issue'))
    })
    const issue = await client.lookup(parseGithubTarget('https://github.com/owner/repo/issues/1'), githubContext())
    assert.equal(issue.bodyHtml, '<p>发起者原文</p>'); assert.equal(issue.createdAt, '2026-10-21T00:00:00Z')
    assert.deepEqual(headers, ['application/vnd.github+json', 'application/vnd.github.html+json'])
    for (const value of [undefined, 7, 'x'.repeat(256 * 1024 + 1)]) {
      const invalid = new GithubPreviewClient(async url => githubResponse(String(url).endsWith('/repos/owner/repo') ? githubFixture('repository') : githubFixture('issue', { body_html: value })))
      await assert.rejects(invalid.lookup(parseGithubTarget('https://github.com/owner/repo/issues/1'), githubContext()), /正文|body_html/)
    }
    const empty = new GithubPreviewClient(async url => githubResponse(String(url).endsWith('/repos/owner/repo') ? githubFixture('repository') : githubFixture('issue', { body_html: null })))
    assert.equal((await empty.lookup(parseGithubTarget('https://github.com/owner/repo/issues/1'), githubContext())).bodyHtml, '')
  })
  await githubCase(t, 'expired rendered bodies refresh signed attachments without If-None-Match', async () => {
    const originalNow = Date.now; let offset = 0, bodyRequests = 0
    Date.now = () => originalNow() + offset
    try {
      const client = new GithubPreviewClient(async (url, options) => {
        if (String(url).endsWith('/repos/owner/repo')) return githubResponse(githubFixture('repository'))
        bodyRequests++; assert.equal(options.headers['If-None-Match'], undefined)
        return githubResponse(githubFixture('issue', { body_html: '<p>signed-generation-' + bodyRequests + '</p>' }), 200, { etag: 'unchanged-issue' })
      })
      const target = parseGithubTarget('https://github.com/owner/repo/issues/1')
      const first = await client.lookup(target, githubContext()); offset = 300001
      const refreshed = await client.lookup(target, githubContext())
      assert.equal(bodyRequests, 2); assert.notEqual(first.bodyHtml, refreshed.bodyHtml)
    } finally { Date.now = originalNow }
  })
  await githubCase(t, 'body cache evicts by total bytes before the one-hundred-entry limit', async () => {
    let firstRequests = 0
    const client = new GithubPreviewClient(async url => {
      if (String(url).endsWith('/repos/owner/repo')) return githubResponse(githubFixture('repository'))
      const number = Number(String(url).split('/').at(-1))
      if (number === 1) firstRequests++
      return githubResponse(githubFixture('issue', { number, html_url: 'https://github.com/owner/repo/issues/' + number, body_html: 'a'.repeat(220 * 1024) }))
    })
    for (let number = 1; number <= 40; number++) await client.lookup(parseGithubTarget('https://github.com/owner/repo/issues/' + number), githubContext())
    await client.lookup(parseGithubTarget('https://github.com/owner/repo/issues/1'), githubContext())
    assert.equal(firstRequests, 2)
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
    await loadGithubAvatar('https://avatars.githubusercontent.com/u/77?v=4&s=460', githubContext(), async (url, options) => { calls++; assert.equal(url.searchParams.get('s'), '64'); assert.equal(url.searchParams.get('v'), '4'); assert.equal(options.redirect, 'error'); assert.equal(options.headers, undefined); return new Response('bad image') })
    assert.equal(calls, 1)
    const sharp = require('sharp'), url = 'https://avatars.githubusercontent.com/u/78'
    const png = await sharp({ create: { width: 32, height: 32, channels: 3, background: '#f5d531' } }).png().toBuffer()
    let downloads = 0
    const transport = async (_url, options) => {
      downloads++
      if (downloads === 1) return new Response('bad image')
      // A stream slower than the old three-second limit still fits the shared asset budget.
      return new Response(new ReadableStream({ start(stream) {
        const timer = setTimeout(() => { stream.enqueue(png); stream.close() }, 3100)
        options.signal.addEventListener('abort', () => { clearTimeout(timer); stream.error(options.signal.reason) }, { once: true })
      } }))
    }
    assert.equal(await loadGithubAvatar(url, githubContext(), transport), null)
    const avatar = await loadGithubAvatar(url, githubContext(), transport)
    assert.equal((await sharp(avatar).metadata()).width, 64)
    assert.deepEqual(await loadGithubAvatar(url, githubContext(), transport), avatar); assert.equal(downloads, 2)
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
  await withScenario({}, async ({ data, makeSession, run: middleware }) => {
    await githubCase(t, 'repository commands use real middleware, admin permission and an independent default-off whitelist', async () => {
      const originalFetch = global.fetch, calls = []
      global.fetch = async url => {
        const route = String(url); calls.push(route)
        return route.endsWith('/repos/owner/repo') ? githubResponse(githubFixture('repository')) : githubResponse({}, 404)
      }
      try {
        const denied = await middleware(makeSession({ userId: '300000000', content: 'GitHub群项目导入 https://github.com/owner/repo' }))
        assert(denied.sent.join('').includes('指定管理员')); assert.equal(calls.length, 0)
        const privateCommand = await middleware(makeSession({ isDirect: true, content: 'GitHub群项目导入 https://github.com/owner/repo' }))
        assert(privateCommand.sent.join('').includes('请在')); assert.equal(calls.length, 0)
        const imported = await middleware(makeSession({ content: 'GitHub群项目导入 https://github.com/owner/repo' }))
        assert(imported.sent.join('').includes('已绑定')); assert.deepEqual(data.readJson('github-preview-repositories.json'), { '10001': 'https://github.com/owner/repo' })
        assert(!fs.existsSync(data.pathFor('github-preview-groups.json')))
        const disabled = await middleware(makeSession({ content: '#123' }))
        assert(disabled.nextCalled); assert.equal(calls.length, 1)
        await middleware(makeSession({ content: 'GitHub查询群添加 10001' }))
        const query = await middleware(makeSession({ messageId: 'bound-123', content: '#123' }))
        assert(!query.nextCalled); assert(query.sent.join('').includes('资源不存在')); assert.equal(calls.at(-1), 'https://api.github.com/repos/owner/repo/issues/123')
        for (const [index, content] of ['看看 #124', '#124 看看', '#124\n#125', '<at id="999"/>#124', '#124<image src="x"/>'].entries()) {
          const result = await middleware(makeSession({ messageId: 'not-whole-' + index, content }))
          assert(!result.sent.join('').includes('https://github.com/owner/repo/issues/124'))
        }
        assert(!calls.some(url => url.includes('/issues/124')))
        const viewed = await middleware(makeSession({ content: 'GitHub群项目查看' }))
        assert(viewed.sent.join('').includes('https://github.com/owner/repo'))
        const deleted = await middleware(makeSession({ content: 'GitHub群项目删除' }))
        assert(deleted.sent.join('').includes('已删除')); assert.deepEqual(data.readJson('github-preview-repositories.json'), {})
      } finally { global.fetch = originalFetch }
    })
  })
  await withScenario({}, async ({ data, makeSession, run: middleware }) => {
    await githubCase(t, 'real middleware deletes screenshot-style linked commands with no API request and checks the matching group', async () => {
      const originalFetch = global.fetch
      const repositoryUrl = 'https://github.com/qiongtu2077/dsh-melody-launcher'
      let calls = 0
      global.fetch = async () => { calls++; return githubResponse(githubFixture('repository', { full_name: 'qiongtu2077/dsh-melody-launcher', html_url: repositoryUrl })) }
      try {
        await middleware(makeSession({ content: 'GitHub查询群添加 10001' }))
        await middleware(makeSession({ content: 'GitHub群项目导入 ' + repositoryUrl }))
        await middleware(makeSession({ guildId: '10002', content: 'GitHub群项目导入 ' + repositoryUrl }))
        const baseline = data.readJson('github-preview-repositories.json'), apiCalls = calls
        const denied = await middleware(makeSession({ userId: '300000000', content: 'GitHub群项目删除' + repositoryUrl }))
        assert(denied.sent.join('').includes('指定管理员'))
        const direct = await middleware(makeSession({ isDirect: true, content: 'GitHub群项目删除' + repositoryUrl }))
        assert(direct.sent.join('').includes('请在'))
        const mismatch = await middleware(makeSession({ content: 'GitHub群项目删除 https://github.com/other/project' }))
        assert(mismatch.sent.join('').includes('不一致'))
        for (const suffix of [repositoryUrl + '/issues/1', 'https://github.com.evil/owner/repo', '不是链接', repositoryUrl + ' ' + repositoryUrl]) {
          const invalid = await middleware(makeSession({ content: 'GitHub群项目删除 ' + suffix }))
          assert(invalid.sent.join('').includes('用法'))
        }
        assert.deepEqual(data.readJson('github-preview-repositories.json'), baseline); assert.equal(calls, apiCalls)
        const screenshotInput = await middleware(makeSession({ content: 'GitHub群项目删除' + repositoryUrl }))
        assert(screenshotInput.sent.join('').includes('已删除')); assert(!screenshotInput.nextCalled)
        assert.deepEqual(data.readJson('github-preview-repositories.json'), { '10002': repositoryUrl })
        assert.deepEqual(data.readJson('github-preview-groups.json'), ['10001']); assert.equal(calls, apiCalls)
        const empty = await middleware(makeSession({ content: 'GitHub群项目删除 ' + repositoryUrl }))
        assert(empty.sent.join('').includes('尚未绑定'))
        await middleware(makeSession({ content: 'GitHub群项目导入 ' + repositoryUrl }))
        const canonical = await middleware(makeSession({ content: 'GitHub群项目删除 HTTPS://GITHUB.COM/QIONGTU2077/DSH-MELODY-LAUNCHER/?x=1#readme' }))
        assert(canonical.sent.join('').includes('已删除'))
        await middleware(makeSession({ content: 'GitHub群项目导入 ' + repositoryUrl }))
        const bare = await middleware(makeSession({ content: 'GitHub群项目删除' }))
        assert(bare.sent.join('').includes('已删除')); assert.equal(calls, apiCalls)
        assert.deepEqual(data.readJson('github-preview-repositories.json'), { '10002': repositoryUrl })
      } finally { global.fetch = originalFetch }
    })
  })
  await withScenario({}, async ({ data }) => {
    await githubCase(t, 'linked deletion compares the latest serialized binding and preserves failed writes', async () => {
      const { GithubGroupRepositories, handleGithubRepositoryCommand } = require(path.join(AI_ROOT, 'lib/github-preview/repositories'))
      const repository = parseGithubTarget('https://github.com/qiongtu2077/dsh-melody-launcher'), other = parseGithubTarget('https://github.com/other/project')
      const directory = data.pathFor('delete-race'), repositories = new GithubGroupRepositories(directory)
      const noLookup = async () => { throw new Error('deletion must not request GitHub') }, signal = new AbortController().signal
      await repositories.update('10001', repository)
      let notifications = 0; repositories.onChanged(() => notifications++)
      const replacement = repositories.update('10001', other)
      const deletion = handleGithubRepositoryCommand('10001', false, 'GitHub群项目删除' + repository.url, repositories, noLookup, signal)
      await replacement
      assert((await deletion).includes('不一致')); assert.equal(notifications, 1)
      assert.equal(new GithubGroupRepositories(directory).get('10001').key, other.key)
      const failure = new GithubGroupRepositories(directory, async () => { throw new Error('disk full') })
      failure.onChanged(() => notifications++)
      const failed = await handleGithubRepositoryCommand('10001', false, 'GitHub群项目删除 ' + other.url, failure, noLookup, signal)
      assert(failed.includes('保存失败')); assert.equal(failure.get('10001').key, other.key); assert.equal(notifications, 1)
      const removed = await handleGithubRepositoryCommand('10001', false, 'GitHub群项目删除 ' + other.url, repositories, noLookup, signal)
      assert(removed.includes('已删除')); assert.equal(notifications, 2)
      assert.equal(new GithubGroupRepositories(directory).get('10001'), null)
      assert((await handleGithubRepositoryCommand('10001', false, 'GitHub群项目删除' + other.url, repositories, noLookup, signal)).includes('尚未绑定'))
    })
    await githubCase(t, 'repository binding is singular, durable, serialized and unchanged after failed writes or invalid snapshots', async () => {
      const { GithubGroupRepositories, handleGithubRepositoryCommand } = require(path.join(AI_ROOT, 'lib/github-preview/repositories'))
      const { GithubQueryError: RepositoryQueryError } = require(path.join(AI_ROOT, 'lib/github-preview/client'))
      const repository = parseGithubTarget('https://github.com/owner/repo'), other = parseGithubTarget('https://github.com/other/project')
      const directory = data.pathFor('bindings'), repositories = new GithubGroupRepositories(directory)
      await Promise.all([repositories.update('10001', repository), repositories.update('10002', other), repositories.update('10001', other)])
      const restarted = new GithubGroupRepositories(directory)
      assert.equal(restarted.get('10001').url, other.url); assert.equal(restarted.get('10002').url, other.url)
      assert.equal(await restarted.update('10001', other), false)
      let notifications = 0
      const failure = new GithubGroupRepositories(directory, async () => { throw new Error('disk full') })
      failure.onChanged(() => notifications++)
      await assert.rejects(failure.update('10001', null), /disk full/)
      assert.equal(failure.get('10001').url, other.url); assert.equal(notifications, 0)
      const signal = new AbortController().signal
      const denied = await handleGithubRepositoryCommand('10001', false, 'GitHub群项目导入 https://github.com/owner/repo', repositories, async () => { throw new RepositoryQueryError('仅支持公开仓库', 403) }, signal)
      assert(denied.includes('仅支持公开仓库')); assert.equal(repositories.get('10001').url, other.url)
      const replaced = await handleGithubRepositoryCommand('10001', false, 'GitHub群项目导入 https://github.com/owner/repo', repositories, async target => ({ target, url: target.url }), signal)
      assert(replaced.includes('原项目：' + other.url)); assert(replaced.includes('新项目：' + repository.url))
      const invalid = await handleGithubRepositoryCommand('10001', false, 'GitHub群项目导入 https://github.com/owner/repo/issues/1', repositories, async () => { throw new Error('must not request') }, signal)
      assert(invalid.includes('用法'))
      data.writeJson('bad-bindings/github-preview-repositories.json', { '10001': repository.url, '10002': 7 })
      const warnings = [], malformed = new GithubGroupRepositories(data.pathFor('bad-bindings'), undefined, message => warnings.push(message))
      assert.equal(malformed.get('10001'), null); assert.equal(warnings.length, 1)
    })
  })
  // Fake timers are explicit because this case verifies the ten-second import cancellation timer.
  await withScenario({ fakeTimers: true }, async ({ data, clock }) => {
    await githubCase(t, 'repository validation times out without persisting a late API response', async () => {
      const { GithubGroupRepositories, handleGithubRepositoryCommand } = require(path.join(AI_ROOT, 'lib/github-preview/repositories'))
      const repositories = new GithubGroupRepositories(data.pathFor('import-timeout')), hold = githubDeferred()
      let requestSignal
      const pending = handleGithubRepositoryCommand('10001', false, 'GitHub群项目导入 https://github.com/owner/repo', repositories, async (target, context) => { requestSignal = context.signal; await hold.promise; return { target, url: target.url } }, new AbortController().signal)
      try {
        await clock.tick(10001)
        assert((await pending).includes('超时')); assert(requestSignal.aborted)
        hold.resolve(); await flushAsync(3)
        assert.equal(repositories.get('10001'), null); assert(!fs.existsSync(repositories.file))
      } finally { hold.resolve() }
    })
  })
  await withScenario({}, async ({ data, makeSession }) => {
    await githubCase(t, 'whole-message number uses the bound repository and the existing API detects PRs automatically', async () => {
      const { GithubPreviewSettings } = require(path.join(AI_ROOT, 'lib/github-preview/settings'))
      const { GithubPreviewRuntime } = require(path.join(AI_ROOT, 'lib/github-preview/runtime'))
      const settings = new GithubPreviewSettings(data.pathFor('number')); await settings.update('10001', true)
      const calls = [], captures = []
      const client = new GithubPreviewClient(async url => {
        calls.push(String(url))
        return githubResponse(String(url).endsWith('/repos/owner/repo') ? githubFixture('repository') : String(url).includes('/issues/') ? githubFixture('issue', { pull_request: { url: 'official' } }) : githubFixture('pull'))
      })
      const runtime = new GithubPreviewRuntime(settings, { lookup: (target, context) => client.lookup(target, context), screenshot: async metadata => { captures.push(metadata.target.kind); return { images: [Buffer.from('pull-image')], capturedAt: Date.now() } }, acquire: async () => () => {}, log: () => {} })
      try {
        const session = makeSession({ content: '#1', messageId: 'number-pr' })
        assert.equal(runtime.accepts(session, '#1'), false)
        await runtime.repositories.update('10001', parseGithubTarget('https://github.com/owner/repo'))
        await runtime.handle(session, '#1')
        assert.deepEqual(captures, ['pull']); assert(session.sent.join('').includes('data:image/png')); assert(session.sent.join('').includes('/pull/1'))
        assert(calls.some(url => url.endsWith('/issues/1'))); assert(calls.some(url => url.endsWith('/pulls/1')))
        assert.equal(runtime.accepts(makeSession({ isDirect: true, content: '#1' }), '#1'), false)
        assert.equal(runtime.accepts(makeSession({ guildId: '10002', content: '#1' }), '#1'), false)
        assert.equal(runtime.accepts(makeSession({ content: '<at id="999"/>#1' }), '#1'), false)
      } finally { runtime.dispose() }
    })
  })
  await withScenario({}, async ({ data, makeSession }) => {
    await githubCase(t, 'replacing a binding cancels active and queued queries before sending old repository images', async () => {
      const { GithubPreviewSettings } = require(path.join(AI_ROOT, 'lib/github-preview/settings'))
      const { GithubPreviewRuntime } = require(path.join(AI_ROOT, 'lib/github-preview/runtime'))
      const settings = new GithubPreviewSettings(data.pathFor('binding-cancel')); await settings.update('10001', true)
      const started = githubDeferred(), hold = githubDeferred(); let gates = 0
      const runtime = new GithubPreviewRuntime(settings, { lookup: async (target, context) => { if (target.owner === 'owner') { started.resolve(); await hold.promise } return { target, title: 'title', url: target.url, facts: [], fetchedAt: Date.now() } }, screenshot: async () => ({ images: [Buffer.from('new-image')], capturedAt: Date.now() }), acquire: async () => { gates++; return () => {} }, log: () => {} })
      try {
        await runtime.repositories.update('10001', parseGithubTarget('https://github.com/owner/repo'))
        const active = makeSession({ content: '#1', messageId: 'old-active' }), queued = makeSession({ content: '#2', messageId: 'old-queued' })
        const first = runtime.handle(active, '#1'); await started.promise
        const second = runtime.handle(queued, '#2')
        await runtime.repositories.update('10001', parseGithubTarget('https://github.com/other/project'))
        hold.resolve(); await Promise.all([first, second])
        assert.equal(gates, 0); assert.equal(active.sent.length + queued.sent.length, 0)
        const fresh = makeSession({ content: '#1', messageId: 'new-binding' }); await runtime.handle(fresh, '#1')
        assert.equal(gates, 1); assert(fresh.sent.join('').includes('https://github.com/other/project/issues/1'))
        await runtime.repositories.update('10001', null)
        assert.equal(runtime.accepts(makeSession({ content: '#3' }), '#3'), false)
      } finally { hold.resolve(); runtime.dispose() }
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
      for (const url of ['https://github.com/owner/repo/issues/1', 'https://github.com/owner/repo/pull/1', 'https://github.com/owner/repo', 'https://github.com/owner']) {
        const settings = new GithubPreviewSettings(data.pathFor('partial')); await settings.update('10001', true); await settings.update('10002', true)
        let captures = 0
        // Both renderer branches must preserve partial-avatar retry behavior across groups.
        const partial = async () => { captures++; return { images: [Buffer.from('partial')], capturedAt: Date.now(), incomplete: true, note: '头像暂未载入，请查看原文。' } }
        const runtime = new GithubPreviewRuntime(settings, { lookup: async target => ({ target, url: target.url, title: 'title', facts: [], fetchedAt: Date.now() }), screenshot: partial, render: partial, acquire: async () => () => {}, log: () => {} })
        try {
          const first = makeSession({ messageId: 'partial-one' }), second = makeSession({ guildId: '10002', messageId: 'partial-two' })
          await runtime.handle(first, url); await runtime.handle(second, url)
          assert.equal(captures, 2); assert(first.sent.join('').includes('头像暂未载入'))
        } finally { runtime.dispose() }
      }
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
    await githubCase(t, '30-second target deadline includes lookup and rendering, then returns text without late images', async () => {
      const { GithubPreviewSettings } = require(path.join(AI_ROOT, 'lib/github-preview/settings'))
      const { GithubPreviewRuntime } = require(path.join(AI_ROOT, 'lib/github-preview/runtime'))
      const settings = new GithubPreviewSettings(data.pathFor('target-deadline')); await settings.update('10001', true)
      const started = githubDeferred(); let deadline, released = 0, cancelled = false
      const runtime = new GithubPreviewRuntime(settings, {
        lookup: async (target, context) => { deadline = context.deadline; await clock.tick(8000); return { target, title: 'title', url: target.url, facts: [], fetchedAt: Date.now() } },
        acquire: async () => () => { released++ }, log: () => {},
        screenshot: async (_metadata, context) => {
          assert.equal(context.deadline, deadline); assert.equal(context.deadline - Date.now(), 22000)
          started.resolve()
          await new Promise(resolve => context.signal.addEventListener('abort', () => { cancelled = true; resolve() }, { once: true }))
          return { images: [Buffer.from('late')], capturedAt: Date.now() }
        },
      })
      try {
        const session = makeSession({ messageId: 'target-deadline' })
        const task = runtime.handle(session, 'https://github.com/owner/repo/issues/1'); await started.promise
        await clock.tick(22001); await task
        assert(cancelled); assert.equal(released, 1); assert.equal(session.sent.length, 1)
        assert(session.sent.join('').includes('30秒')); assert(!session.sent.join('').includes('data:image'))
      } finally { runtime.dispose() }
    })
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
    await githubCase(t, 'two targets share 45 seconds and the second target cannot reset the message deadline', async () => {
      const { GithubPreviewSettings } = require(path.join(AI_ROOT, 'lib/github-preview/settings'))
      const { GithubPreviewRuntime } = require(path.join(AI_ROOT, 'lib/github-preview/runtime'))
      const settings = new GithubPreviewSettings(data.pathFor('deadline')); await settings.update('10001', true)
      const started = [githubDeferred(), githubDeferred()], deadlines = []; let cancelled = 0, released = false
      const runtime = new GithubPreviewRuntime(settings, { lookup: async target => ({ target, title: 'title', url: target.url, facts: [], fetchedAt: Date.now() }), acquire: async () => () => { released = true }, screenshot: async (_metadata, context) => { const index = deadlines.length; deadlines.push(context.deadline); started[index].resolve(); await new Promise(resolve => context.signal.addEventListener('abort', () => { cancelled++; resolve() }, { once: true })); return { images: [Buffer.from('late')], capturedAt: Date.now() } }, log: () => {} })
      const session = makeSession({ messageId: 'deadline' })
      try {
        const task = runtime.handle(session, 'https://github.com/owner/repo/issues/1 https://github.com/owner/repo/issues/2'); await started[0].promise
        await clock.tick(30001); await started[1].promise
        assert.equal(deadlines[1] - deadlines[0], 15000)
        await clock.tick(15000); await task
        assert.equal(cancelled, 2); assert(released); assert.equal(session.sent.length, 1)
        assert(!session.sent.join('').includes('data:image'))
      } finally { runtime.dispose() }
    })
  })
}
module.exports = { run }
