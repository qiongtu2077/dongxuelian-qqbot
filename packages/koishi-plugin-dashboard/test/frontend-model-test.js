'use strict'

const assert = require('assert')
const fs = require('fs')
const path = require('path')
const ts = require('typescript')

const FRONTEND_ROOT = path.resolve(__dirname, '..', 'frontend', 'src')
const BACKEND_ROOT = path.resolve(__dirname, '..', 'src', 'lib')

// Installs a temporary TypeScript loader for pure frontend model modules.
function installTypeScriptLoader() {
  const previous = require.extensions['.ts']
  require.extensions['.ts'] = (module, filename) => {
    const source = fs.readFileSync(filename, 'utf8')
    const output = ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
      fileName: filename,
    }).outputText
    module._compile(output, filename)
  }
  return () => {
    if (previous) require.extensions['.ts'] = previous
    else delete require.extensions['.ts']
  }
}

// Loads one pure frontend service through the temporary TypeScript loader.
function loadService(name) {
  return require(path.join(FRONTEND_ROOT, 'services', `${name}.ts`))
}

// Loads one pure Dashboard backend module through the temporary TypeScript loader.
function loadBackendModule(name) {
  return require(path.join(BACKEND_ROOT, `${name}.ts`))
}

// Verifies deployment response normalization at the API boundary.
function testDeployModel(deploy) {
  const preview = deploy.normalizeUninstallPreview({
    deleteItems: [{ path: '/tmp/app', size: '42' }],
    warnings: [{ label: '保留数据' }],
  })
  assert.strictEqual(preview.deleteItems[0].key, '/tmp/app')
  assert.strictEqual(preview.deleteItems[0].size, 42)
  assert.strictEqual(preview.warnings[0].label, '保留数据')
}

// Verifies provider editing, validation and fallback transaction composition.
function testKeyManagerModel(keys) {
  const invalid = keys.buildProviderTransaction({ ...keys.createProviderDraft(), baseURL: '' }, [], {})
  assert.match(invalid.error, /不能为空/)

  const draft = keys.createProviderDraft()
  draft.apiKey = ' secret '
  const transaction = keys.buildProviderTransaction(draft, [], {})
  assert.strictEqual(transaction.error, '')
  assert.strictEqual(transaction.keyValue, 'secret')
  assert.strictEqual(transaction.providers.length, 1)
  assert.strictEqual(transaction.chains.chat[0].model, 'gpt-4o')
  assert.strictEqual(transaction.chains.vision[0].model, 'gpt-4o')
  assert.strictEqual(transaction.chains.lightweight[0].model, 'gpt-4o-mini')
}

// Verifies worker status classification against a deterministic resource snapshot.
function testResourceModel(resource) {
  const now = Date.parse('2026-08-30T08:00:00.000Z')
  const worker = {
    alive: true,
    kind: 'agent',
    heartbeatLagMs: 100,
    lastClaimAttemptAt: '2026-08-30T07:40:00.000Z',
  }
  const state = {
    media: {},
    status: {},
    tasks: [{ id: 'p1', kind: 'agent_task', status: 'pending' }],
  }
  assert.strictEqual(resource.workerBacklogCount(worker, state), 1)
  assert.strictEqual(resource.workerProgressStatus(worker, state, now).label, '疑似僵尸')
  assert.strictEqual(resource.memoryUsedValue({ memTotalMb: 4096, memAvailableMb: 1024 }), 3072)

  const modes = {
    normal: '正常',
    busy: '正在忙碌',
    report_silent: '日报生成中',
    critical: '资源紧张',
    maintenance: '维护中',
  }
  for (const [mode, label] of Object.entries(modes)) assert.strictEqual(resource.botModeDisplay(mode).label, label)
  assert.strictEqual(resource.resourceStateDisplay('green', 1024, 2048).label, '充足')
  assert.strictEqual(resource.resourceStateDisplay('yellow', 500, 2048).label, '注意')
  assert.strictEqual(resource.resourceStateDisplay('red', 200, 2048).label, '紧张')
  assert.strictEqual(resource.resourceStateDisplay('yellow', null, null).label, '资源数据暂不可用')
  assert.deepStrictEqual(
    resource.pauseReasonLabels(['maintenance', 'resource_critical', 'browser_active', 'daily_render_active']),
    ['维护模式', '资源不足', '浏览器自动操作占用', '日报图片生成占用'],
  )
  assert.strictEqual(resource.serverModeDisplay('small').label, '小内存策略')
  assert.strictEqual(resource.workerDisplay({ workerType: 'agent', workerHealthCode: 'stopped_idle', backlogTotal: 0 }).label, '已停止')
  assert.strictEqual(resource.workerDisplay({ workerType: 'media', workerHealthCode: 'idle', backlogTotal: 0 }).name, '媒体分析处理器')
  assert.strictEqual(resource.workerDisplay({ workerType: 'daily', workerHealthCode: 'working', runningCount: 1 }).name, '日报处理器')
  assert.strictEqual(
    resource.workerDisplay({ workerType: 'agent', workerHealthCode: 'running_unresponsive_backlog', backlogTotal: 1, runningCount: 1 }).label,
    '任务运行中，但处理器无响应；另有 1 项任务等待处理',
  )
  assert.strictEqual(resource.workerDisplay({ workerType: 'daily', workerHealthCode: 'claiming_idle', backlogTotal: 1 }).label, '处理器空闲')
  assert.strictEqual(resource.workerDisplay({ workerType: 'daily', workerHealthCode: 'task_timeout_idle', backlogTotal: 0 }).label, '处理器空闲，上一个任务超时')
  assert.strictEqual(resource.mediaQueueDisplay('image', { queueTotal: 96, queueLimit: 120, readyCount: 90, deferredCount: 6, runningCount: 1 }, 'near_limit').label, '接近上限')
  assert.match(resource.mediaSummaryDisplay({ mediaRiskCode: 'at_limit', mediaRiskKinds: ['file', 'voice'] }).detail, /文件、语音/)
}

