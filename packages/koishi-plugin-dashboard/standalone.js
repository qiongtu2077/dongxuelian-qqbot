#!/usr/bin/env node
/**
 * Dashboard 独立服务器
 * 不依赖 koishi，独立进程运行在 5150 端口
 * 用法: node standalone.js &
 */
const fs = require('fs')
const path = require('path')
const http = require('http')
const crypto = require('crypto')
const os = require('os')
const { execSync, exec } = require('child_process')

// ====== 全局异常兜底（防止单请求崩溃整个进程） ======
process.on('uncaughtException', (err) => {
  console.error('[dashboard] UNCAUGHT EXCEPTION:', err.stack || err.message)
})
process.on('unhandledRejection', (reason) => {
  console.error('[dashboard] UNHANDLED REJECTION:', reason?.stack || reason)
})

// ====== 路径配置 ======
const PLUGIN_ROOT = __dirname
const AI_LIB = path.join(PLUGIN_ROOT, '..', 'koishi-plugin-dongxuelian-ai', 'lib')
const DATA_DIR = process.env.DONGXUELIAN_AI_DATA_DIR || path.join(PLUGIN_ROOT, '..', 'koishi-plugin-dongxuelian-ai', 'data')
const PERSONAS_DIR = path.join(DATA_DIR, 'ai-skills', 'personas')
const LORES_DIR = path.join(DATA_DIR, 'ai-skills', 'lore')
const MODES_DIR = path.join(DATA_DIR, 'ai-skills', 'modes')
const DIST_DIR = path.join(PLUGIN_ROOT, 'frontend', 'dist')
const PORT = process.env.DASHBOARD_PORT || 5150
const KOISHI_DIR = process.env.KOISHI_DIR || path.join(PLUGIN_ROOT, '..', '..')
const PASSWORD = process.env.DASHBOARD_PASSWORD || '123456'
const ADMIN_PASSWORD = process.env.DASHBOARD_ADMIN_PASSWORD || '123456'

const ADMIN_PWD_FILE = path.join(DATA_DIR, 'dashboard-admin-pwd.txt')
const ACCESS_PWD_FILE = path.join(DATA_DIR, 'dashboard-access-pwd.txt')
const LEGACY_ACCESS_PWD_FILE = path.join(DATA_DIR, 'dashboard-pwd.txt')

// ====== 工具函数 ======
function json(res, data, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(data))
}

function readFileSync(p) {
  try { if (fs.statSync(p).isFile()) return fs.readFileSync(p, 'utf8').trim() } catch {}
  return ''
}

function writeFileSync(p, content) {
  const dir = path.dirname(p)
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(p, String(content).trim(), 'utf8')
}

function log(msg) {
  console.log(`[dashboard] ${msg}`)
}

