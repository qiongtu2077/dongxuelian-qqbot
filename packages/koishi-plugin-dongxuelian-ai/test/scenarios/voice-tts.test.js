const path = require('path')
const fs = require('fs')
const os = require('os')
const { spawnSync } = require('child_process')
const { withScenario } = require('./_setup')

// 构造供语音协议场景复用的最小可播放 WAV。
function buildTestWav(payload = Buffer.from([1, 2, 3, 4])) {
  const data = Buffer.from(payload)
  const header = Buffer.alloc(44)
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + data.length, 4)
  header.write('WAVE', 8)
  header.write('fmt ', 12)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(1, 22)
  header.writeUInt32LE(16000, 24)
  header.writeUInt32LE(32000, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36)
  header.writeUInt32LE(data.length, 40)
  return Buffer.concat([header, data])
}

// 验证语音识别、语音合成、人格音色与 Dashboard 预览的场景契约。
async function run(t) {
  t.section('scenario: voice ASR module')

  const voice = require('../../lib/media/voice/voice')

  t.check('extractVoicePayload returns null for empty session', voice.extractVoicePayload({}) === null)
  t.check('extractVoicePayload returns null for text-only', voice.extractVoicePayload({ content: 'hello' }) === null)

  t.check('extractVoicePayload finds record segment', (() => {
    const session = { event: { message: [{ type: 'record', data: { url: 'http://example.com/voice.silk' } }] } }
    const result = voice.extractVoicePayload(session)
    return result && result.url === 'http://example.com/voice.silk'
  })())

  t.check('extractVoicePayload finds CQ record', (() => {
    const session = { content: '[CQ:record,file=abc.silk,url=http://example.com/v.amr]' }
    const result = voice.extractVoicePayload(session)
    return result && result.url === 'http://example.com/v.amr'
  })())

  t.check('extractVoicePayload finds CQ record file only', (() => {
    const session = { content: '[CQ:record,file=abc.silk]' }
    const result = voice.extractVoicePayload(session)
    return result && result.file === 'abc.silk'
  })())

  await withScenario({
    data: { randomWhitelist: [] },
  }, async ({ ready, makeSession, run }) => {
    await ready()
    const session = makeSession({
      userId: '3001',
      author: { id: '3001', name: 'voice-user' },
      content: '',
      messageId: 'ordinary-group-voice',
      event: { sender: { role: 'member' }, message: [{ type: 'record', data: { file: 'voice.silk' } }] },
    })
    const result = await run(session, { flushTicks: 40 })
    const conversation = require('../../lib/conversation')
    const shared = conversation.channelSharedCache.get('10001') || []
    t.check('ordinary group voice writes shared audio anchor without ASR', result.sent.length === 0 && shared.some(item => item.messageId === 'ordinary-group-voice' && item.content === '[语音]' && item.hasAudio === true), JSON.stringify({ sent: result.sent, shared }))
  })

  t.section('scenario: voice TTS module')

  const tts = require('../../lib/media/voice/tts')

  t.check('getBuiltinVoices returns array', Array.isArray(tts.getBuiltinVoices()) && tts.getBuiltinVoices().length > 0)
  t.check('getBuiltinVoices includes 冰糖', tts.getBuiltinVoices().includes('冰糖'))
  t.check('getBuiltinVoices includes Mia', tts.getBuiltinVoices().includes('Mia'))

  t.check('extractVoiceStyle extracts tag', tts.extractVoiceStyle('你好【语音风格：温柔甜美】世界') === '温柔甜美')
  t.check('extractVoiceStyle returns null for no tag', tts.extractVoiceStyle('普通文本') === null)
  t.check('sanitizeTtsStyle normalizes whitespace', tts.sanitizeTtsStyle('  沉稳\n冷静\t ') === '沉稳 冷静')
  t.check('sanitizeTtsStyle caps long style', tts.sanitizeTtsStyle('风'.repeat(tts.MAX_TTS_STYLE_LENGTH + 20)).length === tts.MAX_TTS_STYLE_LENGTH)
  t.check('sanitizeTtsStyle redacts key-like content', !tts.sanitizeTtsStyle('沉稳 tp-secret-value-123456789').includes('tp-secret-value'))
  t.check('composeTtsStyle combines persona and temporary style', (() => {
    const result = tts.composeTtsStyle('沉稳冷静', '略带笑意')
    return result.includes('人格基础语音风格：沉稳冷静') && result.includes('本句临时语气：略带笑意') && result.includes('不要因为临时语气变成另一种人格')
  })())
  t.check('composeTtsStyle keeps guard when composed style is long', (() => {
    const result = tts.composeTtsStyle('沉稳'.repeat(90), '轻声'.repeat(90))
    return result.length <= tts.MAX_TTS_STYLE_LENGTH && result.includes('不要因为临时语气变成另一种人格')
  })())
  t.check('composeTtsStyle uses neutral fallback for empty style', tts.composeTtsStyle('', '') === tts.NEUTRAL_TTS_STYLE)

  t.check('stripVoiceStyleTag removes tag', tts.stripVoiceStyleTag('你好【语音风格：温柔甜美】世界') === '你好世界')
  t.check('stripVoiceStyleTag removes multiple tags', tts.stripVoiceStyleTag('A【语音风格：温柔】B【语音风格:轻声】C') === 'ABC')
  t.check('stripVoiceStyleTag preserves text without tag', tts.stripVoiceStyleTag('普通文本') === '普通文本')

  t.check('isChannelOnCooldown returns false for unknown channel', !tts.isChannelOnCooldown('test-channel-999'))

  tts.markChannelCooldown('test-channel-cd')
  t.check('isChannelOnCooldown returns true after mark', tts.isChannelOnCooldown('test-channel-cd'))

  t.check('shouldTriggerRandomVoice respects cooldown', !tts.shouldTriggerRandomVoice('test-channel-cd'))
  t.check('random voice upgrade rate is 10%', tts.RANDOM_VOICE_RATE === 0.1)
  t.check('getRandomVoiceRate returns default 10%', tts.getRandomVoiceRate('test-channel-default') === 0.1)
  const originalRandom = Math.random
  try {
    t.check('shouldTriggerRandomVoice triggers below 10%', tts.shouldTriggerRandomVoice('test-channel-rate-low', () => 0.099))
    t.check('shouldTriggerRandomVoice does not trigger at 10% boundary', !tts.shouldTriggerRandomVoice('test-channel-rate-edge', () => 0.1))
  } finally {
    Math.random = originalRandom
  }

  t.check('resolvePersonaVoice returns defaults for unknown persona', (() => {
    const result = tts.resolvePersonaVoice('nonexistent-persona-xyz')
    return result.voice === '冰糖' && result.style === tts.NEUTRAL_TTS_STYLE
  })())

  t.check('resolvePersonaVoice returns defaults for null', (() => {
    const result = tts.resolvePersonaVoice(null)
    return result.voice === '冰糖' && result.style === tts.NEUTRAL_TTS_STYLE
  })())

  t.section('scenario: voice asset metadata')

  const tempDataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-assets-'))
  const voiceAssetsModule = path.join(__dirname, '..', '..', 'lib', 'media', 'voice', 'voice-assets')
  const constantsModule = path.join(__dirname, '..', '..', 'lib', 'core', 'constants')
  const ttsModule = path.join(__dirname, '..', '..', 'lib', 'media', 'voice', 'tts')
  const dashboardRouteModule = path.join(__dirname, '..', '..', '..', 'koishi-plugin-dashboard', 'lib', 'routes', 'agent')
  const dashboardAuthModule = path.join(__dirname, '..', '..', '..', 'koishi-plugin-dashboard', 'lib', 'auth')
  const capabilityFixtureModule = path.join(__dirname, '..', 'helpers', 'ai-capability-fixture')
  const assetScript = `
const fs = require('fs')
const path = require('path')
const constants = require(${JSON.stringify(constantsModule)})
const voiceAssets = require(${JSON.stringify(voiceAssetsModule)})
const tts = require(${JSON.stringify(ttsModule)})
fs.mkdirSync(constants.VOICES_DIR, { recursive: true })
fs.mkdirSync(path.join(constants.DATA_DIR, 'ai-skills', 'personas'), { recursive: true })
const sample = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4096)])
const firstId = voiceAssets.createVoiceAssetId('TestPersona')
const firstFile = voiceAssets.buildVoiceAssetFilename(firstId, 'audio/wav')
fs.writeFileSync(path.join(constants.VOICES_DIR, firstFile), sample)
const asset = voiceAssets.upsertVoiceAsset({ id: firstId, personaName: 'TestPersona', filename: firstFile, displayName: '测试音色', description: '备注', sampleText: '试听文本' })
const secondId = voiceAssets.createVoiceAssetId('TestPersona')
const secondFile = voiceAssets.buildVoiceAssetFilename(secondId, 'audio/wav')
fs.writeFileSync(path.join(constants.VOICES_DIR, secondFile), Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(5120, 1)]))
const secondAsset = voiceAssets.upsertVoiceAsset({ id: secondId, personaName: 'TestPersona', filename: secondFile, displayName: '温柔版本', sampleText: '第二版试听' })
fs.writeFileSync(path.join(constants.DATA_DIR, 'ai-skills', 'personas', 'SKILL.TestPersona.md'), '---\\nname: TestPersona\\nvoice_id: __cloned__\\nvoice_asset_id: ' + secondAsset.id + '\\nvoice_style: 温柔\\n---\\n测试人格')
fs.writeFileSync(path.join(constants.DATA_DIR, 'ai-skills', 'personas', 'SKILL.ReusePersona.md'), '---\\nname: ReusePersona\\nvoice_id: __cloned__\\nvoice_asset_id: ' + asset.id + '\\nvoice_style: 轻快\\n---\\n复用人格')
const personaConfigs = [
  { name: 'TestPersona', voice: '__cloned__', voiceAssetId: secondAsset.id },
  { name: 'ReusePersona', voice: '__cloned__', voiceAssetId: asset.id },
]
const list = voiceAssets.listVoiceAssets(personaConfigs)
const updated = voiceAssets.updateVoiceAssetMetadata(asset.id, { displayName: '新版音色', sampleText: '新版试听' }, personaConfigs)
const sampleFile = voiceAssets.resolveVoiceSampleFile('TestPersona', secondAsset.id)
const reusedSampleFile = voiceAssets.resolveVoiceSampleFile('ReusePersona', asset.id)
const resolved = tts.resolvePersonaVoice('TestPersona')
const reused = tts.resolvePersonaVoice('ReusePersona')
const refsFirst = voiceAssets.listVoiceAssetReferences(asset, personaConfigs)
const refsSecond = voiceAssets.listVoiceAssetReferences(secondAsset, personaConfigs)
const deleted = voiceAssets.deleteVoiceAsset(asset.id, personaConfigs)
const afterDeleteFirst = voiceAssets.resolveVoiceSampleFile('ReusePersona', asset.id)
const afterDeleteSecond = voiceAssets.resolveVoiceSampleFile('TestPersona', secondAsset.id)
console.log(JSON.stringify({
  id: asset.id,
  secondId: secondAsset.id,
  filename: asset.filename,
  secondFilename: secondAsset.filename,
  listCount: list.length,
  displayName: updated && updated.displayName,
  sampleText: updated && updated.sampleText,
  sampleFound: !!sampleFile,
  reusedSampleFound: !!reusedSampleFile,
  resolvedClone: resolved.voice.startsWith('data:audio/wav;base64,') && resolved.style === '温柔',
  reusedClone: reused.voice.startsWith('data:audio/wav;base64,') && reused.style === '轻快',
  refsFirst,
  refsSecond,
  deletedFile: deleted && deleted.deleted && deleted.deleted[0],
  afterDeleteFirst: afterDeleteFirst === null,
  afterDeleteSecond: !!afterDeleteSecond,
}))
`
  const assetResult = spawnSync(process.execPath, ['-e', assetScript], {
    cwd: path.join(__dirname, '..', '..', '..', '..'),
    env: { ...process.env, DONGXUELIAN_AI_DATA_DIR: tempDataRoot },
    encoding: 'utf8',
  })
  let assetSummary = {}
  try { assetSummary = JSON.parse(String(assetResult.stdout || '').trim()) } catch {}
  t.check('voice asset metadata child process passes', assetResult.status === 0, assetResult.stderr || assetResult.stdout)
  t.check('voice asset ids are unique per upload', assetSummary.id && assetSummary.secondId && assetSummary.id !== assetSummary.secondId, JSON.stringify(assetSummary))
  t.check('voice asset files use asset ids', assetSummary.filename === `${assetSummary.id}.wav` && assetSummary.secondFilename === `${assetSummary.secondId}.wav`, JSON.stringify(assetSummary))
  t.check('voice asset list keeps multiple versions', assetSummary.listCount === 2, JSON.stringify(assetSummary))
  t.check('voice asset metadata update keeps file name stable', assetSummary.displayName === '新版音色' && assetSummary.sampleText === '新版试听')
  t.check('voice asset resolves sample file', assetSummary.sampleFound === true)
  t.check('voice asset can be reused by another persona', assetSummary.reusedSampleFound === true && assetSummary.reusedClone === true)
  t.check('resolvePersonaVoice reads voice_asset_id clone', assetSummary.resolvedClone === true)
  t.check('voice asset references list all users', Array.isArray(assetSummary.refsFirst) && assetSummary.refsFirst.includes('ReusePersona') && Array.isArray(assetSummary.refsSecond) && assetSummary.refsSecond.includes('TestPersona'), JSON.stringify(assetSummary))
  t.check('voice asset delete removes one sample only', assetSummary.deletedFile === `${assetSummary.id}.wav` && assetSummary.afterDeleteFirst === true && assetSummary.afterDeleteSecond === true, JSON.stringify(assetSummary))

  const voicesRouteScript = `
const fs = require('fs')
const path = require('path')
const constants = require(${JSON.stringify(constantsModule)})
const voiceAssets = require(${JSON.stringify(voiceAssetsModule)})
const auth = require(${JSON.stringify(dashboardAuthModule)})
const dashboard = require(${JSON.stringify(dashboardRouteModule)})
fs.mkdirSync(path.join(constants.DATA_DIR, 'ai-skills', 'personas'), { recursive: true })
fs.mkdirSync(constants.VOICES_DIR, { recursive: true })
const sample = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4096)])
const routeTestFile = voiceAssets.buildVoiceAssetFilename('route_test_voice', 'audio/wav')
const routeReuseFile = voiceAssets.buildVoiceAssetFilename('route_reuse_voice', 'audio/wav')
fs.writeFileSync(path.join(constants.VOICES_DIR, routeTestFile), sample)
fs.writeFileSync(path.join(constants.VOICES_DIR, routeReuseFile), Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4096, 1)]))
const routeTestAsset = voiceAssets.upsertVoiceAsset({ id: 'route_test_voice', personaName: 'TestPersona', filename: routeTestFile, displayName: 'Route Test Voice' })
const routeReuseAsset = voiceAssets.upsertVoiceAsset({ id: 'route_reuse_voice', personaName: 'ReusePersona', filename: routeReuseFile, displayName: 'Route Reuse Voice' })
fs.writeFileSync(path.join(constants.DATA_DIR, 'ai-skills', 'personas', 'SKILL.TestPersona.md'), '---\\nname: TestPersona\\nvoice_id: __cloned__\\nvoice_asset_id: ' + routeTestAsset.id + '\\nvoice_style: 温柔\\n---\\ntest persona')
fs.writeFileSync(path.join(constants.DATA_DIR, 'ai-skills', 'personas', 'SKILL.ReusePersona.md'), '---\\nname: ReusePersona\\nvoice_id: __cloned__\\nvoice_asset_id: ' + routeReuseAsset.id + '\\nvoice_style: 轻快\\n---\\nreuse persona')
fs.writeFileSync(path.join(constants.DATA_DIR, 'ai-skills', 'personas', 'SKILL.OrdinaryPersona.md'), '---\\nname: OrdinaryPersona\\nvoice_id: 冰糖\\nvoice_style: 沉稳测试\\n---\\nordinary persona')
const req = { method: 'GET', headers: { 'x-admin-token': auth.createAdminToken() }, socket: { remoteAddress: '127.0.0.1' } }
const response = { status: 0, headers: null, body: '' }
const res = {
  writeHead(status, headers) { response.status = status; response.headers = headers },
  end(body) { response.body = body || '' },
}
const handler = dashboard.routes['GET /dashboard/api/agent/tts/voices']
;(async () => {
  const maybe = handler(req, res)
  if (maybe && typeof maybe.then === 'function') await maybe
  const payload = JSON.parse(response.body || '{}')
  const personas = new Map((payload.personas || []).map(item => [item.name, item]))
  const clonedVoices = new Map((payload.clonedVoices || []).map(item => [item.id, item]))
  console.log(JSON.stringify({
    status: response.status,
    testHasSample: !!personas.get('TestPersona')?.hasSample,
    reuseHasSample: !!personas.get('ReusePersona')?.hasSample,
    ordinaryHasSample: !!personas.get('OrdinaryPersona')?.hasSample,
    testRefs: clonedVoices.get(routeTestAsset.id)?.referencedBy || [],
    reuseRefs: clonedVoices.get(routeReuseAsset.id)?.referencedBy || [],
  }))
})().catch(error => {
  console.error(error.stack || error.message || error)
  process.exit(1)
})
`
  const voicesRouteResult = spawnSync(process.execPath, ['-e', voicesRouteScript], {
    cwd: path.join(__dirname, '..', '..', '..', '..'),
    env: { ...process.env, DONGXUELIAN_AI_DATA_DIR: tempDataRoot },
    encoding: 'utf8',
  })
  let voicesRouteSummary = {}
  try { voicesRouteSummary = JSON.parse(String(voicesRouteResult.stdout || '').trim()) } catch {}
  t.check('voice route metadata child process passes', voicesRouteResult.status === 0, voicesRouteResult.stderr || voicesRouteResult.stdout)
  t.check('voice route metadata returns per-persona clone flags', voicesRouteSummary.status === 200 && voicesRouteSummary.testHasSample === true && voicesRouteSummary.reuseHasSample === true && voicesRouteSummary.ordinaryHasSample === false, JSON.stringify(voicesRouteSummary))
  t.check('voice route metadata keeps references scoped to each asset', Array.isArray(voicesRouteSummary.testRefs) && voicesRouteSummary.testRefs.includes('TestPersona') && Array.isArray(voicesRouteSummary.reuseRefs) && voicesRouteSummary.reuseRefs.includes('ReusePersona'), JSON.stringify(voicesRouteSummary))

  const dashboardVoiceWriteScript = `
const fs = require('fs')
const path = require('path')
const { Readable } = require('stream')
const constants = require(${JSON.stringify(constantsModule)})
const auth = require(${JSON.stringify(dashboardAuthModule)})
const dashboard = require(${JSON.stringify(dashboardRouteModule)})
fs.mkdirSync(path.join(constants.DATA_DIR, 'ai-skills', 'personas'), { recursive: true })
const personaFile = path.join(constants.DATA_DIR, 'ai-skills', 'personas', 'SKILL.EmptyStylePersona.md')
fs.writeFileSync(personaFile, '---\\nname: EmptyStylePersona\\ndescription: 测试人格\\nvoice_id: 冰糖\\nvoice_style: 旧风格\\n---\\n正文')
function callRoute(key, payload) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload || {})
    const req = Readable.from([Buffer.from(body)])
    req.method = key.split(' ')[0]
    req.headers = { 'x-admin-token': auth.createAdminToken(), 'content-length': Buffer.byteLength(body) }
    req.socket = { remoteAddress: '127.0.0.1' }
    const response = { status: 0, body: '' }
    const res = {
      writeHead(status) { response.status = status },
      end(data) { response.body = data || ''; resolve(response) },
    }
    try {
      const maybe = dashboard.routes[key](req, res)
      if (maybe && typeof maybe.then === 'function') maybe.catch(reject)
    } catch (error) { reject(error) }
  })
}
;(async () => {
  const save = await callRoute('PUT /dashboard/api/agent/persona/voice', { personaName: 'EmptyStylePersona', voiceId: '冰糖', voiceStyle: '' })
  const afterClear = fs.readFileSync(personaFile, 'utf8')
  await callRoute('PUT /dashboard/api/agent/persona/voice', { personaName: 'EmptyStylePersona', voiceId: '冰糖', voiceStyle: '沉稳冷静' })
  const afterSave = fs.readFileSync(personaFile, 'utf8')
  console.log(JSON.stringify({
    saveStatus: save.status,
    clearedOldStyle: !afterClear.includes('voice_style:'),
    noLegacyDefault: !afterClear.includes('voice_style: 活泼可爱') && !afterSave.includes('voice_style: 活泼可爱'),
    savedCustomStyle: afterSave.includes('voice_style: 沉稳冷静'),
  }))
})().catch(error => {
  console.error(error.stack || error.message || error)
  process.exit(1)
})
`
  const dashboardVoiceWriteResult = spawnSync(process.execPath, ['-e', dashboardVoiceWriteScript], {
    cwd: path.join(__dirname, '..', '..', '..', '..'),
    env: { ...process.env, DONGXUELIAN_AI_DATA_DIR: tempDataRoot },
    encoding: 'utf8',
  })
  let dashboardVoiceWriteSummary = {}
  try { dashboardVoiceWriteSummary = JSON.parse(String(dashboardVoiceWriteResult.stdout || '').trim()) } catch {}
  t.check('dashboard persona voice write child process passes', dashboardVoiceWriteResult.status === 0, dashboardVoiceWriteResult.stderr || dashboardVoiceWriteResult.stdout)
  t.check('dashboard clearing empty voice style removes voice_style', dashboardVoiceWriteSummary.saveStatus === 200 && dashboardVoiceWriteSummary.clearedOldStyle === true, JSON.stringify(dashboardVoiceWriteSummary))
  t.check('dashboard persona voice save does not write legacy default', dashboardVoiceWriteSummary.noLegacyDefault === true && dashboardVoiceWriteSummary.savedCustomStyle === true, JSON.stringify(dashboardVoiceWriteSummary))

  const dashboardPreviewScript = `
const fs = require('fs')
const path = require('path')
const { Readable } = require('stream')
const constants = require(${JSON.stringify(constantsModule)})
const { createCapabilityConfig } = require(${JSON.stringify(capabilityFixtureModule)})
fs.mkdirSync(constants.DATA_DIR, { recursive: true })
fs.writeFileSync(constants.MIMORIUM_KEY_FILE, 'tp-test-key')
fs.writeFileSync(path.join(constants.DATA_DIR, 'ai-capability-config.json'), JSON.stringify(createCapabilityConfig({
  'voice-tts': [{ provider: 'mimorium', model: 'mimo-v2.5-tts' }],
})))
const auth = require(${JSON.stringify(dashboardAuthModule)})
const dashboard = require(${JSON.stringify(dashboardRouteModule)})
fs.mkdirSync(path.join(constants.DATA_DIR, 'ai-skills', 'personas'), { recursive: true })
fs.writeFileSync(path.join(constants.DATA_DIR, 'ai-skills', 'personas', 'SKILL.PreviewPersona.md'), '---\\nname: PreviewPersona\\nvoice_id: 冰糖\\nvoice_style: 沉稳预览\\n---\\npreview persona')
function buildWav() {
  const data = Buffer.from([1, 2, 3, 4])
  const header = Buffer.alloc(44)
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + data.length, 4)
  header.write('WAVE', 8)
  header.write('fmt ', 12)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(1, 22)
  header.writeUInt32LE(16000, 24)
  header.writeUInt32LE(32000, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36)
  header.writeUInt32LE(data.length, 40)
  return Buffer.concat([header, data])
}
function callPreview(payload) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload || {})
    const req = Readable.from([Buffer.from(body)])
    req.method = 'POST'
    req.headers = { 'x-admin-token': auth.createAdminToken(), 'content-length': Buffer.byteLength(body) }
    req.socket = { remoteAddress: '127.0.0.1' }
    const response = { status: 0, body: '' }
    const res = {
      writeHead(status) { response.status = status },
      end(data) { response.body = data || ''; resolve(response) },
    }
    try {
      const maybe = dashboard.routes['POST /dashboard/api/agent/tts/preview'](req, res)
      if (maybe && typeof maybe.then === 'function') maybe.catch(reject)
    } catch (error) { reject(error) }
  })
}
;(async () => {
  const calls = []
  global.fetch = async (url, opts) => {
    calls.push(JSON.parse(opts.body))
    return { ok: true, json: async () => ({ choices: [{ message: { audio: { data: buildWav().toString('base64') } } }] }) }
  }
  const personaRes = await callPreview({ text: '测试', voice: '', style: '', personaName: 'PreviewPersona' })
  const explicitRes = await callPreview({ text: '测试', voice: '冰糖', style: '', personaName: 'PreviewPersona' })
  console.log(JSON.stringify({
    personaStatus: personaRes.status,
    explicitStatus: explicitRes.status,
    personaStyle: calls[0]?.messages?.[0]?.content || '',
    explicitStyle: calls[1]?.messages?.[0]?.content || '',
  }))
})().catch(error => {
  console.error(error.stack || error.message || error)
  process.exit(1)
})
`
  const dashboardPreviewDataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tts-preview-'))
  const dashboardPreviewResult = spawnSync(process.execPath, ['-e', dashboardPreviewScript], {
    cwd: path.join(__dirname, '..', '..', '..', '..'),
    env: { ...process.env, DONGXUELIAN_AI_DATA_DIR: dashboardPreviewDataRoot },
    encoding: 'utf8',
  })
  let dashboardPreviewSummary = {}
  try { dashboardPreviewSummary = JSON.parse(String(dashboardPreviewResult.stdout || '').trim()) } catch {}
  t.check('dashboard tts preview child process passes', dashboardPreviewResult.status === 0, dashboardPreviewResult.stderr || dashboardPreviewResult.stdout)
  t.check('dashboard preview empty style resolves persona style', dashboardPreviewSummary.personaStatus === 200 && dashboardPreviewSummary.personaStyle === '沉稳预览', JSON.stringify(dashboardPreviewSummary))
  t.check('dashboard preview explicit voice still resolves persona style when style is empty', dashboardPreviewSummary.explicitStatus === 200 && dashboardPreviewSummary.explicitStyle === '沉稳预览', JSON.stringify(dashboardPreviewSummary))
  try { fs.rmSync(dashboardPreviewDataRoot, { recursive: true, force: true }) } catch {}

  const dashboardPersonaEditScript = `
const fs = require('fs')
const path = require('path')
const { Readable } = require('stream')
const constants = require(${JSON.stringify(constantsModule)})
const auth = require(${JSON.stringify(dashboardAuthModule)})
const configRoutes = require(${JSON.stringify(path.join(__dirname, '..', '..', '..', 'koishi-plugin-dashboard', 'lib', 'routes', 'config'))})
fs.mkdirSync(path.join(constants.DATA_DIR, 'ai-skills', 'personas'), { recursive: true })
const personaFile = path.join(constants.DATA_DIR, 'ai-skills', 'personas', 'SKILL.EditKeepVoice.md')
fs.writeFileSync(personaFile, '---\\nname: EditKeepVoice\\ndescription: 旧描述\\nlore: none\\nwill: 1\\nvoice_id: __cloned__\\nvoice_asset_id: keep_asset\\nvoice_style: 沉稳保留\\n---\\n旧正文')
function callPut(payload) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload || {})
    const req = Readable.from([Buffer.from(body)])
    req.method = 'PUT'
    req.headers = { 'x-admin-token': auth.createAdminToken(), 'content-length': Buffer.byteLength(body) }
    req.socket = { remoteAddress: '127.0.0.1' }
    const response = { status: 0, body: '' }
    const res = {
      writeHead(status) { response.status = status },
      end(data) { response.body = data || ''; resolve(response) },
    }
    try {
      const maybe = configRoutes.routes['PUT /dashboard/api/personas'](req, res)
      if (maybe && typeof maybe.then === 'function') maybe.catch(reject)
    } catch (error) { reject(error) }
  })
}
;(async () => {
  const response = await callPut({ name: 'EditKeepVoice', description: '新描述', lore: 'none', will: 1.2, nsfw: 'none', content: '新正文' })
  const after = fs.readFileSync(personaFile, 'utf8')
  console.log(JSON.stringify({
    status: response.status,
    keepsVoiceId: after.includes('voice_id: __cloned__'),
    keepsAssetId: after.includes('voice_asset_id: keep_asset'),
    keepsVoiceStyle: after.includes('voice_style: 沉稳保留'),
    updatesContent: after.includes('新正文') && after.includes('description: 新描述'),
  }))
})().catch(error => {
  console.error(error.stack || error.message || error)
  process.exit(1)
})
`
  const dashboardPersonaEditDataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'persona-edit-'))
  const dashboardPersonaEditResult = spawnSync(process.execPath, ['-e', dashboardPersonaEditScript], {
    cwd: path.join(__dirname, '..', '..', '..', '..'),
    env: { ...process.env, DONGXUELIAN_AI_DATA_DIR: dashboardPersonaEditDataRoot },
    encoding: 'utf8',
  })
  let dashboardPersonaEditSummary = {}
  try { dashboardPersonaEditSummary = JSON.parse(String(dashboardPersonaEditResult.stdout || '').trim()) } catch {}
  t.check('dashboard persona edit child process passes', dashboardPersonaEditResult.status === 0, dashboardPersonaEditResult.stderr || dashboardPersonaEditResult.stdout)
  t.check('dashboard persona edit preserves voice frontmatter', dashboardPersonaEditSummary.status === 200 && dashboardPersonaEditSummary.keepsVoiceId === true && dashboardPersonaEditSummary.keepsAssetId === true && dashboardPersonaEditSummary.keepsVoiceStyle === true && dashboardPersonaEditSummary.updatesContent === true, JSON.stringify(dashboardPersonaEditSummary))
  try { fs.rmSync(dashboardPersonaEditDataRoot, { recursive: true, force: true }) } catch {}

  const dashboardPersonaDiagnosticsScript = `
const fs = require('fs')
const path = require('path')
const constants = require(${JSON.stringify(constantsModule)})
const configRoutes = require(${JSON.stringify(path.join(__dirname, '..', '..', '..', 'koishi-plugin-dashboard', 'lib', 'routes', 'config'))})
fs.mkdirSync(path.join(constants.DATA_DIR, 'ai-skills', 'personas'), { recursive: true })
fs.mkdirSync(path.join(constants.DATA_DIR, 'ai-skills', 'lore'), { recursive: true })
const personaFile = path.join(constants.DATA_DIR, 'ai-skills', 'personas', 'SKILL.DiagnosticsPersona.md')
fs.writeFileSync(personaFile, '---\\nname: DiagnosticsPersona\\nlore: missing-lore\\n---\\nSECRET_PERSONA_BODY')
const req = { method: 'GET', headers: {}, socket: { remoteAddress: '127.0.0.1' } }
const response = { status: 0, body: '' }
const res = {
  writeHead(status) { response.status = status },
  end(data) { response.body = data || '' },
}
configRoutes.routes['GET /dashboard/api/persona-diagnostics'](req, res)
const data = JSON.parse(response.body)
const bodyText = JSON.stringify(data)
const doc = data.documents.find(item => item.name === 'DiagnosticsPersona')
console.log(JSON.stringify({
  status: response.status,
  ok: data.ok,
  hasDoc: !!doc,
  hasMissingLoreWarning: !!doc && doc.diagnostics.some(item => item.code === 'missing_lore_ref'),
  exposesBody: bodyText.includes('SECRET_PERSONA_BODY'),
  exposesAbsolutePath: bodyText.includes(constants.DATA_DIR.replace(/\\\\/g, '/')) || bodyText.includes(constants.DATA_DIR.replace(/\\//g, '\\\\')),
  fileIsBasename: !!doc && doc.file === 'SKILL.DiagnosticsPersona.md',
}))
`
  const dashboardPersonaDiagnosticsDataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'persona-diagnostics-'))
  const dashboardPersonaDiagnosticsResult = spawnSync(process.execPath, ['-e', dashboardPersonaDiagnosticsScript], {
    cwd: path.join(__dirname, '..', '..', '..', '..'),
    env: { ...process.env, DONGXUELIAN_AI_DATA_DIR: dashboardPersonaDiagnosticsDataRoot },
    encoding: 'utf8',
  })
  let dashboardPersonaDiagnosticsSummary = {}
  try { dashboardPersonaDiagnosticsSummary = JSON.parse(String(dashboardPersonaDiagnosticsResult.stdout || '').trim()) } catch {}
  t.check('dashboard persona diagnostics route child process passes', dashboardPersonaDiagnosticsResult.status === 0, dashboardPersonaDiagnosticsResult.stderr || dashboardPersonaDiagnosticsResult.stdout)
  t.check('dashboard persona diagnostics route reports sanitized warning', dashboardPersonaDiagnosticsSummary.status === 200 && dashboardPersonaDiagnosticsSummary.hasDoc === true && dashboardPersonaDiagnosticsSummary.hasMissingLoreWarning === true && dashboardPersonaDiagnosticsSummary.exposesBody === false && dashboardPersonaDiagnosticsSummary.exposesAbsolutePath === false && dashboardPersonaDiagnosticsSummary.fileIsBasename === true, JSON.stringify(dashboardPersonaDiagnosticsSummary))
  try { fs.rmSync(dashboardPersonaDiagnosticsDataRoot, { recursive: true, force: true }) } catch {}
  try { fs.rmSync(tempDataRoot, { recursive: true, force: true }) } catch {}

  const voiceCommandScript = `
const fs = require('fs')
const path = require('path')
const constants = require(${JSON.stringify(constantsModule)})
const { createCapabilityConfig } = require(${JSON.stringify(capabilityFixtureModule)})
fs.mkdirSync(path.join(constants.DATA_DIR, 'ai-skills', 'personas'), { recursive: true })
fs.writeFileSync(constants.MIMORIUM_KEY_FILE, 'tp-test-key')
fs.writeFileSync(path.join(constants.DATA_DIR, 'ai-capability-config.json'), JSON.stringify(createCapabilityConfig({
  'voice-tts': [{ provider: 'mimorium', model: 'mimo-v2.5-tts' }],
})))
const persona = require(${JSON.stringify(path.join(__dirname, '..', '..', 'lib', 'persona', 'persona'))})
const command = require(${JSON.stringify(path.join(__dirname, '..', '..', 'lib', 'commands', 'voice-command'))})
fs.writeFileSync(path.join(constants.DATA_DIR, 'ai-skills', 'personas', 'SKILL.CurrentVoicePersona.md'), '---\\nname: CurrentVoicePersona\\nvoice_id: Mia\\nvoice_style: 当前人格沉稳冷静\\n---\\ncurrent persona')
persona.loadPersonaGroups()
persona.loadPersonaUsers()
persona.setGroupPersona('group-voice-test', 'CurrentVoicePersona')
function buildWav() {
  const data = Buffer.from([1, 2, 3, 4])
  const header = Buffer.alloc(44)
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + data.length, 4)
  header.write('WAVE', 8)
  header.write('fmt ', 12)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(1, 22)
  header.writeUInt32LE(16000, 24)
  header.writeUInt32LE(32000, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36)
  header.writeUInt32LE(data.length, 40)
  return Buffer.concat([header, data])
}
;(async () => {
  const calls = []
  global.fetch = async (url, opts) => {
    calls.push(JSON.parse(opts.body))
    return { ok: true, json: async () => ({ choices: [{ message: { audio: { data: buildWav().toString('base64') } } }] }) }
  }
  const sent = []
  const result = await command.handleVoiceCommand(
    { send: async msg => sent.push(msg) },
    { plain: '东雪莲说句话', channelKey: 'group-voice-test', currentUserId: 'user-1' },
    {}
  )
  console.log(JSON.stringify({
    matched: !!result.matched,
    response: result.response || '',
    sentCount: sent.length,
    voice: calls[0]?.audio?.voice || '',
    style: calls[0]?.messages?.[0]?.content || '',
    text: calls[0]?.messages?.[1]?.content || '',
  }))
})().catch(error => {
  console.error(error.stack || error.message || error)
  process.exit(1)
})
`
  const voiceCommandDataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-command-'))
  const voiceCommandResult = spawnSync(process.execPath, ['-e', voiceCommandScript], {
    cwd: path.join(__dirname, '..', '..', '..', '..'),
    env: { ...process.env, DONGXUELIAN_AI_DATA_DIR: voiceCommandDataRoot },
    encoding: 'utf8',
  })
  let voiceCommandSummary = {}
  try { voiceCommandSummary = JSON.parse(String(voiceCommandResult.stdout || '').trim()) } catch {}
  t.check('voice command current persona child process passes', voiceCommandResult.status === 0, voiceCommandResult.stderr || voiceCommandResult.stdout)
  t.check('东雪莲说句话 uses configured current persona voice', voiceCommandSummary.matched === true && voiceCommandSummary.sentCount === 1 && voiceCommandSummary.voice === 'Mia', JSON.stringify(voiceCommandSummary))
  t.check('东雪莲说句话 uses configured current persona style', voiceCommandSummary.style === '当前人格沉稳冷静' && !voiceCommandSummary.style.includes('活泼可爱'), JSON.stringify(voiceCommandSummary))
  try { fs.rmSync(voiceCommandDataRoot, { recursive: true, force: true }) } catch {}

  t.section('scenario: rare fixed voice module')

  const rareVoice = require('../../lib/behavior/rare-voice')

  t.check('shouldTriggerRareVoice ignores non-rare meta', !rareVoice.shouldTriggerRareVoice({}, () => 0))
  t.check('shouldTriggerRareVoice triggers below half', rareVoice.shouldTriggerRareVoice({ rareConfirmed: true }, () => 0.49))
  t.check('shouldTriggerRareVoice skips at half', !rareVoice.shouldTriggerRareVoice({ rareConfirmed: true }, () => 0.5))
  t.check('resolveRareVoiceSource returns null or mp4', (() => {
    const source = rareVoice.resolveRareVoiceSource()
    return source === null || /\.mp4$/i.test(source)
  })())

  t.section('scenario: voice TTS synthesize (mock)')

  const ttsFailureScript = `
const fs = require('fs')
const path = require('path')
const constants = require(${JSON.stringify(constantsModule)})
const { createCapabilityConfig } = require(${JSON.stringify(capabilityFixtureModule)})
fs.mkdirSync(constants.DATA_DIR, { recursive: true })
fs.writeFileSync(constants.MIMORIUM_KEY_FILE, 'tp-test-key')
const configFile = path.join(constants.DATA_DIR, 'ai-capability-config.json')
fs.writeFileSync(configFile, JSON.stringify(createCapabilityConfig({
  'voice-tts': [{ provider: 'mimorium', model: 'mimo-v2.5-tts' }],
})))
const tts = require(${JSON.stringify(ttsModule)})
function buildWav() {
  const data = Buffer.from([1, 2, 3, 4])
  const header = Buffer.alloc(44)
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + data.length, 4)
  header.write('WAVE', 8)
  header.write('fmt ', 12)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(1, 22)
  header.writeUInt32LE(16000, 24)
  header.writeUInt32LE(32000, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36)
  header.writeUInt32LE(data.length, 40)
  return Buffer.concat([header, data])
}
(async () => {
  const result = {}
  const wavBase64 = buildWav().toString('base64')
  let calls = []
  global.fetch = async (url, opts) => {
    calls.push({ url: String(url), body: JSON.parse(opts.body) })
    return { ok: true, json: async () => ({ choices: [{ message: { audio: { data: 'data:audio/wav;base64,' + wavBase64 } } }] }) }
  }
  let diagnostics = {}
  const normalBuf = await tts.synthesizeSpeech('测试文本', { voice: '冰糖', style: '活泼', diagnostics })
  result.normalMime = tts.detectAudioMime(normalBuf)
  result.normalUrl = calls[0].url
  result.normalBody = calls[0].body

  fs.unlinkSync(constants.MIMORIUM_KEY_FILE)
  calls = []
  diagnostics = {}
  const unconfiguredBuf = await tts.synthesizeSpeech('测试', { voice: '冰糖', style: '活泼', diagnostics })
  result.unconfiguredNull = unconfiguredBuf === null
  result.unconfiguredCode = diagnostics.lastError && diagnostics.lastError.code
  result.unconfiguredMessage = diagnostics.lastError && diagnostics.lastError.message
  result.unconfiguredCalls = calls.length
  fs.writeFileSync(constants.MIMORIUM_KEY_FILE, 'tp-test-key')

  calls = []
  const dataUriBuf = await tts.synthesizeSpeech('测试', { voice: '冰糖', style: '活泼', diagnostics })
  result.dataUriMime = tts.detectAudioMime(dataUriBuf)
  result.dataUriModel = calls[0].body.model

  global.fetch = async () => ({ ok: true, json: async () => ({ choices: [{ message: { audio: { data: Buffer.from('not audio').toString('base64') } } }] }) })
  diagnostics = {}
  const badAudio = await tts.synthesizeSpeech('测试', { voice: '冰糖', style: '活泼', diagnostics })
  result.badAudioNull = badAudio === null
  result.badAudioCode = diagnostics.lastError && diagnostics.lastError.code

  global.fetch = async () => ({ ok: false, status: 401, text: async () => 'bad token tp-secret-value' })
  diagnostics = {}
  const httpAudio = await tts.synthesizeSpeech('测试', { voice: '冰糖', style: '活泼', diagnostics })
  result.httpNull = httpAudio === null
  result.httpCode = diagnostics.lastError && diagnostics.lastError.code
  result.httpMessage = diagnostics.lastError && diagnostics.lastError.message

  calls = []
  global.fetch = async (url, opts) => {
    calls.push({ url: String(url), body: JSON.parse(opts.body) })
    return { ok: true, json: async () => ({ choices: [{ message: { audio: { data: wavBase64 } } }] }) }
  }
  fs.writeFileSync(configFile, JSON.stringify(createCapabilityConfig({
    'voice-tts': [{ provider: 'mimorium', model: 'mimo-v2.5-tts-voiceclone' }],
  })))
  diagnostics = {}
  const cloneBuf = await tts.synthesizeSpeech('测试', { voice: 'data:audio/wav;base64,' + wavBase64, style: '活泼', diagnostics })
  result.cloneMime = tts.detectAudioMime(cloneBuf)
  result.cloneModel = calls[0].body.model
  console.log(JSON.stringify(result))
})().catch(error => {
  console.error(error.stack || error.message || error)
  process.exit(1)
})
`
  const ttsFailureDataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tts-failure-'))
  const ttsFailureResult = spawnSync(process.execPath, ['-e', ttsFailureScript], {
    cwd: path.join(__dirname, '..', '..', '..', '..'),
    env: { ...process.env, DONGXUELIAN_AI_DATA_DIR: ttsFailureDataRoot },
    encoding: 'utf8',
  })
  let ttsFailureSummary = {}
  try { ttsFailureSummary = JSON.parse(String(ttsFailureResult.stdout || '').trim()) } catch {}
  t.check('tts diagnostics child process passes', ttsFailureResult.status === 0, ttsFailureResult.stderr || ttsFailureResult.stdout)
  t.check('synthesizeSpeech follows configured Mimorium TTS protocol', ttsFailureSummary.normalMime === 'audio/wav' && ttsFailureSummary.normalUrl.includes('token-plan-cn.xiaomimimo.com') && ttsFailureSummary.normalBody?.model === 'mimo-v2.5-tts' && ttsFailureSummary.normalBody?.audio?.format === 'wav' && ttsFailureSummary.normalBody?.audio?.voice === '冰糖', JSON.stringify(ttsFailureSummary))
  t.check('synthesizeSpeech keeps configured style and text ordering', ttsFailureSummary.normalBody?.messages?.[0]?.role === 'user' && ttsFailureSummary.normalBody?.messages?.[0]?.content === '活泼' && ttsFailureSummary.normalBody?.messages?.[1]?.role === 'assistant' && ttsFailureSummary.normalBody?.messages?.[1]?.content === '测试文本', JSON.stringify(ttsFailureSummary))
  t.check('synthesizeSpeech stops without request when configured provider key is unavailable', ttsFailureSummary.unconfiguredNull === true && ttsFailureSummary.unconfiguredCode === 'capability_unconfigured' && ttsFailureSummary.unconfiguredMessage === '该能力未配置模型' && ttsFailureSummary.unconfiguredCalls === 0, JSON.stringify(ttsFailureSummary))
  t.check('synthesizeSpeech accepts data URI audio response', ttsFailureSummary.dataUriMime === 'audio/wav' && ttsFailureSummary.dataUriModel === 'mimo-v2.5-tts', JSON.stringify(ttsFailureSummary))
  t.check('synthesizeSpeech rejects unplayable decoded audio', ttsFailureSummary.badAudioNull === true && ttsFailureSummary.badAudioCode === 'invalid_audio', JSON.stringify(ttsFailureSummary))
  t.check('synthesizeSpeech reports sanitized HTTP failure', ttsFailureSummary.httpNull === true && ttsFailureSummary.httpCode === 'http_error' && !String(ttsFailureSummary.httpMessage || '').includes('tp-secret-value'), JSON.stringify(ttsFailureSummary))
  t.check('synthesizeSpeech uses clone model for data URI voice', ttsFailureSummary.cloneMime === 'audio/wav' && ttsFailureSummary.cloneModel === 'mimo-v2.5-tts-voiceclone', JSON.stringify(ttsFailureSummary))
  try { fs.rmSync(ttsFailureDataRoot, { recursive: true, force: true }) } catch {}

  const ttsSendScript = `
const fs = require('fs')
const { fileURLToPath } = require('url')
const constants = require(${JSON.stringify(constantsModule)})
const tts = require(${JSON.stringify(ttsModule)})
function buildWav() {
  const data = Buffer.alloc(3200, 1)
  const header = Buffer.alloc(44)
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + data.length, 4)
  header.write('WAVE', 8)
  header.write('fmt ', 12)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(1, 22)
  header.writeUInt32LE(16000, 24)
  header.writeUInt32LE(32000, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36)
  header.writeUInt32LE(data.length, 40)
  return Buffer.concat([header, data])
}
(async () => {
  const result = {}
  const sent = []
  const diagnostics = {}
  const ok = await tts.sendVoiceMessage({
    messageId: 'quoted-source-message',
    quote: { id: 'quoted-source-message', content: 'quoted text' },
    send: async msg => sent.push(msg),
  }, buildWav(), { diagnostics, tempFileTtlMs: 60000 })
  const src = sent[0]?.attrs?.src || sent[0]?.attrs?.url || sent[0]?.attrs?.file || ''
  const serialized = String(sent[0] || '')
  const filePath = src.startsWith('file:') ? fileURLToPath(src) : src
  result.ok = ok
  result.type = sent[0]?.type
  result.serialized = serialized
  result.hasQuote = serialized.includes('<quote') || sent.some(item => String(item).includes('<quote'))
  result.src = src
  result.usesFileUrl = src.startsWith('file:')
  result.usesDataUri = src.startsWith('data:') || src.startsWith('base64://')
  result.fileExists = !!filePath && fs.existsSync(filePath)
  result.fileInTempDir = filePath.startsWith(constants.TTS_TEMP_DIR)
  result.filePrefix = /tts-send-/.test(filePath)
  result.lastSend = diagnostics.lastSend

  const beforeFail = fs.readdirSync(constants.TTS_TEMP_DIR).filter(name => name.startsWith('tts-send-')).length
  const failOk = await tts.sendVoiceMessage({ send: async () => { throw new Error('adapter refused') } }, buildWav(), { tempFileTtlMs: 60000 })
  const afterFail = fs.readdirSync(constants.TTS_TEMP_DIR).filter(name => name.startsWith('tts-send-')).length
  result.failOk = failOk
  result.failedSendCleaned = afterFail === beforeFail
  try { fs.rmSync(constants.TTS_TEMP_DIR, { recursive: true, force: true }) } catch {}
  console.log(JSON.stringify(result))
})().catch(error => {
  console.error(error.stack || error.message || error)
  process.exit(1)
})
`
  const ttsSendDataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tts-send-'))
  const ttsSendResult = spawnSync(process.execPath, ['-e', ttsSendScript], {
    cwd: path.join(__dirname, '..', '..', '..', '..'),
    env: { ...process.env, DONGXUELIAN_AI_DATA_DIR: ttsSendDataRoot },
    encoding: 'utf8',
  })
  let ttsSendSummary = {}
  try { ttsSendSummary = JSON.parse(String(ttsSendResult.stdout || '').trim()) } catch {}
  t.check('tts send child process passes', ttsSendResult.status === 0, ttsSendResult.stderr || ttsSendResult.stdout)
  t.check('sendVoiceMessage sends file audio element', ttsSendSummary.ok === true && ttsSendSummary.type === 'audio' && ttsSendSummary.usesFileUrl === true, JSON.stringify(ttsSendSummary))
  t.check('sendVoiceMessage does not quote source message', ttsSendSummary.hasQuote === false, JSON.stringify(ttsSendSummary))
  t.check('sendVoiceMessage does not send data/base64 record', ttsSendSummary.usesDataUri === false, JSON.stringify(ttsSendSummary))
  t.check('sendVoiceMessage writes temp file inside TTS_TEMP_DIR', ttsSendSummary.fileExists === true && ttsSendSummary.fileInTempDir === true && ttsSendSummary.filePrefix === true, JSON.stringify(ttsSendSummary))
  t.check('sendVoiceMessage records sanitized send diagnostics', ttsSendSummary.lastSend?.method === 'file' && ttsSendSummary.lastSend?.mimeType === 'audio/wav' && ttsSendSummary.lastSend?.bytes > 44, JSON.stringify(ttsSendSummary))
  t.check('sendVoiceMessage removes temp file after adapter failure', ttsSendSummary.failOk === false && ttsSendSummary.failedSendCleaned === true, JSON.stringify(ttsSendSummary))
  try { fs.rmSync(ttsSendDataRoot, { recursive: true, force: true }) } catch {}

  t.section('scenario: voice ASR transcribe (mock)')

  const voiceProtocolScript = `
const fs = require('fs')
const path = require('path')
const constants = require(${JSON.stringify(constantsModule)})
const { createCapabilityConfig } = require(${JSON.stringify(capabilityFixtureModule)})
fs.mkdirSync(constants.DATA_DIR, { recursive: true })
fs.writeFileSync(constants.MIMORIUM_KEY_FILE, 'tp-test-mimorium-key')
fs.writeFileSync(path.join(constants.DATA_DIR, 'ai-openai-official-key.txt'), 'tp-test-openai-key')
const configFile = path.join(constants.DATA_DIR, 'ai-capability-config.json')
// 原子替换本子进程要验证的显式能力优先级。
function saveConfig(priorities) {
  fs.writeFileSync(configFile, JSON.stringify(createCapabilityConfig(priorities)))
}
saveConfig({ 'voice-asr': [{ provider: 'mimorium', model: 'mimo-v2.5-asr' }] })
const voice = require(${JSON.stringify(path.join(__dirname, '..', '..', 'lib', 'media', 'voice', 'voice'))})
const tts = require(${JSON.stringify(ttsModule)})
// 构造同时适用于 ASR 上传和 TTS 返回值校验的最小 WAV。
function buildWav() {
  const data = Buffer.from([1, 2, 3, 4])
  const header = Buffer.alloc(44)
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + data.length, 4)
  header.write('WAVE', 8)
  header.write('fmt ', 12)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(1, 22)
  header.writeUInt32LE(16000, 24)
  header.writeUInt32LE(32000, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36)
  header.writeUInt32LE(data.length, 40)
  return Buffer.concat([header, data])
}
(async () => {
  const result = {}
  const wav = buildWav()
  const wavPath = path.join(constants.DATA_DIR, 'protocol-asr.wav')
  fs.writeFileSync(wavPath, wav)

  global.fetch = async (url, opts) => {
    result.mimoriumAsrUrl = String(url)
    result.mimoriumAsrBody = JSON.parse(opts.body)
    return { ok: true, json: async () => ({ choices: [{ message: { content: '小米转写' } }] }) }
  }
  result.mimoriumAsrText = await voice.callModelAsr(wavPath)

  saveConfig({ 'voice-asr': [{ provider: 'openai', model: 'gpt-4o-mini-transcribe' }] })
  global.fetch = async (url, opts) => {
    result.openAiAsrUrl = String(url)
    result.openAiAsrModel = opts.body.get('model')
    return { ok: true, json: async () => ({ text: 'OpenAI转写' }) }
  }
  result.openAiAsrText = await voice.callModelAsr(wavPath)

  saveConfig({ 'voice-tts': [{ provider: 'openai', model: 'gpt-4o-mini-tts' }] })
  global.fetch = async (url, opts) => {
    result.openAiTtsUrl = String(url)
    result.openAiTtsBody = JSON.parse(opts.body)
    return { ok: true, arrayBuffer: async () => wav.buffer.slice(wav.byteOffset, wav.byteOffset + wav.byteLength) }
  }
  const openAiAudio = await tts.synthesizeSpeech('OpenAI 合成', { voice: '冰糖', style: '沉稳' })
  result.openAiTtsMime = tts.detectAudioMime(openAiAudio)

  saveConfig({})
  let unconfiguredRequests = 0
  global.fetch = async () => { unconfiguredRequests += 1; throw new Error('unexpected request') }
  try {
    await voice.callModelAsr(wavPath)
  } catch (error) {
    result.unconfiguredAsrMessage = String(error && error.message || error)
  }
  result.unconfiguredAsrRequests = unconfiguredRequests
  console.log(JSON.stringify(result))
})().catch(error => {
  console.error(error.stack || error.message || error)
  process.exit(1)
})
`
  const voiceProtocolDataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-protocol-'))
  const voiceProtocolResult = spawnSync(process.execPath, ['-e', voiceProtocolScript], {
    cwd: path.join(__dirname, '..', '..', '..', '..'),
    env: { ...process.env, DONGXUELIAN_AI_DATA_DIR: voiceProtocolDataRoot },
    encoding: 'utf8',
  })
  let voiceProtocolSummary = {}
  try { voiceProtocolSummary = JSON.parse(String(voiceProtocolResult.stdout || '').trim()) } catch {}
  t.check('voice protocol child process passes', voiceProtocolResult.status === 0, voiceProtocolResult.stderr || voiceProtocolResult.stdout)
  t.check('callModelAsr uses configured Mimorium ASR model', voiceProtocolSummary.mimoriumAsrText === '小米转写' && voiceProtocolSummary.mimoriumAsrUrl?.endsWith('/chat/completions') && voiceProtocolSummary.mimoriumAsrBody?.model === 'mimo-v2.5-asr' && voiceProtocolSummary.mimoriumAsrBody?.messages?.[0]?.content?.some(item => item.type === 'input_audio'), JSON.stringify(voiceProtocolSummary))
  t.check('callModelAsr uses OpenAI audio/transcriptions protocol', voiceProtocolSummary.openAiAsrText === 'OpenAI转写' && voiceProtocolSummary.openAiAsrUrl?.endsWith('/audio/transcriptions') && voiceProtocolSummary.openAiAsrModel === 'gpt-4o-mini-transcribe', JSON.stringify(voiceProtocolSummary))
  t.check('synthesizeSpeech uses OpenAI audio/speech protocol', voiceProtocolSummary.openAiTtsMime === 'audio/wav' && voiceProtocolSummary.openAiTtsUrl?.endsWith('/audio/speech') && voiceProtocolSummary.openAiTtsBody?.model === 'gpt-4o-mini-tts' && voiceProtocolSummary.openAiTtsBody?.voice === 'alloy', JSON.stringify(voiceProtocolSummary))
  t.check('callModelAsr stops without request when capability priority is empty', voiceProtocolSummary.unconfiguredAsrMessage === '该能力未配置模型' && voiceProtocolSummary.unconfiguredAsrRequests === 0, JSON.stringify(voiceProtocolSummary))
  try { fs.rmSync(voiceProtocolDataRoot, { recursive: true, force: true }) } catch {}
}

module.exports = { run }