// Verifies backend health-code precedence, all worker states, pause reasons, and media risk ties.
function testResourceReadability(readability) {
  const now = Date.parse('2026-08-30T08:00:00.000Z')
  const base = {
    snapshot: { botMode: 'normal', resourceState: 'green', backgroundAllowed: true },
    media: {
      queues: {
        image: { queueTotal: 0, queueLimit: 120, readyCount: 0, deferredCount: 0, runningCount: 0 },
        file: { queueTotal: 48, queueLimit: 60, readyCount: 40, deferredCount: 8, runningCount: 0 },
        voice: { queueTotal: 80, queueLimit: 80, readyCount: 75, deferredCount: 5, runningCount: 1 },
      },
    },
    resolveTaskTimeoutMs: () => 10000,
    now,
  }
  const paused = readability.buildBackgroundPauseReasons({
    botMode: 'maintenance',
    resourceState: 'red',
    backgroundAllowed: false,
    toolActive: true,
    renderActive: true,
  })
  assert.deepStrictEqual(paused, ['maintenance', 'resource_critical', 'browser_active', 'daily_render_active'])

  const cases = [
    { expected: 'idle', worker: { name: 'agent-worker', kind: 'agent', alive: true, heartbeatAt: '2026-08-30T07:59:59.000Z' }, tasks: [] },
    { expected: 'working', worker: { name: 'agent-worker', kind: 'agent', alive: true, currentTaskId: 'r1', heartbeatAt: '2026-08-30T07:59:59.000Z' }, tasks: [{ id: 'r1', kind: 'agent_task', status: 'running', startedAt: '2026-08-30T07:59:55.000Z' }] },
    { expected: 'claiming_idle', expectedRunningCount: 0, worker: { name: 'agent-worker', kind: 'agent', alive: false }, tasks: [{ id: 'c1', kind: 'agent_task', status: 'claiming', claimedBy: 'agent-worker' }, { id: 'p1', kind: 'agent_task', status: 'pending' }] },
    { expected: 'running_unresponsive_backlog', worker: { name: 'agent-worker', kind: 'agent', alive: false, currentTaskId: 'r1' }, tasks: [{ id: 'p1', kind: 'agent_task', status: 'pending' }, { id: 'r1', kind: 'agent_task', status: 'running', startedAt: '2026-08-30T07:59:55.000Z' }] },
    { expected: 'running_unresponsive_backlog', worker: { name: 'daily-worker', kind: 'daily', alive: false, currentTaskId: 'r1' }, tasks: [{ id: 'p1', kind: 'daily_report', status: 'pending' }, { id: 'r1', kind: 'daily_report', status: 'running', startedAt: '2026-08-30T07:59:55.000Z' }] },
    { expected: 'task_timeout_idle', worker: { name: 'agent-worker', kind: 'agent', alive: false, currentTaskId: 'r1' }, tasks: [{ id: 'r1', kind: 'agent_task', status: 'running', startedAt: '2026-08-30T07:59:40.000Z' }] },
    { expected: 'paused_auto_resume', worker: { name: 'agent-worker', kind: 'agent', alive: true, parked: true, heartbeatAt: '2026-08-30T07:59:59.000Z' }, tasks: [] },
    { expected: 'stopped_idle', worker: { name: 'agent-worker', kind: 'agent', alive: false }, tasks: [] },
    { expected: 'stopped_backlog', worker: { name: 'agent-worker', kind: 'agent', alive: false }, tasks: [{ id: 'p1', kind: 'agent_task', status: 'pending' }] },
    { expected: 'stalled', worker: { name: 'agent-worker', kind: 'agent', alive: true, heartbeatAt: '2026-08-30T07:40:00.000Z' }, tasks: [{ id: 'p1', kind: 'agent_task', status: 'pending' }] },
    { expected: 'task_timeout', worker: { name: 'agent-worker', kind: 'agent', alive: false, currentTaskId: 'r1' }, tasks: [{ id: 'p1', kind: 'agent_task', status: 'pending' }, { id: 'r1', kind: 'agent_task', status: 'running', startedAt: '2026-08-30T07:59:40.000Z' }] },
  ]
  for (const testCase of cases) {
    const result = readability.buildResourceReadability({ ...base, workers: [testCase.worker], tasks: testCase.tasks })
    assert.strictEqual(result.workers[0].workerHealthCode, testCase.expected)
    if (testCase.expectedRunningCount !== undefined) assert.strictEqual(result.workers[0].runningCount, testCase.expectedRunningCount)
  }
  const mediaWithRunningBacklog = {
    queues: {
      image: { queueTotal: 2, queueLimit: 120, readyCount: 1, deferredCount: 0, runningCount: 1 },
      file: { queueTotal: 0, queueLimit: 60, readyCount: 0, deferredCount: 0, runningCount: 0 },
      voice: { queueTotal: 0, queueLimit: 80, readyCount: 0, deferredCount: 0, runningCount: 0 },
    },
  }
  const mediaWorker = readability.buildResourceReadability({ ...base, media: mediaWithRunningBacklog, workers: [{ name: 'media-worker', kind: 'media', alive: false }], tasks: [] }).workers[0]
  assert.strictEqual(mediaWorker.workerHealthCode, 'running_unresponsive_backlog')
  assert.strictEqual(mediaWorker.runningCount, 1)
  const mediaRisk = readability.buildMediaRisk(base.media)
  assert.deepStrictEqual(mediaRisk.mediaRiskByKind, { image: 'idle', file: 'near_limit', voice: 'at_limit' })
  assert.strictEqual(mediaRisk.mediaRiskCode, 'at_limit')
  assert.deepStrictEqual(mediaRisk.mediaRiskKinds, ['voice'])
}

