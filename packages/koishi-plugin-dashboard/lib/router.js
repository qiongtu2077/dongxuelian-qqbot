'use strict'

const { authMiddleware } = require('./routes/auth')
const galleryRoutes = require('./routes/gallery')
const authRoutes = require('./routes/auth')
const configRoutes = require('./routes/config')
const agentRoutes = require('./routes/agent')
const settingsRoutes = require('./routes/settings')
const botRoutes = require('./routes/bot')
const deployRoutes = require('./routes/deploy')

const exactRoutes = new Map()
const prefixRoutes = []
const regexRoutes = []

for (const mod of [galleryRoutes, authRoutes, configRoutes, agentRoutes, settingsRoutes, botRoutes, deployRoutes]) {
  if (mod.routes) for (const [key, handler] of Object.entries(mod.routes)) exactRoutes.set(key, handler)
  if (mod.prefixRoutes) {
    if (Array.isArray(mod.prefixRoutes)) {
      for (const item of mod.prefixRoutes) prefixRoutes.push(item)
    } else {
      for (const [prefix, handler] of Object.entries(mod.prefixRoutes)) prefixRoutes.push({ prefix, method: prefix.split(' ')[0], handler })
    }
  }
  if (mod.regexRoutes) for (const item of mod.regexRoutes) regexRoutes.push(item)
}

const preAuthKeys = new Set([
  'POST /dashboard/api/login',
  'POST /dashboard/api/admin/verify',
  'PUT /dashboard/api/auth/password',
  'POST /dashboard/api/auth/reset-password',
])

function dispatch(req, res, pathname, url) {
  const method = req.method
  const key = method + ' ' + pathname

  if (preAuthKeys.has(key)) {
    const handler = exactRoutes.get(key)
    if (handler) { handler(req, res, pathname, url); return true }
  }

  if (!authMiddleware(req, res, pathname)) return true

  const handler = exactRoutes.get(key)
  if (handler) { handler(req, res, pathname, url); return true }

  for (const pfx of prefixRoutes) {
    if (pfx.method && pfx.method !== method) continue
    if (pathname.startsWith(pfx.prefix)) { pfx.handler(req, res, pathname, url); return true }
  }

  for (const [pattern, routeMethod, rxHandler] of regexRoutes) {
    if (method !== routeMethod) continue
    const match = pathname.match(pattern)
    if (match) { rxHandler(req, res, pathname, url, match); return true }
  }

  return false
}

module.exports = { dispatch, exactRoutes, prefixRoutes, regexRoutes }
