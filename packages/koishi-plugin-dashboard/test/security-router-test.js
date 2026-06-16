'use strict'

const assert = require('assert')
const crypto = require('crypto')
const fs = require('fs')
const path = require('path')
const { PassThrough } = require('stream')

process.env.GLOBAL_LOCAL_MODE = ''
process.env.DONGXUELIAN_AI_DATA_DIR = path.join(__dirname, '..', '..', '..', 'tmp', 'dashboard-security-router-test')

fs.rmSync(process.env.DONGXUELIAN_AI_DATA_DIR, { recursive: true, force: true })
fs.mkdirSync(process.env.DONGXUELIAN_AI_DATA_DIR, { recursive: true })

const auth = require('../lib/auth')
const router = require('../lib/router')
const standalone = require('../standalone')

function resetDataDir() {
  fs.rmSync(process.env.DONGXUELIAN_AI_DATA_DIR, { recursive: true, force: true })
  fs.mkdirSync(process.env.DONGXUELIAN_AI_DATA_DIR, { recursive: true })
}

// Builds a minimal HTTP request object for router/auth unit tests.
function makeReq(method, pathname, headers = {}) {
  return {
    method,
    url: pathname,
    headers: { host: '127.0.0.1:5150', ...headers },
    socket: { remoteAddress: '127.0.0.1' },
  }
}

// Builds a minimal HTTP response object that captures status/body/headers.
function makeRes() {
  return {
    statusCode: 0,
    headers: {},
    body: '',
    setHeader(name, value) { this.headers[name.toLowerCase()] = value },
    writeHead(status, headers = {}) {
      this.statusCode = status
      for (const [key, value] of Object.entries(headers)) this.setHeader(key, value)
    },
    end(body = '') { this.body += body },
  }
}

// Dispatches a JSON request and resolves when the fake response ends.
function dispatchJson(method, pathname, body, headers = {}, remoteAddress = '127.0.0.1') {
  return new Promise((resolve) => {
    const req = new PassThrough()
    req.method = method
    req.url = pathname
    req.headers = {
      host: '127.0.0.1:5150',
      'content-type': 'application/json',
      ...headers,
    }
    req.socket = { remoteAddress }
    req.connection = req.socket

    const res = makeRes()
    const end = res.end
    res.end = function endAndResolve(bodyText = '') {
      end.call(this, bodyText)
      resolve(res)
    }

    router.dispatch(req, res, pathname, new URL('http://127.0.0.1:5150' + pathname))
    req.end(JSON.stringify(body))
  })
}

function parseJsonResponse(res) {
  return JSON.parse(res.body || '{}')
}

function adminHeaders() {
  return {
    authorization: 'Bearer ' + auth.createToken(),
    'x-admin-token': auth.createAdminToken(),
  }
}

// Verifies object-shaped regex route entries dispatch without throwing.
function testRegexRouteObjectDispatch() {
  let captured = ''
  router.regexRoutes.push({
    pattern: /^\/dashboard\/api\/unit\/([^/]+)$/,
    method: 'GET',
    handler: (req, res, match) => {
      captured = match[1]
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true }))
    },
  })
  const req = makeReq('GET', '/dashboard/api/unit/abc123', { authorization: 'Bearer ' + auth.createToken() })
  const res = makeRes()
  assert.strictEqual(router.dispatch(req, res, '/dashboard/api/unit/abc123', new URL('http://127.0.0.1/dashboard/api/unit/abc123')), true)
  assert.strictEqual(captured, 'abc123')
  assert.strictEqual(res.statusCode, 200)
}

// Verifies admin verification is protected by the normal access token layer.
function testAdminVerifyRequiresAccessToken() {
  const req = makeReq('POST', '/dashboard/api/admin/verify', { origin: 'http://127.0.0.1:5150' })
  const res = makeRes()
  assert.strictEqual(router.dispatch(req, res, '/dashboard/api/admin/verify', new URL('http://127.0.0.1/dashboard/api/admin/verify')), true)
  assert.strictEqual(res.statusCode, 401)
  assert.match(res.body, /AUTH_REQUIRED/)
}

