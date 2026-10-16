/**
 * MODULE: 自定义 OpenAI 兼容模型的四能力探测。
 * 职责: 以小型有效请求验证既有运行时协议，返回脱敏的三态检测结果。
 * 边界: 不保存配置、不记录认证头；不跟随重定向；全局最多两个探测请求。
 * 状态: active/waiters 只管理进程内请求并发，每个请求单独超时并释放槽位。
 */
import type { ManagementModule } from 'koishi-plugin-dongxuelian-ai/lib/public/management-runtime'
const { loadManagementModule } = require('koishi-plugin-dongxuelian-ai/lib/public/management-runtime') as typeof import('koishi-plugin-dongxuelian-ai/lib/public/management-runtime')
const discovery = loadManagementModule('core.modelDiscovery')
const capabilityConfig = loadManagementModule('core.aiCapabilityConfig')
type Model = ReturnType<ManagementModule<'core.aiCapabilityConfig'>['normalizeDiscoveredModels']>[number]
type Capability = 'text' | 'vision' | 'voice-asr' | 'voice-tts'
type Check = { status: 'supported' | 'unsupported' | 'pending'; reason: string }
let active = 0
const waiters: Array<() => void> = []

// 生成一秒有效 PCM WAV 静音，验证语音识别接口而不传入用户音频。
function silenceWav(): Buffer {
  const wav = Buffer.alloc(44 + 32000)
  wav.write('RIFF', 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8)
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22)
  wav.writeUInt32LE(16000, 24); wav.writeUInt32LE(32000, 28); wav.writeUInt16LE(2, 32)
  wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(32000, 40)
  return wav
}

// 生成确定的红色 PNG，用回答内容排除仅忽略图片却返回成功的接口。
async function redImage(): Promise<string> {
  const sharp = require('sharp') as typeof import('sharp')
  const png = await sharp({ create: { width: 32, height: 32, channels: 3, background: '#ff0000' } }).png().toBuffer()
  return `data:image/png;base64,${png.toString('base64')}`
}

// 构造与当前运行时一致的四种 OpenAI 兼容请求，不通过模型名称猜测能力。
async function buildProbe(baseURL: string, model: string, capability: Capability): Promise<{ url: string; body: BodyInit; json: boolean }> {
  const base = baseURL.replace(/\/+$/, '').replace(/\/models$/, '')
  if (capability === 'voice-asr') {
    const body = new FormData()
    body.append('model', model); body.append('file', new Blob([new Uint8Array(silenceWav())], { type: 'audio/wav' }), 'silence.wav')
    return { url: `${base}/audio/transcriptions`, body, json: false }
  }
  if (capability === 'voice-tts') return { url: `${base}/audio/speech`, body: JSON.stringify({ model, input: '好', voice: 'alloy', response_format: 'wav' }), json: true }
  const content = capability === 'vision'
    ? [{ type: 'text', text: '图片的主要颜色是什么？只回答颜色名称。' }, { type: 'image_url', image_url: { url: await redImage() } }]
    : 'Reply OK.'
  return { url: `${base}/chat/completions`, body: JSON.stringify({ model, messages: [{ role: 'user', content }], max_tokens: 32, stream: false }), json: true }
}

// 按协议检查有效返回，不将鉴权、限流、超时或未知错误认作不支持。
async function inspectResponse(response: Response, capability: Capability): Promise<Check> {
  if (!response.ok) {
    await response.body?.cancel()
    return { status: [404, 405, 415, 501].includes(response.status) ? 'unsupported' : 'pending', reason: `接口检测 HTTP ${response.status}${[401, 403].includes(response.status) ? '，请检查权限' : response.status === 429 ? '，请稍后重试' : ''}` }
  }
  if (capability === 'voice-tts') {
    // 只读首个数据块后关闭音频流，避免供应商忽略短输入产生过量响应。
    const reader = response.body?.getReader()
    if (!reader) return { status: 'pending', reason: '语音接口未返回音频数据' }
    try {
      const first = await reader.read()
      const data = Buffer.from(first.value || [])
      const signature = data.length >= 12 && (data.toString('ascii', 0, 4) === 'RIFF' && data.toString('ascii', 8, 12) === 'WAVE' || data.toString('ascii', 0, 4) === 'OggS' || data.toString('ascii', 0, 3) === 'ID3' || data[0] === 0xff && (data[1] & 0xe0) === 0xe0)
      const valid = signature && /^(audio\/|application\/octet-stream)/i.test(response.headers.get('content-type') || '')
      return { status: valid ? 'supported' : 'pending', reason: valid ? '已返回有效音频流' : '返回内容未确认是音频' }
    } finally { await reader.cancel() }
  }
  const payload = await response.json() as { text?: unknown; choices?: Array<{ message?: { content?: unknown } }> }
  const content = capability === 'voice-asr' ? payload.text : payload.choices?.[0]?.message?.content
  const valid = typeof content === 'string' && (capability === 'voice-asr' || content.trim().length > 0)
  const vision = capability !== 'vision' || typeof content === 'string' && ['红', '红色', 'red'].includes(content.trim().toLowerCase().replace(/[。.!！\s]/g, ''))
  return { status: valid && vision ? 'supported' : 'pending', reason: valid && vision ? '接口请求及返回格式验证通过' : '返回内容未能确认该能力' }
}

// 执行单能力探测；所有退出路径均取消超时并释放全局槽位。
async function probeCapability(baseURL: string, model: string, key: string, capability: Capability): Promise<Check> {
  if (active >= 2) await new Promise<void>(resolve => waiters.push(resolve))
  else active += 1
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 6000)
  try {
    const request = await buildProbe(baseURL, model, capability)
    const url = await discovery.validateCustomDiscoveryUrl(request.url)
    if (controller.signal.aborted) return { status: 'pending', reason: '能力检测超时，请重试' }
    const response = await fetch(url, { method: 'POST', redirect: 'manual', signal: controller.signal,
      headers: { Authorization: `Bearer ${key}`, ...(request.json ? { 'Content-Type': 'application/json' } : {}) }, body: request.body })
    return await inspectResponse(response, capability)
  } catch { return { status: 'pending', reason: controller.signal.aborted ? '能力检测超时，请重试' : '网络或返回格式异常，待重新检测' } }
  finally { clearTimeout(timer); const next = waiters.shift(); if (next) next(); else active -= 1 }
}

// 检测一个自定义模型的全部能力；不把暂时未确认的旧能力从既有优先级中移除。
async function detectModelCapabilities(baseURL: string, model: Model, key: string): Promise<Model> {
  const results = await Promise.all(capabilityConfig.AI_CAPABILITIES.map(async capability => [capability, await probeCapability(baseURL, model.id, key, capability as Capability)] as const))
  const checks = Object.fromEntries(results) as NonNullable<Model['capabilityChecks']>
  return { ...model, capabilities: capabilityConfig.AI_CAPABILITIES.filter(capability => checks[capability].status === 'supported' || checks[capability].status === 'pending' && model.capabilities.includes(capability)), capabilityChecks: checks }
}

export = { detectModelCapabilities, inspectResponse }
