/**
 * MODULE: 语音识别（ASR）。
 * 职责: 提取语音 payload → 下载 → 转码 WAV → 调 MiMo 多模态模型转写 → 返回文字。
 * 边界: 不发送消息、不写对话历史、不改 conversation。
 * 状态: 无持久状态。
 */
const fs = require('fs')
const path = require('path')
const { execFile } = require('child_process')
const { recordTokenUsage } = require('../../core/api') as typeof import('../../core/api')
const { resolveCapabilityRuntimeSteps } = require('../../core/ai-capability-config') as typeof import('../../core/ai-capability-config')
const { notifyCapabilityStepFailure } = require('../../core/capability-failure-notifier') as typeof import('../../core/capability-failure-notifier')
const { extractVoiceUrls, validatePublicHttpUrl, resolveAndValidateHostname } = require('../../core/utils') as typeof import('../../core/utils')
const { DATA_DIR } = require('../../core/constants') as typeof import('../../core/constants')

const ASR_TIMEOUT_MS = 10000
const MAX_VOICE_BYTES = 2 * 1024 * 1024
const VOICE_TEMP_DIR: string = path.join(DATA_DIR, 'voice-temp')

interface VoiceSegment {
  type?: string
  data?: {
    url?: unknown
    file?: unknown
  }
}

interface VoiceSessionLike {
  content?: string
  messageId?: string | number
  event?: {
    message?: VoiceSegment[]
  }
}

interface VoicePayload {
  url: string
  file: string | null
}

interface VoiceConfig {
  apiKey: string
  model?: string
  provider?: string
  baseURL?: string
}

interface AsrRuntimeStep extends VoiceConfig {
  apiKey: string
  model: string
  provider: string
  baseURL: string
}

interface AsrAttemptResult {
  text: string
  usage?: Record<string, unknown>
  readable: boolean
}

interface HttpResponseLike {
  statusCode?: number
  headers: Record<string, unknown>
  resume(): void
  on(event: 'data', handler: (chunk: Buffer) => void): void
  on(event: 'end', handler: () => void): void
  on(event: 'error', handler: (error: Error) => void): void
}

interface HttpRequestLike {
  destroy(): void
  on(event: 'error', handler: (error: Error) => void): void
}

interface SilkModule {
  isSilk(input: Buffer): boolean
  decode(input: Buffer, sampleRate: number): { data: Buffer | Uint8Array }
}

function getVoiceErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function extractVoicePayload(session: VoiceSessionLike | null | undefined): VoicePayload | null {
  const segments = Array.isArray(session?.event?.message) ? session.event.message : []
  for (const seg of segments) {
    if (seg.type === 'record' && seg.data) {
      return { url: String(seg.data.url || ''), file: seg.data.file ? String(seg.data.file) : null }
    }
  }
  const content = String(session?.content || '')
  const urls = extractVoiceUrls(content)
  if (urls.length) return { url: urls[0], file: null }
  const cqFile = content.match(/\[CQ:record[^\]]*?file=([^,\]\s]+)/i)
  if (cqFile) return { url: '', file: cqFile[1] }
  return null
}

// 下载经过公网校验且满足大小限制的语音到临时文件。
async function downloadVoiceFile(url: string, destPath: string): Promise<string | null> {
  return new Promise<string | null>((resolve) => {
    let req: HttpRequestLike | null = null
    let timer: ReturnType<typeof setTimeout> | null = null
    let settled = false
    const finish = (value: string | null): void => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      try { if (req) req.destroy() } catch { /* non-critical: request may already be closed */
      }
      resolve(value || null)
    }

    ;(async () => {
      let parsed: URL
      try {
        parsed = validatePublicHttpUrl(url)
        await resolveAndValidateHostname(parsed)
      } catch (error) {
        console.warn(`[voice-asr] download_url_rejected detail=${getVoiceErrorMessage(error)}`)
        return finish(null)
      }
      try {
        const mod = parsed.protocol === 'https:' ? require('https') : require('http')
        timer = setTimeout(() => finish(null), 15000)
        const currentReq: HttpRequestLike = mod.get(parsed, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res: HttpResponseLike) => {
          if (res.statusCode !== 200) { res.resume(); return finish(null) }
          const declared = parseInt(String(res.headers['content-length'] || ''), 10)
          if (Number.isFinite(declared) && declared > MAX_VOICE_BYTES) { res.resume(); return finish(null) }
          const chunks: Buffer[] = []
          let received = 0
          res.on('data', (c) => {
            if (settled) return
            received += c.length
            if (received > MAX_VOICE_BYTES) { res.resume(); return finish(null) }
            chunks.push(c)
          })
          res.on('end', () => {
            const buf = Buffer.concat(chunks)
            if (!buf.length || buf.length > MAX_VOICE_BYTES) return finish(null)
            try { fs.mkdirSync(path.dirname(destPath), { recursive: true }); fs.writeFileSync(destPath, buf); finish(destPath) } catch (error) {
              console.warn(`[voice-asr] temp_voice_write_failed detail=${getVoiceErrorMessage(error)}`)
              finish(null)
            }
          })
          res.on('error', () => finish(null))
        })
        req = currentReq
        currentReq.on('error', () => finish(null))
      } catch (error) {
        console.warn(`[voice-asr] network_setup_failed detail=${getVoiceErrorMessage(error)}`)
        finish(null)
      }
    })()
  })
}

