/**
 * MODULE: 随机回复内部模式。
 * 职责: 解析随机主动回复的内部 mode 协议，避免 JSON/工具计划/乱码直接发到群里。
 * 边界: 不调用 AI API、不发送消息；只返回发送决策。
 */
type RandomReplyMode = 'anchored_reply' | 'context_lookup' | 'ambient_water' | 'no_send'

interface RandomReplyDecision {
  shouldSend: boolean
  mode: RandomReplyMode
  reply: string
  reason: string
}

interface AmbientWaterSendOptions {
  [key: string]: unknown
}

const RANDOM_REPLY_MODES: Set<string> = new Set(['anchored_reply', 'context_lookup', 'ambient_water', 'no_send'])

function stripCodeFence(text: string = ''): string {
  const value = String(text || '').trim()
  const fenced = value.match(/^```(?:json|javascript|js)?\s*([\s\S]*?)\s*```$/i)
  return fenced ? fenced[1].trim() : value
}

function looksLikeRawInternalProtocol(text: string = ''): boolean {
  const value = String(text || '').trim()
  if (!value) return false
  if (/^```(?:json|html|javascript|js)?/i.test(value)) return true
  if (/^__SILENT__$/i.test(value)) return true
  if (/^\s*[{[]/.test(value) && /"(?:mode|reply|tool|function|arguments)"\s*:/.test(value)) return true
  if (/^\s*(?:mode|reply|action)\s*[:=]\s*(?:anchored_reply|context_lookup|ambient_water|no_send)/i.test(value)) return true
  return false
}

function normalizeRandomReplyMode(mode: unknown = ''): RandomReplyMode {
  const value = String(mode || '').trim().toLowerCase().replace(/[\s-]+/g, '_')
  return RANDOM_REPLY_MODES.has(value) ? value as RandomReplyMode : 'anchored_reply'
}

function getRandomReplyField(source: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = source[key]
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value)
  }
  return ''
}

function parseRandomReplyJsonObject(text: string = ''): Record<string, unknown> | null {
  const value = stripCodeFence(text)
  if (!/^\s*{[\s\S]*}\s*$/.test(value)) return null
  try {
    const parsed: unknown = JSON.parse(value)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null
  } catch { /* non-critical: model JSON may be plain text fallback */
    return null
  }
}

function normalizeVisibleReply(text: string = ''): string {
  return String(text || '')
    .replace(/^__SILENT__$/i, '')
    .replace(/```[a-zA-Z0-9_-]*\s*([\s\S]*?)```/g, '$1')
    .replace(/```/g, '')
    .trim()
}

function parseRandomReplyDecision(rawReply: string = ''): RandomReplyDecision {
  const raw = String(rawReply || '').trim()
  if (!raw) return { shouldSend: false, mode: 'no_send', reply: '', reason: 'empty' }
  if (/^__SILENT__$/i.test(raw)) return { shouldSend: false, mode: 'no_send', reply: '', reason: 'silent-token' }

  const parsed = parseRandomReplyJsonObject(raw)
  if (parsed) {
    const mode = normalizeRandomReplyMode(parsed.mode || parsed.action)
    const reply = normalizeVisibleReply(getRandomReplyField(parsed, ['reply', 'text', 'content', 'message']))
    if (mode === 'no_send') return { shouldSend: false, mode, reply: '', reason: 'model-no-send' }
    if (!reply) return { shouldSend: false, mode, reply: '', reason: 'structured-empty-reply' }
    if (looksLikeRawInternalProtocol(reply)) return { shouldSend: false, mode, reply: '', reason: 'structured-reply-still-internal' }
    return { shouldSend: true, mode, reply, reason: 'structured' }
  }

  if (looksLikeRawInternalProtocol(raw)) {
    return { shouldSend: false, mode: 'no_send', reply: '', reason: 'raw-internal-protocol' }
  }

  return { shouldSend: true, mode: 'anchored_reply', reply: normalizeVisibleReply(raw), reason: 'plain-text' }
}

function buildRandomModePrompt(): string {
  return [
    '[随机主动插话内部模式]',
    '这条提示只用于你决定是否插话，最终用户不能看到模式名或 JSON。',
    '你可以直接输出自然聊天文本；也可以在不适合发言时输出 JSON：{"mode":"no_send","reply":""}。',
    '可选模式：anchored_reply=现场清楚时接当前话题；context_lookup=需要旧公共上下文时先调用 read_group_context；ambient_water=不锚定任何人/消息，只轻轻水一句；no_send=说了会打扰或容易误解时不发。',
    '如果选择 ambient_water，只写一句很短的群聊反应，不引用旧话题、不接管任务、不回答点名请求。',
    '如果群友只是在互相吐槽或评价现场里的对象，主语、意图或与你的关系不清时优先 no_send；现场清楚也只能接一句自然反应，禁止把普通评价理解成用户让你接管任务。',
    '不要把 JSON、模式名、工具名、函数名、思考过程发给用户；工具调用是内部动作。',
  ].join('\n')
}

function buildAmbientWaterSendOptions(baseOptions: AmbientWaterSendOptions = {}): AmbientWaterSendOptions {
  return {
    ...baseOptions,
    forceQuote: false,
    quoteMessageId: '',
    noQuote: true,
    noMention: true,
    noReplyTo: true,
    randomMode: 'ambient_water',
  }
}

export = {
  RANDOM_REPLY_MODES,
  stripCodeFence,
  looksLikeRawInternalProtocol,
  normalizeRandomReplyMode,
  parseRandomReplyDecision,
  buildRandomModePrompt,
  buildAmbientWaterSendOptions,
}