// Verifies token signing no longer accepts the old password-derived hash token.
function testLegacyPasswordHashTokenRejected() {
  resetDataDir()
  fs.writeFileSync(path.join(process.env.DONGXUELIAN_AI_DATA_DIR, 'dashboard-access-pwd.txt'), 'access-pass', 'utf8')
  const forged = crypto.createHash('sha256').update('dashboard:access-pass').digest('hex')
  assert.strictEqual(auth.validateToken(forged), false)
}

// Verifies rotating the session secret invalidates existing tokens.
function testTokenRotationInvalidatesToken() {
  resetDataDir()
  const token = auth.createToken()
  assert.strictEqual(auth.validateToken(token), true)
  auth.rotateSessionSecret()
  assert.strictEqual(auth.validateToken(token), false)
}

// Verifies the reset-token recovery path still works after bcrypt migration.
async function testResetPasswordAcceptsValidResetToken() {
  resetDataDir()
  const dataDir = process.env.DONGXUELIAN_AI_DATA_DIR
  fs.writeFileSync(path.join(dataDir, 'password-reset-token.txt'), 'reset-token-123', 'utf8')
  fs.writeFileSync(path.join(dataDir, 'dashboard-access-pwd.txt'), 'old-access', 'utf8')
  fs.writeFileSync(path.join(dataDir, 'dashboard-admin-pwd.txt'), 'old-admin', 'utf8')
  fs.writeFileSync(path.join(dataDir, 'dashboard-pwd.txt'), 'legacy-access', 'utf8')

  const res = await dispatchJson('POST', '/dashboard/api/auth/reset-password', { resetToken: 'reset-token-123' }, { origin: 'http://127.0.0.1:5150' })
  assert.strictEqual(res.statusCode, 200)
  assert.strictEqual(parseJsonResponse(res).ok, true)
  assert.strictEqual(fs.existsSync(path.join(dataDir, 'dashboard-pwd.txt')), false)
  assert.strictEqual(auth.isBcryptHash(fs.readFileSync(path.join(dataDir, 'dashboard-access-pwd.txt'), 'utf8').trim()), true)
  assert.strictEqual(auth.isBcryptHash(fs.readFileSync(path.join(dataDir, 'dashboard-admin-pwd.txt'), 'utf8').trim()), true)
}

// Verifies a legacy plaintext access password is removed only after a successful hash upgrade.
async function testLegacyAccessLoginUpgradesAndRemovesPlaintext() {
  resetDataDir()
  const dataDir = process.env.DONGXUELIAN_AI_DATA_DIR
  fs.writeFileSync(path.join(dataDir, 'dashboard-pwd.txt'), 'legacy-access-pass', 'utf8')

  const failed = await dispatchJson('POST', '/dashboard/api/login', { password: 'wrong-pass' }, { origin: 'http://127.0.0.1:5150' }, '203.0.113.21')
  assert.strictEqual(failed.statusCode, 401)
  assert.strictEqual(fs.readFileSync(path.join(dataDir, 'dashboard-pwd.txt'), 'utf8').trim(), 'legacy-access-pass')
  assert.strictEqual(fs.existsSync(path.join(dataDir, 'dashboard-access-pwd.txt')), false)

  const ok = await dispatchJson('POST', '/dashboard/api/login', { password: 'legacy-access-pass' }, { origin: 'http://127.0.0.1:5150' }, '203.0.113.22')
  assert.strictEqual(ok.statusCode, 200)
  assert.strictEqual(auth.validateToken(parseJsonResponse(ok).token), true)
  assert.strictEqual(fs.existsSync(path.join(dataDir, 'dashboard-pwd.txt')), false)
  assert.strictEqual(auth.isBcryptHash(fs.readFileSync(path.join(dataDir, 'dashboard-access-pwd.txt'), 'utf8').trim()), true)
}

// Verifies failed admin password checks are rate limited behind access auth.
async function testAdminVerifyRateLimit() {
  process.env.GLOBAL_LOCAL_MODE = ''
  const dataDir = process.env.DONGXUELIAN_AI_DATA_DIR
  resetDataDir()
  fs.mkdirSync(dataDir, { recursive: true })
  fs.writeFileSync(path.join(dataDir, 'dashboard-admin-pwd.txt'), 'admin-pass', 'utf8')

  const authHeader = 'Bearer ' + auth.createToken()
  const headers = { authorization: authHeader, origin: 'http://127.0.0.1:5150' }
  for (let i = 0; i < 10; i += 1) {
    const res = await dispatchJson('POST', '/dashboard/api/admin/verify', { password: 'wrong-pass' }, headers, '203.0.113.10')
    assert.strictEqual(res.statusCode, 401)
  }

  const locked = await dispatchJson('POST', '/dashboard/api/admin/verify', { password: 'admin-pass' }, headers, '203.0.113.10')
  assert.strictEqual(locked.statusCode, 429)
}

