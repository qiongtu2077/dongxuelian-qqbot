'use strict'
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { json, log, getRemoteAddress, isLoopbackAddress } = require('./utils')
const { ADMIN_PWD_FILE, ACCESS_PWD_FILE, LEGACY_ACCESS_PWD_FILE, RESET_TOKEN_FILE, PASSWORD, ADMIN_PASSWORD, isGlobalLocalMode } = require('./paths')

const TOKEN_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000
const LOGIN_FAIL_WINDOW_MS = 5 * 60 * 1000
const LOGIN_FAIL_THRESHOLD = 10
const LOGIN_LOCKOUT_MS = 15 * 60 * 1000
const loginFailMap = new Map()

function readFileContent(p) {
  try {
    const stat = fs.statSync(p)
    if (stat.isFile() && stat.size <= 64 * 1024) return fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '').trim()
  } catch {}
  return ''
}

function safeCompare(a, b) {
  const bufA = Buffer.from(String(a || ''))
  const bufB = Buffer.from(String(b || ''))
  if (bufA.length !== bufB.length) return crypto.timingSafeEqual(Buffer.alloc(32), Buffer.alloc(32)) && false
  return crypto.timingSafeEqual(bufA, bufB)
}

function getAdminPassword() {
  return readFileContent(ADMIN_PWD_FILE) || ADMIN_PASSWORD
}

function getAccessPassword() {
  return readFileContent(ACCESS_PWD_FILE) || readFileContent(LEGACY_ACCESS_PWD_FILE) || PASSWORD
}

function createToken() {
  const ts = Date.now().toString(36)
  const hmac = crypto.createHmac('sha256', 'dashboard:' + getAccessPassword()).update(ts).digest('hex')
  return ts + '.' + hmac
}

function validateToken(token) {
  const parts = String(token || '').split('.')
  if (parts.length !== 2) return safeCompare(token, crypto.createHash('sha256').update('dashboard:' + getAccessPassword()).digest('hex'))
  const [ts, hmac] = parts
  const timestamp = parseInt(ts, 36)
  if (!Number.isFinite(timestamp) || Date.now() - timestamp > TOKEN_EXPIRY_MS) return false
  const expected = crypto.createHmac('sha256', 'dashboard:' + getAccessPassword()).update(ts).digest('hex')
  return safeCompare(hmac, expected)
}

function createAdminToken() {
  const ts = Date.now().toString(36)
  const hmac = crypto.createHmac('sha256', 'admin:' + getAdminPassword()).update(ts).digest('hex')
  return ts + '.' + hmac
}

function validateAdminToken(token) {
  const parts = String(token || '').split('.')
  if (parts.length !== 2) return safeCompare(token, crypto.createHash('sha256').update('admin:' + getAdminPassword()).digest('hex'))
  const [ts, hmac] = parts
  const timestamp = parseInt(ts, 36)
  if (!Number.isFinite(timestamp) || Date.now() - timestamp > TOKEN_EXPIRY_MS) return false
  const expected = crypto.createHmac('sha256', 'admin:' + getAdminPassword()).update(ts).digest('hex')
  return safeCompare(hmac, expected)
}

function generateResetToken() {
  const token = crypto.randomBytes(16).toString('hex')
  try {
    fs.mkdirSync(path.dirname(RESET_TOKEN_FILE), { recursive: true })
    fs.writeFileSync(RESET_TOKEN_FILE, token, 'utf8')
  } catch (e) { log('WARNING: 无法写入重置令牌文件: ' + e.message) }
  return token
}

function getResetToken() {
  return readFileContent(RESET_TOKEN_FILE) || ''
}

function shouldGenerateResetTokenOnStartup() {
  return !isGlobalLocalMode()
}

function isLocalAuthBypass(req) {
  if (!req) return false
  if (!isGlobalLocalMode()) return false
  return isLoopbackAddress(getRemoteAddress(req))
}

function requireAdmin(req, res) {
  if (isLocalAuthBypass(req)) return true
  const token = (req.headers['x-admin-token'] || '').trim()
  if (!token || !validateAdminToken(token)) {
    json(res, { ok: false, message: '需要管理员密码验证', code: 'ADMIN_REQUIRED' }, 403)
    return false
  }
  return true
}

function requireStrictAdmin(req, res) {
  if (isLocalAuthBypass(req)) return true
  const token = (req.headers['x-admin-token'] || '').trim()
  if (!token || !validateAdminToken(token)) {
    json(res, { ok: false, message: '需要管理员密码验证', code: 'ADMIN_REQUIRED' }, 403)
    return false
  }
  return true
}

function isLoginRateLimited(ip) {
  const entry = loginFailMap.get(ip)
  if (!entry) return false
  if (entry.lockedUntil && Date.now() < entry.lockedUntil) return true
  if (Date.now() - entry.firstFail > LOGIN_FAIL_WINDOW_MS) {
    loginFailMap.delete(ip)
    return false
  }
  return entry.count >= LOGIN_FAIL_THRESHOLD
}

function recordLoginFailure(ip) {
  const now = Date.now()
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
}

module.exports = {
  TOKEN_EXPIRY_MS,
  safeCompare,
  getAdminPassword,
  getAccessPassword,
  createToken,
  validateToken,
  createAdminToken,
  validateAdminToken,
  generateResetToken,
  getResetToken,
  shouldGenerateResetTokenOnStartup,
  isLocalAuthBypass,
  requireAdmin,
  requireStrictAdmin,
  isLoginRateLimited,
  recordLoginFailure,
}
