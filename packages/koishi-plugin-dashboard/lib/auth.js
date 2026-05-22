'use strict'
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { json, log, getRemoteAddress, isLoopbackAddress } = require('./utils')
const { ADMIN_PWD_FILE, ACCESS_PWD_FILE, LEGACY_ACCESS_PWD_FILE, RESET_TOKEN_FILE, SESSION_SECRET_FILE, PASSWORD, ADMIN_PASSWORD, isGlobalLocalMode } = require('./paths')

const TOKEN_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000
const LOGIN_FAIL_WINDOW_MS = 5 * 60 * 1000
const LOGIN_FAIL_THRESHOLD = 10
const LOGIN_LOCKOUT_MS = 15 * 60 * 1000
const LOGIN_FAIL_MAX_ENTRIES = 1000
const LOGIN_FAIL_CLEANUP_MS = 60 * 1000
const loginFailMap = new Map()
if (!globalThis.__dongxuelianDashboardLoginFailCleanupTimer) {
  globalThis.__dongxuelianDashboardLoginFailCleanupTimer = setInterval(() => trimLoginFailMap(), LOGIN_FAIL_CLEANUP_MS)
  if (globalThis.__dongxuelianDashboardLoginFailCleanupTimer.unref) globalThis.__dongxuelianDashboardLoginFailCleanupTimer.unref()
}

// Reads small secret/config files without throwing.
function readFileContent(p) {
  try {
    const stat = fs.statSync(p)
    if (stat.isFile() && stat.size <= 64 * 1024) return fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '').trim()
  } catch {}
  return ''
}

// Writes a secret file and creates its parent directory first.
function writeSecretFile(p, value) {
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, String(value || '').trim(), 'utf8')
}

// Generates a URL-safe random secret for passwords and token signing.
function randomSecret(bytes = 24) {
  return crypto.randomBytes(bytes).toString('base64url')
}

// Compares secrets without leaking timing differences for equal lengths.
function safeCompare(a, b) {
  const bufA = Buffer.from(String(a || ''))
  const bufB = Buffer.from(String(b || ''))
  if (bufA.length !== bufB.length) return crypto.timingSafeEqual(Buffer.alloc(32), Buffer.alloc(32)) && false
  return crypto.timingSafeEqual(bufA, bufB)
}

// Ensures first-run remote deployments do not fall back to a public default.
function ensurePassword(file, envValue, label, options = {}) {
  const stored = readFileContent(file)
  if (stored && !options.force) return stored
  if (envValue && !options.force) return envValue
  if (isGlobalLocalMode() && !options.force) return ''
  const generated = randomSecret(18)
  writeSecretFile(file, generated)
  log(`generated ${label} password file: ${file}`)
  return generated
}

// Returns the admin password, generating a first-run file when needed.
function getAdminPassword() {
  return ensurePassword(ADMIN_PWD_FILE, ADMIN_PASSWORD, 'admin')
}

// Returns the access password while preserving the legacy password file.
function getAccessPassword() {
  const stored = readFileContent(ACCESS_PWD_FILE) || readFileContent(LEGACY_ACCESS_PWD_FILE)
  if (stored) return stored
  return ensurePassword(ACCESS_PWD_FILE, PASSWORD, 'access')
}

// Ensures both dashboard password files exist for non-local first startup.
function ensureInitialCredentials() {
  getAccessPassword()
  getAdminPassword()
  getSessionSecret()
}

// Resets access/admin passwords to new random values and invalidates tokens.
function resetDashboardCredentials() {
  ensurePassword(ACCESS_PWD_FILE, '', 'access', { force: true })
  ensurePassword(ADMIN_PWD_FILE, '', 'admin', { force: true })
  rotateSessionSecret()
}

// Reads or creates the persistent token signing secret.
function getSessionSecret() {
  const stored = readFileContent(SESSION_SECRET_FILE)
  if (stored) return stored
  const generated = randomSecret(32)
  writeSecretFile(SESSION_SECRET_FILE, generated)
  return generated
}

