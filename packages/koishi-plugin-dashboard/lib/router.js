'use strict'

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

function dispatch(req, res, pathname, url) {
  const method = req.method
  const key = method + ' ' + pathname
  const handler = exactRoutes.get(key)
  if (handler) { handler(req, res, pathname, url); return true }
  for (const pfx of prefixRoutes) {
    if (pfx.method && pfx.method !== method) continue
    const pfxPath = pfx.prefix
    if (pathname.startsWith(pfxPath)) { pfx.handler(req, res, pathname, url); return true }
  }
  for (const [pattern, routeMethod, handler] of regexRoutes) {
    if (method !== routeMethod) continue
    const match = pathname.match(pattern)
    if (match) { handler(req, res, pathname, url, match); return true }
  }
  return false
}

module.exports = { dispatch, exactRoutes, prefixRoutes, regexRoutes }
