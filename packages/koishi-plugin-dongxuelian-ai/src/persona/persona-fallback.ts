/**
 * MODULE: 人格化异常兜底。
 * 职责: 在回复守卫失败时，用当前人格 prompt 生成短纠偏回复。
 * 边界: 不读写文件、不保存 conversation；只调用传入的模型函数。
 * 状态: 无。
 */
const { sanitizeReply, stripMarkdownForQQ, trimReply } = require('../core/utils') as typeof import('../core/utils')
const { isUnsafeThinkingReply, hasInternalContextLeak, stripStickerMarkersForGuard, shouldRetryRepeatedReply } = require('../reply/reply-guard') as typeof import('../reply/reply-guard')
const { hasBannedOutput } = require('../core/utils') as typeof import('../core/utils')

interface FallbackSession {
  channelId?: string
  userId?: string
}

interface ModelTextResult {
  content?: unknown
  message?: { content?: unknown }
}

interface PersonaFallbackMessage {
  role: 'system' | 'user'
  content: string
}

interface GeneratePersonaFallbackOptions {
  session?: FallbackSession
  systemPrompt?: string
  currentUserMessage?: string
  userName?: string
  reason?: string
  maxChars?: number
  callModel?: (messages: PersonaFallbackMessage[], isRandom?: boolean, options?: Record<string, unknown>) => Promise<unknown>
  isRandom?: boolean
}

function getPersonaFallbackErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function normalizeModelText(result: unknown): string {
  if (typeof result === 'string') return result
  if (result && typeof result === 'object') {
    const data = result as ModelTextResult
    return String(data.content || data.message?.content || '')
  }
  return ''
}

function isUnsafeFallbackText(session: FallbackSession | undefined, text: string = ''): boolean {
  const value = stripStickerMarkersForGuard(String(text || '').trim())
  return !value ||
    hasBannedOutput(value) ||
    isUnsafeThinkingReply(value) ||
    hasInternalContextLeak(value) ||
    shouldRetryRepeatedReply(session as Parameters<typeof shouldRetryRepeatedReply>[0], value)
}

function cleanPersonaFallbackReply(session: FallbackSession | undefined, text: string = '', userName: string = '用户', maxChars: number = 120): string {
  const cleaned = trimReply(stripMarkdownForQQ(sanitizeReply(text, userName)), maxChars)
  return isUnsafeFallbackText(session, cleaned) ? '' : cleaned
}

function buildPersonaFallbackMessages(systemPrompt: string, currentUserMessage: string, reason: string = ''): PersonaFallbackMessage[] {
  return [
    { role: 'system', content: systemPrompt },
    {
      role: 'system',
      content: [
        '你刚才的候选回复没有通过发送前守卫。',
        reason ? `原因：${reason}` : '',
        '不要复述失败回复，不要解释规则，不要提工具名/函数名/内部材料。',
        '直接按当前人格给用户一句到两句自然回复；短一点，像 QQ 聊天。',
      ].filter(Boolean).join('\n'),
    },
    { role: 'user', content: currentUserMessage },
  ]
}

async function generatePersonaFallbackReply({
  session,
  systemPrompt,
  currentUserMessage,
  userName,
  reason,
  maxChars,
  callModel,
  isRandom,
}: GeneratePersonaFallbackOptions): Promise<string> {
  if (typeof callModel !== 'function' || !systemPrompt || !currentUserMessage) return ''
  try {
    const result = await callModel(
      buildPersonaFallbackMessages(systemPrompt, currentUserMessage, reason),
      isRandom,
      { max_tokens: 80, _fallbackSet: 'lightweight' }
    )
    return cleanPersonaFallbackReply(session, normalizeModelText(result), userName, maxChars)
  } catch (error) {
    console.warn(`[dongxuelian-ai] persona fallback generation failed: ${getPersonaFallbackErrorMessage(error)}`)
    return ''
  }
}

export = {
  normalizeModelText,
  isUnsafeFallbackText,
  cleanPersonaFallbackReply,
  buildPersonaFallbackMessages,
  generatePersonaFallbackReply,
}