// Verifies non-local first startup creates random credential and session files.
function testInitialCredentialsGenerated() {
  process.env.GLOBAL_LOCAL_MODE = ''
  const dataDir = process.env.DONGXUELIAN_AI_DATA_DIR
  resetDataDir()
  auth.ensureInitialCredentials()

  const accessPassword = fs.readFileSync(path.join(dataDir, 'dashboard-access-pwd.txt'), 'utf8').trim()
  const adminPassword = fs.readFileSync(path.join(dataDir, 'dashboard-admin-pwd.txt'), 'utf8').trim()
  const sessionSecret = fs.readFileSync(path.join(dataDir, 'dashboard-session-secret.txt'), 'utf8').trim()

  assert.ok(accessPassword.length >= 24)
  assert.ok(adminPassword.length >= 24)
  assert.ok(sessionSecret.length >= 40)
  assert.notStrictEqual(accessPassword, '123')
  assert.notStrictEqual(adminPassword, '123')
}

// Verifies session signing cannot be pinned to an environment secret after rotation.
function testSessionSecretIgnoresEnvPinning() {
  process.env.DASHBOARD_SESSION_SECRET = 'fixed-env-secret'
  const token = auth.createToken()
  assert.strictEqual(auth.validateToken(token), true)
  auth.rotateSessionSecret()
  assert.strictEqual(auth.validateToken(token), false)
  delete process.env.DASHBOARD_SESSION_SECRET
}

// Verifies local auth bypass is not granted to cross-site browser requests.
function testLocalBypassRejectsCrossSite() {
  process.env.GLOBAL_LOCAL_MODE = 'true'
  const sameOriginReq = makeReq('GET', '/dashboard/api/status')
  assert.strictEqual(auth.isLocalAuthBypass(sameOriginReq), true)

  const sameHostDifferentSchemeReq = makeReq('GET', '/dashboard/api/status', {
    origin: 'https://127.0.0.1:5150',
  })
  assert.strictEqual(auth.isLocalAuthBypass(sameHostDifferentSchemeReq), false)

  const crossSiteReq = makeReq('GET', '/dashboard/api/status', {
    origin: 'https://evil.example',
    'sec-fetch-site': 'cross-site',
  })
  assert.strictEqual(auth.isLocalAuthBypass(crossSiteReq), false)

  const res = makeRes()
  assert.strictEqual(auth.rejectCrossSiteRequest(crossSiteReq, res), true)
  assert.strictEqual(res.statusCode, 403)
  assert.strictEqual(res.headers['access-control-allow-origin'], undefined)
}

// Verifies Dashboard preview audio Blob URLs are allowed without relaxing script sources.
function testContentSecurityPolicyAllowsPreviewAudio() {
  const csp = standalone.CONTENT_SECURITY_POLICY
  assert.match(csp, /media-src[^;]*'self'[^;]*blob:[^;]*data:/)
  assert.doesNotMatch(csp, /script-src[^;]*blob:/)
  assert.doesNotMatch(csp, /script-src[^;]*data:/)
}

// Verifies resource status can include disk capacity and directory size details.
function testResourceDiskUsageShape() {
  const resourceRoutes = require('../lib/routes/resource')
  const disk = resourceRoutes.collectDiskUsage()
  assert.strictEqual(disk.ok, true)
  assert.ok(Array.isArray(disk.entries))
  assert.ok(disk.entries.length > 0)
  for (const entry of disk.entries) {
    assert.strictEqual(typeof entry.name, 'string')
    assert.strictEqual(typeof entry.label, 'string')
    assert.strictEqual(typeof entry.path, 'string')
    assert.strictEqual(typeof entry.sizeBytes, 'number')
    assert.strictEqual(typeof entry.sizeMb, 'number')
  }
  if (disk.filesystem) {
    assert.strictEqual(typeof disk.filesystem.totalMb, 'number')
    assert.strictEqual(typeof disk.filesystem.availableMb, 'number')
    assert.strictEqual(typeof disk.filesystem.usedPercent, 'number')
  }
}