function shellQuote(value) {
  return "'" + String(value).replace(/'/g, "'\\''") + "'"
}

function remoteDataFile(appDir, filename) {
  return String(appDir).replace(/\/+$/, '') + '/data/' + filename
}

function remoteWriteFileCommand(server, filePath, content) {
  const dir = filePath.replace(/\/[^/]*$/, '')
  const remoteCmd = `mkdir -p ${shellQuote(dir)} && printf %s ${shellQuote(content)} > ${shellQuote(filePath)}`
  return `ssh ${server} ${shellQuote(remoteCmd)}`
}

// ====== Auth ======
function createToken() {
  return crypto.createHash('sha256').update('dashboard:' + getAccessPassword()).digest('hex')
}

function validateToken(token) {
  return token === createToken()
}

// ====== 管理员密码系统 ======
function getAdminPassword() {
  return readFileSync(ADMIN_PWD_FILE) || ADMIN_PASSWORD
}
function getAccessPassword() {
  return readFileSync(ACCESS_PWD_FILE) || readFileSync(LEGACY_ACCESS_PWD_FILE) || PASSWORD
}
function createAdminToken() {
  return crypto.createHash('sha256').update('admin:' + getAdminPassword()).digest('hex')
}
function validateAdminToken(token) {
  return token === createAdminToken()
}
// 更新 access token 后需要刷新登录，所以也更新 PASSWORD 常量
function reloadAccessPassword() {
  const pwd = getAccessPassword()
}

function requireAdmin(req, res) {
  const token = (req.headers['x-admin-token'] || '').trim()
  if (!token || !validateAdminToken(token)) {
    json(res, { ok: false, message: '需要管理员密码验证', code: 'ADMIN_REQUIRED' }, 403)
    return false
  }
  return true
}

// ====== NapCat Token ======
function getNapcatToken() {
  if (getNapcatToken._cached) return getNapcatToken._cached
  const candidates = [
    '/root/Napcat/opt/QQ/resources/app/app_launcher/napcat/config/webui.json',
    process.env.NAPCAT_CONFIG || '',
  ].filter(Boolean)
  for (const p of candidates) {
    try {
      const cfg = JSON.parse(fs.readFileSync(p, 'utf8'))
      if (cfg.token) { getNapcatToken._cached = cfg.token; return cfg.token }
    } catch {}
  }
  return ''
}

// ====== NapCat 代理 ======
function napcatProxy(req, res, targetPath) {
  const host = process.env.NAPCAT_HOST || '127.0.0.1'
  const port = process.env.NAPCAT_PORT || 6099
  const token = process.env.NAPCAT_TOKEN || getNapcatToken()
  const opts = { hostname: host, port, path: targetPath, method: req.method, headers: { ...req.headers, host: host + ':' + port } }
  if (token) opts.headers['Authorization'] = 'Bearer ' + token
  const proxyReq = http.request(opts, (proxyRes) => {
    if (proxyRes.statusCode === 401 && token) {
      opts.headers['Authorization'] = ''
      http.request(opts, (r2) => { napcatRespond(res, r2, token) }).on('error', () => { res.writeHead(502); res.end('proxy error') }).end()
      proxyRes.resume()
      return
    }
    napcatRespond(res, proxyRes, token)
  })
  proxyReq.on('error', () => { res.writeHead(502, { 'Content-Type': 'text/plain' }); res.end('NapCat proxy error') })
  req.pipe(proxyReq)
}

function napcatRespond(res, proxyRes, token) {
  const contentType = proxyRes.headers['content-type'] || ''
  if (contentType.includes('text/html') && token) {
    let body = ''
    proxyRes.on('data', c => body += c)
    proxyRes.on('end', () => {
      const injected = body.replace('</head>', `<script>localStorage.setItem('token','${token}');</script></head>`)
      res.writeHead(proxyRes.statusCode, { ...proxyRes.headers, 'content-length': Buffer.byteLength(injected) })
      res.end(injected)
    })
    return
  }
  res.writeHead(proxyRes.statusCode, proxyRes.headers)
  proxyRes.pipe(res)
}

// ====== HTTP 服务器 ======
const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`)
  const pathname = url.pathname

  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, PUT, POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')

  if (req.method === 'OPTIONS') {
    res.writeHead(204)
    res.end()
    return
  }

  // 登录
  if (pathname === '/dashboard/api/login' && req.method === 'POST') {
    let body = ''
    req.on('data', c => body += c)
    req.on('end', () => {
      try {
        const { password } = JSON.parse(body)
        const stored = getAccessPassword()
        const match = password === stored
        if (match) return json(res, { ok: true, token: createToken() })
        return json(res, { ok: false, message: '密码错误' }, 401)
      } catch { return json(res, { ok: false, message: '无效请求' }, 400) }
    })
    return
  }

  // 管理员验证（不需要普通登录）
  if (pathname === '/dashboard/api/admin/verify' && req.method === 'POST') {
    let body = ''
    req.on('data', c => body += c)
    req.on('end', () => {
      try {
        const { password } = JSON.parse(body)
        if (password === getAdminPassword()) return json(res, { ok: true, token: createAdminToken() })
        return json(res, { ok: false, message: '管理员密码错误' }, 401)
      } catch { return json(res, { ok: false, message: '无效请求' }, 400) }
    })
    return
  }

  // 修改密码
  if (pathname === '/dashboard/api/auth/password' && req.method === 'PUT') {
    if (!requireAdmin(req, res)) return
    let body = ''
    req.on('data', c => body += c)
    req.on('end', () => {
      try {
        const { type, newPassword } = JSON.parse(body)
        if (!newPassword || newPassword.length < 4) return json(res, { ok: false, message: '新密码长度不能少于4位' }, 400)
        if (type === 'admin') {
          writeFileSync(ADMIN_PWD_FILE, newPassword)
          return json(res, { ok: true, message: '管理员密码已更新' })
        } else if (type === 'access') {
          writeFileSync(ACCESS_PWD_FILE, newPassword)
          return json(res, { ok: true, message: '访问密码已更新，请重新登录' })
        }
        return json(res, { ok: false, message: '无效类型' }, 400)
      } catch { return json(res, { ok: false, message: '无效请求' }, 400) }
    })
    return
  }

  // Auth 检查
  if (pathname.startsWith('/dashboard/api/')) {
    const auth = req.headers['authorization'] || ''
    const token = auth.replace(/^Bearer\s+/i, '')
    if (!validateToken(token)) {
      res.writeHead(401, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: false, message: '请先登录', code: 'AUTH_REQUIRED' }))
      return
    }
  }

  // ===== API 路由 =====
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
    if (!requireAdmin(req, res)) return
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
      } catch (e) { json(res, { ok: false, message: e.message }, 400) }
    })
    return
  }

  if (pathname === '/dashboard/api/personas' && req.method === 'GET') {
    try {
      const { getAvailablePersonals, loadPersonalSkill } = require(path.join(AI_LIB, 'persona'))
      const name = url.searchParams.get('name')
      if (name) {
        const content = loadPersonalSkill(name)
        if (!content) return json(res, { ok: false, message: '未找到人格' }, 404)
        const m = content.match(/^---\n([\s\S]*?)\n---\n\n?/)
        let meta = {}
        if (m) {
          for (const line of m[1].split('\n')) {
            const kv = line.match(/^(\w[\w_-]*):\s*(.+)/)
            if (kv) meta[kv[1]] = kv[2].trim()
          }
        }
        const bodyContent = m ? content.slice(m[0].length) : content
        return json(res, { ok: true, data: { name, description: meta.description || '', lore: meta.lore || '', will: meta.will || 1.0, content: bodyContent } })
      }
      return json(res, getAvailablePersonals().map(p => ({ name: p.name, description: p.description })))
    } catch { return json(res, []) }
  }

  if (pathname === '/dashboard/api/personas' && req.method === 'POST') {
    if (!requireAdmin(req, res)) return
    let body = ''
    req.on('data', c => body += c)
    req.on('end', () => {
      try {
        const { name, description, lore, will, content } = JSON.parse(body)
        if (!name || !content) return json(res, { ok: false, message: '名称和内容不能为空' }, 400)
        const sanitized = name.replace(/[^a-zA-Z0-9\u4e00-\u9fff_-]/g, '')
        const filePath = path.join(PERSONAS_DIR, 'SKILL.' + sanitized + '.md')
        if (fs.existsSync(filePath)) return json(res, { ok: false, message: '同名人格已存在' }, 400)
        const loreLine = lore && lore !== 'none' ? '\nlore: ' + lore : ''
        const willLine = will !== undefined && will !== '' ? '\nwill: ' + parseFloat(will) : '\nwill: 1.0'
        const md = '---\nname: ' + sanitized + '\ndescription: ' + (description || '') + loreLine + willLine + '\n---\n\n' + content
        fs.writeFileSync(filePath, md, 'utf8')
        json(res, { ok: true, message: '人格 ' + sanitized + ' 已创建' })
      } catch (e) { json(res, { ok: false, message: e.message }, 400) }
    })
    return
  }

  if (pathname === '/dashboard/api/personas' && req.method === 'DELETE') {
    if (!requireAdmin(req, res)) return
    let body = ''
    req.on('data', c => body += c)
    req.on('end', () => {
      try {
        const { name } = JSON.parse(body)
        if (!name) return json(res, { ok: false, message: '名称不能为空' }, 400)
        const files = fs.readdirSync(PERSONAS_DIR).filter(f => /^SKILL(\.[^.]+)?\.md$/i.test(f))
        let deleted = false
        for (const f of files) {
          const raw = fs.readFileSync(path.join(PERSONAS_DIR, f), 'utf8')
          const m = raw.match(/^---\n([\s\S]*?)\n---/)
          const metaName = m?.[1]?.match(/name:\s*(.+)/)?.[1]?.trim()
          if (metaName === name) {
            fs.unlinkSync(path.join(PERSONAS_DIR, f))
            deleted = true
            break
          }
        }
        if (!deleted) return json(res, { ok: false, message: '未找到人格 ' + name }, 404)
        json(res, { ok: true, message: '人格 ' + name + ' 已删除' })
      } catch (e) { json(res, { ok: false, message: e.message }, 400) }
    })
    return
  }

  if (pathname === '/dashboard/api/personas' && req.method === 'PUT') {
    if (!requireAdmin(req, res)) return
    let body = ''
    req.on('data', c => body += c)
    req.on('end', () => {
      try {
        const { name, description, lore, will, content } = JSON.parse(body)
        if (!name || !content) return json(res, { ok: false, message: '名称和内容不能为空' }, 400)
        const files = fs.readdirSync(PERSONAS_DIR).filter(f => /^SKILL(\.[^.]+)?\.md$/i.test(f))
        let found = false
        for (const f of files) {
          const raw = fs.readFileSync(path.join(PERSONAS_DIR, f), 'utf8')
          const m = raw.match(/^---\n([\s\S]*?)\n---/)
          const metaName = m?.[1]?.match(/name:\s*(.+)/)?.[1]?.trim()
          if (metaName === name) {
            const loreLine = lore && lore !== 'none' ? '\nlore: ' + lore : ''
            const willLine = will !== undefined && will !== '' ? '\nwill: ' + parseFloat(will) : '\nwill: 1.0'
            const md = '---\nname: ' + name + '\ndescription: ' + (description || '') + loreLine + willLine + '\n---\n\n' + content
            fs.writeFileSync(path.join(PERSONAS_DIR, f), md, 'utf8')
            found = true
            break
          }
        }
        if (!found) return json(res, { ok: false, message: '未找到人格 ' + name }, 404)
        json(res, { ok: true, message: '人格 ' + name + ' 已更新' })
      } catch (e) { json(res, { ok: false, message: e.message }, 400) }
    })
    return
  }

  // 可用世界观列表
  if (pathname === '/dashboard/api/lore-list' && req.method === 'GET') {
    try {
      const loreDir = LORES_DIR
      const files = fs.readdirSync(loreDir).filter(f => f.endsWith('.md'))
      const list = files.map(f => {
        const raw = fs.readFileSync(path.join(loreDir, f), 'utf8')
        const m = raw.match(/^---\n([\s\S]*?)\n---/)
        const name = m?.[1]?.match(/name:\s*(\S+)/)?.[1] || f.replace('SKILL.', '').replace('.md', '')
        const desc = m?.[1]?.match(/description:\s*(.+)/)?.[1] || ''
        return { id: name, description: desc, file: f }
      })
      list.unshift({ id: 'none', description: '不绑定任何世界观', file: '' })
      return json(res, list)
    } catch { return json(res, [{ id: 'none', description: '不绑定任何世界观', file: '' }]) }
  }

  if (pathname === '/dashboard/api/lores' && req.method === 'GET') {
    try {
      const loreDir = LORES_DIR
      const files = fs.readdirSync(loreDir).filter(f => f.endsWith('.md'))
      return json(res, files.map(f => {
        const raw = fs.readFileSync(path.join(loreDir, f), 'utf8')
        const m = raw.match(/^---\n([\s\S]*?)\n---\n\n?/)
        let name = '', description = '', content = raw
        if (m) {
          for (const line of m[1].split('\n')) {
            const kv = line.match(/^(\w[\w_-]*):\s*(.+)/)
            if (kv) { if (kv[1] === 'name') name = kv[2].trim(); else if (kv[1] === 'description') description = kv[2].trim() }
          }
          content = raw.slice(m[0].length)
        } else {
          name = f.replace(/^SKILL\./, '').replace(/\.md$/, '')
        }
        return { name, description, content }
      }))
    } catch { return json(res, []) }
  }

  if (pathname === '/dashboard/api/lores' && req.method === 'POST') {
    if (!requireAdmin(req, res)) return
    let body = ''
    req.on('data', c => body += c)
    req.on('end', () => {
      try {
        const { name, description, content } = JSON.parse(body)
        if (!name || !content) return json(res, { ok: false, message: '名称和内容不能为空' }, 400)
        const loreDir = LORES_DIR
        const filePath = path.join(loreDir, 'SKILL.' + name.replace(/[^a-zA-Z0-9\u4e00-\u9fff_-]/g, '') + '.md')
        if (fs.existsSync(filePath)) return json(res, { ok: false, message: '同名世界观已存在' }, 400)
        const md = '---\nname: ' + name + '\ndescription: ' + (description || '') + '\n---\n\n' + content
        fs.writeFileSync(filePath, md, 'utf8')
        json(res, { ok: true, message: '世界观 ' + name + ' 已创建' })
      } catch (e) { json(res, { ok: false, message: e.message }, 400) }
    })
    return
  }

  if (pathname === '/dashboard/api/lores' && req.method === 'PUT') {
    if (!requireAdmin(req, res)) return
    let body = ''
    req.on('data', c => body += c)
    req.on('end', () => {
      try {
        const { name, description, content } = JSON.parse(body)
        if (!name || !content) return json(res, { ok: false, message: '名称和内容不能为空' }, 400)
        const loreDir = LORES_DIR
        const files = fs.readdirSync(loreDir).filter(f => f.endsWith('.md'))
        let found = false
        for (const f of files) {
          const raw = fs.readFileSync(path.join(loreDir, f), 'utf8')
          const m = raw.match(/^---\n([\s\S]*?)\n---/)
          const metaName = m?.[1]?.match(/name:\s*(.+)/)?.[1]?.trim()
          if (metaName === name) {
            const md = '---\nname: ' + name + '\ndescription: ' + (description || '') + '\n---\n\n' + content
            fs.writeFileSync(path.join(loreDir, f), md, 'utf8')
            found = true
            break
          }
        }
        if (!found) return json(res, { ok: false, message: '未找到世界观 ' + name }, 404)
        json(res, { ok: true, message: '世界观 ' + name + ' 已更新' })
      } catch (e) { json(res, { ok: false, message: e.message }, 400) }
    })
    return
  }

  if (pathname === '/dashboard/api/lores' && req.method === 'DELETE') {
    if (!requireAdmin(req, res)) return
    let body = ''
    req.on('data', c => body += c)
    req.on('end', () => {
      try {
        const { name } = JSON.parse(body)
        if (!name) return json(res, { ok: false, message: '名称不能为空' }, 400)
        const loreDir = LORES_DIR
        const files = fs.readdirSync(loreDir).filter(f => f.endsWith('.md'))
        let deleted = false
        for (const f of files) {
          const raw = fs.readFileSync(path.join(loreDir, f), 'utf8')
          const m = raw.match(/^---\n([\s\S]*?)\n---/)
          const metaName = m?.[1]?.match(/name:\s*(.+)/)?.[1]?.trim()
          if (metaName === name) {
            fs.unlinkSync(path.join(loreDir, f))
            deleted = true
            break
          }
        }
        if (!deleted) return json(res, { ok: false, message: '未找到世界观 ' + name }, 404)
        json(res, { ok: true, message: '世界观 ' + name + ' 已删除' })
      } catch (e) { json(res, { ok: false, message: e.message }, 400) }
    })
    return
  }

  if (pathname === '/dashboard/api/modes' && req.method === 'GET') {
    try {
      const dir = MODES_DIR
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

  // 白名单/黑名单管理
  const whitelistFiles = {
    summary: { file: 'summary-whitelist.json', label: '解除上限群白名单', type: 'array' },
    random: { file: 'ai-random-whitelist.json', label: '群聊AI白名单', type: 'array' },
    userBlacklist: { file: 'ai-user-blacklist.json', label: '用户黑名单', type: 'array' },
    videoBlacklist: { file: 'video-blacklist.json', label: '视频黑名单', type: 'object', default: { groups: [], users: [] } },
  }

  if (pathname === '/dashboard/api/whitelist' && req.method === 'GET') {
    const result = {}
    for (const [key, cfg] of Object.entries(whitelistFiles)) {
      try {
        result[key] = { label: cfg.label, data: JSON.parse(fs.readFileSync(path.join(DATA_DIR, cfg.file), 'utf8')) }
      } catch {
        result[key] = { label: cfg.label, data: cfg.default || [] }
      }
    }
    return json(res, result)
  }

  if (pathname === '/dashboard/api/whitelist' && req.method === 'PUT') {
    if (!requireAdmin(req, res)) return
    let body = ''
    req.on('data', c => body += c)
    req.on('end', () => {
      try {
        const { type, data } = JSON.parse(body)
        const cfg = whitelistFiles[type]
        if (!cfg) return json(res, { ok: false, message: '无效类型' }, 400)
        writeFileSync(path.join(DATA_DIR, cfg.file), JSON.stringify(data, null, 2))
        // 通知主插件刷新缓存
        try {
          const { resetConfigCache } = require(path.join(AI_LIB, 'runtime-config'))
          resetConfigCache()
        } catch {}
        json(res, { ok: true, message: cfg.label + ' 已更新' })
      } catch (e) { json(res, { ok: false, message: e.message }, 400) }
    })
    return
  }

  if (pathname === '/dashboard/api/keys' && req.method === 'GET') {
    const keyFiles = [
      { name: 'OpenAI/OpenCode', file: 'ai-openai-key.txt' },
      { name: 'DeepSeek 官方', file: 'ai-deepseek-key.txt' },
      { name: '阿里云 DashScope', file: 'ai-dashscope-key.txt' },
      { name: '智谱 GLM', file: 'ai-glm-key.txt' },
      { name: '小米 MiMo', file: 'ai-mimorium-key.txt' },
    ]
    return json(res, keyFiles.map(k => {
      const content = readFileSync(path.join(DATA_DIR, k.file))
      return { label: k.name, file: k.file, exists: !!content, prefix: content ? content.slice(0, 8) + '****' : '' }
    }))
  }

  if (pathname === '/dashboard/api/keys/usage' && req.method === 'GET') {
    try {
      const usageFile = path.join(DATA_DIR, 'token-usage.json')
      if (!fs.existsSync(usageFile)) return json(res, { days: [], providers: [] })
      const raw = fs.readFileSync(usageFile, 'utf8')
      const data = JSON.parse(raw)
      const providerSet = new Set()
      const days = Object.keys(data).sort().slice(-30).map(date => {
        const day = { date }
        for (const [prov, count] of Object.entries(data[date] || {})) {
          day[prov] = count
          providerSet.add(prov)
        }
        return day
      })
      const providers = [...providerSet].map(p => ({
        key: p,
        label: p === 'opencode' ? 'OpenCode' : p === 'glm' ? 'GLM' : p === 'dashscope' ? '阿里云' : p === 'deepseek' ? 'DeepSeek' : p === 'mimorium' ? 'MiMo' : p,
      }))
      return json(res, { days, providers })
    } catch { return json(res, { days: [], providers: [] }) }
  }

  if (pathname === '/dashboard/api/keys' && req.method === 'PUT') {
    if (!requireAdmin(req, res)) return
    let body = ''
    req.on('data', c => body += c)
    req.on('end', () => {
      try {
        const data = JSON.parse(body)
        const file = data.file
        if (!file || file.includes('..') || !file.endsWith('-key.txt')) return json(res, { ok: false, message: '无效文件名' }, 400)
        writeFileSync(path.join(DATA_DIR, file), data.value)
        const { resetConfigCache } = require(path.join(AI_LIB, 'runtime-config'))
        resetConfigCache()
        json(res, { ok: true, message: 'Key 已更新' })
      } catch (e) { json(res, { ok: false, message: e.message }, 400) }
    })
    return
  }

  if (pathname === '/dashboard/api/features' && req.method === 'GET') {
    return json(res, require('./index').FEATURES_DATA || [])
  }

  if (pathname === '/dashboard/api/commands' && req.method === 'GET') {
    return json(res, require('./index').COMMANDS_DATA || [])
  }

  // NapCat 代理
  if (pathname.startsWith('/webui/') || pathname === '/webui') {
    const nToken = process.env.NAPCAT_TOKEN || getNapcatToken()
    const sep = url.search ? '&' : '?'
    return napcatProxy(req, res, pathname + url.search + (nToken ? sep + 'webui_token=' + nToken : ''))
  }
  if (pathname.startsWith('/api/') && !pathname.startsWith('/dashboard/api/')) {
    return napcatProxy(req, res, pathname + url.search)
  }

  // Bot 控制
  if (pathname === '/dashboard/api/bot/status' && req.method === 'GET') {
    try {
      const out = execSync("ps aux | grep 'koishi/lib/worker' | grep -v grep", { encoding: 'utf8', timeout: 3000 }).trim()
      const running = out.split('\n').filter(Boolean).length
      let qq = ''
      try {
        const yml = fs.readFileSync(path.join(KOISHI_DIR, 'koishi.yml'), 'utf8')
        const m = yml.match(/selfId:\s*['\"]?(\d+)['\"]?/)
        if (m) qq = m[1]
      } catch {}
      return json(res, { running: running > 0, workers: running, qq })
    } catch { return json(res, { running: false, workers: 0 }) }
  }

  if (pathname === '/dashboard/api/bot/start' && req.method === 'POST') {
    if (!requireAdmin(req, res)) return
    exec(`bash "${path.join(KOISHI_DIR, 'restart.sh').replace(/\\/g, '/')}"`, (err) => {
      if (err) log('start bot failed: ' + err.message)
    })
    return json(res, { ok: true, message: '启动命令已发送' })
  }

  if (pathname === '/dashboard/api/bot/stop' && req.method === 'POST') {
    if (!requireAdmin(req, res)) return
    try {
      execSync("pkill -9 -f 'koishi'", { timeout: 5000 })
      return json(res, { ok: true, message: '已停止所有 koishi 进程' })
    } catch (e) { return json(res, { ok: false, message: e.message }) }
  }

  // 维护模式
  if (pathname === '/dashboard/api/maintenance' && req.method === 'GET') {
    return json(res, { enabled: !!readFileSync(path.join(DATA_DIR, 'ai-paused.txt')) })
  }
  if (pathname === '/dashboard/api/maintenance' && req.method === 'PUT') {
    if (!requireAdmin(req, res)) return
    let body = ''
    req.on('data', c => body += c)
    req.on('end', () => {
      try {
        const { enabled } = JSON.parse(body)
        const f = path.join(DATA_DIR, 'ai-paused.txt')
        if (enabled) writeFileSync(f, '优化中，别急')
        else try { fs.unlinkSync(f) } catch {}
        return json(res, { ok: true, message: enabled ? '维护模式已开启' : '维护模式已关闭' })
      } catch (e) { return json(res, { ok: false, message: e.message }, 400) }
    })
    return
  }

  // QQ 管理
  if (pathname === '/dashboard/api/qq/token' && req.method === 'GET') {
    return json(res, { token: process.env.NAPCAT_TOKEN || getNapcatToken() })
  }
  if (pathname === '/dashboard/api/qq/ssh-info' && req.method === 'GET') {
    return json(res, {
      host: process.env.DASHBOARD_SSH_HOST || '',
      user: process.env.DASHBOARD_SSH_USER || 'root',
      port: 22,
    })
  }

  // QQ 号切换
  if (pathname === '/dashboard/api/qq/selfid' && req.method === 'GET') {
    try {
      const yml = fs.readFileSync(path.join(KOISHI_DIR, 'koishi.yml'), 'utf8')
      const m = yml.match(/selfId:\s*['\"]?(\d+)['\"]?/)
      return json(res, { selfId: m ? m[1] : '' })
    } catch { return json(res, { selfId: '' }) }
  }
  if (pathname === '/dashboard/api/qq/selfid' && req.method === 'PUT') {
    if (!requireAdmin(req, res)) return
    let body = ''
    req.on('data', c => body += c)
    req.on('end', () => {
      try {
        const { selfId } = JSON.parse(body)
        if (!selfId || !/^\d+$/.test(selfId)) return json(res, { ok: false, message: '无效 QQ 号' }, 400)
        const ymlPath = path.join(KOISHI_DIR, 'koishi.yml')
        let yml = fs.readFileSync(ymlPath, 'utf8')
        yml = yml.replace(/(selfId:\s*['\"]?)\d+(['\"]?)/, '$1' + selfId + '$2')
        fs.writeFileSync(ymlPath, yml, 'utf8')
        // 自动重启 koishi
        exec(`bash "${path.join(KOISHI_DIR, 'restart.sh').replace(/\\/g, '/')}"`)
        json(res, { ok: true, message: 'QQ 号已更新，Koishi 正在重启...' })
      } catch (e) { json(res, { ok: false, message: e.message }, 400) }
    })
    return
  }

  // NapCat 管理
  if (pathname === '/dashboard/api/napcat/status' && req.method === 'GET') {
    try {
      execSync("ps aux | grep 'qq.*--no-sandbox' | grep -v grep", { encoding: 'utf8', timeout: 3000 })
      return json(res, { running: true })
    } catch { return json(res, { running: false }) }
  }
  if (pathname === '/dashboard/api/napcat/restart' && req.method === 'POST') {
    const qq = process.env.DASHBOARD_QQ_NUMBER || '3098291287'
    exec("screen -S napcat -X quit 2>/dev/null; sleep 2; screen -dmS napcat bash -c 'xvfb-run -a /root/Napcat/opt/QQ/qq --no-sandbox -q " + qq + "'")
    return json(res, { ok: true, message: 'NapCat 重启命令已发送' })
  }

  // ==== 部署管理 ====
  const DEPLOY_CONFIG_FILE = path.join(DATA_DIR, 'deploy-config.json')
  const DEPLOY_TASKS_DIR = path.join(DATA_DIR, 'deploy-tasks')
  if (!fs.existsSync(DEPLOY_TASKS_DIR)) fs.mkdirSync(DEPLOY_TASKS_DIR, { recursive: true })

  if (pathname === '/dashboard/api/deploy/config' && req.method === 'GET') {
    try {
      const cfg = JSON.parse(fs.readFileSync(DEPLOY_CONFIG_FILE, 'utf8'))
      let botRunning = false
      try { execSync('ss -tlnp | grep -q :5140', { stdio: 'ignore' }); botRunning = true } catch {}
      return json(res, { ...cfg, botRunning })
    }
    catch { return json(res, { server: '', appDir: '/root/koishi-app', botRunning: false }) }
  }

  if (pathname === '/dashboard/api/deploy/config' && req.method === 'PUT') {
    if (!requireAdmin(req, res)) return
    let body = ''
    req.on('data', c => body += c)
    req.on('end', () => {
      try {
        const cfg = JSON.parse(body)
        if (!cfg.server || !cfg.appDir) return json(res, { ok: false, message: '服务器地址和应用目录不能为空' }, 400)
        const tmp = DEPLOY_CONFIG_FILE + '.tmp'
        fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2), 'utf8')
        fs.renameSync(tmp, DEPLOY_CONFIG_FILE)
        json(res, { ok: true, message: '配置已保存' })
      } catch (e) { json(res, { ok: false, message: e.message }, 400) }
    })
    return
  }

  if (pathname === '/dashboard/api/deploy/run' && req.method === 'POST') {
    if (!requireAdmin(req, res)) return
    let body = ''
    req.on('data', c => body += c)
    req.on('end', () => {
      try {
        const cfg = JSON.parse(body)
        if (!cfg.server || !cfg.appDir) return json(res, { ok: false, message: '配置不完整' }, 400)
        const taskId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
        const logFile = path.join(DEPLOY_TASKS_DIR, taskId + '.log')
        const log = (msg) => { try { fs.appendFileSync(logFile, msg + '\n', 'utf8') } catch {} }
        json(res, { ok: true, taskId })

        const repoRoot = path.join(PLUGIN_ROOT, '..', '..')
        const s = cfg.server
        const d = cfg.appDir
        const pkgs = [
          'koishi-plugin-dongxuelian-ai', 'koishi-plugin-dongxuelian-help',
          'koishi-plugin-group-name-at', 'koishi-plugin-defense',
          'koishi-plugin-local-video-sender', 'koishi-plugin-group-leave-notice',
          'koishi-plugin-dongxuelian-poke', 'koishi-plugin-daily-report',
        ]
        const cmds = []
        cmds.push(`echo "创建远程目录..."`)
        cmds.push(`ssh -o StrictHostKeyChecking=no ${s} "mkdir -p ${d}/data/ai-skills ${d}/packages/koishi-plugin-dashboard/frontend/dist ${d}/scripts"`)
        for (const pkg of pkgs) {
          cmds.push(`echo "→ ${pkg}"`)
          cmds.push(`scp -r ${repoRoot}/packages/${pkg}/lib/* ${s}:${d}/node_modules/${pkg}/lib/ 2>/dev/null || true`)
          cmds.push(`scp ${repoRoot}/packages/${pkg}/package.json ${s}:${d}/node_modules/${pkg}/ 2>/dev/null || true`)
        }
        cmds.push(`echo "Dashboard 前端..."`)
        cmds.push(`scp ${PLUGIN_ROOT}/standalone.js ${s}:${d}/packages/koishi-plugin-dashboard/`)
        cmds.push(`scp -r ${DIST_DIR}/* ${s}:${d}/packages/koishi-plugin-dashboard/frontend/dist/`)
        cmds.push(`echo "ai-skills 数据..."`)
        cmds.push(`scp -r ${repoRoot}/packages/koishi-plugin-dongxuelian-ai/data/ai-skills/. ${s}:${d}/data/ai-skills/`)
        cmds.push(`echo "配置文件..."`)
        cmds.push(`scp ${DATA_DIR}/ai-*.txt ${s}:${d}/data/ 2>/dev/null || true`)
        cmds.push(`scp ${DATA_DIR}/ai-*-ids.json ${s}:${d}/data/ 2>/dev/null || true`)
        cmds.push(`scp ${DATA_DIR}/video-blacklist.json ${s}:${d}/data/ 2>/dev/null || true`)
        cmds.push(`scp ${DATA_DIR}/bilibili-cookies.txt ${s}:${d}/data/../ 2>/dev/null || true`)
        if (cfg.accessPwd) cmds.push(remoteWriteFileCommand(s, remoteDataFile(d, 'dashboard-access-pwd.txt'), cfg.accessPwd))
        if (cfg.adminPwd) cmds.push(remoteWriteFileCommand(s, remoteDataFile(d, 'dashboard-admin-pwd.txt'), cfg.adminPwd))
        cmds.push(`echo "视频插件环境..."`)
        cmds.push(`ssh ${s} "mkdir -p /root/koishi-bili-downloads"`)
        cmds.push(`ssh ${s} "which yt-dlp >/dev/null 2>&1 || (curl -sL https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp && chmod +x /usr/local/bin/yt-dlp)"`)
        cmds.push(`echo "重启脚本..."`)
        cmds.push(`scp ${repoRoot}/scripts/restart-bot.sh ${s}:${d}/restart.sh`)
        cmds.push(`scp ${repoRoot}/scripts/watchdog.sh ${s}:${d}/scripts/watchdog.sh`)
        cmds.push(`echo "确保 package.json..."`)
        cmds.push(`ssh ${s} "for p in ${pkgs.join(' ')}; do test -f ${d}/node_modules/\$p/package.json || echo '{}' > ${d}/node_modules/\$p/package.json; done"`)
        cmds.push(`echo "重启 Bot..."`)
        cmds.push(`ssh ${s} "bash ${d}/restart.sh"`)
        cmds.push(`echo "✅ 部署完成"`)

        let idx = 0
        function runNext() {
          if (idx >= cmds.length) { log('DONE'); return }
          log('$ ' + cmds[idx])
          exec(cmds[idx], { cwd: repoRoot, timeout: 60000 }, (err, stdout, stderr) => {
            if (stdout) log(stdout.trim())
            if (stderr) log(stderr.trim())
            if (err) { log('❌ ' + err.message); log('FAIL'); return }
            idx++; runNext()
          })
        }
        runNext()
      } catch (e) { json(res, { ok: false, message: e.message }, 400) }
    })
    return
  }

  if (pathname.startsWith('/dashboard/api/deploy/progress/') && req.method === 'GET') {
    const taskId = pathname.split('/').pop()
    if (!taskId) return json(res, { ok: false, message: '缺少 taskId' }, 400)
    try {
      const logFile = path.join(DEPLOY_TASKS_DIR, taskId + '.log')
      if (!fs.existsSync(logFile)) return json(res, { ok: false, lines: [], done: false })
      const raw = fs.readFileSync(logFile, 'utf8').trim()
      const lines = raw ? raw.split('\n') : []
      const done = lines.length > 0 && lines[lines.length - 1] === 'DONE'
      return json(res, { ok: true, lines, done })
    } catch { return json(res, { ok: false, lines: [], done: false }) }
  }

  if (pathname === '/dashboard/api/deploy/confirm' && req.method === 'POST') {
    if (!requireAdmin(req, res)) return
    try {
      const cfg = JSON.parse(fs.readFileSync(DEPLOY_CONFIG_FILE, 'utf8') || '{}')
      cfg.deployedAt = Date.now()
      const tmp = DEPLOY_CONFIG_FILE + '.tmp'
      fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2), 'utf8')
      fs.renameSync(tmp, DEPLOY_CONFIG_FILE)
      json(res, { ok: true })
    } catch (e) { json(res, { ok: false, message: e.message }, 400) }
    return
  }

  if (pathname === '/dashboard/api/deploy/upload' && req.method === 'POST') {
    if (!requireAdmin(req, res)) return
    let body = ''
    req.on('data', c => body += c)
    req.on('end', () => {
      try {
        const { name, data } = JSON.parse(body)
        if (!name || !data) return json(res, { ok: false, message: '文件名或内容为空' }, 400)
        const filePath = path.join(DATA_DIR, name)
        const buf = Buffer.from(data, 'base64')
        fs.writeFileSync(filePath, buf)
        json(res, { ok: true, message: name + ' 已保存到本地，部署时将自动推送' })
      } catch (e) { json(res, { ok: false, message: e.message }, 400) }
    })
    return
  }

  // 静态文件
  const serveFile = (filePath) => {
    try {
      if (fs.statSync(filePath).isFile()) {
        const ext = path.extname(filePath)
        const mime = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json', '.ico': 'image/x-icon' }[ext] || 'application/octet-stream'
        res.writeHead(200, { 'Content-Type': mime })
        res.end(fs.readFileSync(filePath))
        return
      }
    } catch {}
    res.writeHead(404)
    res.end('Not Found')
  }
  const reqPath = pathname.replace(/^\/dashboard\//, '')
  serveFile(path.join(DIST_DIR, reqPath || 'index.html'))
})

server.listen(PORT, () => {
  log(`dashboard running on http://localhost:${PORT}/dashboard/`)
  log(`bot control: start/stop/maintenance`)
  log(`napcat proxy: /webui/ -> NapCat WebUI`)
})

process.on('SIGINT', () => { log('shutting down'); server.close(); process.exit(0) })
process.on('SIGTERM', () => { log('shutting down'); server.close(); process.exit(0) })