// Verifies fixed 120-record keyset pagination, stable ordering, filters, and lazy detail output.
function testResourceDiagnostics(diagnostics) {
  const resourceTasks = Array.from({ length: 245 }, (_, index) => ({
    id: `unknown-${String(index).padStart(3, '0')}`,
    kind: 'unknown_queue',
    status: 'failed',
    createdAt: '2026-08-30T08:00:00.000Z',
    updatedAt: '2026-08-30T08:00:00.000Z',
    error: index === 244 ? 'saved failure' : '',
  }))
  resourceTasks.push({ id: 'known-agent', kind: 'agent_task', status: 'pending', createdAt: '2026-08-30T09:00:00.000Z', updatedAt: '2026-08-30T09:00:00.000Z' })
  const mediaTasks = [
    { id: 'media-failed', kind: 'media_image_analysis', status: 'failed', createdAt: '2026-08-30T07:00:00.000Z', finishedAt: '2026-08-30T10:00:00.000Z', finishReason: 'processing_failed', error: 'media failure' },
  ]
  const source = { resourceTasks, mediaTasks, redactText: value => value }
  const first = diagnostics.buildResourceDiagnosticsPage(source)
  const second = diagnostics.buildResourceDiagnosticsPage(source, { cursor: first.nextCursor })
  const third = diagnostics.buildResourceDiagnosticsPage(source, { cursor: second.nextCursor })
  assert.strictEqual(first.items.length, 120)
  assert.strictEqual(second.items.length, 120)
  assert.strictEqual(third.items.length, 6)
  assert.strictEqual(third.hasMore, false)
  const ids = [...first.items, ...second.items, ...third.items].map(item => item.recordId)
  assert.strictEqual(new Set(ids).size, 246)
  assert.strictEqual(first.items[0].recordId, 'media:media-failed')
  const mediaOnly = diagnostics.buildResourceDiagnosticsPage(source, { group: 'media', reason: 'processing_failed' })
  assert.strictEqual(mediaOnly.total, 1)
  const detail = diagnostics.buildResourceDiagnosticDetail(source, 'media:media-failed')
  assert.strictEqual(detail.error, 'media failure')
  assert.strictEqual(Object.prototype.hasOwnProperty.call(detail, 'payload'), false)
}

// Verifies persona diagnostics and cloned-voice normalization.
function testPersonaModel(persona) {
  const asset = persona.normalizeVoiceAsset({ id: 'voice-1', displayName: '莲莲', referencedBy: ['椿'], size: '1024' })
  assert.strictEqual(asset.id, 'voice-1')
  assert.strictEqual(asset.size, 1024)
  assert.match(persona.assetOptionLabel(asset), /使用：椿/)
  const diagnostics = persona.flattenPersonaDiagnostics([{
    type: 'persona',
    name: '椿',
    diagnostics: [
      { level: 'info', code: 'I1', message: 'ignored' },
      { level: 'warning', code: 'W1', field: 'lore', message: '缺少世界书' },
    ],
  }])
  assert.strictEqual(diagnostics.length, 1)
  assert.strictEqual(diagnostics[0].message, '缺少世界书')
}

// Runs all pure Dashboard frontend model tests.
function main() {
  const restore = installTypeScriptLoader()
  try {
    testDeployModel(loadService('deploy-model'))
    testKeyManagerModel(loadService('key-manager-model'))
    testResourceModel(loadService('resource-model'))
    testResourceReadability(loadBackendModule('resource-readability'))
    testResourceDiagnostics(loadBackendModule('resource-diagnostics'))
    testPersonaModel(loadService('persona-model'))
    console.log('Dashboard frontend model tests passed')
  } finally {
    restore()
  }
}

main()
