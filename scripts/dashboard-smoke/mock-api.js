/** Pads a date component to two digits. */
function pad2(value) {
  return String(value).padStart(2, '0')
}

/** Returns today in the Asia/Shanghai time zone. */
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

/** Offsets an ISO date by the requested number of days. */
function addDays(date, offset) {
  const match = String(date || '').match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (!match) return date
  const d = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]) + offset))
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`
}

/** Converts an ISO date to the chart label format. */
function chartDate(date) {
  const match = String(date || '').match(/^\d{4}-(\d{2})-(\d{2})$/)
  return match ? `${match[1]}-${match[2]}` : date
}


/** Builds the deterministic image fixture used by gallery scenarios. */
function svgDataUri() {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="240"><rect width="320" height="240" fill="#182033"/><text x="24" y="126" fill="#f4c430" font-size="28">LianBoard</text></svg>'
  return 'data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64')
}

/** Builds the deterministic WAV fixture used by voice scenarios. */
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

/** Builds a Puppeteer-compatible JSON response. */
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
  serverMode: 'large',
  serverModeSource: 'resource-control/config.json',
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

/** Resolves a Dashboard API request against the local smoke-test fixture state. */
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
  if (method === 'POST' && pathname === '/deploy/preview') return ok({
    previewId: 'a'.repeat(32),
    expiresAt: Date.now() + 30 * 60 * 1000,
    canDeploy: true,
    blockers: [],
    source: { commit: 'b'.repeat(40), hostname: 'source-host', clean: true },
    target: { server: 'mock-user@mock-host.invalid', hostname: 'target-host', appDir: '/opt/mock-koishi', availableBytes: 1024 * 1024 * 1024, release: { releaseId: 'old-release' } },
    release: { releaseId: 'new-release', totalBytes: 1024, fileCount: 10 },
    requiredBytes: 64 * 1024 * 1024,
    changes: { added: 1, modified: 2, removed: 0, unchanged: 7 },
  })
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
    serverMode: mockState.serverMode,
    serverModeSource: mockState.serverModeSource,
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
  if (method === 'GET' && pathname === '/resource/mode') return ok({
    ok: true,
    serverMode: mockState.serverMode,
    serverModeSource: mockState.serverModeSource,
    tool_active: false,
    render_active: false,
    background_allowed: false,
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
      hostSampleIntervalMs: 10000,
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
  if (method === 'POST' && pathname === '/resource/mode') {
    const next = String(body.body?.serverMode || '').trim().toLowerCase()
    if (next !== 'small' && next !== 'large') return jsonResponse({ ok: false, message: 'serverMode 只能是 small 或 large' }, 400)
    mockState.serverMode = next
    return ok({
      ok: true,
      serverMode: mockState.serverMode,
      serverModeSource: mockState.serverModeSource,
      tool_active: false,
      render_active: false,
      background_allowed: false,
    })
  }

  return ok({ ok: true, message: `mocked ${method} ${pathname}` })
}


module.exports = {
  todayShanghaiDate,
  addDays,
  chartDate,
  jsonResponse,
  apiMock,
}
