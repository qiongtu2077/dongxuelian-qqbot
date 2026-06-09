const fs = require('fs')
const path = require('path')
const { spawn } = require('child_process')
const puppeteer = require('puppeteer-core')

const ROOT = path.resolve(__dirname, '..')
const FRONTEND_DIR = path.join(ROOT, 'packages', 'koishi-plugin-dashboard', 'frontend')
const PORT = Number(process.env.DASHBOARD_SMOKE_PORT || 5177)
const BASE_URL = `http://127.0.0.1:${PORT}/`
const LIVE_URL = process.env.DASHBOARD_SMOKE_LIVE_URL || ''
const LIVE_PASSWORD = process.env.DASHBOARD_SMOKE_PASSWORD || ''
const LIVE_ADMIN_PASSWORD = process.env.DASHBOARD_SMOKE_ADMIN_PASSWORD || ''
const LIVE_TOKEN = process.env.DASHBOARD_SMOKE_TOKEN || ''
const LIVE_ADMIN_TOKEN = process.env.DASHBOARD_SMOKE_ADMIN_TOKEN || ''

function pad2(value) {
  return String(value).padStart(2, '0')
}

function todayShanghaiDate() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date())
  const pick = type => parts.find(item => item.type === type)?.value || ''
  return `${pick('year')}-${pick('month')}-${pick('day')}`
}