// Verifies memory history only requires the normal Dashboard access token.
function testResourceMemoryHistoryRequiresAccessOnly() {
  const req = makeReq('GET', '/dashboard/api/resource/memory-history?range=1m', { authorization: 'Bearer ' + auth.createToken() })
  const res = makeRes()
  assert.strictEqual(router.dispatch(req, res, '/dashboard/api/resource/memory-history', new URL('http://127.0.0.1:5150/dashboard/api/resource/memory-history?range=1m')), true)
  assert.strictEqual(res.statusCode, 200)
  assert.strictEqual(parseJsonResponse(res).ok, true)
}

// Verifies memory history exposes used-memory fields while keeping available-memory fields.
function testResourceMemoryHistoryIncludesUsedMemory() {
  resetDataDir()
  const resourceRoutes = require('../lib/routes/resource')
  const systemRoot = path.join(process.env.DONGXUELIAN_AI_DATA_DIR, 'resource-system')
  fs.mkdirSync(systemRoot, { recursive: true })
  const now = new Date()
  const stamp = now.toISOString().slice(0, 10)
  const sample = {
    createdAt: now.toISOString(),
    event: 'process_metrics',
    memAvailableMb: 600,
    memTotalMb: 1000,
    rssMb: 42,
    source: 'unit-test',
  }
  fs.writeFileSync(path.join(systemRoot, `process-metrics-${stamp}.jsonl`), JSON.stringify(sample) + '\n', 'utf8')

  const payload = resourceRoutes.collectMemoryHistory({ system: { RESOURCE_SYSTEM_ROOT: systemRoot } }, '1m')
  assert.strictEqual(payload.ok, true)
  assert.strictEqual(payload.pointCount, 1)
  assert.strictEqual(payload.points[0].memAvailableMb, 600)
  assert.strictEqual(payload.points[0].memUsedMb, 400)
  assert.strictEqual(payload.points[0].minUsedMb, 400)
  assert.strictEqual(payload.points[0].maxUsedMb, 400)
}

// Verifies resource status surfaces server mode and activity flags from the shared runtime facts.
function testResourceStatusIncludesServerModeFlags() {
  resetDataDir()
  const dataDir = process.env.DONGXUELIAN_AI_DATA_DIR
  const controlDir = path.join(dataDir, 'resource-control')
  fs.mkdirSync(controlDir, { recursive: true })
  fs.writeFileSync(path.join(controlDir, 'config.json'), JSON.stringify({
    serverMode: 'small',
    updatedAt: '2026-06-14T00:00:00.000Z',
  }, null, 2), 'utf8')

  const activityLease = require('../../koishi-plugin-dongxuelian-ai/lib/resource-scheduler/resource-activity-lease')
  const taskStore = require('../../koishi-plugin-dongxuelian-ai/lib/resource-workers/task-store')
  const releaseTool = activityLease.acquireResourceActivityLease('tool_active', {
    owner: 'dashboard-security-router-test',
    taskId: 'dashboard-resource-status-mode',
    ttlMs: 120000,
  })
  taskStore.writeWorkerHeartbeat('agent-worker', {
    kind: 'agent',
    step: 'tick',
    loopIterations: 3,
    lastClaimAttemptAt: '2026-06-16T00:00:00.000Z',
    lastTaskFinishedAt: '2026-06-16T00:01:00.000Z',
    currentTaskId: '',
    currentTaskStartedAt: '',
    parked: false,
    parkSleepMs: 0,
  })

  try {
    const req = makeReq('GET', '/dashboard/api/resource/status', { authorization: 'Bearer ' + auth.createToken() })
    const res = makeRes()
    assert.strictEqual(router.dispatch(req, res, '/dashboard/api/resource/status', new URL('http://127.0.0.1:5150/dashboard/api/resource/status')), true)
    assert.strictEqual(res.statusCode, 200)
    const payload = parseJsonResponse(res)
    assert.strictEqual(payload.ok, true)
    assert.strictEqual(payload.serverMode, 'small')
    assert.strictEqual(payload.tool_active, true)
    assert.strictEqual(payload.render_active, false)
    assert.strictEqual(payload.background_allowed, false)
    assert.ok(typeof payload.mode === 'string')
    assert.ok(typeof payload.resourceState === 'string')
    assert.ok(Array.isArray(payload.workers))
    const worker = payload.workers.find(item => item && item.name === 'agent-worker')
    assert.ok(worker)
    assert.strictEqual(worker.loopIterations, 3)
    assert.strictEqual(worker.lastClaimAttemptAt, '2026-06-16T00:00:00.000Z')
    assert.strictEqual(worker.lastTaskFinishedAt, '2026-06-16T00:01:00.000Z')
    assert.strictEqual(worker.currentTaskId, '')
    assert.strictEqual(worker.parked, false)
  } finally {
    releaseTool('resource-status-test-finally')
  }
}

