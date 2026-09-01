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
  maintenance: false,
  resourceScenario: 'idle',
  openAiKeyConfigured: true,
  aiPriorities: {
    text: [{ provider: 'openai', model: 'gpt-4o-mini' }],
    vision: [{ provider: 'openai', model: 'gpt-4o-mini' }],
    'voice-asr': [{ provider: 'mimorium', model: 'mimo-v2.5-asr' }],
    'voice-tts': [{ provider: 'mimorium', model: 'mimo-v2.5-tts' }],
  },
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

/** Returns the eight fixed provider entries exposed by the unified AI page. */
function mockAiCatalog() {
  return [
    { id: 'openai', name: 'GPT', discoveryAvailable: true, discoveryReason: '', documentationURL: 'https://platform.openai.com/docs', supportedCapabilities: ['text', 'vision', 'voice-asr', 'voice-tts'] },
    { id: 'anthropic', name: 'Claude', discoveryAvailable: true, discoveryReason: '', documentationURL: 'https://docs.anthropic.com', supportedCapabilities: ['text', 'vision'] },
    { id: 'gemini', name: 'Gemini', discoveryAvailable: true, discoveryReason: '', documentationURL: 'https://ai.google.dev', supportedCapabilities: ['text', 'vision'] },
    { id: 'deepseek', name: '深度求索', discoveryAvailable: true, discoveryReason: '', documentationURL: 'https://api-docs.deepseek.com', supportedCapabilities: ['text'] },
    { id: 'glm', name: '智谱', discoveryAvailable: false, discoveryReason: 'Key 级模型枚举尚未验证', documentationURL: 'https://open.bigmodel.cn', supportedCapabilities: ['text', 'vision'] },
    { id: 'mimorium', name: '小米', discoveryAvailable: false, discoveryReason: 'Key 级模型枚举尚未验证', documentationURL: 'https://platform.xiaomimimo.com', supportedCapabilities: ['text', 'vision', 'voice-asr', 'voice-tts'] },
    { id: 'dashscope', name: '千问', discoveryAvailable: false, discoveryReason: '模型目录需要 Workspace ID', documentationURL: 'https://help.aliyun.com/zh/model-studio', supportedCapabilities: ['text', 'vision'] },
    { id: 'opencode', name: 'OpenCode', discoveryAvailable: false, discoveryReason: 'Key 级模型枚举尚未验证', documentationURL: 'https://opencode.ai/docs', supportedCapabilities: ['text', 'vision'] },
  ]
}

/** Builds a complete four-capability config snapshot from mutable smoke state. */
function mockAiConfig() {
  const emptyProvider = () => ({ models: [], key: { configured: false, prefix: '' } })
  const providers = Object.fromEntries(mockAiCatalog().map(provider => [provider.id, emptyProvider()]))
  providers.openai = {
    models: [
      { id: 'gpt-4o-mini', name: 'GPT-4o mini', capabilities: ['text', 'vision'] },
      { id: 'gpt-4o', name: 'GPT-4o', capabilities: ['text', 'vision'] },
      { id: 'gpt-4o-mini-transcribe', name: 'GPT-4o mini Transcribe', capabilities: ['voice-asr'] },
      { id: 'gpt-4o-mini-tts', name: 'GPT-4o mini TTS', capabilities: ['voice-tts'] },
    ],
    key: { configured: mockState.openAiKeyConfigured, prefix: mockState.openAiKeyConfigured ? 'sk-moc****' : '' },
  }
  providers.mimorium = {
    models: [
      { id: 'mimo-v2.5-asr', name: 'MiMo ASR', capabilities: ['voice-asr'] },
      { id: 'mimo-v2.5-tts', name: 'MiMo TTS', capabilities: ['voice-tts'] },
    ],
    key: { configured: true, prefix: 'tp-moc****' },
  }
  return {
    version: 1,
    capabilities: ['text', 'vision', 'voice-asr', 'voice-tts'],
    providers,
    priorities: Object.fromEntries(Object.entries(mockState.aiPriorities).map(([capability, steps]) => [capability, steps.map(step => ({ ...step }))])),
  }
}

