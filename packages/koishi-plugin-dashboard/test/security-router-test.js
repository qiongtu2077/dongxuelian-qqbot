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
  fs.writeFileSync(path.join(process.env.DONGXUELIAN_AI_DATA_DIR, 'dashboard-access-pwd.txt'), 'access-pass', 'utf8')
  const forged = crypto.createHash('sha256').update('dashboard:access-pass').digest('hex')
  assert.strictEqual(auth.validateToken(forged), false)
}

// Verifies rotating the session secret invalidates existing tokens.
function testTokenRotationInvalidatesToken() {
  const token = auth.createToken()
  assert.strictEqual(auth.validateToken(token), true)
  auth.rotateSessionSecret()
  assert.strictEqual(auth.validateToken(token), false)
}

// Verifies failed admin password checks are rate limited behind access auth.
async function testAdminVerifyRateLimit() {
  process.env.GLOBAL_LOCAL_MODE = ''
  const dataDir = process.env.DONGXUELIAN_AI_DATA_DIR
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
  fs.rmSync(dataDir, { recursive: true, force: true })
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

// Runs all tests sequentially so rate-limit state remains deterministic.
async function run() {
  testRegexRouteObjectDispatch()
  testAdminVerifyRequiresAccessToken()
  testLegacyPasswordHashTokenRejected()
  testTokenRotationInvalidatesToken()
  await testAdminVerifyRateLimit()
  testInitialCredentialsGenerated()
  testSessionSecretIgnoresEnvPinning()
  testLocalBypassRejectsCrossSite()
  testContentSecurityPolicyAllowsPreviewAudio()

  fs.rmSync(process.env.DONGXUELIAN_AI_DATA_DIR, { recursive: true, force: true })
  console.log('dashboard security/router tests passed')
}

run().catch((error) => {
  try { fs.rmSync(process.env.DONGXUELIAN_AI_DATA_DIR, { recursive: true, force: true }) } catch {}
  console.error(error)
  process.exit(1)
})