// Verifies resource center read APIs require only normal access while writes stay admin-gated.
async function testResourceReadApisRequireAccessOnly() {
  process.env.GLOBAL_LOCAL_MODE = ''
  const headers = { authorization: 'Bearer ' + auth.createToken() }
  const readPaths = [
    '/dashboard/api/resource/mode',
    '/dashboard/api/resource/status',
    '/dashboard/api/resource/tasks',
    '/dashboard/api/resource/events',
    '/dashboard/api/resource/workers',
    '/dashboard/api/resource/media',
    '/dashboard/api/resource/precompute',
  ]
  for (const pathname of readPaths) {
    const req = makeReq('GET', pathname, headers)
    const res = makeRes()
    assert.strictEqual(router.dispatch(req, res, pathname, new URL('http://127.0.0.1:5150' + pathname)), true)
    assert.notStrictEqual(res.statusCode, 403)
  }

  const writeRes = await dispatchJson('POST', '/dashboard/api/resource/maintenance', { enabled: true }, headers)
  assert.strictEqual(writeRes.statusCode, 403)
  assert.strictEqual(parseJsonResponse(writeRes).code, 'ADMIN_REQUIRED')

  const modeWriteRes = await dispatchJson('POST', '/dashboard/api/resource/mode', { serverMode: 'small' }, headers)
  assert.strictEqual(modeWriteRes.statusCode, 403)
  assert.strictEqual(parseJsonResponse(modeWriteRes).code, 'ADMIN_REQUIRED')
}

// Verifies resource mode updates require admin and round-trip through mode + status endpoints.
async function testResourceModeRoundTripRequiresAdminAndUpdatesStatus() {
  resetDataDir()
  const headers = { authorization: 'Bearer ' + auth.createToken() }
  const rejected = await dispatchJson('POST', '/dashboard/api/resource/mode', { serverMode: 'small' }, headers)
  assert.strictEqual(rejected.statusCode, 403)
  assert.strictEqual(parseJsonResponse(rejected).code, 'ADMIN_REQUIRED')

  const writeRes = await dispatchJson('POST', '/dashboard/api/resource/mode', { serverMode: 'small' }, adminHeaders())
  assert.strictEqual(writeRes.statusCode, 200)
  const writeBody = parseJsonResponse(writeRes)
  assert.strictEqual(writeBody.ok, true)
  assert.strictEqual(writeBody.serverMode, 'small')

  const modeReq = makeReq('GET', '/dashboard/api/resource/mode', headers)
  const modeRes = makeRes()
  assert.strictEqual(router.dispatch(modeReq, modeRes, '/dashboard/api/resource/mode', new URL('http://127.0.0.1:5150/dashboard/api/resource/mode')), true)
  assert.strictEqual(modeRes.statusCode, 200)
  const modeBody = parseJsonResponse(modeRes)
  assert.strictEqual(modeBody.ok, true)
  assert.strictEqual(modeBody.serverMode, 'small')
  assert.strictEqual(modeBody.serverModeSource, 'resource-control/config.json')

  const statusReq = makeReq('GET', '/dashboard/api/resource/status', headers)
  const statusRes = makeRes()
  assert.strictEqual(router.dispatch(statusReq, statusRes, '/dashboard/api/resource/status', new URL('http://127.0.0.1:5150/dashboard/api/resource/status')), true)
  assert.strictEqual(statusRes.statusCode, 200)
  const statusBody = parseJsonResponse(statusRes)
  assert.strictEqual(statusBody.ok, true)
  assert.strictEqual(statusBody.serverMode, 'small')
  assert.strictEqual(statusBody.serverModeSource, 'resource-control/config.json')
}