/** Returns distinct readable or unavailable usage for the requested capability. */
function mockAiUsage(capability) {
  const today = todayShanghaiDate()
  if (capability === 'voice-asr') {
    return {
      capability, readable: false, unavailable: true,
      days: [{ date: today, key: today, label: today, total: 0, requests: 2, input: 0, output: 0, cacheCreation: 0, cacheRead: 0, readableRequests: 0, unreadableRequests: 2, providers: {}, models: {} }],
      providers: [{ key: 'mimorium', label: '小米', total: 0, requests: 2, input: 0, output: 0, cacheCreation: 0, cacheRead: 0, readableRequests: 0, unreadableRequests: 2 }],
      models: [{ key: 'mimorium/mimo-v2.5-asr', label: 'mimo-v2.5-asr', provider: 'mimorium', total: 0, requests: 2, input: 0, output: 0, cacheCreation: 0, cacheRead: 0, readableRequests: 0, unreadableRequests: 2 }],
    }
  }
  if (capability === 'voice-tts') return { capability, readable: false, unavailable: false, days: [], providers: [], models: [] }
  const vision = capability === 'vision'
  const total = vision ? 7200 : 18400
  const requests = vision ? 3 : 8
  return {
    capability, readable: true, unavailable: false,
    days: [{ date: today, key: today, label: today, total, requests, input: Math.floor(total * 0.7), output: Math.ceil(total * 0.3), cacheCreation: 0, cacheRead: 0, readableRequests: requests, unreadableRequests: 0, providers: {}, models: {} }],
    providers: [{ key: 'openai', label: 'GPT', total, requests, input: Math.floor(total * 0.7), output: Math.ceil(total * 0.3), cacheCreation: 0, cacheRead: 0, readableRequests: requests, unreadableRequests: 0 }],
    models: [{ key: `openai/${vision ? 'gpt-4o' : 'gpt-4o-mini'}`, label: vision ? 'gpt-4o' : 'gpt-4o-mini', provider: 'openai', total, requests, input: Math.floor(total * 0.7), output: Math.ceil(total * 0.3), cacheCreation: 0, cacheRead: 0, readableRequests: requests, unreadableRequests: 0 }],
  }
}

/** Builds empty media queue facts with the production capacity limits. */
function emptyMediaQueues() {
  return {
    image: { kind: 'image', queueTotal: 0, readyCount: 0, deferredCount: 0, runningCount: 0, queueLimit: 120, doneCount: 4, cacheReusableCount: 2 },
    file: { kind: 'file', queueTotal: 0, readyCount: 0, deferredCount: 0, runningCount: 0, queueLimit: 60, doneCount: 3, cacheReusableCount: 1 },
    voice: { kind: 'voice', queueTotal: 0, readyCount: 0, deferredCount: 0, runningCount: 0, queueLimit: 80, doneCount: 2, cacheReusableCount: 1 },
  }
}

