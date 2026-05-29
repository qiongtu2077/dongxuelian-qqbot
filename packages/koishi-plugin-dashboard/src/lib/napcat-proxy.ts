'use strict'

const http = require('http')
const { resolveNapcatWebuiListenPort, getNapcatToken } = require('./napcat')

interface NapcatProxyOptions {
  token?: string
}

interface NapcatStatus {
  logLines?: string[]
  login?: { reason?: string }
  installation?: { reason?: string }
}

function napcatRespond(res, proxyRes, token) {
  const contentType = proxyRes.headers['content-type'] || ''
  const contentLength = parseInt(proxyRes.headers['content-length'] || '0', 10)
  if (contentType.includes('text/html') && token && contentLength > 0 && contentLength <= 1024 * 1024) {
    let body = ''
    proxyRes.on('data', c => body += c)
    proxyRes.on('end', () => {
      const jsonToken = JSON.stringify(String(token || ''))
      const injected = body.replace('</head>', `<script>localStorage.setItem('token',${jsonToken});</script></head>`)
      res.writeHead(proxyRes.statusCode, { ...proxyRes.headers, 'content-length': Buffer.byteLength(injected) })
      res.end(injected)
    })
    return
  }
  res.writeHead(proxyRes.statusCode, proxyRes.headers)
  proxyRes.pipe(res)
}

function napcatProxy(req, res, targetPath, getStatusFn, options: NapcatProxyOptions = {}) {
  const host = process.env.NAPCAT_HOST || '127.0.0.1'
  const port = resolveNapcatWebuiListenPort()
  const token = options.token || process.env.NAPCAT_TOKEN || getNapcatToken()
  const opts = { hostname: host, port, path: targetPath, method: req.method, headers: { ...req.headers, host: host + ':' + port } }
  delete opts.headers.authorization
  delete opts.headers['x-napcat-token']
  delete opts.headers['x-admin-token']
  if (token) {
    opts.headers['Authorization'] = 'Bearer ' + token
    opts.headers['webui-token'] = token
  }
  const proxyReq = http.request(opts, (proxyRes) => {
    if (proxyRes.statusCode === 401 && token) {
      opts.headers['Authorization'] = ''
      http.request(opts, (r2) => { napcatRespond(res, r2, token) }).on('error', () => { res.writeHead(502); res.end('proxy error') }).end()
      proxyRes.resume()
      return
    }
    napcatRespond(res, proxyRes, token)
  })
  proxyReq.on('error', () => {
    let detail = 'NapCat WebUI 代理失败：127.0.0.1:' + port + ' 当前没有响应。'
    if (typeof getStatusFn === 'function') {
      try {
        const status: NapcatStatus = getStatusFn()
        const tail = (status.logLines || []).slice(-12).join('\n')
        const parts = [detail, status.login?.reason || status.installation?.reason || '', tail ? '最近 NapCat 日志：\n' + tail : '']
        detail = parts.filter(Boolean).join('\n\n')
      } catch { /* non-critical: status details best effort */ }
    }
    res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' })
    res.end(detail)
  })
  req.pipe(proxyReq)
}

export = { napcatProxy }