// 优先用 ffmpeg 转码，失败后尝试 Silk 解码并返回 WAV 路径。
function convertToWav(srcPath: string): Promise<string | null> {
  return new Promise<string | null>((resolve) => {
    const outPath = srcPath + '.wav'
    execFile('ffmpeg', ['-y', '-i', srcPath, '-ar', '16000', '-ac', '1', '-sample_fmt', 's16', outPath], { timeout: 10000 }, (err: Error | null) => {
      if (!err && fs.existsSync(outPath)) return resolve(outPath)
      try {
        const silk = require('silk-wasm') as SilkModule
        const input = fs.readFileSync(srcPath)
        if (silk.isSilk(input)) {
          const { data } = silk.decode(input, 16000)
          const wavBuf = pcmToWav(data, 16000, 1, 16)
          fs.writeFileSync(outPath, wavBuf)
          return resolve(outPath)
        }
      } catch (error) {
        console.warn(`[voice-asr] conversion_fallback_failed ffmpeg=${getVoiceErrorMessage(err)} silk=${getVoiceErrorMessage(error)}`)
      }
      resolve(null)
    })
  })
}

function pcmToWav(pcmData: Buffer | Uint8Array, sampleRate: number, channels: number, bitsPerSample: number): Buffer {
  const byteRate = sampleRate * channels * (bitsPerSample / 8)
  const blockAlign = channels * (bitsPerSample / 8)
  const dataSize = pcmData.length
  const header = Buffer.alloc(44)
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + dataSize, 4)
  header.write('WAVE', 8)
  header.write('fmt ', 12)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(channels, 22)
  header.writeUInt32LE(sampleRate, 24)
  header.writeUInt32LE(byteRate, 28)
  header.writeUInt16LE(blockAlign, 32)
  header.writeUInt16LE(bitsPerSample, 34)
  header.write('data', 36)
  header.writeUInt32LE(dataSize, 40)
  return Buffer.concat([header, Buffer.from(pcmData)])
}

// 把上游 ASR HTTP 状态转换为不含响应正文的稳定错误。
function assertAsrResponseOk(response: Response): void {
  if (response.ok) return
  const error = new Error(`语音识别上游失败（HTTP ${response.status}）`) as Error & { retryable?: boolean }
  error.retryable = response.status === 401 || response.status === 403 || response.status === 429 || response.status >= 500
  throw error
}

// 安全解析 ASR JSON，解析失败可进入下一优先级且不泄露上游正文。
async function readAsrJson(response: Response): Promise<Record<string, unknown>> {
  try {
    const value: unknown = await response.json()
    if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>
  } catch { /* handled below */ }
  const error = new Error('语音识别上游返回了无法解析的结果') as Error & { retryable?: boolean }
  error.retryable = true
  throw error
}

// 通过 OpenAI 官方 audio/transcriptions 协议转写一个 WAV 文件。
async function requestOpenAiAsr(wavPath: string, step: AsrRuntimeStep, signal: AbortSignal): Promise<AsrAttemptResult> {
  const form = new FormData()
  form.append('model', step.model)
  form.append('file', new Blob([fs.readFileSync(wavPath)], { type: 'audio/wav' }), 'voice.wav')
  const response = await fetch(`${step.baseURL.replace(/\/+$/, '')}/audio/transcriptions`, {
    method: 'POST', signal, headers: { Authorization: `Bearer ${step.apiKey}` }, body: form,
  })
  assertAsrResponseOk(response)
  const data = await readAsrJson(response)
  const text = String(data.text || '').trim()
  if (!text) {
    const error = new Error('语音识别上游返回空结果') as Error & { retryable?: boolean }
    error.retryable = true
    throw error
  }
  const usage = data.usage && typeof data.usage === 'object' && !Array.isArray(data.usage) ? data.usage as Record<string, unknown> : undefined
  return { text, usage, readable: !!usage && Object.keys(usage).some(key => /tokens/i.test(key)) }
}