/** Builds one independently injectable resource-status scenario. */
function resourceScenarioStatus(name) {
  const queues = emptyMediaQueues()
  const base = {
    ok: true,
    mode: mockState.maintenance ? 'maintenance' : 'normal',
    resourceState: 'yellow',
    serverMode: mockState.serverMode,
    serverModeSource: mockState.serverModeSource,
    memAvailableMb: 556,
    memTotalMb: 1608,
    memSource: 'mock',
    tool_active: false,
    render_active: false,
    background_allowed: !mockState.maintenance,
    backgroundPauseReasons: mockState.maintenance ? ['maintenance'] : [],
    running: null,
    queueLength: 0,
    workers: [{ name: 'agent-worker', workerType: 'agent', alive: true, workerHealthCode: 'idle', workerPauseReasons: [], heartbeatLagMs: 120, backlogTotal: 0, readyCount: 0, deferredCount: 0, runningCount: 0 }],
    media: {
      queues,
      mediaRiskByKind: { image: 'idle', file: 'idle', voice: 'idle' },
      mediaRiskCode: 'idle',
      mediaRiskKinds: ['image', 'file', 'voice'],
      doneCount: 9,
      cacheIndexSize: 4,
      unfinishedByReason: { queue_limit: 1, processing_failed: 1, restart_interrupted: 1, legacy_unknown: 1 },
    },
    precompute: {
      coverageCount: 2,
      slotCount: 3,
      coverage: [
        { date: todayShanghaiDate(), channelKey: 'group_10001', coverageRate: 0.8, updatedAt: '12:00' },
        { date: todayShanghaiDate(), channelKey: 'group_20002', coverageRate: 0.35, updatedAt: '12:05' },
      ],
    },
    maintenance: mockState.maintenance,
    events: [{ source: 'S1', event: 'mock_status_event', reason: 'resource mock ready', createdAt: '12:00:00' }],
  }
  if (name === 'working') {
    base.running = { taskId: 'mock-running-1', kind: 'agent_task', step: 'working', owner: 'agent-worker' }
    base.workers = [{ name: 'agent-worker', workerType: 'agent', alive: true, workerHealthCode: 'working', workerPauseReasons: [], heartbeatLagMs: 80, backlogTotal: 0, readyCount: 0, deferredCount: 0, runningCount: 1, currentTaskId: 'mock-running-1' }]
  } else if (name === 'stopped_idle') {
    base.workers = [{ name: 'agent-worker', workerType: 'agent', alive: false, workerHealthCode: 'stopped_idle', workerPauseReasons: [], heartbeatLagMs: 32020000, backlogTotal: 0, readyCount: 0, deferredCount: 0, runningCount: 0 }]
  } else if (name === 'stopped_backlog') {
    base.queueLength = 3
    base.workers = [{ name: 'agent-worker', workerType: 'agent', alive: false, workerHealthCode: 'stopped_backlog', workerPauseReasons: [], heartbeatLagMs: 900000, backlogTotal: 3, readyCount: 2, deferredCount: 1, runningCount: 0 }]
  } else if (name === 'task_timeout') {
    base.running = { taskId: 'mock-timeout-task', kind: 'daily_report', step: 'rendering', owner: 'daily-worker' }
    base.workers = [{ name: 'daily-worker', workerType: 'daily', alive: true, workerHealthCode: 'task_timeout', workerPauseReasons: [], heartbeatLagMs: 100, backlogTotal: 0, readyCount: 0, deferredCount: 0, runningCount: 1, currentTaskId: 'mock-timeout-task' }]
  } else if (name === 'small_browser_active') {
    base.serverMode = 'small'
    base.tool_active = true
    base.background_allowed = false
    base.backgroundPauseReasons = ['browser_active']
    base.workers = [{ name: 'media-worker', workerType: 'media', alive: true, workerHealthCode: 'paused_auto_resume', workerPauseReasons: ['browser_active'], heartbeatLagMs: 100, backlogTotal: 0, readyCount: 0, deferredCount: 0, runningCount: 0 }]
  } else if (name === 'media_near_limit') {
    queues.image = { ...queues.image, queueTotal: 96, readyCount: 90, deferredCount: 6, runningCount: 1 }
    base.media.mediaRiskByKind.image = 'near_limit'
    base.media.mediaRiskCode = 'near_limit'
    base.media.mediaRiskKinds = ['image']
  } else if (name === 'media_at_limit') {
    queues.file = { ...queues.file, queueTotal: 60, readyCount: 55, deferredCount: 5, runningCount: 1 }
    base.media.mediaRiskByKind.file = 'at_limit'
    base.media.mediaRiskCode = 'at_limit'
    base.media.mediaRiskKinds = ['file']
  } else if (name === 'unknown_queue') {
    base.queueLength = 1
    base.workers = [{ name: 'agent-worker', workerType: 'agent', alive: true, workerHealthCode: 'idle', workerPauseReasons: [], heartbeatLagMs: 100, backlogTotal: 0, readyCount: 0, deferredCount: 0, runningCount: 0 }]
  } else if (name === 'exclusive_anomaly') {
    base.mode = 'busy'
    base.running = { taskId: 'exclusive-anomaly-1', kind: 'diagnostic_probe', step: 'checking', owner: 'diagnostic-owner' }
  }
  return base
}

