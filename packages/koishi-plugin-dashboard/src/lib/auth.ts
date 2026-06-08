'use strict'
const fs = require('fs') as typeof import('fs')
const path = require('path') as typeof import('path')
const crypto = require('crypto') as typeof import('crypto')
import type { IncomingMessage, ServerResponse } from 'http'
const bcrypt = require('bcryptjs') as BcryptLike
const { json, log, getRemoteAddress, isLoopbackAddress } = require('./utils')
const { ADMIN_PWD_FILE, ACCESS_PWD_FILE, LEGACY_ACCESS_PWD_FILE, RESET_TOKEN_FILE, SESSION_SECRET_FILE, PASSWORD, ADMIN_PASSWORD, isGlobalLocalMode } = require('./paths')

interface EnsurePasswordOptions {
  force?: boolean
}

interface BcryptLike {
  hash(plain: string, rounds: number): Promise<string>
  hashSync(plain: string, rounds: number): string
  compare(input: string, stored: string): Promise<boolean>
}

interface DashboardGlobalWithTimer {
  __dongxuelianDashboardLoginFailCleanupTimer?: NodeJS.Timeout
}

interface AccessPasswordRecord {
  value: string
  sourceFile: string
  legacy: boolean
}

interface LoginFailEntry {
  count: number
  firstFail: number
  lockedUntil: number
}

interface MaybeEncryptedSocket {
  encrypted?: boolean
}

type TokenScope = 'dashboard' | 'admin'

const BCRYPT_ROUNDS = 12

const TOKEN_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000
const LOGIN_FAIL_WINDOW_MS = 5 * 60 * 1000
const LOGIN_FAIL_THRESHOLD = 10
const LOGIN_LOCKOUT_MS = 15 * 60 * 1000
const LOGIN_FAIL_MAX_ENTRIES = 1000
const LOGIN_FAIL_CLEANUP_MS = 60 * 1000
const loginFailMap = new Map<string, LoginFailEntry>()
const dashboardGlobal = globalThis as typeof globalThis & DashboardGlobalWithTimer
if (!dashboardGlobal.__dongxuelianDashboardLoginFailCleanupTimer) {
  dashboardGlobal.__dongxuelianDashboardLoginFailCleanupTimer = setInterval(() => trimLoginFailMap(), LOGIN_FAIL_CLEANUP_MS)
  if (dashboardGlobal.__dongxuelianDashboardLoginFailCleanupTimer.unref) dashboardGlobal.__dongxuelianDashboardLoginFailCleanupTimer.unref()
}

function getErrorMessage(error: unknown): string {
  if (error && typeof error === 'object' && 'message' in error) return String((error as { message?: unknown }).message || '')
  return String(error || '')
}

// Reads small secret/config files without throwing.
function readFileContent(p: string): string {
  try {
    const stat = fs.statSync(p)
    if (stat.isFile() && stat.size <= 64 * 1024) return fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '').trim()
  } catch { /* non-critical: missing secret file fallback */ }
  return ''
}

// Writes a secret file and creates its parent directory first.
function writeSecretFile(p: string, value: unknown): void {
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, String(value || '').trim(), 'utf8')
}

// Generates a URL-safe random secret for passwords and token signing.
function randomSecret(bytes = 24): string {
  return crypto.randomBytes(bytes).toString('base64url')
}

// Compares secrets without leaking timing differences for equal lengths.
function safeCompare(a: unknown, b: unknown): boolean {
  const bufA = Buffer.from(String(a || ''))
  const bufB = Buffer.from(String(b || ''))
  if (bufA.length !== bufB.length) return crypto.timingSafeEqual(Buffer.alloc(32), Buffer.alloc(32)) && false
  return crypto.timingSafeEqual(bufA, bufB)
}

function isBcryptHash(s: unknown): boolean {
  return /^\$2[aby]\$\d{2}\$.{53}$/.test(String(s || ''))
}

async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, BCRYPT_ROUNDS)
}

// Verifies input against stored (bcrypt hash or legacy plaintext).
// On legacy match, auto-upgrades the file to bcrypt hash.
async function verifyPassword(input: string, stored: string, upgradeFile?: string): Promise<boolean> {
  if (!input || !stored) return false
  if (isBcryptHash(stored)) {
    return bcrypt.compare(input, stored)
  }
  if (!safeCompare(input, stored)) return false
  if (upgradeFile) {
    try {
      const hash = await hashPassword(input)
      writeSecretFile(upgradeFile, hash)
      log(`auto-upgraded password to bcrypt: ${path.basename(upgradeFile)}`)
    } catch (e) {
      log(`WARNING: failed to auto-upgrade password: ${getErrorMessage(e)}`)
    }
  }
  return true
}

