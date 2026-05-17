const path = require('path')
const fs = require('fs')

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

  t.section('scenario: voice TTS synthesize (mock)')

  const originalFetch = global.fetch
  const mockAudioBase64 = Buffer.from('RIFF fake wav data').toString('base64')
  let fetchCalls = []
  global.fetch = async (url, opts) => {
    fetchCalls.push({ url, opts })
    return {
      ok: true,
      json: async () => ({ choices: [{ message: { audio: { data: mockAudioBase64 } } }] }),
    }
  }

  try {
    const buf = await tts.synthesizeSpeech('测试文本', { voice: '冰糖', style: '活泼' })
    if (buf) {
      t.check('synthesizeSpeech returns Buffer', Buffer.isBuffer(buf))
      t.check('synthesizeSpeech Buffer has content', buf.length > 0)
      t.check('synthesizeSpeech called fetch', fetchCalls.length === 1)
      t.check('synthesizeSpeech used correct URL', fetchCalls[0].url.includes('token-plan-cn.xiaomimimo.com'))
      const body = JSON.parse(fetchCalls[0].opts.body)
      t.check('synthesizeSpeech model is mimo-v2.5-tts', body.model === 'mimo-v2.5-tts')
      t.check('synthesizeSpeech audio format is wav', body.audio && body.audio.format === 'wav')
      t.check('synthesizeSpeech voice is 冰糖', body.audio && body.audio.voice === '冰糖')
      t.check('synthesizeSpeech messages has style', body.messages[0].role === 'user' && body.messages[0].content === '活泼')
      t.check('synthesizeSpeech messages has text', body.messages[1].role === 'assistant' && body.messages[1].content === '测试文本')
    } else {
      t.check('synthesizeSpeech returns null (no key file)', true)
    }
  } finally {
    global.fetch = originalFetch
    fetchCalls = []
  }

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
