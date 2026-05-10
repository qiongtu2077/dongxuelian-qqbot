#!/usr/bin/env node
/**
 * Dashboard 独立服务器
 * 不依赖 koishi，独立进程运行在 5150 端口
 * 用法: node standalone.js &
 */
const fs = require('fs')
const path = require('path')
const http = require('http')
const https = require('https')
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

const MAX_BODY_SIZE = 1024 * 512 // 512KB 请求体上限

function collectBody(req, res, callback) {
  let body = ''
  req.on('data', c => {
    body += c
    if (Buffer.byteLength(body) > MAX_BODY_SIZE) {
      res.writeHead(413, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: false, message: '请求体过大' }))
      req.destroy()
      return
    }
  })
  req.on('end', () => callback(body))
}

// ====== 路径配置 ======
const PLUGIN_ROOT = __dirname
const AI_LIB = path.join(PLUGIN_ROOT, '..', 'koishi-plugin-dongxuelian-ai', 'lib')
const DATA_DIR = process.env.DONGXUELIAN_AI_DATA_DIR || path.join(KOISHI_DIR, 'data') || path.join(PLUGIN_ROOT, '..', 'koishi-plugin-dongxuelian-ai', 'data')
const PERSONAS_DIR = path.join(DATA_DIR, 'ai-skills', 'personas')
const CORE_DIR = path.join(DATA_DIR, 'ai-skills', 'core')
const LORES_DIR = path.join(DATA_DIR, 'ai-skills', 'lore')
const MODES_DIR = path.join(DATA_DIR, 'ai-skills', 'modes')
const DIST_DIR = path.join(PLUGIN_ROOT, 'frontend', 'dist')
const PORT = process.env.DASHBOARD_PORT || 5150
const KOISHI_DIR = process.env.KOISHI_DIR || path.join(PLUGIN_ROOT, '..', '..')
const PASSWORD = process.env.DASHBOARD_PASSWORD || '123'
const ADMIN_PASSWORD = process.env.DASHBOARD_ADMIN_PASSWORD || '123'

const ADMIN_PWD_FILE = path.join(DATA_DIR, 'dashboard-admin-pwd.txt')
const ACCESS_PWD_FILE = path.join(DATA_DIR, 'dashboard-access-pwd.txt')
const LEGACY_ACCESS_PWD_FILE = path.join(DATA_DIR, 'dashboard-pwd.txt')
const RESET_TOKEN_FILE = path.join(DATA_DIR, 'password-reset-token.txt')
const CUSTOM_PROVIDERS_FILE = path.join(DATA_DIR, 'ai-providers-custom.json')
const FALLBACK_CHAINS_FILE = path.join(DATA_DIR, 'ai-fallback-chains.json')

// ====== 默认 fallback 链（按 AI 用途分类） ======
const DEFAULT_FALLBACK_CHAINS = {
  chat: [
    { provider: 'glm', model: 'glm-4.6v-flash', keyFile: 'ai-glm-key.txt' },
    { provider: 'opencode', model: 'deepseek-v4-flash', keyFile: 'ai-openai-key.txt' },
    { provider: 'dashscope', model: 'qwen3.5-omni-flash', keyFile: 'ai-dashscope-key.txt' },
    { provider: 'dashscope', model: 'qwen3.5-plus', keyFile: 'ai-dashscope-key.txt' },
  ],
  vision: [
    { provider: 'glm', model: 'glm-4.6v-flash', keyFile: 'ai-glm-key.txt' },
    { provider: 'mimorium', model: 'mimo-v2-omni', keyFile: 'ai-mimorium-key.txt' },
    { provider: 'dashscope', model: 'qwen3.5-omni-flash', keyFile: 'ai-dashscope-key.txt' },
    { provider: 'dashscope', model: 'qwen3.5-plus', keyFile: 'ai-dashscope-key.txt' },
  ],
  lightweight: [
    { provider: 'glm', model: 'glm-4.6v-flash', keyFile: 'ai-glm-key.txt' },
    { provider: 'opencode', model: 'deepseek-v4-flash', keyFile: 'ai-openai-key.txt' },
    { provider: 'dashscope', model: 'qwen3.5-omni-flash', keyFile: 'ai-dashscope-key.txt' },
    { provider: 'dashscope', model: 'qwen3.5-plus', keyFile: 'ai-dashscope-key.txt' },
  ],
}

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

function isLocalAuthBypass(req) {
  if (/^(?:1|true|yes|on)$/i.test(String(process.env.GLOBAL_LOCAL_MODE || '').trim())) return true
  if (!req) return false
  const host = req.headers?.host || ''
  return /^(?:localhost|127\.0\.0\.1|::1)(?::\d+)?$/i.test(host.trim())
}

