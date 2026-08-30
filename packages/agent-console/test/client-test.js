'use strict'

const assert = require('assert')
const fs = require('fs')
const path = require('path')
const ts = require('typescript')

const CLIENT_PATH = path.resolve(__dirname, '..', 'src', 'api', 'client.ts')

/** Installs a temporary CommonJS loader for the TypeScript API client. */
function installTypeScriptLoader() {
  const previous = require.extensions['.ts']
  require.extensions['.ts'] = (module, filename) => {
    const source = fs.readFileSync(filename, 'utf8')
    const output = ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
      fileName: filename,
    }).outputText
    module._compile(output, filename)
  }
  return () => {
    if (previous) require.extensions['.ts'] = previous
    else delete require.extensions['.ts']
  }
}

/** Creates the Web Storage subset used by the API client. */
function createLocalStorage() {
  const values = new Map()
  return {
    getItem: key => values.has(key) ? values.get(key) : null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: key => values.delete(key),
    clear: () => values.clear(),
  }
}

/** Creates the response subset consumed by JSON API requests. */
function jsonResponse(data, ok = true) {
  return {
    ok,
    json: async () => data,
  }
}

/** Installs a fetch recorder that returns deterministic JSON responses. */
function recordFetch(calls, response = jsonResponse({ ok: true })) {
  global.fetch = async (url, init = {}) => {
    calls.push({ url, init })
    return response
  }
}

/** Resets browser globals between API client scenarios. */
function resetBrowserState(calls) {
  global.localStorage.clear()
  calls.length = 0
  recordFetch(calls)
}

/** Verifies token persistence and authenticated request headers. */
async function testAuthentication(client, calls) {
  client.setAccessToken('access-token')
  client.setAdminToken('admin-token')
  await client.api.getConfig()

  assert.strictEqual(calls[0].url, '/dashboard/api/agent/config')
  assert.strictEqual(calls[0].init.headers.Authorization, 'Bearer access-token')
  assert.strictEqual(calls[0].init.headers['X-Admin-Token'], 'admin-token')
  assert.strictEqual(global.localStorage.getItem('dashboard_admin_token'), null)
  const saved = JSON.parse(global.localStorage.getItem('dashboard_server_token'))
  assert.strictEqual(saved.token, 'admin-token')
  assert.ok(saved.expires > Date.now())

  global.localStorage.setItem('dashboard_server_token', JSON.stringify({ token: 'expired', expires: Date.now() - 1 }))
  calls.length = 0
  await client.api.getConfig()
  assert.strictEqual(calls[0].init.headers['X-Admin-Token'], undefined)
}

/** Verifies write methods, payloads, and long-running interaction endpoints. */
async function testWriteRequests(client, calls) {
  const config = { channels: {}, autoRoute: {}, enabledSkills: [], persona: {}, queue: {}, planMode: {}, push: {}, cron: {}, memory: {} }
  await client.api.saveConfig({ config, mode: 'confirm' })
  await client.api.chat('你好', [{ role: 'user', content: '前文' }], true, false)
  await client.api.confirm('pending-1')
  await client.api.fileUpload({ root: 'workspace', name: 'a.txt', content: 'hello' })

  assert.deepStrictEqual(calls.map(call => [call.url, call.init.method]), [
    ['/dashboard/api/agent/config', 'PUT'],
    ['/dashboard/api/agent/chat', 'POST'],
    ['/dashboard/api/agent/confirm', 'POST'],
    ['/dashboard/api/agent/file/upload', 'POST'],
  ])
  assert.deepStrictEqual(JSON.parse(calls[0].init.body), { config, mode: 'confirm' })
  assert.deepStrictEqual(JSON.parse(calls[1].init.body), {
    message: '你好',
    history: [{ role: 'user', content: '前文' }],
    enableThinking: true,
    agentMode: false,
  })
  assert.deepStrictEqual(JSON.parse(calls[2].init.body), { pendingId: 'pending-1' })
  assert.deepStrictEqual(JSON.parse(calls[3].init.body), { root: 'workspace', name: 'a.txt', content: 'hello' })
}