/** Builds more than one diagnostic page with all required record categories. */
function mockDiagnosticRecords() {
  const unknown = Array.from({ length: 121 }, (_, index) => ({
    recordId: `unknown:mock-unknown-${String(index).padStart(3, '0')}`,
    recordType: 'unknown_task',
    taskId: `mock-unknown-${String(index).padStart(3, '0')}`,
    kind: 'unknown_queue',
    status: 'failed',
    createdAt: new Date(Date.now() - index * 1000).toISOString(),
    updatedAt: new Date(Date.now() - index * 1000).toISOString(),
    relatedAt: new Date(Date.now() - index * 1000).toISOString(),
    finishReason: '',
    hasError: index === 0,
  }))
  const reasons = ['queue_limit', 'processing_failed', 'restart_interrupted', 'legacy_unknown']
  const media = reasons.map((finishReason, index) => ({
    recordId: `media:mock-media-${index}`,
    recordType: 'unfinished_media',
    taskId: `mock-media-${index}`,
    kind: index % 2 ? 'media_file_analysis' : 'media_image_analysis',
    status: 'failed',
    createdAt: new Date(Date.now() - 200000 - index * 1000).toISOString(),
    updatedAt: new Date(Date.now() - 190000 - index * 1000).toISOString(),
    finishedAt: new Date(Date.now() - 180000 - index * 1000).toISOString(),
    relatedAt: new Date(Date.now() - 180000 - index * 1000).toISOString(),
    finishReason,
    hasError: finishReason === 'processing_failed',
  }))
  return [...unknown, ...media]
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
  if (method === 'GET' && pathname === '/ai-model-api/config') return ok({ ok: true, catalog: mockAiCatalog(), config: mockAiConfig(), migration: { applied: false, diagnostics: [] } })
  if (method === 'POST' && pathname === '/ai-model-api/discover') {
    mockState.openAiKeyConfigured = true
    return ok({ ok: true, message: 'API Key 与模型池已原子保存', config: mockAiConfig(), models: mockAiConfig().providers.openai.models, removedModels: 0, removedSteps: 0, emptyCapabilities: [] })
  }
  if (method === 'PUT' && pathname === '/ai-model-api/priority') {
    const capability = String(body.body?.capability || '')
    const steps = Array.isArray(body.body?.steps) ? body.body.steps : []
    if (Object.prototype.hasOwnProperty.call(mockState.aiPriorities, capability)) mockState.aiPriorities[capability] = steps.map(step => ({ provider: step.provider, model: step.model }))
    return ok({ ok: true, message: steps.length ? '模型优先级已保存' : '优先级已保存；该能力未配置模型', config: mockAiConfig() })
  }
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
  if (method === 'GET' && pathname === '/keys/usage') return ok(mockAiUsage(String(body.searchParams.get('capability') || '')))

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

  if (method === 'GET' && pathname === '/resource/status') return ok(resourceScenarioStatus(mockState.resourceScenario))
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
  if (method === 'GET' && pathname === '/resource/diagnostics') {
    const all = mockDiagnosticRecords()
    const group = body.searchParams.get('group') || 'all'
    const reason = body.searchParams.get('reason') || ''
    const filtered = all.filter(item => {
      if (group === 'unknown' && item.recordType !== 'unknown_task') return false
      if (group === 'media' && item.recordType !== 'unfinished_media') return false
      if (reason && item.finishReason !== reason) return false
      return true
    })
    const offset = Math.max(0, Number(body.searchParams.get('cursor') || 0))
    const items = filtered.slice(offset, offset + 120)
    const nextOffset = offset + items.length
    return ok({
      ok: true,
      items,
      total: filtered.length,
      counts: {
        all: all.length,
        unknown: all.filter(item => item.recordType === 'unknown_task').length,
        media: all.filter(item => item.recordType === 'unfinished_media').length,
      },
      nextCursor: nextOffset < filtered.length ? String(nextOffset) : '',
      hasMore: nextOffset < filtered.length,
      pageSize: 120,
    })
  }
  if (method === 'GET' && pathname === '/resource/diagnostics/detail') {
    const recordId = body.searchParams.get('id') || ''
    const record = mockDiagnosticRecords().find(item => item.recordId === recordId)
    if (!record) return jsonResponse({ ok: false, message: '诊断记录不存在或已被清理' }, 404)
    return ok({
      ok: true,
      item: record,
      error: record.hasError ? 'mock saved diagnostic error' : '',
      diagnostics: { step: 'mock-step', source: 'dashboard-smoke', finishReason: record.finishReason },
    })
  }
  if (method === 'GET' && pathname === '/resource/workers') return ok({ ok: true, workers: resourceScenarioStatus(mockState.resourceScenario).workers })
  if (method === 'GET' && pathname === '/resource/media') return ok({ ok: true, media: resourceScenarioStatus(mockState.resourceScenario).media })
  if (method === 'GET' && pathname === '/resource/precompute') return ok({ ok: true, precompute: { coverageCount: 1, slotCount: 3, coverage: [] } })
  if (method === 'POST' && pathname === '/resource/cancel') return ok({ ok: true, message: '任务已取消' })
  if (method === 'POST' && pathname === '/resource/mock-scenario') {
    mockState.resourceScenario = String(body.body?.scenario || 'idle')
    return ok({ ok: true, scenario: mockState.resourceScenario })
  }
  if (method === 'POST' && pathname === '/resource/maintenance') {
    mockState.maintenance = !!body.body?.enabled
    return ok({
      ok: true,
      enabled: mockState.maintenance,
      message: mockState.maintenance
        ? '维护模式已开启，机器人将回复维护提示'
        : '维护模式已结束，智能回复和后台任务已恢复',
    })
  }
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