// Verifies custom providers are validated before being persisted.
async function testCustomProviderValidationRejectsUnsafeInput() {
  resetDataDir()
  const headers = adminHeaders()
  const invalidKey = await dispatchJson('PUT', '/dashboard/api/providers/custom', [{
    id: 'openai-official',
    name: 'OpenAI',
    baseURL: 'https://api.openai.com/v1',
    keyFile: '../secret-key.txt',
    models: [{ id: 'gpt-4o', vision: true }],
  }], headers)
  assert.strictEqual(invalidKey.statusCode, 400)

  const invalidUrl = await dispatchJson('PUT', '/dashboard/api/providers/custom', [{
    id: 'openai-official',
    name: 'OpenAI',
    baseURL: 'file:///etc/passwd',
    keyFile: 'ai-openai-official-key.txt',
    models: [{ id: 'gpt-4o', vision: true }],
  }], headers)
  assert.strictEqual(invalidUrl.statusCode, 400)
}

// Verifies API keys include custom provider key files after saving provider metadata.
async function testKeysIncludeCustomProviders() {
  resetDataDir()
  const headers = adminHeaders()
  const saveProvider = await dispatchJson('PUT', '/dashboard/api/providers/custom', [{
    id: 'openai-official',
    name: 'OpenAI 官方',
    baseURL: 'https://api.openai.com/v1',
    keyFile: 'ai-openai-official-key.txt',
    models: [{ id: 'gpt-4o', name: 'GPT-4o', vision: true }],
  }], headers)
  assert.strictEqual(saveProvider.statusCode, 200)

  const saveKey = await dispatchJson('PUT', '/dashboard/api/keys', { file: 'ai-openai-official-key.txt', value: 'sk-test-openai' }, headers)
  assert.strictEqual(saveKey.statusCode, 200)

  const req = makeReq('GET', '/dashboard/api/keys', headers)
  const res = makeRes()
  assert.strictEqual(router.dispatch(req, res, '/dashboard/api/keys', new URL('http://127.0.0.1/dashboard/api/keys')), true)
  assert.strictEqual(res.statusCode, 200)
  const keys = parseJsonResponse(res)
  const custom = keys.find(item => item.providerId === 'openai-official')
  assert.ok(custom)
  assert.strictEqual(custom.source, 'custom')
  assert.strictEqual(custom.file, 'ai-openai-official-key.txt')
  assert.strictEqual(custom.exists, true)
  assert.strictEqual(custom.prefix, 'sk-test-****')
}

// Runs all tests sequentially so rate-limit state remains deterministic.
async function run() {
  testRegexRouteObjectDispatch()
  testAdminVerifyRequiresAccessToken()
  testLegacyPasswordHashTokenRejected()
  testTokenRotationInvalidatesToken()
  await testResetPasswordAcceptsValidResetToken()
  await testLegacyAccessLoginUpgradesAndRemovesPlaintext()
  await testAdminVerifyRateLimit()
  testInitialCredentialsGenerated()
  testSessionSecretIgnoresEnvPinning()
  testLocalBypassRejectsCrossSite()
  testContentSecurityPolicyAllowsPreviewAudio()
  testResourceDiskUsageShape()
  testResourceMemoryHistoryRequiresAccessOnly()
  testResourceMemoryHistoryIncludesUsedMemory()
  testResourceStatusIncludesServerModeFlags()
  await testResourceReadApisRequireAccessOnly()
  await testResourceModeRoundTripRequiresAdminAndUpdatesStatus()
  await testCustomProviderValidationRejectsUnsafeInput()
  await testKeysIncludeCustomProviders()

  fs.rmSync(process.env.DONGXUELIAN_AI_DATA_DIR, { recursive: true, force: true })
  console.log('dashboard security/router tests passed')
}

run().catch((error) => {
  try { fs.rmSync(process.env.DONGXUELIAN_AI_DATA_DIR, { recursive: true, force: true }) } catch {}
  console.error(error)
  process.exit(1)
})