function getAccessPasswordRecord(): AccessPasswordRecord {
  const current = readFileContent(ACCESS_PWD_FILE)
  if (current) return { value: current, sourceFile: ACCESS_PWD_FILE, legacy: false }
  const legacy = readFileContent(LEGACY_ACCESS_PWD_FILE)
  if (legacy) return { value: legacy, sourceFile: LEGACY_ACCESS_PWD_FILE, legacy: true }
  return { value: ensurePassword(ACCESS_PWD_FILE, PASSWORD, 'access'), sourceFile: ACCESS_PWD_FILE, legacy: false }
}

async function removeLegacyAccessPasswordAfterUpgrade(record: AccessPasswordRecord, input: string): Promise<boolean> {
  if (!record || !record.legacy || record.sourceFile !== LEGACY_ACCESS_PWD_FILE) return false
  const upgraded = readFileContent(ACCESS_PWD_FILE)
  if (!isBcryptHash(upgraded)) return false
  let upgradedMatches = false
  try {
    upgradedMatches = await bcrypt.compare(input, upgraded)
  } catch (e) {
    log(`WARNING: failed to verify upgraded access password before legacy cleanup: ${getErrorMessage(e)}`)
    return false
  }
  if (!upgradedMatches) return false
  const legacy = readFileContent(LEGACY_ACCESS_PWD_FILE)
  if (!legacy || !safeCompare(legacy, record.value)) return false
  try {
    fs.unlinkSync(LEGACY_ACCESS_PWD_FILE)
    log(`removed legacy plaintext access password file: ${path.basename(LEGACY_ACCESS_PWD_FILE)}`)
    return true
  } catch (e) {
    log(`WARNING: failed to remove legacy access password file: ${getErrorMessage(e)}`)
    return false
  }
}

// Ensures first-run remote deployments do not fall back to a public default.
function ensurePassword(file: string, envValue: string, label: string, options: EnsurePasswordOptions = {}): string {
  const stored = readFileContent(file)
  if (stored && !options.force) return stored
  if (envValue && !options.force) {
    if (!isBcryptHash(envValue)) {
      const hash = bcrypt.hashSync(envValue, BCRYPT_ROUNDS)
      writeSecretFile(file, hash)
      log(`stored ${label} password as bcrypt hash: ${file}`)
      return hash
    }
    return envValue
  }
  if (isGlobalLocalMode() && !options.force) return ''
  const generated = randomSecret(18)
  const hash = bcrypt.hashSync(generated, BCRYPT_ROUNDS)
  writeSecretFile(file, hash)
  log(`generated ${label} password (plaintext shown once): ${generated}`)
  log(`${label} password hash stored in: ${file}`)
  return hash
}

// Returns the admin password, generating a first-run file when needed.
function getAdminPassword(): string {
  return ensurePassword(ADMIN_PWD_FILE, ADMIN_PASSWORD, 'admin')
}

// Returns the access password while preserving the legacy password file.
function getAccessPassword(): string {
  return getAccessPasswordRecord().value
}

// Ensures both dashboard password files exist for non-local first startup.
function ensureInitialCredentials(): void {
  getAccessPassword()
  getAdminPassword()
  getSessionSecret()
}

// Resets access/admin passwords to new random values and invalidates tokens.
function resetDashboardCredentials(): void {
  ensurePassword(ACCESS_PWD_FILE, '', 'access', { force: true })
  ensurePassword(ADMIN_PWD_FILE, '', 'admin', { force: true })
  rotateSessionSecret()
}

// Reads or creates the persistent token signing secret.
function getSessionSecret(): string {
  const stored = readFileContent(SESSION_SECRET_FILE)
  if (stored) return stored
  const generated = randomSecret(32)
  writeSecretFile(SESSION_SECRET_FILE, generated)
  return generated
}

// Replaces the persistent token signing secret to expire existing tokens.
function rotateSessionSecret(): string {
  const generated = randomSecret(32)
  writeSecretFile(SESSION_SECRET_FILE, generated)
  return generated
}

// Creates a short structured HMAC token for a token scope.
function createScopedToken(scope: TokenScope): string {
  const ts = Date.now().toString(36)
  const hmac = crypto.createHmac('sha256', `${scope}:${getSessionSecret()}`).update(ts).digest('hex')
  return ts + '.' + hmac
}

