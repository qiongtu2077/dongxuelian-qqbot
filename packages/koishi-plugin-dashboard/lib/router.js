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
  if (mod.prefixRoutes) for (const [prefix, handler] of Object.entries(mod.prefixRoutes)) prefixRoutes.push({ prefix, handler })
  if (mod.regexRoutes) for (const item of mod.regexRoutes) regexRoutes.push(item)
}

function dispatch(req, res, pathname, url) {
  const method = req.method
  const key = method + ' ' + pathname
  const handler = exactRoutes.get(key)
  if (handler) { handler(req, res, pathname, url); return true }
  for (const { prefix, handler: pfxHandler } of prefixRoutes) {
    const pfxKey = method + ' ' + prefix
    if (key.startsWith(pfxKey)) { pfxHandler(req, res, pathname, url); return true }
  }
  for (const [pattern, routeMethod, handler] of regexRoutes) {
    if (method !== routeMethod) continue
    const match = pathname.match(pattern)
    if (match) { handler(req, res, pathname, url, match); return true }
  }
  return false
}

module.exports = { dispatch, exactRoutes, prefixRoutes, regexRoutes }
