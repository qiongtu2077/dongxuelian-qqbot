#!/usr/bin/env node
/**
 * Standalone Dashboard server.
 * Runs independently from the Koishi lifecycle on DASHBOARD_PORT.
 */
const fs = require('fs')
const path = require('path')
const http = require('http')
const { parsePositiveInt, isLoopbackAddress, getRemoteAddress, isInsidePath, log } = require('./lib/utils')
const {
  PORT,
  HOST,
  DIST_DIR,
  AGENT_CONSOLE_DIST_DIR,
  KOISHI_PID_FILE,
  DATA_DIR,
  RESET_TOKEN_FILE,
  ADMIN_PWD_FILE,
  ACCESS_PWD_FILE,
  isGlobalLocalMode,
} = require('./lib/paths')
const {
  isLocalAuthBypass,
  requireAdmin,
  shouldGenerateResetTokenOnStartup,
  getResetToken,
  generateResetToken,
  ensureInitialCredentials,
  applyCorsHeaders,
  rejectCrossSiteRequest,
} = require('./lib/auth')
const { getNapcatToken } = require('./lib/napcat')
const { napcatProxy } = require('./lib/napcat-proxy')
const router = require('./lib/router')

process.on('uncaughtException', (err) => {
  console.error('[dashboard] UNCAUGHT EXCEPTION:', err.stack || err.message)
})
process.on('unhandledRejection', (reason) => {
  console.error('[dashboard] UNHANDLED REJECTION:', reason?.stack || reason)
})

const MAX_STATIC_FILE_BYTES = parsePositiveInt(process.env.DASHBOARD_MAX_STATIC_FILE_BYTES, 32 * 1024 * 1024, 1024 * 1024, 256 * 1024 * 1024)
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "media-src 'self' blob: data:",
  "font-src 'self' data:",
  "connect-src 'self' ws: wss:",
  "frame-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "frame-ancestors 'self'",
].join('; ')

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`)
  const pathname = url.pathname

  applyCorsHeaders(req, res)
  res.setHeader('Content-Security-Policy', CONTENT_SECURITY_POLICY)
  res.setHeader('X-Content-Type-Options', 'nosniff')
  const isSensitiveRequest = pathname.startsWith('/dashboard/api/') || pathname.startsWith('/api/') || pathname.startsWith('/webui')
  if (isSensitiveRequest && rejectCrossSiteRequest(req, res)) return

  if (req.method === 'OPTIONS') {
    res.writeHead(204)
    res.end()
    return
  }

  if (pathname.startsWith('/webui/') || pathname === '/webui') {
    if (!requireAdmin(req, res)) return
    const nToken = process.env.NAPCAT_TOKEN || getNapcatToken()
    return napcatProxy(req, res, pathname + url.search, null, { token: nToken })
  }
  if (pathname.startsWith('/api/') && !pathname.startsWith('/dashboard/api/')) {
    if (!requireAdmin(req, res)) return
    return napcatProxy(req, res, pathname + url.search)
  }

  if (router.dispatch(req, res, pathname, url)) return

  if (pathname === '/dashboard') {
    res.writeHead(302, { Location: '/dashboard/' })
    res.end()
    return
  }
  if (pathname === '/agent') {
    res.writeHead(302, { Location: '/agent/' })
    res.end()
    return
  }

  // Serves one static file from a constrained root directory.
  const serveStaticFile = (rootDir, filePath) => {
    try {
      if (!isInsidePath(rootDir, filePath)) {
        res.writeHead(403)
        res.end('Forbidden')
        return true
      }
      const stat = fs.statSync(filePath)
      if (stat.isFile()) {
        if (stat.size > MAX_STATIC_FILE_BYTES) {
          res.writeHead(413, { 'Content-Type': 'text/plain; charset=utf-8' })
          res.end('File too large')
          return true
        }
        const ext = path.extname(filePath)
        const mime = { '.html': 'text/html', '.js': 'application/javascript', '.mjs': 'application/javascript', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.json': 'application/json', '.ico': 'image/x-icon' }[ext] || 'application/octet-stream'
        const rel = path.relative(rootDir, filePath).replace(/\\/g, '/')
        const cache = rel === 'index.html' ? 'no-cache' : (rel.startsWith('assets/') ? 'public, max-age=31536000, immutable' : 'public, max-age=3600')
        res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': cache })
        fs.createReadStream(filePath).pipe(res)
        return true
      }
    } catch {}
    return false
  }

  if (pathname.startsWith('/agent/')) {
    let agentReqPath = pathname.replace(/^\/agent\/?/, '')
    try { agentReqPath = decodeURIComponent(agentReqPath) } catch {}
    if (serveStaticFile(AGENT_CONSOLE_DIST_DIR, path.join(AGENT_CONSOLE_DIST_DIR, agentReqPath || 'index.html'))) return
    if (pathname.startsWith('/agent/assets/')) {
      res.writeHead(404)
      res.end('Not Found')
      return
    }
    if (serveStaticFile(AGENT_CONSOLE_DIST_DIR, path.join(AGENT_CONSOLE_DIST_DIR, 'index.html'))) return
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
    res.end('Agent Console dist not found. Run npm run build --prefix packages/agent-console')
    return
  }

  let reqPath = pathname.replace(/^\/dashboard\/?/, '')
  try { reqPath = decodeURIComponent(reqPath) } catch {}
  if (serveStaticFile(DIST_DIR, path.join(DIST_DIR, reqPath || 'index.html'))) return
  if (pathname.startsWith('/dashboard/assets/') || pathname.startsWith('/dashboard/backgrounds/')) {
    res.writeHead(404)
    res.end('Not Found')
    return
  }
  if (!pathname.startsWith('/dashboard/api/') && serveStaticFile(DIST_DIR, path.join(DIST_DIR, 'index.html'))) return
  res.writeHead(404)
  res.end('Not Found')
})

module.exports = {
  isLoopbackAddress,
  isLocalAuthBypass,
  getRemoteAddress,
  KOISHI_PID_FILE,
  CONTENT_SECURITY_POLICY,
}

if (require.main === module) {
  ensureInitialCredentials()
  if (shouldGenerateResetTokenOnStartup() && !getResetToken()) generateResetToken()

  server.on('error', err => {
    if (err && err.code === 'EADDRINUSE') log(`port ${PORT} is already in use`)
    else console.error('[dashboard] HTTP server error:', err.stack || err.message || err)
    process.exit(1)
  })
  server.listen(PORT, HOST, () => {
    const shownHost = HOST === '0.0.0.0' ? 'localhost' : HOST
    log(`LianBoard running on http://${shownHost}:${PORT}/dashboard/`)
    log(`listen host: ${HOST}`)
    log(`runtime data dir: ${DATA_DIR}`)
    log('bot control: start/stop/maintenance')
    log('napcat proxy: /webui/ -> NapCat WebUI')
    if (!isGlobalLocalMode()) {
      log(`password reset token file: ${RESET_TOKEN_FILE}`)
      log(`access password file: ${ACCESS_PWD_FILE}`)
      log(`admin password file: ${ADMIN_PWD_FILE}`)
    }
  })

  process.on('SIGINT', () => { log('shutting down'); server.close(); process.exit(0) })
  process.on('SIGTERM', () => { log('shutting down'); server.close(); process.exit(0) })
}