// Validates a structured HMAC token for a token scope.
function validateScopedToken(scope: TokenScope, token: unknown): boolean {
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
function createToken(): string {
  return createScopedToken('dashboard')
}

// Validates an access token for normal dashboard API requests.
function validateToken(token: unknown): boolean {
  return validateScopedToken('dashboard', token)
}

// Creates an admin token for privileged dashboard actions.
function createAdminToken(): string {
  return createScopedToken('admin')
}

// Validates an admin token for privileged dashboard actions.
function validateAdminToken(token: unknown): boolean {
  return validateScopedToken('admin', token)
}

// Generates a filesystem reset token for password recovery.
function generateResetToken(): string {
  const token = crypto.randomBytes(16).toString('hex')
  try {
    fs.mkdirSync(path.dirname(RESET_TOKEN_FILE), { recursive: true })
    fs.writeFileSync(RESET_TOKEN_FILE, token, 'utf8')
  } catch (e) { log('WARNING: 无法写入重置令牌文件: ' + getErrorMessage(e)) }
  return token
}

// Reads the filesystem reset token.
function getResetToken(): string {
  return readFileContent(RESET_TOKEN_FILE) || ''
}

// Reports whether startup should create a reset token file.
function shouldGenerateResetTokenOnStartup(): boolean {
  return !isGlobalLocalMode()
}

// Compares the request Origin to the current HTTP Host.
function isSameOriginRequest(req: IncomingMessage): boolean {
  const origin = String(req?.headers?.origin || '').trim()
  if (!origin) return true
  const host = String(req?.headers?.host || '').trim().toLowerCase()
  if (!host) return false
  try {
    const parsed = new URL(origin)
    const socket = req.socket as MaybeEncryptedSocket
    const connection = req.connection as MaybeEncryptedSocket
    const protocol = socket?.encrypted || connection?.encrypted ? 'https:' : 'http:'
    return parsed.protocol === protocol && parsed.host.toLowerCase() === host
  } catch {
    return false
  }
}

// Detects browser cross-site requests that should not reach local bypass APIs.
function isRequestSiteTrusted(req: IncomingMessage): boolean {
  const fetchSite = String(req?.headers?.['sec-fetch-site'] || '').trim().toLowerCase()
  if (fetchSite === 'cross-site') return false
  return isSameOriginRequest(req)
}

// Applies CORS only for same-origin requests that include an Origin header.
function applyCorsHeaders(req: IncomingMessage, res: ServerResponse): void {
  const origin = String(req?.headers?.origin || '').trim()
  if (origin && isSameOriginRequest(req)) {
    res.setHeader('Access-Control-Allow-Origin', origin)
    res.setHeader('Vary', 'Origin')
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, PUT, POST, DELETE, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Admin-Token')
}

// Rejects browser cross-site requests before auth bypass or side effects.
function rejectCrossSiteRequest(req: IncomingMessage, res: ServerResponse): boolean {
  if (isRequestSiteTrusted(req)) return false
  json(res, { ok: false, message: 'cross-site dashboard requests are not allowed', code: 'CROSS_SITE_FORBIDDEN' }, 403)
  return true
}

// Allows local deployer auth bypass only for trusted loopback requests.
function isLocalAuthBypass(req: IncomingMessage | null | undefined): boolean {
  if (!req) return false
  if (!isGlobalLocalMode()) return false
  return isLoopbackAddress(getRemoteAddress(req)) && isRequestSiteTrusted(req)
}

// Requires a valid admin token unless local trusted bypass is active.
function requireAdmin(req: IncomingMessage, res: ServerResponse): boolean {
  if (isLocalAuthBypass(req)) return true
  const token = (req.headers['x-admin-token'] as string || '').trim()
  if (!token || !validateAdminToken(token)) {
    json(res, { ok: false, message: '需要管理员密码验证', code: 'ADMIN_REQUIRED' }, 403)
    return false
  }
  return true
}

// Requires a valid admin token for destructive admin-only operations.
function requireStrictAdmin(req: IncomingMessage, res: ServerResponse): boolean {
  if (isLocalAuthBypass(req)) return true
  const token = (req.headers['x-admin-token'] as string || '').trim()
  if (!token || !validateAdminToken(token)) {
    json(res, { ok: false, message: '需要管理员密码验证', code: 'ADMIN_REQUIRED' }, 403)
    return false
  }
  return true
}

// Checks whether an IP is currently login/admin locked out.
function isLoginRateLimited(ip: string): boolean {
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
function recordLoginFailure(ip: string): void {
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
function clearLoginFails(ip: string): void {
  loginFailMap.delete(ip)
}

function trimLoginFailMap(now = Date.now()): void {
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

export = {
  TOKEN_EXPIRY_MS,
  safeCompare,
  hashPassword,
  verifyPassword,
  isBcryptHash,
  getAdminPassword,
  getAccessPasswordRecord,
  removeLegacyAccessPasswordAfterUpgrade,
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