// Replaces the persistent token signing secret to expire existing tokens.
function rotateSessionSecret() {
  const generated = randomSecret(32)
  writeSecretFile(SESSION_SECRET_FILE, generated)
  return generated
}

// Creates a short structured HMAC token for a token scope.
function createScopedToken(scope) {
  const ts = Date.now().toString(36)
  const hmac = crypto.createHmac('sha256', `${scope}:${getSessionSecret()}`).update(ts).digest('hex')
  return ts + '.' + hmac
}

// Validates a structured HMAC token for a token scope.
function validateScopedToken(scope, token) {
  const parts = String(token || '').split('.')
  if (parts.length !== 2) return false
  const [ts, hmac] = parts
  const timestamp = parseInt(ts, 36)
  const now = Date.now()
  if (!Number.isFinite(timestamp) || timestamp > now + 60 * 1000 || now - timestamp > TOKEN_EXPIRY_MS) return false
  const expected = crypto.createHmac('sha256', `${scope}:${getSessionSecret()}`).update(ts).digest('hex')
  return safeCompare(hmac, expected)
}

// Creates an access token for normal dashboard API requests.
function createToken() {
  return createScopedToken('dashboard')
}

// Validates an access token for normal dashboard API requests.
function validateToken(token) {
  return validateScopedToken('dashboard', token)
}

// Creates an admin token for privileged dashboard actions.
function createAdminToken() {
  return createScopedToken('admin')
}

// Validates an admin token for privileged dashboard actions.
function validateAdminToken(token) {
  return validateScopedToken('admin', token)
}

// Generates a filesystem reset token for password recovery.
function generateResetToken() {
  const token = crypto.randomBytes(16).toString('hex')
  try {
    fs.mkdirSync(path.dirname(RESET_TOKEN_FILE), { recursive: true })
    fs.writeFileSync(RESET_TOKEN_FILE, token, 'utf8')
  } catch (e) { log('WARNING: 无法写入重置令牌文件: ' + e.message) }
  return token
}

// Reads the filesystem reset token.
function getResetToken() {
  return readFileContent(RESET_TOKEN_FILE) || ''
}

// Reports whether startup should create a reset token file.
function shouldGenerateResetTokenOnStartup() {
  return !isGlobalLocalMode()
}

// Compares the request Origin to the current HTTP Host.
function isSameOriginRequest(req) {
  const origin = String(req?.headers?.origin || '').trim()
  if (!origin) return true
  const host = String(req?.headers?.host || '').trim().toLowerCase()
  if (!host) return false
  try {
    const parsed = new URL(origin)
    const protocol = req?.socket?.encrypted || req?.connection?.encrypted ? 'https:' : 'http:'
    return parsed.protocol === protocol && parsed.host.toLowerCase() === host
  } catch {
    return false
  }
}

// Detects browser cross-site requests that should not reach local bypass APIs.
function isRequestSiteTrusted(req) {
  const fetchSite = String(req?.headers?.['sec-fetch-site'] || '').trim().toLowerCase()
  if (fetchSite === 'cross-site') return false
  return isSameOriginRequest(req)
}

