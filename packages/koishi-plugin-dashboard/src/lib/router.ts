'use strict'

import type { IncomingMessage, ServerResponse } from 'http'

type HttpRequest = IncomingMessage
type HttpResponse = ServerResponse
type RouteHandler = (req: HttpRequest, res: HttpResponse, pathname: string, url: URL) => unknown
type RegexRouteHandler = (req: HttpRequest, res: HttpResponse, match: RegExpMatchArray, pathname: string, url: URL) => unknown
type AuthMiddleware = (req: HttpRequest, res: HttpResponse, pathname: string) => boolean

interface PrefixRoute {
  prefix: string
  method?: string
  handler: RouteHandler
}

interface RegexRouteObject {
  pattern?: RegExp
  method?: string
  handler?: RegexRouteHandler
  0?: RegExp
  1?: string
  2?: RegexRouteHandler
}

type RegexRoute = RegexRouteObject

interface RouteModule {
  routes?: Record<string, RouteHandler>
  prefixRoutes?: PrefixRoute[] | Record<string, RouteHandler>
  regexRoutes?: RegexRoute[]
}

const { authMiddleware } = require('./routes/auth') as { authMiddleware: AuthMiddleware }
const galleryRoutes = require('./routes/gallery') as RouteModule
const authRoutes = require('./routes/auth') as RouteModule
const configRoutes = require('./routes/config') as RouteModule
const agentRoutes = require('./routes/agent') as RouteModule
const settingsRoutes = require('./routes/settings') as RouteModule
const botRoutes = require('./routes/bot') as RouteModule
const deployRoutes = require('./routes/deploy') as RouteModule
const resourceRoutes = require('./routes/resource') as RouteModule

const exactRoutes = new Map<string, RouteHandler>()
const prefixRoutes: PrefixRoute[] = []
const regexRoutes: RegexRoute[] = []

for (const mod of [galleryRoutes, authRoutes, configRoutes, agentRoutes, settingsRoutes, botRoutes, deployRoutes, resourceRoutes]) {
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
  'POST /dashboard/api/auth/reset-password',
])

// Dispatches an HTTP request to exact, prefix, or regex route handlers.
function dispatch(req: HttpRequest, res: HttpResponse, pathname: string, url: URL): boolean {
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

  for (const route of regexRoutes) {
    const pattern = route.pattern || route[0]
    const routeMethod = route.method || route[1]
    const rxHandler = route.handler || route[2]
    if (!pattern || !rxHandler || method !== routeMethod) continue
    const match = pathname.match(pattern)
    if (match) { rxHandler(req, res, match, pathname, url); return true }
  }

  return false
}

export = { dispatch, exactRoutes, prefixRoutes, regexRoutes }
