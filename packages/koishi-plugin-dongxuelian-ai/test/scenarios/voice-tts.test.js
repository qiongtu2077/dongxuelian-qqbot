const path = require('path')
const fs = require('fs')
const os = require('os')
const { spawnSync } = require('child_process')

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

async function run(t) {
  t.section('scenario: voice ASR module')

  const voice = require('../../lib/voice')

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

  t.section('scenario: voice TTS module')

  const tts = require('../../lib/tts')

  t.check('getBuiltinVoices returns array', Array.isArray(tts.getBuiltinVoices()) && tts.getBuiltinVoices().length > 0)
  t.check('getBuiltinVoices includes 冰糖', tts.getBuiltinVoices().includes('冰糖'))
  t.check('getBuiltinVoices includes Mia', tts.getBuiltinVoices().includes('Mia'))

  t.check('extractVoiceStyle extracts tag', tts.extractVoiceStyle('你好【语音风格：温柔甜美】世界') === '温柔甜美')
  t.check('extractVoiceStyle returns null for no tag', tts.extractVoiceStyle('普通文本') === null)

  t.check('stripVoiceStyleTag removes tag', tts.stripVoiceStyleTag('你好【语音风格：温柔甜美】世界') === '你好世界')
  t.check('stripVoiceStyleTag preserves text without tag', tts.stripVoiceStyleTag('普通文本') === '普通文本')

  t.check('isChannelOnCooldown returns false for unknown channel', !tts.isChannelOnCooldown('test-channel-999'))

  tts.markChannelCooldown('test-channel-cd')
  t.check('isChannelOnCooldown returns true after mark', tts.isChannelOnCooldown('test-channel-cd'))

  t.check('shouldTriggerRandomVoice respects cooldown', !tts.shouldTriggerRandomVoice('test-channel-cd'))

  t.check('resolvePersonaVoice returns defaults for unknown persona', (() => {
    const result = tts.resolvePersonaVoice('nonexistent-persona-xyz')
    return result.voice === '冰糖' && result.style === '活泼可爱'
  })())

  t.check('resolvePersonaVoice returns defaults for null', (() => {
    const result = tts.resolvePersonaVoice(null)
    return result.voice === '冰糖' && result.style === '活泼可爱'
  })())

  t.section('scenario: voice asset metadata')

  const tempDataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-assets-'))
  const voiceAssetsModule = path.join(__dirname, '..', '..', 'lib', 'voice-assets')
  const constantsModule = path.join(__dirname, '..', '..', 'lib', 'constants')
  const ttsModule = path.join(__dirname, '..', '..', 'lib', 'tts')
  const dashboardRouteModule = path.join(__dirname, '..', '..', '..', 'koishi-plugin-dashboard', 'lib', 'routes', 'agent')
  const dashboardAuthModule = path.join(__dirname, '..', '..', '..', 'koishi-plugin-dashboard', 'lib', 'auth')
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
fs.writeFileSync(path.join(constants.DATA_DIR, 'ai-skills', 'personas', 'SKILL.OrdinaryPersona.md'), '---\\nname: OrdinaryPersona\\nvoice_id: 冰糖\\nvoice_style: 娲绘臣鍙埍\\n---\\nordinary persona')
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
  try { fs.rmSync(tempDataRoot, { recursive: true, force: true }) } catch {}

  t.section('scenario: rare fixed voice module')

  const rareVoice = require('../../lib/rare-voice')

  t.check('shouldTriggerRareVoice ignores non-rare meta', !rareVoice.shouldTriggerRareVoice({}, () => 0))
  t.check('shouldTriggerRareVoice triggers below half', rareVoice.shouldTriggerRareVoice({ rareConfirmed: true }, () => 0.49))
  t.check('shouldTriggerRareVoice skips at half', !rareVoice.shouldTriggerRareVoice({ rareConfirmed: true }, () => 0.5))
  t.check('resolveRareVoiceSource returns null or mp4', (() => {
    const source = rareVoice.resolveRareVoiceSource()
    return source === null || /\.mp4$/i.test(source)
  })())

  t.section('scenario: voice TTS synthesize (mock)')

  const originalFetch = global.fetch
  const mockAudioBase64 = buildTestWav(Buffer.from('fake wav data')).toString('base64')
  let fetchCalls = []
  let diagnostics = {}
  global.fetch = async (url, opts) => {
    fetchCalls.push({ url, opts })
    return {
      ok: true,
      json: async () => ({ choices: [{ message: { audio: { data: mockAudioBase64 } } }] }),
    }
  }

  try {
    const buf = await tts.synthesizeSpeech('测试文本', { voice: '冰糖', style: '活泼', diagnostics })
    if (buf) {
      t.check('synthesizeSpeech returns Buffer', Buffer.isBuffer(buf))
      t.check('synthesizeSpeech Buffer is playable wav', tts.detectAudioMime(buf) === 'audio/wav')
      t.check('synthesizeSpeech called fetch', fetchCalls.length === 1)
      t.check('synthesizeSpeech used correct URL', fetchCalls[0].url.includes('token-plan-cn.xiaomimimo.com'))
      const body = JSON.parse(fetchCalls[0].opts.body)
      t.check('synthesizeSpeech model is mimo-v2.5-tts', body.model === 'mimo-v2.5-tts')
      t.check('synthesizeSpeech audio format is wav', body.audio && body.audio.format === 'wav')
      t.check('synthesizeSpeech voice is 冰糖', body.audio && body.audio.voice === '冰糖')
      t.check('synthesizeSpeech messages has style', body.messages[0].role === 'user' && body.messages[0].content === '活泼')
      t.check('synthesizeSpeech messages has text', body.messages[1].role === 'assistant' && body.messages[1].content === '测试文本')
    } else {
      t.check('synthesizeSpeech reports missing key when no key file', diagnostics.lastError?.code === 'missing_key', JSON.stringify(diagnostics.lastError || {}))
    }
  } finally {
    global.fetch = originalFetch
    fetchCalls = []
  }

  const ttsFailureScript = `
const fs = require('fs')
const path = require('path')
const constants = require(${JSON.stringify(constantsModule)})
const tts = require(${JSON.stringify(ttsModule)})
fs.mkdirSync(constants.DATA_DIR, { recursive: true })
fs.writeFileSync(constants.MIMORIUM_KEY_FILE, 'tp-test-key')
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
    calls.push(JSON.parse(opts.body))
    return { ok: true, json: async () => ({ choices: [{ message: { audio: { data: 'data:audio/wav;base64,' + wavBase64 } } }] }) }
  }
  let diagnostics = {}
  const dataUriBuf = await tts.synthesizeSpeech('测试', { voice: '冰糖', style: '活泼', diagnostics })
  result.dataUriMime = tts.detectAudioMime(dataUriBuf)
  result.dataUriModel = calls[0].model

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
    calls.push(JSON.parse(opts.body))
    return { ok: true, json: async () => ({ choices: [{ message: { audio: { data: wavBase64 } } }] }) }
  }
  diagnostics = {}
  const cloneBuf = await tts.synthesizeSpeech('测试', { voice: 'data:audio/wav;base64,' + wavBase64, style: '活泼', diagnostics })
  result.cloneMime = tts.detectAudioMime(cloneBuf)
  result.cloneModel = calls[0].model
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
  t.check('synthesizeSpeech accepts data URI audio response', ttsFailureSummary.dataUriMime === 'audio/wav' && ttsFailureSummary.dataUriModel === 'mimo-v2.5-tts', JSON.stringify(ttsFailureSummary))
  t.check('synthesizeSpeech rejects unplayable decoded audio', ttsFailureSummary.badAudioNull === true && ttsFailureSummary.badAudioCode === 'invalid_audio', JSON.stringify(ttsFailureSummary))
  t.check('synthesizeSpeech reports sanitized HTTP failure', ttsFailureSummary.httpNull === true && ttsFailureSummary.httpCode === 'http_error' && !String(ttsFailureSummary.httpMessage || '').includes('tp-secret-value'), JSON.stringify(ttsFailureSummary))
  t.check('synthesizeSpeech uses clone model for data URI voice', ttsFailureSummary.cloneMime === 'audio/wav' && ttsFailureSummary.cloneModel === 'mimo-v2.5-tts-voiceclone', JSON.stringify(ttsFailureSummary))
  try { fs.rmSync(ttsFailureDataRoot, { recursive: true, force: true }) } catch {}

  t.section('scenario: voice ASR transcribe (mock)')

  const { TTS_TEMP_DIR } = require('../../lib/constants')
  fs.mkdirSync(TTS_TEMP_DIR, { recursive: true })
  const testWav = path.join(TTS_TEMP_DIR, 'test-asr-scenario.wav')
  const wavHeader = Buffer.alloc(44)
  wavHeader.write('RIFF', 0)
  wavHeader.writeUInt32LE(36, 4)
  wavHeader.write('WAVE', 8)
  wavHeader.write('fmt ', 12)
  wavHeader.writeUInt32LE(16, 16)
  wavHeader.writeUInt16LE(1, 20)
  wavHeader.writeUInt16LE(1, 22)
  wavHeader.writeUInt32LE(16000, 24)
  wavHeader.writeUInt32LE(32000, 28)
  wavHeader.writeUInt16LE(2, 32)
  wavHeader.writeUInt16LE(16, 34)
  wavHeader.write('data', 36)
  wavHeader.writeUInt32LE(0, 40)
  fs.writeFileSync(testWav, wavHeader)

  global.fetch = async (url, opts) => {
    fetchCalls.push({ url, opts })
    return {
      ok: true,
      json: async () => ({ choices: [{ message: { content: '你好世界' } }] }),
    }
  }

  try {
    const config = { apiKey: 'test-key', model: 'test', baseURL: 'http://localhost', provider: 'opencode' }
    const text = await voice.callModelAsr(testWav, config)
    t.check('callModelAsr returns transcribed text', text === '你好世界')
    t.check('callModelAsr called fetch', fetchCalls.length === 1)
    t.check('callModelAsr used mimorium URL', fetchCalls[0].url.includes('token-plan-cn.xiaomimimo.com'))
    const body = JSON.parse(fetchCalls[0].opts.body)
    t.check('callModelAsr model is mimo-v2.5', body.model === 'mimo-v2.5')
    t.check('callModelAsr has audio content', body.messages[0].content.some(c => c.type === 'input_audio'))
  } finally {
    global.fetch = originalFetch
    try { fs.unlinkSync(testWav) } catch {}
  }
}

module.exports = { run }