/** Verifies path and query values are encoded exactly once. */
async function testUrlEncoding(client, calls) {
  await client.api.files('C:\\工作 目录', '猫&狗')
  await client.api.filePreview('../a b.txt')
  await client.api.plan('id/with?query')

  assert.strictEqual(calls[0].url, '/dashboard/api/agent/files?root=C%3A%5C%E5%B7%A5%E4%BD%9C%20%E7%9B%AE%E5%BD%95&q=%E7%8C%AB%26%E7%8B%97')
  assert.strictEqual(calls[1].url, '/dashboard/api/agent/file?path=..%2Fa%20b.txt')
  assert.strictEqual(calls[2].url, '/dashboard/api/agent/plans/id%2Fwith%3Fquery')
}

/** Verifies API envelope failures and network errors retain useful messages. */
async function testRequestErrors(client) {
  global.fetch = async () => jsonResponse({ ok: false, code: 'DENIED', message: '拒绝访问' }, true)
  const denied = await client.api.getConfig()
  assert.deepStrictEqual(denied, {
    ok: false,
    data: { ok: false, code: 'DENIED', message: '拒绝访问' },
    code: 'DENIED',
    message: '拒绝访问',
  })

  global.fetch = async () => { throw new Error('network offline') }
  const offline = await client.api.getConfig()
  assert.strictEqual(offline.ok, false)
  assert.strictEqual(offline.message, 'network offline')
}

/** Verifies an aborted request is converted to the stable timeout message. */
async function testTimeoutError(client) {
  const originalSetTimeout = global.setTimeout
  const originalClearTimeout = global.clearTimeout
  global.setTimeout = callback => {
    queueMicrotask(callback)
    return 1
  }
  global.clearTimeout = () => {}
  global.fetch = async (_url, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener('abort', () => {
      const error = new Error('aborted')
      error.name = 'AbortError'
      reject(error)
    })
  })
  try {
    const result = await client.api.getConfig()
    assert.strictEqual(result.ok, false)
    assert.strictEqual(result.message, '请求超时')
  } finally {
    global.setTimeout = originalSetTimeout
    global.clearTimeout = originalClearTimeout
  }
}

/** Verifies file downloads return blobs and surface server error messages. */
async function testFileDownload(client, calls) {
  const blob = { fixture: true }
  global.fetch = async (url, init) => {
    calls.push({ url, init })
    return { ok: true, blob: async () => blob }
  }
  assert.strictEqual(await client.api.fileDownload('报告 1.txt'), blob)
  assert.strictEqual(calls[0].url, '/dashboard/api/agent/file/download?path=%E6%8A%A5%E5%91%8A%201.txt')

  global.fetch = async () => ({
    ok: false,
    json: async () => ({ message: '文件不存在' }),
  })
  await assert.rejects(() => client.api.fileDownload('missing.txt'), /文件不存在/)
}

/** Verifies administrator verification uses the unauthenticated endpoint contract. */
async function testVerifyAdmin(client, calls) {
  recordFetch(calls, jsonResponse({ ok: true, token: 'verified' }))
  const result = await client.verifyAdmin('secret')
  assert.deepStrictEqual(result, { ok: true, token: 'verified' })
  assert.strictEqual(calls[0].url, '/dashboard/api/admin/verify')
  assert.strictEqual(calls[0].init.method, 'POST')
  assert.deepStrictEqual(calls[0].init.headers, { 'Content-Type': 'application/json' })
  assert.deepStrictEqual(JSON.parse(calls[0].init.body), { password: 'secret' })
}

/** Runs all Agent Console API client contract tests. */
async function main() {
  const restoreLoader = installTypeScriptLoader()
  const calls = []
  global.localStorage = createLocalStorage()
  try {
    const client = require(CLIENT_PATH)
    resetBrowserState(calls)
    await testAuthentication(client, calls)
    resetBrowserState(calls)
    await testWriteRequests(client, calls)
    resetBrowserState(calls)
    await testUrlEncoding(client, calls)
    resetBrowserState(calls)
    await testRequestErrors(client)
    resetBrowserState(calls)
    await testTimeoutError(client)
    resetBrowserState(calls)
    await testFileDownload(client, calls)
    resetBrowserState(calls)
    await testVerifyAdmin(client, calls)
    assert.strictEqual(client.getErrorMessage({ message: '对象错误' }), '对象错误')
    assert.strictEqual(client.getErrorMessage(null, '回退错误'), '回退错误')
    console.log('Agent Console API client tests passed')
  } finally {
    restoreLoader()
    delete global.fetch
    delete global.localStorage
  }
}

main().catch(error => {
  console.error(error.stack || error.message || error)
  process.exit(1)
})