function addDays(date, offset) {
  const match = String(date || '').match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (!match) return date
  const d = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]) + offset))
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`
}

function chartDate(date) {
  const match = String(date || '').match(/^\d{4}-(\d{2})-(\d{2})$/)
  return match ? `${match[1]}-${match[2]}` : date
}

function findBrowserExecutable() {
  const candidates = [
    process.env.PUPPETEER_EXECUTABLE_PATH,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
    '/usr/bin/microsoft-edge',
  ].filter(Boolean)
  return candidates.find(item => fs.existsSync(item))
}

function startVite() {
  const viteBin = path.join(FRONTEND_DIR, 'node_modules', 'vite', 'bin', 'vite.js')
  const child = spawn(process.execPath, [viteBin, '--host', '127.0.0.1', '--port', String(PORT), '--strictPort'], {
    cwd: FRONTEND_DIR,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  child.stdout.on('data', chunk => process.stdout.write('[vite] ' + chunk.toString()))
  child.stderr.on('data', chunk => process.stderr.write('[vite] ' + chunk.toString()))
  return child
}

async function waitForServer(child) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < 60000) {
    if (child.exitCode !== null) throw new Error(`vite exited with code ${child.exitCode}`)
    try {
      const res = await fetch(BASE_URL)
      if (res.ok) return
    } catch { /* non-critical: server may not be ready yet */ }
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  throw new Error('vite server did not become ready')
}

function svgDataUri() {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="240"><rect width="320" height="240" fill="#182033"/><text x="24" y="126" fill="#f4c430" font-size="28">LianBoard</text></svg>'
  return 'data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64')
}

function wavDataBase64() {
  const sampleRate = 16000
  const durationSec = 0.18
  const samples = Math.floor(sampleRate * durationSec)
  const data = Buffer.alloc(samples * 2)
  for (let i = 0; i < samples; i += 1) {
    const value = Math.round(Math.sin(2 * Math.PI * 440 * (i / sampleRate)) * 9000)
    data.writeInt16LE(value, i * 2)
  }
  const header = Buffer.alloc(44)
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + data.length, 4)
  header.write('WAVE', 8)
  header.write('fmt ', 12)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(1, 22)
  header.writeUInt32LE(sampleRate, 24)
  header.writeUInt32LE(sampleRate * 2, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36)
  header.writeUInt32LE(data.length, 40)
  return Buffer.concat([header, data]).toString('base64')
}

function jsonResponse(data, status = 200) {
  return {
    status,
    contentType: 'application/json; charset=utf-8',
    body: JSON.stringify(data),
  }
}

const mockState = {
  voiceEnabled: false,
  voiceAssetId: '',
  clonedVoice: {
    id: 'voice_asset_a',
    personaName: '测试人格',
    displayName: '测试音色',
    description: '本地烟测样本',
    filename: 'voice_asset_a.wav',
    size: 4096,
    mtime: Date.now(),
    sampleText: '你好，这是克隆音色测试。',
  },
}

function apiMock(method, pathname, body) {
  const ok = data => jsonResponse(data)
  const writeOk = message => ok({ ok: true, message })

  if (method === 'GET' && pathname === '/status') return ok({ provider: 'deepseek', model: 'deepseek-chat' })
  if (method === 'GET' && pathname === '/providers') return ok({
    deepseek: { name: 'DeepSeek', models: [{ id: 'deepseek-chat', name: 'DeepSeek Chat' }] },
    dashscope: { name: 'DashScope', models: [{ id: 'qwen-plus', name: 'Qwen Plus', vision: false }, { id: 'qwen-vl-plus', name: 'Qwen VL', vision: true }] },
  })
  if (method === 'GET' && pathname === '/config') return ok({ provider: 'deepseek', model: 'deepseek-chat', baseUrl: '' })
  if (method === 'PUT' && pathname === '/config') return writeOk('config saved')
  if (method === 'GET' && pathname === '/fallback') return ok({
    chains: {
      chat: [{ provider: 'deepseek', model: 'deepseek-chat' }],
      vision: [{ provider: 'dashscope', model: 'qwen-vl-plus' }],
      lightweight: [],
    },
    default: {
      chat: [{ provider: 'deepseek', model: 'deepseek-chat' }],
      vision: [{ provider: 'dashscope', model: 'qwen-vl-plus' }],
      lightweight: [],
    },
  })
  if (method === 'PUT' && pathname === '/fallback') return writeOk('fallback saved')
  if (method === 'GET' && pathname === '/providers/custom') return ok([
    { id: 'mock', name: 'Mock Provider', baseURL: 'https://mock.invalid/v1', keyFile: 'mock-key.txt', models: [{ id: 'mock-chat', vision: false }] },
  ])
  if (method === 'PUT' && pathname === '/providers/custom') return writeOk('custom providers saved')

  if (method === 'GET' && pathname === '/features') return ok([
    { id: 'chat', title: '聊天', summary: '普通聊天功能', detail: '模拟功能详情', usage: '莲莲 你好', related: [] },
  ])
  if (method === 'GET' && pathname === '/commands') return ok([
    { category: '基础', commands: [{ cmd: '/help', desc: '查看帮助' }] },
  ])
  if (method === 'GET' && pathname === '/personas') {
    if (body.searchParams.get('name')) {
      return ok({ name: body.searchParams.get('name'), description: '测试详情', content: '测试人格内容', lore: 'lore-a', will: 1.2, nsfw: 'none' })
    }
    return ok([
      { name: '核心规则', type: 'core', description: '核心规则描述' },
      { name: '默认模式', type: 'mode', description: '默认模式描述' },
      { name: '测试人格', type: 'persona', description: '测试人格描述' },
      { name: '普通人格', type: 'persona', description: '普通人格描述' },
    ])
  }
  if (method === 'POST' && pathname === '/personas') return writeOk('persona created')
  if (method === 'PUT' && pathname === '/personas') return writeOk('persona updated')
  if (method === 'DELETE' && pathname === '/personas') return writeOk('persona deleted')
  if (method === 'GET' && pathname === '/lore-list') return ok([{ id: 'none', description: '无' }, { id: 'lore-a', description: '测试世界观' }])
  if (method === 'GET' && pathname === '/lores') return ok([{ name: 'lore-a', description: '测试世界观', content: '世界观内容' }])
  if (method === 'POST' && pathname === '/lores') return writeOk('lore created')
  if (method === 'PUT' && pathname === '/lores') return writeOk('lore updated')
  if (method === 'DELETE' && pathname === '/lores') return writeOk('lore deleted')
  if (method === 'GET' && pathname === '/agent/tts/voices') return ok({
    builtin: ['冰糖', '茉莉'],
    personas: [
      { name: '测试人格', voice: mockState.voiceEnabled ? '__cloned__' : '冰糖', voiceAssetId: mockState.voiceEnabled ? mockState.voiceAssetId : '', style: '温柔', hasSample: true },
      { name: '普通人格', voice: '冰糖', voiceAssetId: '', style: '温和', hasSample: false },
    ],
    clonedVoices: [{
      ...mockState.clonedVoice,
      referencedBy: mockState.voiceEnabled ? ['测试人格'] : [],
      isCurrent: mockState.voiceEnabled,
    }],
  })
  if (method === 'POST' && pathname === '/agent/tts/preview') return ok({ audio: wavDataBase64(), format: 'wav', mimeType: 'audio/wav' })
  if (method === 'POST' && pathname === '/agent/tts/clone/rename') return writeOk('voice asset saved')
  if (method === 'POST' && pathname === '/agent/tts/clone/delete') return writeOk('voice asset deleted')
  if (method === 'PUT' && pathname === '/agent/persona/voice') {
    mockState.voiceEnabled = body.body?.voiceId === '__cloned__'
    mockState.voiceAssetId = body.body?.voiceAssetId || ''
    return writeOk('voice saved')
  }

  if (method === 'GET' && pathname === '/keys') return ok([{ file: 'ai-deepseek-key.txt', label: 'DeepSeek', exists: true, prefix: 'sk-***' }])
  if (method === 'PUT' && pathname === '/keys') return writeOk('key saved')
  if (method === 'GET' && pathname === '/keys/usage') {
    const today = todayShanghaiDate()
    const d1 = addDays(today, -3)
    const d2 = addDays(today, -2)
    const d3 = addDays(today, -1)
    return ok({
      providers: [
        { key: 'mimorium', label: 'MiMo', total: 604000000, requests: 4841, input: 43000000, output: 1100000, cacheCreation: 0, cacheRead: 560000000 },
        { key: 'glm', label: 'GLM', total: 1400000, requests: 21, input: 1100000, output: 300000, cacheCreation: 0, cacheRead: 0 },
        { key: 'dashscope', label: '阿里云', total: 197000, requests: 13, input: 115000, output: 82000, cacheCreation: 0, cacheRead: 0 },
        { key: 'deepseek', label: 'DeepSeek', total: 35000000, requests: 92, input: 29000000, output: 6000000, cacheCreation: 0, cacheRead: 0 },
      ],
      models: [
        { key: 'mimo-v2-omni', label: 'mimo-v2-omni', provider: 'mimorium', total: 604000000, requests: 4841, input: 43000000, output: 1100000, cacheCreation: 0, cacheRead: 560000000 },
        { key: 'deepseek-v4-flash', label: 'deepseek-v4-flash', provider: 'deepseek', total: 35000000, requests: 92, input: 29000000, output: 6000000, cacheCreation: 0, cacheRead: 0 },
        { key: 'glm-4.6v-flash', label: 'glm-4.6v-flash', provider: 'glm', total: 200000, requests: 15, input: 153000, output: 47000, cacheCreation: 0, cacheRead: 0 },
        { key: 'glm:legacy', label: 'GLM 未分模型', provider: 'glm', total: 500000, requests: 0, input: 0, output: 0, cacheCreation: 0, cacheRead: 0 },
        { key: 'glm:unknown', label: 'GLM 未分模型', provider: 'glm', total: 700000, requests: 0, input: 0, output: 0, cacheCreation: 0, cacheRead: 0 },
        { key: 'qwen3.5-omni-flash', label: 'qwen3.5-omni-flash', provider: 'dashscope', total: 50000, requests: 3, input: 30000, output: 20000, cacheCreation: 0, cacheRead: 0 },
        { key: 'mock-extra-model-05', label: 'mock-extra-model-05', provider: 'dashscope', total: 40000, requests: 2, input: 25000, output: 15000, cacheCreation: 0, cacheRead: 0 },
        { key: 'mock-extra-model-06', label: 'mock-extra-model-06', provider: 'dashscope', total: 30000, requests: 2, input: 20000, output: 10000, cacheCreation: 0, cacheRead: 0 },
        { key: 'mock-extra-model-07', label: 'mock-extra-model-07', provider: 'dashscope', total: 20000, requests: 1, input: 12000, output: 8000, cacheCreation: 0, cacheRead: 0 },
        { key: 'mock-extra-model-08', label: 'mock-extra-model-08', provider: 'dashscope', total: 10000, requests: 1, input: 7000, output: 3000, cacheCreation: 0, cacheRead: 0 },
        { key: 'mock-extra-model-09', label: 'mock-extra-model-09', provider: 'dashscope', total: 9000, requests: 1, input: 6000, output: 3000, cacheCreation: 0, cacheRead: 0 },
        { key: 'mock-extra-model-10', label: 'mock-extra-model-10', provider: 'dashscope', total: 8000, requests: 1, input: 5000, output: 3000, cacheCreation: 0, cacheRead: 0 },
      ],
      days: [
        { date: d1, total: 142000000, input: 13000000, output: 900000, cacheCreation: 0, cacheRead: 128100000, mimorium: 133000000, glm: 0, dashscope: 0, deepseek: 9000000, models: { 'mimo-v2-omni': { provider: 'mimorium', total: 133000000, requests: 1000 }, 'deepseek-v4-flash': { provider: 'deepseek', total: 9000000, requests: 20 } } },
        { date: d2, total: 212200000, input: 15000000, output: 1200000, cacheCreation: 0, cacheRead: 196000000, mimorium: 201000000, glm: 1400000, dashscope: 0, deepseek: 9800000, models: { 'mimo-v2-omni': { provider: 'mimorium', total: 201000000, requests: 1500 }, 'glm-4.6v-flash': { provider: 'glm', total: 200000, requests: 15 }, 'glm:legacy': { provider: 'glm', total: 500000 }, 'glm:unknown': { provider: 'glm', total: 700000 }, 'deepseek-v4-flash': { provider: 'deepseek', total: 9800000, requests: 22 } } },
        { date: d3, total: 210000000, input: 17000000, output: 1000000, cacheCreation: 0, cacheRead: 192000000, mimorium: 198000000, deepseek: 12000000, models: { 'mimo-v2-omni': { provider: 'mimorium', total: 198000000, requests: 1600 }, 'deepseek-v4-flash': { provider: 'deepseek', total: 12000000, requests: 25 } } },
        { date: today, total: 75167000, input: 7105000, output: 562000, cacheCreation: 0, cacheRead: 67500000, mimorium: 72000000, deepseek: 3000000, dashscope: 167000, models: { 'mimo-v2-omni': { provider: 'mimorium', total: 72000000, requests: 741 }, 'deepseek-v4-flash': { provider: 'deepseek', total: 3000000, requests: 25 }, 'qwen3.5-omni-flash': { provider: 'dashscope', total: 50000, requests: 3 }, 'mock-extra-model-05': { provider: 'dashscope', total: 40000, requests: 2 }, 'mock-extra-model-06': { provider: 'dashscope', total: 30000, requests: 2 }, 'mock-extra-model-07': { provider: 'dashscope', total: 20000, requests: 1 }, 'mock-extra-model-08': { provider: 'dashscope', total: 10000, requests: 1 }, 'mock-extra-model-09': { provider: 'dashscope', total: 9000, requests: 1 }, 'mock-extra-model-10': { provider: 'dashscope', total: 8000, requests: 1 } } },
      ],
    })
  }

  if (method === 'GET' && pathname === '/whitelist') return ok({
    aiWhitelist: { label: '群聊 AI 白名单', data: ['10001'] },
    userBlacklist: { label: '用户黑名单', data: [] },
    groupUserWhitelist: { label: '混合白名单', data: { groups: ['10001'], users: ['20002'] } },
  })
  if (method === 'PUT' && pathname === '/whitelist') return writeOk('whitelist saved')

  if (method === 'GET' && pathname === '/bot/status') return ok({ running: true, workers: 1, qq: '123456' })
  if (method === 'GET' && pathname === '/maintenance') return ok({ enabled: false })
  if (method === 'GET' && pathname === '/qq/token') return jsonResponse({ code: 'ADMIN_REQUIRED', message: '需要管理员密码' }, 403)
  if (method === 'GET' && pathname === '/qq/ssh-info') return ok({ host: 'mock-host.invalid', user: 'mock-user' })
  if (method === 'GET' && pathname === '/qq/selfid') return ok({ selfId: '123456' })
  if (method === 'PUT' && pathname === '/qq/selfid') return jsonResponse({ code: 'ADMIN_REQUIRED', message: '需要管理员密码' }, 403)
  if (method === 'GET' && pathname === '/throttle') return ok({ maxPerMinute: 20 })

  if (method === 'GET' && pathname === '/logging') return ok({ config: { enabled: false } })
  if (method === 'PUT' && pathname === '/logging') return writeOk('logging saved')
  if (method === 'GET' && pathname === '/bot/activity') return ok({
    entries: [{ id: 1, level: 'I', time: '12:00:00', module: 'dashboard', message: 'mock log line' }],
    total: 1,
  })

  if (method === 'GET' && pathname === '/gallery') return ok([{ id: 'img-1', name: 'mock image', url: svgDataUri(), foilStyle: '' }])
  if (method === 'PUT' && pathname === '/gallery/style') return writeOk('gallery style saved')
  if (method === 'DELETE' && pathname === '/gallery') return writeOk('gallery deleted')

  if (method === 'PUT' && pathname === '/auth/password') return writeOk('password changed')
  if (method === 'GET' && pathname === '/admin-ids') return ok({ ids: ['10000'] })

  if (method === 'GET' && pathname === '/deploy/config') return ok({ server: 'mock-user@mock-host.invalid', appDir: '/opt/mock-koishi', mode: 'update' })
  if (method === 'PUT' && pathname === '/deploy/config') return writeOk('deploy config saved')
  if (method === 'GET' && pathname === '/deploy/check-update') return ok({ upToDate: false, local: 'local-mock', deployed: 'remote-mock' })
  if (method === 'POST' && pathname === '/deploy/rebuild-frontend') return ok({ ok: true, taskId: 'rebuild-mock' })
  if (method === 'GET' && pathname === '/deploy/rebuild-frontend/status') return ok({ ok: true, done: true, success: true, message: 'mock rebuild complete' })
  if (method === 'GET' && pathname === '/env/check') return ok({
    platform: 'linux',
    host: { platform: 'linux', arch: 'x64', hostname: 'mock-host' },
    localDeployTarget: {
      platform: 'linux',
      arch: 'x64',
      canRunWindowsLocalDeploy: false,
      blocked: true,
      blockedReason: 'mock backend is not Windows',
      workspace: { packaged: false, isTempRuntime: false, reasons: [], workspaceRoot: '/opt/mock-koishi' },
    },
    blocked: true,
    blockedReason: 'mock backend is not Windows',
    projectDir: '/opt/mock-koishi',
    runtimeDir: '/opt/mock-koishi/runtime',
    node: { ok: true, version: 'v20.0.0', sourcePath: 'node' },
    npm: { found: true, version: '10.0.0', sourcePath: 'npm' },
    dependencies: { ready: true, reason: 'mock dependencies ready' },
    localConfig: { files: [] },
    ports: { 5140: { status: 'free', available: true }, 5150: { status: 'occupied', available: false } },
    napcat: { found: false, status: 'missing', reason: 'mock NapCat not installed' },
  })
  if (method === 'PUT' && pathname === '/throttle') return writeOk('throttle saved')
  if (method === 'PUT' && pathname === '/maintenance') return writeOk('maintenance saved')

  if (method === 'GET' && pathname === '/agent/config') return ok({
    ok: true,
    mode: 'confirm',
    config: {
      dangerousPolicy: 'confirm',
      channels: {
        qq: { enabled: true, tools: { calculator: true, browser_action: false } },
        dashboard: { enabled: true, tools: { calculator: true, browser_action: true } },
      },
      autoRoute: { qq: { enabled: false }, dashboard: { enabled: false } },
      enabledSkills: ['mock-skill'],
      readFileRoots: ['mock-workspace'],
      mcp: { enabled: true, allowWriteWorkspace: false, allowRunLocal: true, exposeDangerousActions: false },
      persona: { dashboardPersona: '测试人格', qqInheritChatPersona: true },
    },
    tools: [
      { name: 'calculator', description: '计算器', dangerous: false, external: false, defaultChannels: ['dashboard'], qqEnabled: true, dashboardEnabled: true },
      { name: 'browser_action', description: '浏览器动作', dangerous: true, external: true, defaultChannels: ['dashboard'], qqEnabled: false, dashboardEnabled: true },
    ],
    stats: { total: 3, byChannel: { qq: 1, dashboard: 2 }, recent: [{ at: Date.now(), tool: 'calculator', channel: 'dashboard' }] },
    skills: [{ file: 'mock/SKILL.md', name: 'mock-skill', kind: 'workspace', description: '本地 mock 技能' }],
    personas: [{ name: '测试人格' }, { name: '普通人格' }],
    effectiveReadRoots: ['mock-workspace'],
  })
  if (method === 'PUT' && pathname === '/agent/config') return ok({ ok: true, message: 'Agent 配置已保存', config: body.body?.config || {}, mode: body.body?.mode || 'confirm' })
  if (method === 'GET' && pathname === '/agent/personas') return ok({ ok: true, personas: [{ name: '测试人格' }, { name: '普通人格' }], persona: { dashboardPersona: '测试人格', qqInheritChatPersona: true } })
  if (method === 'PUT' && pathname === '/agent/persona') return ok({ ok: true, message: 'Agent 人格已更新', persona: body.body || {} })
  if (method === 'GET' && pathname === '/tools/pending') return ok({ ok: true, pending: [{ id: 'pending-1', toolName: 'read_file', channelKey: 'dashboard', userId: 'mock-user', expireAt: Date.now() + 60000, argsSummary: '读取 package.json' }] })
  if (method === 'GET' && pathname === '/agent/sessions') return ok({ ok: true, sessions: [{ id: 'session-1', title: 'Mock Session', channel: 'dashboard', userName: '测试用户', turns: 2, toolCalls: 1, updatedAt: Date.now(), lastMessage: '最近消息' }] })
  if (method === 'GET' && pathname.startsWith('/agent/sessions/')) return ok({ ok: true, session: { id: 'session-1', turns: [{ at: Date.now(), userMessage: '你好', reply: '你好，mock reply' }] } })
  if (method === 'POST' && pathname === '/agent/chat') return ok({ ok: true, reply: 'Agent mock reply' })

  if (method === 'GET' && pathname === '/resource/status') return ok({
    ok: true,
    mode: 'interactive',
    resourceState: 'green',
    memAvailableMb: 1024,
    memTotalMb: 2048,
    memSource: 'mock',
    running: { taskId: 'mock-running-1', kind: 'agent', step: 'working', owner: 'worker-a' },
    queueLength: 2,
    workers: [{ name: 'worker-a', alive: true, step: 'idle', heartbeatLagMs: 128 }],
    media: { imagePending: 1, filePending: 2, voicePending: 0, running: [{ id: 'media-1' }], droppedCount: 0 },
    precompute: {
      coverageCount: 2,
      slotCount: 3,
      coverage: [
        { date: todayShanghaiDate(), channelKey: 'group_10001', coverageRate: 0.8, updatedAt: '12:00' },
        { date: todayShanghaiDate(), channelKey: 'group_20002', coverageRate: 0.35, updatedAt: '12:05' },
      ],
    },
    maintenance: false,
    events: [{ source: 'S1', event: 'mock_status_event', reason: 'resource mock ready', createdAt: '12:00:00' }],
  })
  if (method === 'GET' && pathname === '/resource/memory-history') {
    const range = body.searchParams.get('range') || '5m'
    const now = Date.now()
    const points = range === '30m'
      ? [
        { ts: now - 20000, memAvailableMb: 910, memTotalMb: 2048, rssMb: 120, sampleCount: 1, sources: ['mock-worker'] },
        { ts: now - 10000, memAvailableMb: 1010, memTotalMb: 2048, rssMb: 125, sampleCount: 1, sources: ['mock-worker'] },
        { ts: now, memAvailableMb: 1110, memTotalMb: 2048, rssMb: 130, sampleCount: 1, sources: ['dashboard-resource-status'] },
      ]
      : [
        { ts: now - 20000, memAvailableMb: 900, memTotalMb: 2048, rssMb: 120, sampleCount: 1, sources: ['mock-worker'] },
        { ts: now - 10000, memAvailableMb: 1000, memTotalMb: 2048, rssMb: 125, sampleCount: 1, sources: ['mock-worker'] },
        { ts: now, memAvailableMb: 1100, memTotalMb: 2048, rssMb: 130, sampleCount: 1, sources: ['dashboard-resource-status'] },
      ]
    return ok({
      ok: true,
      range,
      bucketMs: 10000,
      dashboardSampleIntervalMs: 5000,
      workerSampleIntervalMs: 10000,
      pointCount: points.length,
      points,
    })
  }
  if (method === 'GET' && pathname === '/resource/tasks') return ok({
    ok: true,
    tasks: [
      { id: 'mock-task-1', kind: 'daily', status: 'pending', step: 'queued', updatedAt: '12:00:01' },
      { id: 'mock-task-2', kind: 'agent', status: 'running', step: 'worker', updatedAt: '12:00:02' },
    ],
  })
  if (method === 'GET' && pathname === '/resource/events') return ok({
    ok: true,
    events: [{ source: 'S2', event: 'mock_event', reason: 'worker event', createdAt: '12:00:03', taskId: 'mock-task-1' }],
  })
  if (method === 'GET' && pathname === '/resource/workers') return ok({ ok: true, workers: [{ name: 'worker-a', alive: true, step: 'idle' }] })
  if (method === 'GET' && pathname === '/resource/media') return ok({ ok: true, media: { imagePending: 1, filePending: 2, voicePending: 0, running: [], droppedCount: 0 } })
  if (method === 'GET' && pathname === '/resource/precompute') return ok({ ok: true, precompute: { coverageCount: 1, slotCount: 3, coverage: [] } })
  if (method === 'POST' && pathname === '/resource/cancel') return ok({ ok: true, message: '任务已取消' })
  if (method === 'POST' && pathname === '/resource/reclaim-stale') return ok({ ok: true, reclaimed: false })
  if (method === 'POST' && pathname === '/resource/maintenance') return ok({ ok: true, enabled: !!body.body?.enabled, message: '维护模式已切换' })

  return ok({ ok: true, message: `mocked ${method} ${pathname}` })
}

async function installApiMock(page) {
  await page.setRequestInterception(true)
  page.on('request', async request => {
    const url = new URL(request.url())
    if (url.pathname === '/agent/' || url.pathname === '/agent') {
      return request.respond({
        status: 200,
        contentType: 'text/html; charset=utf-8',
        body: '<!doctype html><html><head><title>Mock Agent Console</title></head><body><main>Mock Agent Console</main></body></html>',
      })
    }
    if (!url.pathname.startsWith('/dashboard/api')) return request.continue()
    const pathname = url.pathname.replace('/dashboard/api', '') || '/'
    const method = request.method()
    let parsedBody = null
    try { parsedBody = request.postData() ? JSON.parse(request.postData()) : null } catch { /* non-critical: mock handlers tolerate non-JSON bodies */ }
    try {
      const response = apiMock(method, pathname, { searchParams: url.searchParams, body: parsedBody })
      const isWrite = method !== 'GET'
      if (isWrite) await new Promise(resolve => setTimeout(resolve, 80))
      await request.respond(response)
    } catch (error) {
      await request.respond(jsonResponse({ ok: false, message: error.message }, 500))
    }
  })
}

async function waitForText(page, text, timeout = 8000) {
  await page.waitForFunction(value => document.body && document.body.innerText.includes(value), { timeout }, text)
}

async function waitForTextInSelector(page, selector, text, timeout = 8000) {
  await page.waitForFunction(({ sel, value }) => {
    const el = document.querySelector(sel)
    return !!(el && el.innerText && el.innerText.includes(value))
  }, { timeout }, { sel: selector, value: text })
}

async function waitForTextNotInSelector(page, selector, text, timeout = 8000) {
  await page.waitForFunction(({ sel, value }) => {
    const el = document.querySelector(sel)
    return !!(el && el.innerText && !el.innerText.includes(value))
  }, { timeout }, { sel: selector, value: text })
}

async function hasText(page, text) {
  return page.evaluate(value => !!(document.body && document.body.innerText.includes(value)), text)
}

async function waitForFieldValue(page, text, timeout = 8000) {
  await page.waitForFunction(value => {
    return [...document.querySelectorAll('input,textarea,select')].some(el => String(el.value || '').includes(value))
  }, { timeout }, text)
}

async function waitForInputValue(page, text, timeout = 8000) {
  await waitForFieldValue(page, text, timeout)
}

async function waitForVisibleSelector(page, selector, timeout = 8000) {
  await page.waitForFunction(sel => {
    return [...document.querySelectorAll(sel)].some(el => {
      const box = el.getBoundingClientRect()
      return box.width > 0 && box.height > 0
    })
  }, { timeout }, selector)
}

async function clickText(page, text, selector = 'button,a') {
  await page.waitForFunction((value, sel) => {
    return [...document.querySelectorAll(sel)].some(el => {
      const rect = el.getBoundingClientRect()
      return rect.width > 0 && rect.height > 0 && el.textContent.includes(value)
    })
  }, { timeout: 8000 }, text, selector)
  const rect = await page.evaluate((value, sel) => {
    const el = [...document.querySelectorAll(sel)].find(item => {
      const box = item.getBoundingClientRect()
      return box.width > 0 && box.height > 0 && item.textContent.includes(value)
    })
    el.scrollIntoView({ block: 'center', inline: 'center' })
    const scrolledBox = el.getBoundingClientRect()
    return { x: scrolledBox.left + scrolledBox.width / 2, y: scrolledBox.top + scrolledBox.height / 2 }
  }, text, selector)
  await new Promise(resolve => setTimeout(resolve, 80))
  await page.mouse.click(rect.x, rect.y)
}

async function clickVisibleSelector(page, selector) {
  await waitForVisibleSelector(page, selector)
  const rect = await page.evaluate(sel => {
    const el = [...document.querySelectorAll(sel)].find(item => {
      const box = item.getBoundingClientRect()
      return box.width > 0 && box.height > 0
    })
    if (!el) return null
    el.scrollIntoView({ block: 'center', inline: 'center' })
    const box = el.getBoundingClientRect()
    return { x: box.left + box.width / 2, y: box.top + box.height / 2 }
  }, selector)
  if (!rect) throw new Error(`selector not visible: ${selector}`)
  await page.mouse.click(rect.x, rect.y)
}

async function ensureSidebarExpanded(page) {
  const hasExpandedNav = await page.$('.sidebar-nav .sidebar-item')
  if (hasExpandedNav) return
  await page.waitForSelector('.sidebar-toggle', { timeout: 8000 })
  await page.click('.sidebar-toggle')
  await page.waitForSelector('.sidebar-nav .sidebar-item', { timeout: 8000 })
}

async function ensureSidebarCollapsed(page) {
  const hasExpandedNav = await page.$('.sidebar-nav .sidebar-item')
  if (!hasExpandedNav) return
  await page.waitForSelector('.sidebar-toggle', { timeout: 8000 })
  await page.click('.sidebar-toggle')
  await page.waitForFunction(() => !document.querySelector('.sidebar-nav .sidebar-item'), { timeout: 8000 })
}

async function clickSidebarTab(page, label) {
  await ensureSidebarExpanded(page)
  await page.waitForFunction(value => {
    return [...document.querySelectorAll('.sidebar-nav .sidebar-item')].some(el => {
      const rect = el.getBoundingClientRect()
      return rect.width > 0 && rect.height > 0 && el.textContent.includes(value)
    })
  }, { timeout: 8000 }, label)
  const clickTarget = value => {
    const el = [...document.querySelectorAll('.sidebar-nav .sidebar-item')].find(item => item.textContent.includes(value))
    if (!el) return false
    el.click()
    return true
  }
  const clicked = await page.evaluate(clickTarget, label)
  if (!clicked) throw new Error(`sidebar tab not found: ${label}`)
  await new Promise(resolve => setTimeout(resolve, 250))
  const active = await page.evaluate(value => {
    const labelEl = document.querySelector('.active-view-label')
    return !!(labelEl && labelEl.textContent.includes(value))
  }, label)
  if (!active) await page.evaluate(clickTarget, label)
  await page.waitForFunction(value => {
    const labelEl = document.querySelector('.active-view-label')
    return labelEl && labelEl.textContent.includes(value)
  }, { timeout: 8000 }, label)
}

async function clickSidebarTabExpectNavigation(page, label, pathname) {
  await ensureSidebarExpanded(page)
  await page.waitForFunction(value => {
    return [...document.querySelectorAll('.sidebar-nav .sidebar-item')].some(el => {
      const rect = el.getBoundingClientRect()
      return rect.width > 0 && rect.height > 0 && el.textContent.includes(value)
    })
  }, { timeout: 8000 }, label)
  const navigationPromise = page.waitForFunction(expected => window.location.pathname === expected, { timeout: 8000 }, pathname)
  const clicked = await page.evaluate(value => {
    const el = [...document.querySelectorAll('.sidebar-nav .sidebar-item')].find(item => item.textContent.includes(value))
    if (!el) return false
    el.click()
    return true
  }, label)
  if (!clicked) throw new Error(`sidebar tab not found: ${label}`)
  await navigationPromise
}

async function clickButtonInCard(page, cardHeading, buttonText) {
  await page.waitForFunction((heading, text) => {
    const cards = [...document.querySelectorAll('.card')]
    return cards.some(card =>
      card.innerText.includes(heading) &&
      [...card.querySelectorAll('button')].some(button => button.textContent.includes(text))
    )
  }, { timeout: 8000 }, cardHeading, buttonText)
  const clicked = await page.evaluate((heading, text) => {
    const card = [...document.querySelectorAll('.card')].find(item => item.innerText.includes(heading))
    if (!card) return false
    const button = [...card.querySelectorAll('button')].find(item => item.textContent.includes(text))
    if (!button) return false
    button.scrollIntoView({ block: 'center', inline: 'center' })
    button.click()
    return true
  }, cardHeading, buttonText)
  if (!clicked) throw new Error(`button not found: ${cardHeading} / ${buttonText}`)
}

async function clickButtonNearText(page, blockText, buttonText) {
  await page.waitForFunction((needle, text) => {
    return [...document.querySelectorAll('button')].some(button => {
      if (!button.textContent.includes(text)) return false
      let node = button.parentElement
      while (node && node !== document.body) {
        if (node.innerText && node.innerText.includes(needle)) return true
        node = node.parentElement
      }
      return false
    })
  }, { timeout: 8000 }, blockText, buttonText)
  const clicked = await page.evaluate((needle, text) => {
    const button = [...document.querySelectorAll('button')].find(item => {
      if (!item.textContent.includes(text)) return false
      let node = item.parentElement
      while (node && node !== document.body) {
        if (node.innerText && node.innerText.includes(needle)) return true
        node = node.parentElement
      }
      return false
    })
    if (!button) return false
    button.scrollIntoView({ block: 'center', inline: 'center' })
    button.click()
    return true
  }, blockText, buttonText)
  if (!clicked) throw new Error(`button near text not found: ${blockText} / ${buttonText}`)
}

async function clickButtonByLabel(page, label) {
  await page.waitForFunction(value => {
    return [...document.querySelectorAll('button')].some(button =>
      button.getAttribute('aria-label') === value || button.getAttribute('title') === value
    )
  }, { timeout: 8000 }, label)
  const clicked = await page.evaluate(value => {
    const button = [...document.querySelectorAll('button')].find(item =>
      item.getAttribute('aria-label') === value || item.getAttribute('title') === value
    )
    if (!button) return false
    button.scrollIntoView({ block: 'center', inline: 'center' })
    button.click()
    return true
  }, label)
  if (!clicked) throw new Error(`button label not found: ${label}`)
}

async function verifyAdminIfVisible(page) {
  const visible = await hasText(page, '请输入管理员密码')
  if (!visible) return
  if (!LIVE_ADMIN_PASSWORD) throw new Error('admin dialog is visible but DASHBOARD_SMOKE_ADMIN_PASSWORD is not set')
  const inputHandle = await page.evaluateHandle(() => {
    const inputs = [...document.querySelectorAll('input')]
    return inputs.find(input => input.offsetParent && (input.placeholder || '').includes('管理员')) ||
      inputs.find(input => input.offsetParent && input.type === 'password') ||
      inputs.find(input => input.offsetParent)
  })
  const input = inputHandle.asElement()
  if (!input) throw new Error('admin password input not found')
  await input.click({ clickCount: 3 })
  await input.type(LIVE_ADMIN_PASSWORD)
  await clickText(page, '确认')
  await page.waitForFunction(() => !document.body.innerText.includes('请输入管理员密码'), { timeout: 10000 })
}

async function typePlaceholder(page, placeholder, value) {
  await page.waitForSelector(`input[placeholder="${placeholder}"], textarea[placeholder="${placeholder}"]`, { timeout: 8000 })
  const selector = `input[placeholder="${placeholder}"], textarea[placeholder="${placeholder}"]`
  await page.click(selector, { clickCount: 3 })
  await page.type(selector, value)
}

async function selectOptionValue(page, optionValue) {
  const labelByValue = {
    dashscope: 'DashScope',
    deepseek: 'DeepSeek',
    'qwen-vl-plus': 'Qwen VL',
    'deepseek-chat': 'DeepSeek Chat',
    '测试人格': '测试人格',
    '普通人格': '普通人格',
    __cloned__: '克隆音色',
    voice_asset_a: '测试音色',
  }
  const changed = await page.evaluate(value => {
    const select = [...document.querySelectorAll('select')].find(item =>
      [...item.options].some(option => option.value === value)
    )
    if (!select) return false
    select.value = value
    select.dispatchEvent(new Event('change', { bubbles: true }))
    return true
  }, optionValue)
  if (changed) return
  const label = labelByValue[optionValue] || optionValue
  const picked = await page.evaluate(async ({ value, labelText }) => {
    const waitFrame = () => new Promise(resolve => requestAnimationFrame(() => resolve()))
    const wraps = [...document.querySelectorAll('.sb-wrap')].filter(wrap => {
      const box = wrap.getBoundingClientRect()
      return box.width > 0 && box.height > 0 && !wrap.classList.contains('disabled')
    })
    for (const wrap of wraps) {
      const trigger = wrap.querySelector('.sb-trigger')
      if (!trigger) continue
      trigger.click()
      await waitFrame()
      const options = [...wrap.querySelectorAll('.sb-opt')]
      const option = options.find(item => item.textContent.trim() === labelText || item.textContent.includes(labelText) || item.textContent.includes(value))
      if (option) {
        option.click()
        return true
      }
      trigger.click()
      await waitFrame()
    }
    return false
  }, { value: optionValue, labelText: label })
  if (!picked) throw new Error(`select option not found: ${optionValue}`)
}

async function waitForSelectBoxOption(page, label, shouldExist = true) {
  await page.waitForFunction(async ({ labelText, expected }) => {
    const waitFrame = () => new Promise(resolve => requestAnimationFrame(() => resolve()))
    const nativeExists = [...document.querySelectorAll('select option')].some(option => option.value === labelText || option.textContent.includes(labelText))
    let customExists = false
    const wraps = [...document.querySelectorAll('.sb-wrap')].filter(wrap => {
      const box = wrap.getBoundingClientRect()
      return box.width > 0 && box.height > 0 && !wrap.classList.contains('disabled')
    })
    for (const wrap of wraps) {
      const trigger = wrap.querySelector('.sb-trigger')
      if (!trigger) continue
      trigger.click()
      await waitFrame()
      if ([...wrap.querySelectorAll('.sb-opt')].some(option => option.textContent.includes(labelText))) customExists = true
      trigger.click()
      await waitFrame()
      if (customExists) break
    }
    return expected ? (nativeExists || customExists) : !(nativeExists || customExists)
  }, { timeout: 8000 }, { labelText: label, expected: shouldExist })
}

async function waitForSelectBoxLabel(page, label) {
  await page.waitForFunction(labelText => {
    if ([...document.querySelectorAll('select')].some(select => select.value === labelText || select.selectedOptions[0]?.textContent.includes(labelText))) return true
    return [...document.querySelectorAll('.sb-trigger')].some(trigger => {
      const box = trigger.getBoundingClientRect()
      return box.width > 0 && box.height > 0 && trigger.textContent.includes(labelText)
    })
  }, { timeout: 8000 }, label)
}

async function verifyAdminModalCancel(page) {
  await waitForVisibleSelector(page, '.admin-modal-card')
  await page.waitForFunction(() => {
    const modal = document.querySelector('.admin-modal-card')
    if (!modal) return false
    const box = modal.getBoundingClientRect()
    const style = getComputedStyle(modal)
    return box.width > 0 && box.height > 0 && style.visibility !== 'hidden' && modal.innerText.includes('管理员密码')
  }, { timeout: 8000 })
  await clickText(page, '取消', '.admin-modal-card button')
  await page.waitForFunction(() => !document.querySelector('.admin-modal-card'), { timeout: 8000 })
}

async function verifyDeployPanel(page) {
  await clickSidebarTab(page, '部署')
  await waitForText(page, '部署方式')
  await waitForText(page, 'Windows 本地部署向导')
  await waitForText(page, '当前不是 Windows 本地部署器')
  await waitForText(page, 'mock backend is not Windows')
  await waitForText(page, '/opt/mock-koishi')
  await clickText(page, '切换到远程 Linux 部署')
  await waitForText(page, '远程 Linux 部署')
  await waitForInputValue(page, 'mock-user@mock-host.invalid')
  await waitForInputValue(page, '/opt/mock-koishi')
  await waitForText(page, '重建并部署到远端')
  await waitForText(page, '重建前端')
  await clickText(page, '自动填入服务器地址')
  await waitForText(page, '已读取部署配置')
  await clickText(page, '检查更新')
  await waitForText(page, '本地 local-mock，远程 remote-mock')
  await clickSidebarTab(page, '功能地图')
  await waitForText(page, '功能介绍')
}

async function verifyControlPanel(page) {
  await clickSidebarTab(page, '终端控制')
  await waitForText(page, 'Bot 运行节点')
  await waitForText(page, 'Online - 运行中')
  await waitForText(page, 'mock-user@mock-host.invalid')
  await waitForText(page, '点击查看 NapCat token 后显示')
  await clickText(page, '查看 NapCat token')
  await verifyAdminModalCancel(page)
  await typePlaceholder(page, '输入新的监听 QQ 号', '654321')
  await clickText(page, '重载配置')
  await verifyAdminModalCancel(page)
  await clickText(page, '保存')
  await waitForText(page, '节流配置已保存')
}

async function verifyAgentNavigation(page) {
  await clickSidebarTabExpectNavigation(page, 'Agent 控制台', '/agent/')
  await page.goBack({ waitUntil: 'networkidle0' })
  await waitForText(page, '莲莲图集')
}

async function verifyLegacyAgentTabColdStart(page) {
  await page.evaluate(() => {
    localStorage.setItem('dashboard_token', 'mock-token')
    localStorage.setItem('dashboard_deploy_unlocked', 'true')
    localStorage.setItem('dashboard_active_tab', 'agent')
    localStorage.setItem('dashboard_sidebar_expanded', 'true')
  })
  await page.reload({ waitUntil: 'networkidle0' })
  await page.waitForFunction(() => ['/', '/dashboard/'].includes(window.location.pathname), { timeout: 8000 })
  await waitForText(page, '功能介绍')
  await page.waitForFunction(() => {
    const text = document.body?.innerText || ''
    return !text.includes('危险工具策略') && !text.includes('QQ 继承聊天人格') && !text.includes('Mock Session')
  }, { timeout: 8000 })
  const storedTab = await page.evaluate(() => localStorage.getItem('dashboard_active_tab'))
  if (storedTab !== 'features') throw new Error(`legacy agent tab was not normalized: ${storedTab}`)
}

async function verifyResourcePanel(page, options = {}) {
  const allowWrites = options.allowWrites !== false
  const expectMockData = options.expectMockData !== false
  await clickSidebarTab(page, '资源中心')
  await waitForText(page, '资源总览')
  await waitForText(page, '日报预计算')
  await waitForText(page, '内存走势')
  if (!expectMockData) return
  await waitForText(page, 'worker 采样 10s')
  await waitForText(page, '面板补采样 5s')
  await waitForText(page, '当前聚合 10s')
  await waitForText(page, '点数 3')
  await waitForText(page, '当前 1100 MB')
  await waitForText(page, '最低 900 MB')
  await waitForText(page, '最高 1100 MB')
  await waitForText(page, 'mock-running-1')
  await waitForText(page, 'worker-a')
  await waitForText(page, 'mock-task-1')
  await waitForText(page, 'mock_event')
  await waitForText(page, 'group_10001')
  await waitForText(page, 'group_20002')
  await page.waitForFunction(() => {
    const dots = document.querySelectorAll('.memory-chart-dot')
    const line = document.querySelector('.memory-chart-line')
    const points = line ? line.getAttribute('points') || '' : ''
    const text = document.body.innerText || ''
    return dots.length >= 3 && points.length > 0 && !text.includes('暂无内存采样')
  }, { timeout: 8000 })
  await page.select('.memory-range-select', '30m')
  await waitForText(page, '当前 1110 MB')
  await waitForText(page, '最低 910 MB')
  await waitForText(page, '最高 1110 MB')
  await typePlaceholder(page, '搜索群号', '20002')
  await waitForTextInSelector(page, '.resource-precompute-card', 'group_20002')
  await waitForTextNotInSelector(page, '.resource-precompute-card', 'group_10001')
  await typePlaceholder(page, '搜索群号', 'no-such-group')
  await waitForText(page, '未找到匹配群号')
  await page.click('input[placeholder="搜索群号"]', { clickCount: 3 })
  await page.keyboard.press('Backspace')
  await waitForTextInSelector(page, '.resource-precompute-card', 'group_10001')
  if (!allowWrites) return
  await clickText(page, '刷新')
  await waitForText(page, 'mock-running-1')
  await clickText(page, '刷新队列')
  await waitForText(page, 'mock-task-2')
  await clickText(page, '刷新事件')
  await waitForText(page, 'worker event')
  await clickText(page, '回收 stale')
  await waitForText(page, 'mock-running-1')
  await clickText(page, '开启维护')
  await waitForText(page, 'mock-running-1')
  await clickButtonNearText(page, 'mock-task-1', '取消')
  await waitForText(page, 'mock-task-1')
}

async function verifyMobileSidebar(page) {
  await page.setViewport({ width: 390, height: 820, deviceScaleFactor: 1, isMobile: true })
  await page.evaluate(() => {
    localStorage.setItem('dashboard_sidebar_expanded', 'false')
    localStorage.setItem('dashboard_active_tab', 'features')
  })
  await page.reload({ waitUntil: 'networkidle0' })
  await waitForText(page, '功能介绍')
  await ensureSidebarExpanded(page)
  await waitForVisibleSelector(page, '.sidebar-scrim')
  await clickSidebarTab(page, '指令速查')
  await waitForText(page, '/help')
  await page.waitForFunction(() => !document.querySelector('.sidebar-nav .sidebar-item'), { timeout: 8000 })
  await ensureSidebarExpanded(page)
  await waitForVisibleSelector(page, '.sidebar-scrim')
  await clickVisibleSelector(page, '.sidebar-scrim')
  await page.waitForFunction(() => !document.querySelector('.sidebar-nav .sidebar-item'), { timeout: 8000 })
  await page.waitForFunction(() => {
    const app = document.querySelector('.app')
    const head = document.querySelector('.app-head')
    if (!app || !head) return false
    const appBox = app.getBoundingClientRect()
    const headBox = head.getBoundingClientRect()
    return appBox.width > 0 && appBox.height > 0 && headBox.width > 0 && headBox.height > 0
  }, { timeout: 8000 })
  await page.setViewport({ width: 1440, height: 1100, deviceScaleFactor: 1 })
  await page.evaluate(() => localStorage.setItem('dashboard_sidebar_expanded', 'true'))
  await page.reload({ waitUntil: 'networkidle0' })
  await waitForText(page, '指令速查')
}

async function runClicks(page) {
  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' })
  await page.evaluate(() => {
    localStorage.setItem('dashboard_token', 'mock-token')
    localStorage.removeItem('dashboard_deploy_unlocked')
    localStorage.removeItem('dashboard_active_tab')
    localStorage.setItem('dashboard_sidebar_expanded', 'true')
  })
  await page.reload({ waitUntil: 'networkidle0' })

  await waitForText(page, '先完成部署')
  await clickText(page, '我已部署，解锁')
  await waitForText(page, '功能介绍')
  await verifyLegacyAgentTabColdStart(page)

  await verifyDeployPanel(page)

  await clickText(page, '主题：')
  await waitForText(page, '界面风格')
  await clickText(page, '昼白')
  await waitForText(page, '功能介绍')

  await verifyControlPanel(page)

  await clickSidebarTab(page, '指令速查')
  await waitForText(page, '/help')

  await clickSidebarTab(page, '模型配置')
  await waitForText(page, '供应商和模型')
  await selectOptionValue(page, 'dashscope')
  await clickText(page, '+ 添加供应商')
  await typePlaceholder(page, '标识', 'localmock')
  await typePlaceholder(page, '名称', 'Local Mock')
  await clickText(page, '保存自定义供应商')
  await waitForText(page, '自定义供应商已保存')
  await clickText(page, '+ 添加步骤')
  await clickText(page, '保存 聊天 Fallback')
  await waitForText(page, 'Fallback 链已保存')

  await clickSidebarTab(page, '人格实验室')
  await waitForText(page, '创建/修改人格')
  await clickText(page, '编辑')
  await waitForFieldValue(page, '测试人格内容')
  await clickText(page, '取消')
  await clickText(page, '创建人格')
  await waitForText(page, '请输入名称')
  await typePlaceholder(page, '人格名称，如：新角色', '新测试人格')
  await typePlaceholder(page, '在此编写人格的提示词...', '这是一段模拟人格提示词。')
  await clickText(page, '创建人格')
  await waitForText(page, 'persona created')
  await clickButtonInCard(page, '世界观管理', '编辑')
  await waitForFieldValue(page, '世界观内容')
  await clickText(page, '取消', 'button')
  await clickButtonInCard(page, '世界观管理', '创建')
  await waitForText(page, '请输入标识')
  await selectOptionValue(page, '测试人格')
  await waitForSelectBoxOption(page, '克隆音色', true)
  await selectOptionValue(page, '普通人格')
  await waitForSelectBoxOption(page, '克隆音色', false)
  await selectOptionValue(page, '测试人格')
  await waitForSelectBoxOption(page, '克隆音色', true)
  await page.waitForFunction(() => [...document.querySelectorAll('input')].some(input => input.value === '温柔'), { timeout: 8000 })
  await Promise.all([
    page.waitForRequest(req => req.method() === 'POST' && req.url().includes('/agent/tts/preview'), { timeout: 8000 }),
    clickButtonInCard(page, '语音合成配置', '试听'),
  ])
  await page.waitForSelector('audio[src^="blob:"]', { timeout: 8000 })
  await page.waitForFunction((expectedFirstChartLabel) => {
    const audio = document.querySelector('audio')
    return audio &&
      audio.src.startsWith('blob:') &&
      audio.readyState >= HTMLMediaElement.HAVE_METADATA &&
      Number.isFinite(audio.duration) &&
      audio.duration > 0
  }, { timeout: 8000 })
  await waitForText(page, '已克隆音色')
  await page.waitForFunction(() => [...document.querySelectorAll('input')].some(input => input.value === '测试音色'), { timeout: 8000 })
  await Promise.all([
    page.waitForRequest(req => req.method() === 'PUT' && req.url().includes('/agent/persona/voice'), { timeout: 8000 }),
    clickButtonInCard(page, '已克隆音色', '启用'),
  ])
  await waitForSelectBoxLabel(page, '克隆音色')
  await waitForSelectBoxLabel(page, '测试音色')
  await waitForText(page, '使用：测试人格')

  await clickSidebarTab(page, 'API Keys')
  await waitForText(page, 'API Key 管理')
  await waitForText(page, '模型分布')
  await waitForText(page, 'Token 使用趋势')
  await waitForText(page, '今天')
  await waitForText(page, '7天')
  await waitForText(page, '30天')
  await waitForText(page, 'mimo-v2-omni')
  await waitForText(page, 'deepseek-v4-flash')
  if (process.env.DASHBOARD_SMOKE_DEBUG_TOKEN_STATS) {
    const tokenStatsDebug = await page.evaluate(() => {
      const rows = [...document.querySelectorAll('.distribution-table tbody tr')]
      const trendPoints = [...document.querySelectorAll('.trend-point')]
      const chartLabels = [...document.querySelectorAll('.chart-axis text')].map(el => el.textContent.trim())
      const rowText = rows.map(row => row.innerText).join('\n')
      const pointTitles = [...document.querySelectorAll('.trend-point title')].map(el => el.textContent.trim())
      const colors = rows.map(row => getComputedStyle(row.querySelector('.model-dot')).backgroundColor)
      return {
        rows: rows.length,
        trendPoints: trendPoints.length,
        chartLabels,
        rowText,
        pointTitles,
      unknownModelRows: rows.filter(row => row.innerText.includes('未分模型（历史数据）')).length,
        uniqueColors: Array.from(new Set(colors)),
        donutBackground: getComputedStyle(document.querySelector('.donut-wrap')).backgroundImage,
      }
    })
    console.log('[dashboard-smoke token-stats]', JSON.stringify(tokenStatsDebug, null, 2))
  }
  await page.waitForFunction((expectedFirstChartLabel) => {
    const text = document.body.innerText
    if (text.includes('[object Object]')) return false
    if (text.includes('"key"') || text.includes('"label"')) return false
    const rows = [...document.querySelectorAll('.distribution-table tbody tr')]
    const trendPoints = [...document.querySelectorAll('.trend-point')]
    const chartLabels = [...document.querySelectorAll('.chart-axis text')].map(el => el.textContent.trim())
    const rowText = rows.map(row => row.innerText).join('\n')
    const pointTitles = [...document.querySelectorAll('.trend-point title')].map(el => el.textContent.trim()).join('\n')
    const unknownModelRows = rows.filter(row => row.innerText.includes('未分模型（历史数据）'))
    const colors = rows.map(row => getComputedStyle(row.querySelector('.model-dot')).backgroundColor)
    const uniqueColors = new Set(colors)
    const cacheHitPoints = [...document.querySelectorAll('.trend-point title')].filter(el => el.textContent.includes('Cache Hit Rate'))
    return rows.length >= 10
      && trendPoints.length >= 10
      && rowText.includes('604.0M')
      && rowText.includes('未分模型（历史数据）')
      && unknownModelRows.length === 1
      && rowText.includes('mock-extra-model-10')
      && pointTitles.includes('196.0M')
      && cacheHitPoints.length === 0
      && uniqueColors.size >= Math.min(8, colors.length)
      && chartLabels.includes(expectedFirstChartLabel)
      && getComputedStyle(document.querySelector('.donut-wrap')).backgroundImage.includes('conic-gradient')
  }, { timeout: 8000 }, chartDate(addDays(todayShanghaiDate(), -3)))
  await clickText(page, '今天')
  await page.waitForFunction(() => {
    const text = document.body.innerText || ''
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' })
      .formatToParts(new Date())
      .reduce((acc, item) => { acc[item.type] = item.value; return acc }, {})
    const todayText = `${today.year}-${today.month}-${today.day}`
    return text.includes(`今天 ${todayText}`)
      && text.includes('75.2M')
      && text.includes('mock-extra-model-10')
      && document.querySelectorAll('.distribution-table tbody tr').length >= 9
      && document.querySelectorAll('.trend-point').length >= 3
      && ![...document.querySelectorAll('.trend-point title')].some(el => el.textContent.includes('Cache Hit Rate'))
  }, { timeout: 8000 })
  await clickText(page, '30天')
  await page.waitForFunction(() => {
    const text = document.body.innerText || ''
    const labels = [...document.querySelectorAll('.chart-axis text')].map(el => el.textContent.trim())
    return document.querySelectorAll('.distribution-table tbody tr').length >= 3
      && labels.length >= 4
      && [...document.querySelectorAll('.distribution-table tbody tr')].filter(row => row.innerText.includes('未分模型（历史数据）')).length === 1
  }, { timeout: 8000 })
  await clickText(page, '编辑')
  await typePlaceholder(page, '输入新的 ai-deepseek-key.txt', 'local-smoke-placeholder')
  await clickText(page, '保存')
  await waitForText(page, 'Key 已更新并热加载')

  await clickSidebarTab(page, '黑白名单')
  await waitForText(page, '黑白名单管理')
  await clickText(page, '刷新全部')
  await waitForText(page, '已刷新')

  await clickSidebarTab(page, '安全设置')
  await waitForText(page, '访问密码')
  await typePlaceholder(page, '新访问密码', 'abc123')
  await clickText(page, '修改访问密码')
  await waitForText(page, 'password changed')

  await clickSidebarTab(page, '日志中心')
  await waitForText(page, 'mock log line')

  await clickSidebarTab(page, '系统状态')
  await waitForText(page, '当前供应商')
  await waitForText(page, 'deepseek')

  await verifyResourcePanel(page)

  await clickSidebarTab(page, '莲莲图集')
  await waitForText(page, '莲莲图集')
  await clickButtonByLabel(page, '批量删除')
  await waitForText(page, '点击图片选择要删除的项目')

  await verifyAgentNavigation(page)
  await verifyMobileSidebar(page)
}

async function runLiveClicks(page) {
  if (!LIVE_PASSWORD && !LIVE_TOKEN) throw new Error('DASHBOARD_SMOKE_PASSWORD or DASHBOARD_SMOKE_TOKEN is required for live smoke')
  await page.goto(LIVE_URL, { waitUntil: 'networkidle0' })
  if (LIVE_TOKEN) {
    await page.evaluate(token => {
      localStorage.setItem('dashboard_token', token)
      localStorage.removeItem('dashboard_deploy_unlocked')
      localStorage.setItem('dashboard_sidebar_expanded', 'true')
    }, LIVE_TOKEN)
    if (LIVE_ADMIN_TOKEN) {
      await page.evaluate(token => {
        localStorage.setItem('dashboard_server_token', JSON.stringify({ token, expires: Date.now() + 3600000 }))
      }, LIVE_ADMIN_TOKEN)
    }
    await page.reload({ waitUntil: 'networkidle0' })
  }
  if (await hasText(page, '请输入访问密码以继续')) {
    await typePlaceholder(page, '密码', LIVE_PASSWORD)
    await clickText(page, '登录')
  }
  await waitForText(page, 'LianBoard 控制中心', 15000)
  if (await hasText(page, '先完成部署')) {
    await clickText(page, '我已部署，解锁')
  }
  await waitForText(page, '功能介绍', 15000)

  await ensureSidebarExpanded(page)
  await clickText(page, '主题：')
  await waitForText(page, '界面风格')
  await clickText(page, '昼白')

  await clickSidebarTab(page, '指令速查')
  await waitForText(page, '指令速查')

  await clickSidebarTab(page, '模型配置')
  await waitForText(page, '供应商和模型')
  await verifyAdminIfVisible(page)
  await selectOptionValue(page, 'dashscope').catch(() => {})
  await clickText(page, '+ 添加供应商').catch(() => {})

  await clickSidebarTab(page, '人格实验室')
  await waitForText(page, '创建/修改人格')
  await clickText(page, '编辑').catch(() => {})
  await waitForText(page, '保存修改').catch(() => {})
  await clickText(page, '取消').catch(() => {})

  await clickSidebarTab(page, 'API Keys')
  await waitForText(page, 'API Key 管理')
  await verifyAdminIfVisible(page)
  await waitForText(page, '模型分布')
  await waitForText(page, 'Token 使用趋势')
  await waitForText(page, '今天')
  await waitForText(page, '7天')
  await waitForText(page, '30天')
  await page.waitForFunction(() => {
    const text = document.body.innerText || ''
    if (text.includes('[object Object]')) return false
    if (text.includes('"key"') || text.includes('"label"')) return false
    const labels = ['MiMo', 'GLM', 'DeepSeek', '阿里云']
    if (!labels.some(label => text.includes(label))) return false
    return document.querySelectorAll('.distribution-table tbody tr').length > 0
      && document.querySelectorAll('.trend-point').length > 0
      && !!document.querySelector('.donut-wrap')
  }, { timeout: 15000 })
  await clickText(page, '今天').catch(() => {})
  await waitForText(page, '今天').catch(() => {})
  await clickText(page, '30天').catch(() => {})
  await clickText(page, '编辑').catch(() => {})
  await waitForText(page, '编辑').catch(() => {})
  await clickText(page, '取消').catch(() => {})

  await clickSidebarTab(page, '黑白名单')
  await waitForText(page, '黑白名单管理')
  await verifyAdminIfVisible(page)
  await clickText(page, '刷新全部').catch(() => {})

  await clickSidebarTab(page, '安全设置')
  await waitForText(page, '访问密码')

  await clickSidebarTab(page, '日志中心')
  await waitForText(page, '日志中心')
  await clickButtonByLabel(page, '刷新').catch(() => {})

  await clickSidebarTab(page, '系统状态')
  await waitForText(page, '当前状态')

  await verifyResourcePanel(page, { allowWrites: false, expectMockData: false })

  await clickSidebarTab(page, '莲莲图集')
  await waitForText(page, '莲莲图集')
  await clickButtonByLabel(page, '批量删除').catch(() => {})
}

async function main() {
  const browserPath = findBrowserExecutable()
  if (!browserPath) {
    throw new Error('No Chrome/Edge executable found. Set PUPPETEER_EXECUTABLE_PATH to run dashboard click smoke.')
  }

  const vite = LIVE_URL ? null : startVite()
  let browser = null
  const consoleErrors = []
  const responseErrors = []
  try {
    if (vite) await waitForServer(vite)
    browser = await puppeteer.launch({
      executablePath: browserPath,
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    })
    const page = await browser.newPage()
    page.on('response', response => {
      const status = response.status()
      if (status < 400) return
      const url = response.url()
      const pathname = new URL(url).pathname
      if (!LIVE_URL && status === 403 && pathname.startsWith('/dashboard/api/')) return
      if (!LIVE_URL && status === 404 && pathname.endsWith('/favicon.ico')) return
      responseErrors.push(`${status} ${url}`)
    })
    page.on('console', msg => {
      const text = msg.text()
      if (/Failed to load resource: the server responded with a status of (403|404)/.test(text)) return
      if (msg.type() === 'error') consoleErrors.push(text)
    })
    page.on('pageerror', error => consoleErrors.push(error.message))
    await page.setViewport({ width: 1440, height: 1100, deviceScaleFactor: 1 })
    if (LIVE_URL) {
      await runLiveClicks(page)
    } else {
      await installApiMock(page)
      await runClicks(page)
    }
    if (responseErrors.length) throw new Error('Browser response errors:\n' + responseErrors.join('\n'))
    if (consoleErrors.length) throw new Error('Browser console errors:\n' + consoleErrors.join('\n'))
    console.log(LIVE_URL ? 'dashboard live click smoke passed' : 'dashboard click smoke passed')
  } catch (error) {
    if (browser) {
      const pages = await browser.pages()
      const page = pages[pages.length - 1]
      if (page) {
        const out = path.join(ROOT, 'tmp', 'dashboard-click-smoke-failure.png')
        fs.mkdirSync(path.dirname(out), { recursive: true })
        await page.screenshot({ path: out, fullPage: true }).catch(() => {})
        console.error(`failure screenshot: ${out}`)
      }
    }
    throw error
  } finally {
    if (browser) await browser.close().catch(() => {})
    if (vite) vite.kill()
  }
}

main().catch(error => {
  console.error(error.stack || error.message || error)
  process.exit(1)
})