function stopKoishiProcesses() {
  if (process.platform === 'win32') {
    execSync('powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $_.Name -match \'node\' -and $_.CommandLine -match \'koishi\' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }"', { timeout: 8000, stdio: 'ignore' })
    return
  }
  execSync("pkill -9 -f 'koishi/lib/worker' 2>/dev/null || true", { timeout: 5000 })
  execSync("pkill -9 -f 'node.*koishi start' 2>/dev/null || true", { timeout: 5000 })
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

function isInsidePath(parent, child) {
  const rel = path.relative(path.resolve(parent), path.resolve(child))
  return rel === '' || (!!rel && !rel.startsWith('..') && !path.isAbsolute(rel))
}

function copyRecursiveSync(src, dst) {
  if (!fs.existsSync(src)) return
  const stat = fs.statSync(src)
  if (stat.isDirectory()) {
    fs.mkdirSync(dst, { recursive: true })
    for (const entry of fs.readdirSync(src)) copyRecursiveSync(path.join(src, entry), path.join(dst, entry))
    return
  }
  fs.mkdirSync(path.dirname(dst), { recursive: true })
  fs.copyFileSync(src, dst)
}

function getCommandVersion(command) {
  try { return execSync(command, { timeout: 3000, encoding: 'utf8' }).trim() } catch { return '' }
}

function checkPortAvailable(port) {
  try {
    const cmd = process.platform === 'win32'
      ? `netstat -ano | findstr ":${port}"`
      : `ss -tlnp | grep -q :${port}`
    const out = execSync(cmd, { timeout: 3000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    return process.platform === 'win32' ? !out.trim() : false
  } catch { return true }
}

function runtimePath(...parts) {
  return path.join(KOISHI_DIR, 'runtime', ...parts)
}

function writeRuntimeLayout() {
  const dirs = [
    runtimePath(),
    runtimePath('downloads'),
    runtimePath('logs'),
    runtimePath('napcat'),
    path.join(KOISHI_DIR, 'data'),
    path.join(KOISHI_DIR, 'node_modules'),
  ]
  for (const dir of dirs) fs.mkdirSync(dir, { recursive: true })
}

function testChinesePathWrite(dir) {
  try {
    const testFile = path.join(dir, '中文路径写入测试.tmp')
    fs.writeFileSync(testFile, 'ok', 'utf8')
    const ok = fs.readFileSync(testFile, 'utf8') === 'ok'
    fs.unlinkSync(testFile)
    return { ok }
  } catch (e) { return { ok: false, message: e.message } }
}

function downloadToRuntime(url, callback) {
  let parsed
  try { parsed = new URL(url) } catch { callback(new Error('下载地址无效')); return }
  if (!['http:', 'https:'].includes(parsed.protocol)) { callback(new Error('只支持 http/https 下载地址')); return }
  writeRuntimeLayout()
  const name = decodeURIComponent(path.basename(parsed.pathname || 'napcat-download')).replace(/[<>:"/\\|?*]/g, '_') || 'napcat-download.bin'
  const filePath = runtimePath('downloads', name)
  const client = parsed.protocol === 'https:' ? https : http
  const req = client.get(parsed, (response) => {
    if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
      response.resume()
      downloadToRuntime(response.headers.location, callback)
      return
    }
    if (response.statusCode !== 200) {
      response.resume()
      callback(new Error('下载失败：HTTP ' + response.statusCode))
      return
    }
    const stream = fs.createWriteStream(filePath)
    response.pipe(stream)
    stream.on('finish', () => stream.close(() => callback(null, filePath)))
    stream.on('error', callback)
  })
  req.setTimeout(120000, () => req.destroy(new Error('下载超时')))
  req.on('error', callback)
}

// 前端重建状态
let rebuildStatus = { state: 'idle', message: '' }

// 版本指纹：对关键代码文件做 hash，不依赖 git
function computeFingerprint() {
  try {
    const repoRoot = path.join(PLUGIN_ROOT, '..', '..')
    const keyFiles = [
      'packages/koishi-plugin-dongxuelian-ai/lib/index.js',
      'packages/koishi-plugin-dashboard/standalone.js',
      'packages/koishi-plugin-daily-report/lib/index.js',
      'packages/koishi-plugin-dongxuelian-ai/lib/chat.js',
      'packages/koishi-plugin-dongxuelian-ai/lib/handler.js',
    ]
    const hash = crypto.createHash('md5')
    for (const f of keyFiles) {
      try { hash.update(fs.readFileSync(path.join(repoRoot, f))) } catch {}
    }
    return hash.digest('hex').slice(0, 8)
  } catch { return 'unknown' }
}

// ====== Auth ======
function createToken() {
  return crypto.createHash('sha256').update('dashboard:' + getAccessPassword()).digest('hex')
}

function validateToken(token) {
  return token === createToken()
}

// ====== 管理员密码系统（敏感操作二次验证） ======
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

function generateResetToken() {
  const token = crypto.randomBytes(16).toString('hex')
  try {
    fs.mkdirSync(path.dirname(RESET_TOKEN_FILE), { recursive: true })
    fs.writeFileSync(RESET_TOKEN_FILE, token, 'utf8')
  } catch (e) { log('WARNING: 无法写入重置令牌文件: ' + e.message) }
  return token
}

function getResetToken() {
  return readFileSync(RESET_TOKEN_FILE) || ''
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

// ====== NapCat Token ======
function getNapcatToken() {
  if (getNapcatToken._cached) return getNapcatToken._cached
  const candidates = [
    path.join(KOISHI_DIR, 'runtime', 'napcat', 'config', 'webui.json'),
    path.join(KOISHI_DIR, 'runtime', 'NapCat', 'config', 'webui.json'),
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
  res.setHeader('Access-Control-Allow-Methods', 'GET, PUT, POST, DELETE, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Admin-Token')

  if (req.method === 'OPTIONS') {
    res.writeHead(204)
    res.end()
    return
  }

  // 登录
  if (pathname === '/dashboard/api/login' && req.method === 'POST') {
    collectBody(req, res, (body) => {
      try {
        const { password } = JSON.parse(body)
        const stored = getAccessPassword()
        if (!stored && !isLocalAuthBypass(req)) {
          log('login rejected: access password is not configured')
          return json(res, { ok: false, message: '访问密码未配置' }, 503)
        }
        const match = isLocalAuthBypass(req) || (!!stored && password === stored)
        if (match) return json(res, { ok: true, token: createToken() })
        log('login failed')
        return json(res, { ok: false, message: '密码错误' }, 401)
      } catch { return json(res, { ok: false, message: '无效请求' }, 400) }
    })
    return
  }

  // 管理员验证（不需要普通登录）
  if (pathname === '/dashboard/api/admin/verify' && req.method === 'POST') {
    if (isLocalAuthBypass(req)) return json(res, { ok: true, token: createAdminToken() })
    collectBody(req, res, (body) => {
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
    collectBody(req, res, (body) => {
      try {
        const { type, oldPassword, newPassword } = JSON.parse(body)
        if (!newPassword || newPassword.length < 3) return json(res, { ok: false, message: '新密码长度不能少于3位' }, 400)
        if (!/^[A-Za-z0-9_~!@#$%^&*()\-+=\[\]{}<>,.?/|\\:;"'`]+$/.test(newPassword)) {
          return json(res, { ok: false, message: '密码仅支持大小写字母、数字、下划线和常见特殊字符' }, 400)
        }
        if (type === 'admin') {
          if (oldPassword !== getAdminPassword()) return json(res, { ok: false, message: '当前管理员密码错误' }, 401)
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

  // 忘记密码 - 通过重置令牌恢复默认密码
  if (pathname === '/dashboard/api/auth/reset-password' && req.method === 'POST') {
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
    return
  }

  // Auth 检查（显式本地模式自动放行）
  if (pathname.startsWith('/dashboard/api/') && !isLocalAuthBypass(req)) {
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
    const merged = { ...PROVIDERS }
    try {
      const raw = fs.readFileSync(CUSTOM_PROVIDERS_FILE, 'utf8')
      const custom = JSON.parse(raw)
      if (Array.isArray(custom)) {
        for (const p of custom) {
          if (p.id && p.name && p.baseURL) {
            merged[p.id] = { name: p.name, baseURL: p.baseURL, models: Array.isArray(p.models) ? p.models : [] }
          }
        }
      }
    } catch {}
    return json(res, merged)
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
    collectBody(req, res, (body) => {
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
        return json(res, { ok: true, data: { name, description: meta.description || '', lore: meta.lore || '', will: meta.will || 1.0, nsfw: meta.nsfw || 'none', content: bodyContent } })
      }
      return json(res, getAvailablePersonals().map(p => ({ name: p.name, description: p.description, type: p.type || 'persona' })))
    } catch { return json(res, []) }
  }

  if (pathname === '/dashboard/api/personas' && req.method === 'POST') {
    if (!requireAdmin(req, res)) return
    collectBody(req, res, (body) => {
      try {
        const { name, description, lore, will, nsfw, content } = JSON.parse(body)
        if (!name || !content) return json(res, { ok: false, message: '名称和内容不能为空' }, 400)
        const sanitized = name.replace(/[^a-zA-Z0-9\u4e00-\u9fff_-]/g, '')
        const filePath = path.join(PERSONAS_DIR, 'SKILL.' + sanitized + '.md')
        if (fs.existsSync(filePath)) return json(res, { ok: false, message: '同名人格已存在' }, 400)
        const loreLine = lore && lore !== 'none' ? '\nlore: ' + lore : ''
        const willLine = will !== undefined && will !== '' ? '\nwill: ' + parseFloat(will) : '\nwill: 1.0'
        const nsfwLine = nsfw && nsfw !== 'none' ? '\nnsfw: ' + nsfw : ''
        const md = '---\nname: ' + sanitized + '\ndescription: ' + (description || '') + loreLine + willLine + nsfwLine + '\n---\n\n' + content
        fs.writeFileSync(filePath, md, 'utf8')
        json(res, { ok: true, message: '人格 ' + sanitized + ' 已创建' })
      } catch (e) { json(res, { ok: false, message: e.message }, 400) }
    })
    return
  }

  if (pathname === '/dashboard/api/personas' && req.method === 'DELETE') {
    if (!requireAdmin(req, res)) return
    collectBody(req, res, (body) => {
      try {
        const { name } = JSON.parse(body)
        if (!name) return json(res, { ok: false, message: '名称不能为空' }, 400)
        const all = require(path.join(AI_LIB, 'persona')).getAvailablePersonals()
        if (all.find(p => p.name === name)?.type === 'core') return json(res, { ok: false, message: '核心规则不可删除' }, 400)
        if (all.find(p => p.name === name)?.type === 'mode') return json(res, { ok: false, message: '默认人格不可删除' }, 400)
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
    collectBody(req, res, (body) => {
      try {
        const { name, description, lore, will, nsfw, content } = JSON.parse(body)
        if (!name || !content) return json(res, { ok: false, message: '名称和内容不能为空' }, 400)
        const searchDirs = [PERSONAS_DIR, CORE_DIR, MODES_DIR]
        let found = false
        for (const dir of searchDirs) {
          const files = fs.readdirSync(dir).filter(f => /^SKILL(\.[^.]+)?\.md$/i.test(f))
          for (const f of files) {
            const raw = fs.readFileSync(path.join(dir, f), 'utf8')
            const m = raw.match(/^---\n([\s\S]*?)\n---/)
            const metaName = m?.[1]?.match(/name:\s*(.+)/)?.[1]?.trim()
            if (metaName === name) {
              const loreLine = lore && lore !== 'none' ? '\nlore: ' + lore : ''
              const willLine = will !== undefined && will !== '' ? '\nwill: ' + parseFloat(will) : '\nwill: 1.0'
              const nsfwLine = nsfw && nsfw !== 'none' ? '\nnsfw: ' + nsfw : ''
              const md = '---\nname: ' + name + '\ndescription: ' + (description || '') + loreLine + willLine + nsfwLine + '\n---\n\n' + content
              fs.writeFileSync(path.join(dir, f), md, 'utf8')
              found = true
              break
            }
          }
          if (found) break
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
    collectBody(req, res, (body) => {
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
    collectBody(req, res, (body) => {
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
    collectBody(req, res, (body) => {
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
    collectBody(req, res, (body) => {
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
    collectBody(req, res, (body) => {
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

  // 自定义供应商管理
  if (pathname === '/dashboard/api/providers/custom' && req.method === 'GET') {
    try {
      const raw = fs.readFileSync(CUSTOM_PROVIDERS_FILE, 'utf8')
      return json(res, JSON.parse(raw))
    } catch { return json(res, []) }
  }
  if (pathname === '/dashboard/api/providers/custom' && req.method === 'PUT') {
    if (!requireAdmin(req, res)) return
    collectBody(req, res, (body) => {
      try {
        const data = JSON.parse(body)
        if (!Array.isArray(data)) return json(res, { ok: false, message: '参数错误' }, 400)
        fs.writeFileSync(CUSTOM_PROVIDERS_FILE + '.tmp', JSON.stringify(data, null, 2), 'utf8')
        fs.renameSync(CUSTOM_PROVIDERS_FILE + '.tmp', CUSTOM_PROVIDERS_FILE)
        json(res, { ok: true, message: '自定义供应商已更新' })
      } catch (e) { json(res, { ok: false, message: e.message }, 400) }
    })
    return
  }

  // Fallback 链管理
  if (pathname === '/dashboard/api/fallback' && req.method === 'GET') {
    function buildProviderMap() {
      const ps = {}
      const pDefs = require(path.join(AI_LIB, 'constants')).PROVIDERS
      for (const key of Object.keys(pDefs)) ps[key] = pDefs[key]
      try {
        const customRaw = fs.readFileSync(CUSTOM_PROVIDERS_FILE, 'utf8')
        const custom = JSON.parse(customRaw)
        if (Array.isArray(custom)) custom.forEach(function(p) { if (p.id) ps[p.id] = p })
      } catch {}
      return ps
    }
    try {
      const raw = fs.readFileSync(FALLBACK_CHAINS_FILE, 'utf8')
      const data = JSON.parse(raw)
      return json(res, { chains: data, defaults: DEFAULT_FALLBACK_CHAINS, providers: buildProviderMap() })
    } catch {
      return json(res, { chains: DEFAULT_FALLBACK_CHAINS, defaults: DEFAULT_FALLBACK_CHAINS, providers: buildProviderMap() })
    }
  }
  if (pathname === '/dashboard/api/fallback' && req.method === 'PUT') {
    if (!requireAdmin(req, res)) return
    collectBody(req, res, (body) => {
      try {
        const { chains } = JSON.parse(body)
        if (!chains || typeof chains !== 'object') return json(res, { ok: false, message: '参数错误' }, 400)
        const tmp = FALLBACK_CHAINS_FILE + '.tmp'
        fs.writeFileSync(tmp, JSON.stringify(chains, null, 2), 'utf8')
        fs.renameSync(tmp, FALLBACK_CHAINS_FILE)
        json(res, { ok: true, message: 'Fallback 链已更新' })
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

  // 管理员列表管理
  const ADMIN_IDS_FILE = path.join(DATA_DIR, 'ai-admin-ids.json')

  if (pathname === '/dashboard/api/admin-ids' && req.method === 'GET') {
    try {
      const raw = fs.readFileSync(ADMIN_IDS_FILE, 'utf8')
      const ids = JSON.parse(raw)
      return json(res, { ids: Array.isArray(ids) ? ids : [] })
    } catch {
      // 文件不存在时返回默认管理员
      const defaults = ['100000000', '200000000']
      try {
        const tmp = ADMIN_IDS_FILE + '.tmp'
        fs.writeFileSync(tmp, JSON.stringify(defaults, null, 2), 'utf8')
        fs.renameSync(tmp, ADMIN_IDS_FILE)
      } catch {}
      return json(res, { ids: defaults })
    }
  }

  if (pathname === '/dashboard/api/admin-ids' && req.method === 'PUT') {
    if (!requireAdmin(req, res)) return
    collectBody(req, res, (body) => {
      try {
        const { ids } = JSON.parse(body)
        if (!Array.isArray(ids)) return json(res, { ok: false, message: '参数错误' }, 400)
        const cleaned = ids.map(String).filter(Boolean)
        const tmp = ADMIN_IDS_FILE + '.tmp'
        fs.writeFileSync(tmp, JSON.stringify(cleaned, null, 2), 'utf8')
        fs.renameSync(tmp, ADMIN_IDS_FILE)
        try {
          const { resetConfigCache } = require(path.join(AI_LIB, 'runtime-config'))
          resetConfigCache()
        } catch {}
        return json(res, { ok: true, message: '管理员列表已更新' })
      } catch { return json(res, { ok: false, message: '无效请求' }, 400) }
    })
    return
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
      let running = 0
      if (process.platform === 'win32') {
        running = !checkPortAvailable(5140) ? 1 : 0
      } else {
        const out = execSync("ps aux | grep 'koishi/lib/worker' | grep -v grep", { encoding: 'utf8', timeout: 3000 }).trim()
        running = out.split('\n').filter(Boolean).length
      }
      let qq = ''
      try {
        const yml = fs.readFileSync(path.join(KOISHI_DIR, 'koishi.yml'), 'utf8')
        const m = yml.match(/selfId:\s*['\"]?(\d+)['\"]?/)
        if (m) qq = m[1]
      } catch {}
      return json(res, { running: running > 0, workers: running, qq })
    } catch { return json(res, { running: false, workers: 0 }) }
  }

  // Bot 活动日志
  if (pathname === '/dashboard/api/bot/activity' && req.method === 'GET') {
    try {
      const logFile = path.join(KOISHI_DIR, 'koishi.log')
      if (!fs.existsSync(logFile)) return json(res, { lines: [] })
      const out = execSync('tail -n 100 ' + shellQuote(logFile), { timeout: 5000, encoding: 'utf8', maxBuffer: 1024 * 1024 })
      const lines = out.trim().split('\n').filter(l => l.includes('entry-debug') || l.includes('chat') || l.includes('repeat') || l.includes('random-reply') || l.includes('banned') || l.includes('sticker'))
      return json(res, { lines, total: lines.length })
    } catch { return json(res, { lines: [] }) }
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
      stopKoishiProcesses()
      return json(res, { ok: true, message: '已停止所有 koishi 进程' })
    } catch (e) { return json(res, { ok: false, message: e.message }) }
  }

  // 维护模式
  if (pathname === '/dashboard/api/maintenance' && req.method === 'GET') {
    return json(res, { enabled: !!readFileSync(path.join(DATA_DIR, 'ai-paused.txt')) })
  }
  if (pathname === '/dashboard/api/maintenance' && req.method === 'PUT') {
    if (!requireAdmin(req, res)) return
    collectBody(req, res, (body) => {
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
    if (!requireAdmin(req, res)) return
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
    collectBody(req, res, (body) => {
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
    const raw = process.env.DASHBOARD_QQ_NUMBER || '123456789'
    const qq = raw.replace(/[^0-9]/g, '')
    if (!qq) return json(res, { ok: false, message: '无效 QQ 号' }, 400)
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
      cfg._localFingerprint = computeFingerprint()
      return json(res, { ...cfg, botRunning })
    }
    catch { return json(res, { server: '', appDir: '/root/koishi-app', botRunning: false, _localFingerprint: computeFingerprint() }) }
  }

  if (pathname === '/dashboard/api/deploy/check-update' && req.method === 'GET') {
    const local = computeFingerprint()
    let deployed = ''
    try {
      const cfg = JSON.parse(fs.readFileSync(DEPLOY_CONFIG_FILE, 'utf8'))
      deployed = cfg.deployFingerprint || ''
    } catch {}
    return json(res, { local, deployed, upToDate: local === deployed })
  }

  if (pathname === '/dashboard/api/deploy/config' && req.method === 'PUT') {
    if (!requireAdmin(req, res)) return
    collectBody(req, res, (body) => {
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
    collectBody(req, res, (body) => {
      try {
        const cfg = JSON.parse(body)
        if (!cfg.server || !cfg.appDir) return json(res, { ok: false, message: '配置不完整' }, 400)
        const taskId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
        const logFile = path.join(DEPLOY_TASKS_DIR, taskId + '.log')
        const log = (msg) => { try { fs.appendFileSync(logFile, msg + '\n', 'utf8') } catch {} }
        json(res, { ok: true, taskId })

        const isUpdate = cfg.mode === 'update'
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
        if (!isUpdate) {
          cmds.push(`echo "创建远程目录..."`)
          cmds.push(`ssh -o StrictHostKeyChecking=no ${s} "mkdir -p ${d}/data/ai-skills ${d}/packages/koishi-plugin-dashboard/frontend/dist ${d}/scripts"`)
        }
        for (const pkg of pkgs) {
          cmds.push(`echo "→ ${pkg}"`)
          cmds.push(`scp -o StrictHostKeyChecking=no -r ${repoRoot}/packages/${pkg}/lib/* ${s}:${d}/node_modules/${pkg}/lib/ 2>/dev/null || true`)
          cmds.push(`scp -o StrictHostKeyChecking=no ${repoRoot}/packages/${pkg}/package.json ${s}:${d}/node_modules/${pkg}/ 2>/dev/null || true`)
        }
        cmds.push(`echo "Dashboard 前端..."`)
        cmds.push(`scp -o StrictHostKeyChecking=no ${PLUGIN_ROOT}/standalone.js ${s}:${d}/packages/koishi-plugin-dashboard/`)
        cmds.push(`scp -o StrictHostKeyChecking=no -r ${DIST_DIR}/* ${s}:${d}/packages/koishi-plugin-dashboard/frontend/dist/`)
        if (!isUpdate) {
          cmds.push(`echo "视频插件环境..."`)
          cmds.push(`ssh ${s} "mkdir -p /root/koishi-bili-downloads"`)
          cmds.push(`ssh ${s} "which yt-dlp >/dev/null 2>&1 || (curl -sL https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp && chmod +x /usr/local/bin/yt-dlp)"`)
        }
        cmds.push(`echo "重启脚本..."`)
        cmds.push(`scp -o StrictHostKeyChecking=no ${repoRoot}/scripts/restart-bot.sh ${s}:${d}/restart.sh 2>/dev/null || true`)
        cmds.push(`scp -o StrictHostKeyChecking=no ${repoRoot}/scripts/watchdog.sh ${s}:${d}/scripts/watchdog.sh 2>/dev/null || true`)
        if (!isUpdate) {
          cmds.push(`echo "确保 package.json..."`)
          cmds.push(`ssh ${s} "for p in ${pkgs.join(' ')}; do test -f ${d}/node_modules/\$p/package.json || echo '{}' > ${d}/node_modules/\$p/package.json; done"`)
        }
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
      const lastLine = lines.length > 0 ? lines[lines.length - 1] : ''
      const done = lastLine === 'DONE' || lastLine === 'FAIL'
      return json(res, { ok: true, lines, done, success: lastLine === 'DONE' })
    } catch { return json(res, { ok: false, lines: [], done: false }) }
  }

  if (pathname === '/dashboard/api/frontend/rebuild' && req.method === 'POST') {
    if (!requireAdmin(req, res)) return
    if (rebuildStatus.state === 'building') {
      return json(res, { ok: false, message: '正在构建中，请等待完成' })
    }
    const FE_DIR = path.join(PLUGIN_ROOT, 'frontend')
    if (!fs.existsSync(path.join(FE_DIR, 'node_modules'))) {
      return json(res, { ok: false, message: '前端依赖未安装，请先在 frontend 目录执行 npm install' })
    }
    rebuildStatus = { state: 'building', message: '' }
    const isWin = process.platform === 'win32'
    const backupCmd = isWin
      ? `cd /d "${FE_DIR}" && if exist dist (xcopy /E /I /Q /Y dist dist.bak >nul) & npm run build`
      : `cd "${FE_DIR}" && [ -d dist ] && cp -r dist dist.bak; npm run build`
    const rollbackCmd = isWin
      ? `cd /d "${FE_DIR}" && if exist dist.bak (rmdir /S /Q dist 2>nul & ren dist.bak dist)`
      : `cd "${FE_DIR}" && rm -rf dist && mv dist.bak dist`
    const cleanupCmd = isWin
      ? `cd /d "${FE_DIR}" && if exist dist.bak (rmdir /S /Q dist.bak)`
      : `cd "${FE_DIR}" && rm -rf dist.bak`
    exec(backupCmd, { timeout: 120000 }, (err, stdout, stderr) => {
      if (err) {
        exec(rollbackCmd, () => {})
        const detail = (stderr || err.message || '').slice(0, 200)
        rebuildStatus = { state: 'failed', message: '构建失败，已自动回退。' + (detail ? ' 原因: ' + detail : '') }
        log('frontend rebuild failed: ' + detail)
      } else {
        exec(cleanupCmd, () => {})
        rebuildStatus = { state: 'success', message: '前端构建成功，请刷新页面' }
        log('frontend rebuild success')
      }
    })
    return json(res, { ok: true, message: '前端构建已启动' })
  }

  if (pathname === '/dashboard/api/frontend/rebuild-status' && req.method === 'GET') {
    return json(res, rebuildStatus)
  }

  if (pathname === '/dashboard/api/deploy/confirm' && req.method === 'POST') {
    if (!requireAdmin(req, res)) return
    try {
      let cfg = {}
      try { cfg = JSON.parse(fs.readFileSync(DEPLOY_CONFIG_FILE, 'utf8')) } catch {}
      cfg.deployedAt = Date.now()
      cfg.deployFingerprint = computeFingerprint()
      const tmp = DEPLOY_CONFIG_FILE + '.tmp'
      fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2), 'utf8')
      fs.renameSync(tmp, DEPLOY_CONFIG_FILE)
      json(res, { ok: true })
    } catch (e) { json(res, { ok: false, message: e.message }, 400) }
    return
  }

  if (pathname === '/dashboard/api/deploy/upload' && req.method === 'POST') {
    if (!requireAdmin(req, res)) return
    collectBody(req, res, (body) => {
      try {
        const { name, data } = JSON.parse(body)
        if (!name || !data) return json(res, { ok: false, message: '文件名或内容为空' }, 400)
        if (name.includes('..') || name.includes('/') || name.includes('\\')) return json(res, { ok: false, message: '无效文件名' }, 400)
        const filePath = path.join(DATA_DIR, name)
        const buf = Buffer.from(data, 'base64')
        fs.writeFileSync(filePath, buf)
        json(res, { ok: true, message: name + ' 已保存到本地，部署时将自动推送' })
      } catch (e) { json(res, { ok: false, message: e.message }, 400) }
    })
    return
  }

  // 环境检测
  if (pathname === '/dashboard/api/env/check' && req.method === 'GET') {
    try { writeRuntimeLayout() } catch {}
    const nodeVersion = getCommandVersion('node --version')
    const npmVersion = getCommandVersion('npm --version')
    const napcatCandidates = [
      runtimePath('napcat'),
      path.join(KOISHI_DIR, 'NapCat'),
      process.env.NAPCAT_DIR || '',
      process.platform === 'win32' ? path.join(KOISHI_DIR, 'runtime', 'NapCat') : '/root/Napcat',
    ].filter(Boolean)
    let napcat = { found: false, path: runtimePath('napcat') }
    for (const candidate of napcatCandidates) {
      try {
        if (fs.existsSync(candidate) && fs.readdirSync(candidate).length > 0) { napcat = { found: true, path: candidate }; break }
      } catch {}
    }
    return json(res, {
      platform: process.platform,
      projectDir: path.resolve(KOISHI_DIR),
      runtimeDir: runtimePath(),
      node: { found: !!nodeVersion, version: nodeVersion },
      npm: { found: !!npmVersion, version: npmVersion },
      workDir: { exists: fs.existsSync(KOISHI_DIR), path: path.resolve(KOISHI_DIR), writable: fs.existsSync(KOISHI_DIR) },
      pathEncoding: testChinesePathWrite(runtimePath('logs')),
      ports: {
        5140: { available: checkPortAvailable(5140) },
        5150: { available: checkPortAvailable(Number(PORT)) },
        8080: { available: checkPortAvailable(8080) },
        6099: { available: checkPortAvailable(6099) },
      },
      napcat,
    })
  }

  // 本地部署
  let localBotProcess = null

  if (pathname === '/dashboard/api/deploy/local' && req.method === 'POST') {
    if (!requireAdmin(req, res)) return
    collectBody(req, res, (body) => {
      try {
        const cfg = JSON.parse(body)
        const workDir = path.resolve(KOISHI_DIR)
        const qq = String(cfg.qq || '').trim()
        if (!/^\d+$/.test(qq)) return json(res, { ok: false, message: 'QQ 号不能为空或格式错误' }, 400)
        if (!isInsidePath(KOISHI_DIR, workDir)) return json(res, { ok: false, message: '本地部署目录必须在当前项目目录内' }, 400)
        writeRuntimeLayout()
        const pkgs = ['koishi-plugin-dongxuelian-ai','koishi-plugin-dongxuelian-help','koishi-plugin-group-name-at','koishi-plugin-defense','koishi-plugin-local-video-sender','koishi-plugin-group-leave-notice','koishi-plugin-dongxuelian-poke','koishi-plugin-daily-report']
        for (const pkg of pkgs) {
          const src = path.join(PLUGIN_ROOT, '..', pkg)
          const dst = path.join(workDir, 'node_modules', pkg)
          if (require('fs').existsSync(src)) {
            copyRecursiveSync(path.join(src, 'lib'), path.join(dst, 'lib'))
            copyRecursiveSync(path.join(src, 'package.json'), path.join(dst, 'package.json'))
          }
        }
        writeFileSync(path.join(workDir, 'data', 'ai-provider.txt'), cfg.provider || 'opencode')
        writeFileSync(path.join(workDir, 'data', 'ai-model.txt'), cfg.model || '')
        writeFileSync(path.join(workDir, 'data', 'ai-base-url.txt'), cfg.baseUrl || '')
        if (cfg.apiKey) writeFileSync(path.join(workDir, 'data', 'ai-openai-key.txt'), cfg.apiKey)
        if (cfg.adminIds) writeFileSync(path.join(workDir, 'data', 'ai-admin-ids.json'), JSON.stringify(cfg.adminIds, null, 2))
        const yml = `port: 5140\nselfUrl: http://localhost:5140\nplugins:\n  adapter-onebot:\n    protocol: ws\n    selfId: '${qq}'\n    endpoint: ws://127.0.0.1:8080/onebot/v11/ws\n  dongxuelian-ai: {}\n  dongxuelian-help: {}\n  group-name-at: {}\n  defense: {}\n  local-video-sender: {}\n  group-leave-notice: {}\n  dongxuelian-poke: {}\n  daily-report: {}\n`
        writeFileSync(path.join(workDir, 'koishi.yml'), yml)
        const helper = `@echo off\r\nchcp 65001 >nul\r\ncd /d "%~dp0"\r\nif not exist node_modules ( npm install )\r\nnpx koishi start\r\n`
        fs.writeFileSync(path.join(workDir, 'start-local.bat'), helper, 'utf8')
        json(res, { ok: true, message: '本地部署配置已写入，运行 start-local.bat 启动 Koishi，NapCat 使用 8080 OneBot WebSocket' })
      } catch (e) { json(res, { ok: false, message: e.message }, 400) }
    })
    return
  }

  if (pathname === '/dashboard/api/deploy/napcat-download' && req.method === 'POST') {
    if (!requireAdmin(req, res)) return
    collectBody(req, res, (body) => {
      try {
        const { url } = JSON.parse(body)
        if (!url) return json(res, { ok: false, message: '下载地址不能为空' }, 400)
        downloadToRuntime(url, (err, filePath) => {
          if (err) return json(res, { ok: false, message: err.message }, 400)
          json(res, { ok: true, message: 'NapCat 包已下载到 ' + filePath, path: filePath })
        })
      } catch (e) { json(res, { ok: false, message: e.message }, 400) }
    })
    return
  }

  if (pathname === '/dashboard/api/bot/local-status' && req.method === 'GET') {
    try {
      if (process.platform === 'win32') {
        return json(res, { running: !checkPortAvailable(5140), workers: !checkPortAvailable(5140) ? 1 : 0 })
      }
      const out = execSync("ps aux | grep 'koishi/lib/worker' | grep -v grep", { encoding: 'utf8', timeout: 3000 }).trim()
      const running = out.split('\n').filter(Boolean).length
      return json(res, { running: running > 0, workers: running })
    } catch { return json(res, { running: false, workers: 0 }) }
  }

  if (pathname === '/dashboard/api/bot/local-stop' && req.method === 'POST') {
    if (!requireAdmin(req, res)) return
    try {
      stopKoishiProcesses()
      return json(res, { ok: true, message: '本地 Bot 已停止' })
    } catch (e) { return json(res, { ok: false, message: e.message }) }
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

if (!getResetToken()) generateResetToken()

server.listen(PORT, () => {
  log(`LianBoard running on http://localhost:${PORT}/dashboard/`)
  log(`bot control: start/stop/maintenance`)
  log(`napcat proxy: /webui/ -> NapCat WebUI`)
  log(`密码重置令牌文件: ${RESET_TOKEN_FILE}`)
  if (!getAccessPassword() && !isLocalAuthBypass()) log('WARNING: dashboard access password is not configured; login is disabled')
  if (!readFileSync(ADMIN_PWD_FILE) && !process.env.DASHBOARD_ADMIN_PASSWORD) log('WARNING: 管理员密码使用默认值 123，请登录后在安全设置中修改')
})

process.on('SIGINT', () => { log('shutting down'); server.close(); process.exit(0) })
process.on('SIGTERM', () => { log('shutting down'); server.close(); process.exit(0) })