// Applies CORS only for same-origin requests that include an Origin header.
function applyCorsHeaders(req, res) {
  const origin = String(req?.headers?.origin || '').trim()
  if (origin && isSameOriginRequest(req)) {
    res.setHeader('Access-Control-Allow-Origin', origin)
    res.setHeader('Vary', 'Origin')
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, PUT, POST, DELETE, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Admin-Token')
}

// Rejects browser cross-site requests before auth bypass or side effects.
function rejectCrossSiteRequest(req, res) {
  if (isRequestSiteTrusted(req)) return false
  json(res, { ok: false, message: 'cross-site dashboard requests are not allowed', code: 'CROSS_SITE_FORBIDDEN' }, 403)
  return true
}

// Allows local deployer auth bypass only for trusted loopback requests.
function isLocalAuthBypass(req) {
  if (!req) return false
  if (!isGlobalLocalMode()) return false
  return isLoopbackAddress(getRemoteAddress(req)) && isRequestSiteTrusted(req)
}

// Requires a valid admin token unless local trusted bypass is active.
function requireAdmin(req, res) {
  if (isLocalAuthBypass(req)) return true
  const token = (req.headers['x-admin-token'] || '').trim()
  if (!token || !validateAdminToken(token)) {
    json(res, { ok: false, message: '需要管理员密码验证', code: 'ADMIN_REQUIRED' }, 403)
    return false
  }
  return true
}

// Requires a valid admin token for destructive admin-only operations.
function requireStrictAdmin(req, res) {
  if (isLocalAuthBypass(req)) return true
  const token = (req.headers['x-admin-token'] || '').trim()
  if (!token || !validateAdminToken(token)) {
    json(res, { ok: false, message: '需要管理员密码验证', code: 'ADMIN_REQUIRED' }, 403)
    return false
  }
  return true
}

// Checks whether an IP is currently login/admin locked out.
function isLoginRateLimited(ip) {
  trimLoginFailMap()
  const entry = loginFailMap.get(ip)
  if (!entry) return false
  if (entry.lockedUntil && Date.now() < entry.lockedUntil) return true
  if (Date.now() - entry.firstFail > LOGIN_FAIL_WINDOW_MS) {
    loginFailMap.delete(ip)
    return false
  }
  return entry.count >= LOGIN_FAIL_THRESHOLD
}

// Records a failed login/admin attempt for rate limiting.
function recordLoginFailure(ip) {
  const now = Date.now()
  trimLoginFailMap(now)
  const entry = loginFailMap.get(ip) || { count: 0, firstFail: now, lockedUntil: 0 }
  if (now - entry.firstFail > LOGIN_FAIL_WINDOW_MS) {
    entry.count = 1
    entry.firstFail = now
  } else {
    entry.count++
  }
  if (entry.count >= LOGIN_FAIL_THRESHOLD) {
    entry.lockedUntil = now + LOGIN_LOCKOUT_MS
    log(`login rate limit: IP ${ip} locked for ${LOGIN_LOCKOUT_MS / 1000}s after ${entry.count} failures`)
  }
  loginFailMap.set(ip, entry)
  trimLoginFailMap(now)
}

// Clears rate-limit state for an IP after successful authentication.
function clearLoginFails(ip) {
  loginFailMap.delete(ip)
}

function trimLoginFailMap(now = Date.now()) {
  for (const [ip, entry] of loginFailMap) {
    const firstFail = Number(entry?.firstFail || 0)
    const lockedUntil = Number(entry?.lockedUntil || 0)
    if ((lockedUntil && now > lockedUntil + LOGIN_FAIL_WINDOW_MS) || (!lockedUntil && now - firstFail > LOGIN_FAIL_WINDOW_MS)) {
      loginFailMap.delete(ip)
    }
  }
  if (loginFailMap.size <= LOGIN_FAIL_MAX_ENTRIES) return
  const ordered = Array.from(loginFailMap.entries()).sort((a, b) => Number(a[1]?.firstFail || 0) - Number(b[1]?.firstFail || 0))
  for (const [ip] of ordered.slice(0, Math.max(0, loginFailMap.size - LOGIN_FAIL_MAX_ENTRIES))) loginFailMap.delete(ip)
}

module.exports = {
  TOKEN_EXPIRY_MS,
  safeCompare,
  getAdminPassword,
  getAccessPassword,
  ensureInitialCredentials,
  resetDashboardCredentials,
  getSessionSecret,
  rotateSessionSecret,
  createToken,
  validateToken,
  createAdminToken,
  validateAdminToken,
  generateResetToken,
  getResetToken,
  shouldGenerateResetTokenOnStartup,
  isSameOriginRequest,
  isRequestSiteTrusted,
  applyCorsHeaders,
  rejectCrossSiteRequest,
  isLocalAuthBypass,
  requireAdmin,
  requireStrictAdmin,
  isLoginRateLimited,
  recordLoginFailure,
  clearLoginFails,
  trimLoginFailMap,
  loginFailMap,
}
