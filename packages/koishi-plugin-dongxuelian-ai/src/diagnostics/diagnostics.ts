/* ==========================================================================
 * MODULE: diagnostics
 * 职责：封装入口旁路诊断日志，包括回复时机、情绪路由和表情 shadow 诊断。
 * 边界：不注册 middleware、不发送消息、不改变概率或回复内容；只观察输入并写调试日志/诊断 JSONL。
 * 状态：不持有业务状态；随机语音概率按需从 random-voice-rate 读取。
 * ========================================================================== */
const path = require('path')
const { logDebug, isDebugLogEnabled } = require('../core/logging-config') as typeof import('../core/logging-config')
const {
  buildReplyTimingDiagnostic,
  formatReplyTimingDiagnostic,
} = require('../reply/reply-timing') as typeof import('../reply/reply-timing')
const {
  buildAffectRouterDiagnostic,
  formatAffectRouterDiagnostic,
} = require('../behavior/affect-router') as typeof import('../behavior/affect-router')
const {
  buildStickerShadowIngestPlan,
  formatStickerShadowIngestDiagnostic,
  buildStickerShadowSendPlan,
  formatStickerShadowSendDiagnostic,
  appendStickerShadowLog,
} = require('../behavior/sticker-shadow') as typeof import('../behavior/sticker-shadow')
const { getRandomVoiceRate } = require('../behavior/random-voice-rate') as typeof import('../behavior/random-voice-rate')

interface DiagnosticsContext {
  [key: string]: unknown
}

interface DiagnosticInput {
  channelKey?: string
  randomVoiceRate?: number
  [key: string]: unknown
}

interface StickerShadowPlan {
  type?: string
  [key: string]: unknown
}

type DiagnosticResult = unknown

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function getStickerShadowLogFileResult(result: unknown): string {
  if (result && typeof result === 'object' && 'file' in result) return String((result as { file?: unknown }).file || '')
  return ''
}

function ignoreDiagnosticDebugFailure(error: unknown): void {
  void error
}

function withRandomVoiceRate(input: DiagnosticInput = {}): DiagnosticInput {
  return {
    ...input,
    randomVoiceRate: input.randomVoiceRate === undefined && input.channelKey
      ? getRandomVoiceRate(input.channelKey)
      : input.randomVoiceRate,
  }
}

function logReplyTimingDiagnostic(ctx: DiagnosticsContext, input: DiagnosticInput = {}): DiagnosticResult {
  try {
    const diagnostic = buildReplyTimingDiagnostic(input)
    logDebug(ctx, 'reply-timing', formatReplyTimingDiagnostic(diagnostic))
    return diagnostic as unknown as Record<string, unknown>
  } catch (error) {
    logDebug(ctx, 'reply-timing', `diagnostic_failed ${getErrorMessage(error)}`)
    return null
  }
}

function logAffectRouterDiagnostic(ctx: DiagnosticsContext, input: DiagnosticInput = {}): DiagnosticResult {
  if (!isDebugLogEnabled('affect-router')) return null
  try {
    const diagnostic = buildAffectRouterDiagnostic(withRandomVoiceRate(input))
    logDebug(ctx, 'affect-router', formatAffectRouterDiagnostic(diagnostic))
    return diagnostic
  } catch (error) {
    logDebug(ctx, 'affect-router', `diagnostic_failed ${getErrorMessage(error)}`)
    return null
  }
}

function buildAffectRouterDiagnosticForShadow(input: DiagnosticInput = {}): DiagnosticResult {
  try {
    return buildAffectRouterDiagnostic(withRandomVoiceRate(input))
  } catch {
    return null
  }
}

function logAffectRouterDiagnosticForOutputShadow(ctx: DiagnosticsContext, input: DiagnosticInput = {}): DiagnosticResult {
  const logged = logAffectRouterDiagnostic(ctx, input)
  if (logged || !isDebugLogEnabled('sticker-shadow')) return logged
  return buildAffectRouterDiagnosticForShadow(input)
}

function logStickerShadowPlan(ctx: DiagnosticsContext, plan: StickerShadowPlan | null | undefined): void {
  if (!plan) return
  const formatter = plan.type === 'sticker_shadow_send_v1'
    ? formatStickerShadowSendDiagnostic
    : formatStickerShadowIngestDiagnostic
  logDebug(ctx, 'sticker-shadow', formatter(plan))
  appendStickerShadowLog(plan)
    .then((result) => {
      try { logDebug(ctx, 'sticker-shadow', `sticker_shadow_jsonl written=true file=${path.basename(getStickerShadowLogFileResult(result))} type=${plan.type || 'unknown'} mode=shadow_only prompt=unchanged send=unchanged`) } catch (error) { ignoreDiagnosticDebugFailure(error) }
    })
    .catch((error) => {
      try { logDebug(ctx, 'sticker-shadow', `sticker_shadow_jsonl_failed reason=${getErrorMessage(error).slice(0, 80)} type=${plan.type || 'unknown'} mode=shadow_only prompt=unchanged send=unchanged`) } catch (debugError) { ignoreDiagnosticDebugFailure(debugError) }
    })
}

function logStickerShadowIngestDiagnostic(ctx: DiagnosticsContext, input: DiagnosticInput = {}): DiagnosticResult {
  if (!isDebugLogEnabled('sticker-shadow')) return null
  try {
    const plan = buildStickerShadowIngestPlan(input)
    logStickerShadowPlan(ctx, plan)
    return plan
  } catch (error) {
    logDebug(ctx, 'sticker-shadow', `sticker_shadow_ingest_failed reason=${getErrorMessage(error).slice(0, 80)} mode=shadow_only prompt=unchanged send=unchanged`)
    return null
  }
}

function logStickerShadowSendDiagnostic(ctx: DiagnosticsContext, input: DiagnosticInput = {}): boolean | null {
  if (!isDebugLogEnabled('sticker-shadow')) return null
  buildStickerShadowSendPlan(input)
    .then((plan) => logStickerShadowPlan(ctx, plan))
    .catch((error) => {
      try { logDebug(ctx, 'sticker-shadow', `sticker_shadow_send_failed reason=${getErrorMessage(error).slice(0, 80)} mode=shadow_only prompt=unchanged send=unchanged`) } catch (debugError) { ignoreDiagnosticDebugFailure(debugError) }
    })
  return true
}

export = {
  logReplyTimingDiagnostic,
  logAffectRouterDiagnostic,
  buildAffectRouterDiagnosticForShadow,
  logAffectRouterDiagnosticForOutputShadow,
  logStickerShadowPlan,
  logStickerShadowIngestDiagnostic,
  logStickerShadowSendDiagnostic,
}
