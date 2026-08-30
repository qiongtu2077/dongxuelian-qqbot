'use strict'

const assert = require('assert')
const fs = require('fs')
const path = require('path')
const ts = require('typescript')

const FRONTEND_ROOT = path.resolve(__dirname, '..', 'frontend', 'src')

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
    testPersonaModel(loadService('persona-model'))
    console.log('Dashboard frontend model tests passed')
  } finally {
    restore()
  }
}

main()
