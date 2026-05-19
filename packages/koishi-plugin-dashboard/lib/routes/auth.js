'use strict'

const fs = require('fs')
const { json, log, collectBody, getRemoteAddress, writeFileSyncSafe } = require('../utils')
const {
  isLocalAuthBypass, isLoginRateLimited, recordLoginFailure, clearLoginFails,
  getAccessPassword, getAdminPassword, createToken, createAdminToken,
  validateToken, requireAdmin, getResetToken, generateResetToken,
} = require('../auth')
const { ADMIN_PWD_FILE, ACCESS_PWD_FILE, LEGACY_ACCESS_PWD_FILE } = require('../paths')

function handleLogin(req, res) {
  const loginIp = getRemoteAddress(req)
  if (!isLocalAuthBypass(req) && isLoginRateLimited(loginIp)) {
    return json(res, { ok: false, message: '登录尝试次数过多，请稍后再试' }, 429)
  }
  collectBody(req, res, (body) => {
    try {
      const { password } = JSON.parse(body)
      const stored = getAccessPassword()
      if (!stored && !isLocalAuthBypass(req)) {
        log('login rejected: access password is not configured')
        return json(res, { ok: false, message: '访问密码未配置' }, 503)
      }
      const match = isLocalAuthBypass(req) || (!!stored && password === stored)
      if (match) {
        clearLoginFails(loginIp)
        return json(res, { ok: true, token: createToken() })
      }
      recordLoginFailure(loginIp)
      log('login failed')
      return json(res, { ok: false, message: '密码错误' }, 401)
    } catch { return json(res, { ok: false, message: '无效请求' }, 400) }
  })
}

function handleAdminVerify(req, res) {
  if (isLocalAuthBypass(req)) return json(res, { ok: true, token: createAdminToken(), accessToken: createToken() })
  collectBody(req, res, (body) => {
    try {
      const { password } = JSON.parse(body)
      if (password === getAdminPassword()) return json(res, { ok: true, token: createAdminToken(), accessToken: createToken() })
      return json(res, { ok: false, message: '管理员密码错误' }, 401)
    } catch { return json(res, { ok: false, message: '无效请求' }, 400) }
  })
}

function handleChangePassword(req, res) {
  if (isLocalAuthBypass(req)) {
    return json(res, { ok: false, message: '本地部署器不包含密码登录，此项已关闭', code: 'AUTH_DISABLED_LOCAL' }, 400)
  }
  if (!requireAdmin(req, res)) return
  collectBody(req, res, (body) => {
    try {
      const { type, oldPassword, newPassword } = JSON.parse(body)
      if (!newPassword || newPassword.length < 3) return json(res, { ok: false, message: '新密码长度不能少于3位' }, 400)
      if (!/^[A-Za-z0-9_~!@#$%^&*()\-+=\[\]{}<>,.?/|\\:;"'`]+$/.test(newPassword)) {
        return json(res, { ok: false, message: '密码仅支持大小写字母、数字、下划线和常见特殊字符' }, 400)
      }
      if (type === 'admin') {
        if (oldPassword !== getAdminPassword()) return json(res, { ok: false, message: '当前管理员密码错误' }, 401)
        writeFileSyncSafe(ADMIN_PWD_FILE, newPassword)
        return json(res, { ok: true, message: '管理员密码已更新' })
      } else if (type === 'access') {
        writeFileSyncSafe(ACCESS_PWD_FILE, newPassword)
        return json(res, { ok: true, message: '访问密码已更新，请重新登录' })
      }
      return json(res, { ok: false, message: '无效类型' }, 400)
    } catch { return json(res, { ok: false, message: '无效请求' }, 400) }
  })
}

function handleResetPassword(req, res) {
  if (isLocalAuthBypass(req)) {
    return json(res, { ok: false, message: '本地部署器不包含密码登录，此项已关闭', code: 'AUTH_DISABLED_LOCAL' }, 400)
  }
  collectBody(req, res, (body) => {
    try {
      const { resetToken } = JSON.parse(body)
      const stored = getResetToken()
      if (!stored || !resetToken || resetToken.trim() !== stored.trim()) {
        return json(res, { ok: false, message: '重置令牌无效' }, 403)
      }
      try { fs.unlinkSync(ACCESS_PWD_FILE) } catch {}
      try { fs.unlinkSync(ADMIN_PWD_FILE) } catch {}
      try { fs.unlinkSync(LEGACY_ACCESS_PWD_FILE) } catch {}
      generateResetToken()
      return json(res, { ok: true, message: '所有密码已重置为默认值 123，请登录后在安全设置中修改' })
    } catch { return json(res, { ok: false, message: '无效请求' }, 400) }
  })
}

function authMiddleware(req, res, pathname) {
  const isPublicGalleryImage = pathname.startsWith('/dashboard/api/gallery/image/') && req.method === 'GET'
  if (pathname.startsWith('/dashboard/api/') && !isPublicGalleryImage && !isLocalAuthBypass(req)) {
    const authHeader = req.headers['authorization'] || ''
    const token = authHeader.replace(/^Bearer\s+/i, '')
    if (!validateToken(token)) {
      res.writeHead(401, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: false, message: '请先登录', code: 'AUTH_REQUIRED' }))
      return false
    }
  }
  return true
}

const routes = {
  'POST /dashboard/api/login': handleLogin,
  'POST /dashboard/api/admin/verify': handleAdminVerify,
  'PUT /dashboard/api/auth/password': handleChangePassword,
  'POST /dashboard/api/auth/reset-password': handleResetPassword,
}

module.exports = { routes, authMiddleware }