// 通过小米已验证的 OpenAI 兼容多模态路径调用专用 ASR 模型。
async function requestMimoriumAsr(wavPath: string, step: AsrRuntimeStep, signal: AbortSignal): Promise<AsrAttemptResult> {
  const audio = `data:audio/wav;base64,${fs.readFileSync(wavPath).toString('base64')}`
  const response = await fetch(`${step.baseURL.replace(/\/+$/, '')}/chat/completions`, {
    method: 'POST', signal,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${step.apiKey}` },
    body: JSON.stringify({
      model: step.model,
      max_tokens: 500,
      messages: [{ role: 'user', content: [
        { type: 'text', text: '请将这段语音转写成文字，只返回转写的文字本身，不要添加任何其他内容。' },
        { type: 'input_audio', input_audio: { data: audio } },
      ] }],
    }),
  })
  assertAsrResponseOk(response)
  const data = await readAsrJson(response)
  const choices = Array.isArray(data.choices) ? data.choices : []
  const first = choices[0] && typeof choices[0] === 'object' ? choices[0] as Record<string, unknown> : {}
  const message = first.message && typeof first.message === 'object' ? first.message as Record<string, unknown> : {}
  const text = String(message.content || '').trim()
  if (!text) {
    const error = new Error('语音识别上游返回空结果') as Error & { retryable?: boolean }
    error.retryable = true
    throw error
  }
  const usage = data.usage && typeof data.usage === 'object' && !Array.isArray(data.usage) ? data.usage as Record<string, unknown> : undefined
  return { text, usage, readable: !!usage && Object.keys(usage).some(key => /tokens/i.test(key)) }
}

// 读取 voice-asr 优先级并按顺序转写；配置为空时不发起任何请求。
async function callModelAsr(wavPath: string, _config?: VoiceConfig): Promise<string> {
  const steps = resolveCapabilityRuntimeSteps('voice-asr') as AsrRuntimeStep[]
  if (!steps.length) throw new Error('该能力未配置模型')
  for (let index = 0; index < steps.length; index += 1) {
    const step = steps[index]
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), ASR_TIMEOUT_MS)
    try {
      const result = step.provider === 'openai'
        ? await requestOpenAiAsr(wavPath, step, controller.signal)
        : await requestMimoriumAsr(wavPath, step, controller.signal)
      const usage = result.usage || {}
      const total = Number(usage.total_tokens || usage.totalTokens || 0)
        || Number(usage.input_tokens || usage.prompt_tokens || 0) + Number(usage.output_tokens || usage.completion_tokens || 0)
      recordTokenUsage(step.provider, Number.isFinite(total) ? total : 0, { capability: 'voice-asr', model: step.model, usage, readable: result.readable })
      return result.text
    } catch (error) {
      const retryable = (error as { retryable?: unknown })?.retryable !== false
      console.warn(`[voice-asr] capability_step_failed provider=${step.provider} model=${step.model}`)
      await notifyCapabilityStepFailure(step.provider, step.model).catch(() => false)
      if (!retryable || index >= steps.length - 1) throw error
    } finally {
      clearTimeout(timer)
    }
  }
  throw new Error('该能力未配置模型')
}

// 依次提取、下载、转码和识别会话中的语音，无法识别时返回 null。
async function transcribeVoice(session: VoiceSessionLike | null | undefined, config: VoiceConfig): Promise<string | null> {
  const payload = extractVoicePayload(session)
  if (!payload) return null

  const id = String(session?.messageId || Date.now())
  fs.mkdirSync(VOICE_TEMP_DIR, { recursive: true })
  const tempFile = path.join(VOICE_TEMP_DIR, `asr-${id.replace(/[^a-zA-Z0-9]/g, '_')}`)

  let downloaded: string | null = null
  if (payload.url && payload.url.startsWith('http')) {
    downloaded = await downloadVoiceFile(payload.url, tempFile)
  }
  if (!downloaded && payload.file) {
    try {
      const { callGetRecord } = require('../../core/api') as typeof import('../../core/api')
      const recordInfo = await callGetRecord(payload.file)
      if (recordInfo && recordInfo.file && fs.existsSync(recordInfo.file)) downloaded = String(recordInfo.file)
    } catch (error) {
      console.warn(`[voice-asr] onebot_get_record_failed detail=${getVoiceErrorMessage(error)}`)
    }
  }
  if (!downloaded) return null

  const wavPath = await convertToWav(downloaded)
  if (downloaded === tempFile) {
    try { fs.unlinkSync(downloaded) } catch { /* non-critical: best-effort ASR temp input cleanup */
    }
  }
  if (!wavPath) return null

  try {
    const text = await callModelAsr(wavPath, config)
    return text || null
  } finally {
    try { fs.unlinkSync(wavPath) } catch { /* non-critical: best-effort ASR wav cleanup */
    }
  }
}

export = {
  extractVoicePayload,
  downloadVoiceFile,
  convertToWav,
  callModelAsr,
  transcribeVoice,
}
