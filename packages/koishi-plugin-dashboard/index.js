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

    // API: 获取所有 Key 文件状态
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
        return {
          label: k.name,
          file: k.file,
          exists: !!content,
          prefix: content ? content.slice(0, 8) + '****' : '',
        }
      }))
    }

    // API: 更新 Key 文件
    if (pathname === '/dashboard/api/keys' && req.method === 'PUT') {
      let body = ''
      req.on('data', c => body += c)
      req.on('end', () => {
        try {
          const data = JSON.parse(body)
          const file = data.file
          if (!file || file.includes('..') || !file.endsWith('-key.txt')) {
            return json(res, { ok: false, message: '无效文件名' }, 400)
          }
          writeFileSync(path.join(DATA_DIR, file), data.value)
          const { resetConfigCache } = require(path.join(AI_LIB, 'runtime-config'))
          resetConfigCache()
          json(res, { ok: true, message: 'Key 已更新' })
        } catch (e) {
          json(res, { ok: false, message: e.message }, 400)
        }
      })
      return
    }

    // API: 获取所有指令和功能介绍
    if (pathname === '/dashboard/api/commands' && req.method === 'GET') {
      return json(res, COMMANDS_DATA)
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

const COMMANDS_DATA = [
  { category: '常用', commands: [
    { cmd: '@东雪莲 你的问题', desc: '向 AI 提问' },
    { cmd: 'AI状态', desc: '查看当前 AI 配置信息' },
    { cmd: 'AI诊断', desc: '检查所有供应商可用状态' },
    { cmd: 'AI重载', desc: '重新加载 AI 配置' },
    { cmd: '东雪莲帮我选 A 还是 B', desc: '让 AI 帮你做选择' },
    { cmd: '东雪莲吐槽我', desc: '让 AI 吐槽你' },
    { cmd: '东雪莲帮我说话 <内容>', desc: '让 AI 替你说句话' },
    { cmd: '东雪莲复读开 / 关 / 状态', desc: '切换复读模式' },
    { cmd: '今日情绪', desc: '查看今日群聊情绪分析' },
    { cmd: '群聊日报 / 群聊详细日报', desc: '生成群聊日报' },
    { cmd: '谁艾特我 / 谁@我', desc: '查看今天谁 @了你' },
  ]},
  { category: '人格', commands: [
    { cmd: '东雪莲我的人格 / 人格查看', desc: '查看你当前的个性' },
    { cmd: '东雪莲人格切换 <名称>', desc: '切换你的个性' },
    { cmd: '东雪莲人格列表', desc: '查看可用个性列表' },
    { cmd: '东雪莲人格重置', desc: '重置为默认个性' },
    { cmd: '东雪莲群人格', desc: '查看群个性' },
    { cmd: '东雪莲群人格切换 <名称>', desc: '切换群个性' },
    { cmd: '东雪莲测试开 / 关', desc: '切换测试模式（管理员）' },
    { cmd: '东雪莲嘴臭开 / 关', desc: '切换嘴臭模式（管理员）' },
    { cmd: '东雪莲思考开 / 关', desc: '切换思考调试模式' },
  ]},
  { category: '切换模型', commands: [
    { cmd: '供应商 opencode', desc: '切换到 OpenCode Go' },
    { cmd: '供应商 dashscope', desc: '切换到阿里云 DashScope' },
    { cmd: '供应商 deepseek', desc: '切换到 DeepSeek 官方' },
    { cmd: '供应商 glm', desc: '切换到智谱 GLM' },
    { cmd: '供应商 mimorium', desc: '切换到小米 MiMo' },
    { cmd: '可用模型', desc: '查看所有供应商的模型列表' },
  ]},
  { category: '记忆', commands: [
    { cmd: '记住xxx', desc: '让 AI 记住某件事' },
    { cmd: '东雪莲忘记我', desc: '清空 AI 对你的记忆' },
    { cmd: '东雪莲清空群记忆', desc: '清空整个群的记忆' },
    { cmd: '东雪莲群记忆定时 <小时>', desc: '设置定时清空群记忆' },
  ]},
  { category: '集合与昵称', commands: [
    { cmd: '@A用户 昵称 名称A', desc: '为用户 A 设置昵称' },
    { cmd: '查看昵称 名称A / 谁是 名称A', desc: '查看昵称对应的用户' },
    { cmd: '查看成员 @A用户', desc: '查看用户的集合成员' },
    { cmd: '创建集合 集合A @A @B', desc: '创建集合' },
    { cmd: '集合添加 / 删除', desc: '管理集合成员' },
    { cmd: '复制集合 / 合并集合', desc: '集合操作' },
    { cmd: '集合交集 / 并集 / 差集', desc: '集合运算' },
  ]},
  { category: '群聊主动回复', commands: [
    { cmd: '概率查看 / 设置 / 重置', desc: '管理 AI 回复概率' },
    { cmd: '白名单添加 / 删除 / 查看', desc: '管理 AI 白名单' },
  ]},
  { category: '联网', commands: [
    { cmd: '东雪莲联网查看', desc: '查看联网搜索状态' },
    { cmd: '东雪莲联网开', desc: '开启联网搜索' },
    { cmd: '东雪莲联网关', desc: '关闭联网搜索' },
  ]},
  { category: '敏感话题检测', commands: [
    { cmd: '敏感话题检测开 / 关', desc: '开关敏感话题检测' },
    { cmd: '敏感话题处理者添加/删除', desc: '管理通知人' },
  ]},
  { category: '白名单黑名单', commands: [
    { cmd: '用户黑名单', desc: '管理用户黑名单' },
    { cmd: '解除上限群白名单', desc: '管理解除上限群白名单' },
    { cmd: '视频黑名单', desc: '管理视频黑名单' },
  ]},
]
