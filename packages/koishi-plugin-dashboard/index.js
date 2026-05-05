const fs = require('fs')
const path = require('path')
const http = require('http')

exports.name = 'dashboard'

exports.apply = (ctx) => {
  const PLUGIN_ROOT = __dirname
  const AI_LIB = path.join(PLUGIN_ROOT, '..', 'koishi-plugin-dongxuelian-ai', 'lib')
  const DATA_DIR = process.env.DONGXUELIAN_AI_DATA_DIR || path.join(PLUGIN_ROOT, '..', 'koishi-plugin-dongxuelian-ai', 'data')
  const DIST_DIR = path.join(PLUGIN_ROOT, 'frontend', 'dist')
  const PORT = 5150

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`)
    const pathname = url.pathname

    // CORS
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', 'GET, PUT, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type')

    if (req.method === 'OPTIONS') {
      res.writeHead(204)
      res.end()
      return
    }

    // API 路由
    if (pathname === '/dashboard/api/status' && req.method === 'GET') {
      return json(res, {
        provider: readFileSync(path.join(DATA_DIR, 'ai-provider.txt')) || 'deepseek',
        model: readFileSync(path.join(DATA_DIR, 'ai-model.txt')) || '',
      })
    }

    if (pathname === '/dashboard/api/providers' && req.method === 'GET') {
      const { PROVIDERS } = require(path.join(AI_LIB, 'constants'))
      return json(res, PROVIDERS)
    }

    if (pathname === '/dashboard/api/config' && req.method === 'GET') {
      return json(res, {
        provider: readFileSync(path.join(DATA_DIR, 'ai-provider.txt')) || 'deepseek',
        model: readFileSync(path.join(DATA_DIR, 'ai-model.txt')) || '',
        baseUrl: readFileSync(path.join(DATA_DIR, 'ai-base-url.txt')) || '',
      })
    }

    if (pathname === '/dashboard/api/config' && req.method === 'PUT') {
      let body = ''
      req.on('data', c => body += c)
      req.on('end', () => {
        try {
          const data = JSON.parse(body)
          if (data.provider !== undefined) writeFileSync(path.join(DATA_DIR, 'ai-provider.txt'), data.provider)
          if (data.model !== undefined) writeFileSync(path.join(DATA_DIR, 'ai-model.txt'), data.model)
          if (data.baseUrl !== undefined) writeFileSync(path.join(DATA_DIR, 'ai-base-url.txt'), data.baseUrl)
          const { resetConfigCache } = require(path.join(AI_LIB, 'runtime-config'))
          resetConfigCache()
          json(res, { ok: true, message: '配置已更新' })
        } catch (e) {
          json(res, { ok: false, message: e.message }, 400)
        }
      })
      return
    }

    if (pathname === '/dashboard/api/personas' && req.method === 'GET') {
      try {
        const { getAvailablePersonals } = require(path.join(AI_LIB, 'persona'))
        return json(res, getAvailablePersonals().map(p => ({ name: p.name, description: p.description })))
      } catch { return json(res, []) }
    }

    if (pathname === '/dashboard/api/modes' && req.method === 'GET') {
      try {
        const dir = path.join(PLUGIN_ROOT, '..', 'koishi-plugin-dongxuelian-ai', 'data', 'ai-skills', 'modes')
        const files = fs.readdirSync(dir).filter(f => f.endsWith('.md'))
        return json(res, files.map(f => {
          const raw = fs.readFileSync(path.join(dir, f), 'utf8')
          const m = raw.match(/^---\n([\s\S]*?)\n---/)
          const name = m?.[1]?.match(/name:\s*(\S+)/)?.[1] || f.replace('.md', '')
          const desc = m?.[1]?.match(/description:\s*(.+)/)?.[1] || ''
          return { name, file: f, description: desc }
        }))
      } catch { return json(res, []) }
    }

    if (pathname === '/dashboard/api/whitelist' && req.method === 'GET') {
      try {
        return json(res, JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'summary-whitelist.json'), 'utf8')))
      } catch { return json(res, []) }
    }

    // 静态文件
    const serveFile = (filePath) => {
      if (fs.existsSync(filePath)) {
        const ext = path.extname(filePath)
        const mime = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json', '.ico': 'image/x-icon' }[ext] || 'application/octet-stream'
        const content = fs.readFileSync(filePath)
        res.writeHead(200, { 'Content-Type': mime })
        res.end(content)
      } else {
        res.writeHead(404)
        res.end('Not Found')
      }
    }

    const reqPath = pathname.replace(/^\/dashboard\//, '')
    if (!reqPath) {
      serveFile(path.join(DIST_DIR, 'index.html'))
    } else {
      serveFile(path.join(DIST_DIR, reqPath))
    }
  })

  server.listen(PORT, () => {
    ctx.logger('dashboard').info(`dashboard running on http://localhost:${PORT}/dashboard/`)
  })

  ctx.on('dispose', () => server.close())
}

function json(res, data, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(data))
}

function readFileSync(p) {
  try { return fs.readFileSync(p, 'utf8').trim() } catch { return '' }
}
function writeFileSync(p, content) {
  const dir = path.dirname(p)
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(p, String(content).trim(), 'utf8')
}


function readFileSync(p) {
  try { return fs.readFileSync(p, 'utf8').trim() } catch { return '' }
}
function writeFileSync(p, content) {
  const dir = path.dirname(p)
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(p, String(content).trim(), 'utf8')
}
