/**
 * MODULE: 人格运行计划旁路编译。
 * 职责: 将现有人格 frontmatter/body 编译为结构化 PersonaRuntimePlan，供后续对账和逐步接入。
 * 边界: 只读；不写人格文件、不调用模型、不改变 chat/TTS/Agent 当前行为。
 * 状态: 无。
 */
const { parsePersonaDocument, parsePersonaNumber, parsePersonaStringList, createPersonaDiagnostic } = require('./persona-schema') as typeof import('./persona-schema')
const { resolvePersona, loadPersonalSkill } = require('./persona') as typeof import('./persona')

const PERSONA_RUNTIME_PLAN_VERSION = 1
const DEFAULT_PERSONA_RUNTIME_NAME = '默认（东雪莲）'
const DEFAULT_PERSONA_RUNTIME_VOICE = '冰糖'
const NEUTRAL_PERSONA_RUNTIME_VOICE_STYLE = '自然清晰，语气稳定，情绪适度，贴合文本内容；不要夸张表演，不要强行卖萌，不要改变角色人设。'
const DEFAULT_PERSONA_WILL = 1.0
const LEGACY_PERSONA_WILL: Readonly<Record<string, number>> = Object.freeze({
  '长离': 0.8,
  '椿': 1.3,
  '特蕾西娅': 0.9,
})
const KNOWN_NSFW_POLICIES = new Set(['none', 'off', 'soft', 'adult', 'strict', 'reply'])

interface PersonaRuntimeDiagnostic {
  level: 'error' | 'warning' | 'info'
  code: string
  message: string
  [key: string]: unknown
}

interface PersonaDocument {
  type?: string
  file?: string
  schemaVersion?: number
  hasFrontmatter?: boolean
  frontmatterText?: string
  meta: Record<string, unknown>
  rawMeta?: Record<string, unknown>
  body?: string
  diagnostics?: PersonaRuntimeDiagnostic[]
}

interface PersonaResolution {
  source?: string
  name?: string | null
}

interface CompilePersonaRuntimePlanOptions {
  personaName?: string
  source?: string
  type?: string
  personaContent?: string
  file?: string
}

interface ResolvePersonaRuntimePlanOptions extends CompilePersonaRuntimePlanOptions {
  resolution?: PersonaResolution
  channelKey?: string
  userId?: string
}

interface PersonaRuntimePlan {
  name?: string | null
  lore?: { primary?: string; refs?: string[] }
  random?: { will?: number }
  safety?: { nsfw?: string }
  voice?: { rawId?: string; assetId?: string; style?: string }
  prompt?: { body?: string }
}

function clampPersonaRuntimeNumber(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof value === 'number' ? value : parsePersonaNumber(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(min, Math.min(max, parsed))
}

function normalizePersonaRuntimeText(value: unknown = '', maxLength: number = 240): string {
  return String(value || '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength)
}

function normalizePersonaRuntimeNsfw(value: unknown = ''): string {
  const text = String(value || '').trim().toLowerCase()
  if (!text) return 'none'
  return KNOWN_NSFW_POLICIES.has(text) ? text : 'none'
}

function buildPersonaRuntimeDiagnostics(doc: PersonaDocument = { meta: {} }, options: { personaName?: string } = {}): PersonaRuntimeDiagnostic[] {
  const diagnostics = Array.isArray(doc.diagnostics) ? doc.diagnostics.slice() : []
  const meta = doc.meta || {}
  const wantedName = String(options.personaName || '').trim()
  if (wantedName && meta.name && meta.name !== wantedName) {
    diagnostics.push(createPersonaDiagnostic('warning', 'persona_name_mismatch', `请求人格 ${wantedName} 与文档 name ${meta.name} 不一致。`, { field: 'name' }))
  }
  const nsfw = String(meta.nsfw || '').trim().toLowerCase()
  if (nsfw && !KNOWN_NSFW_POLICIES.has(nsfw)) {
    diagnostics.push(createPersonaDiagnostic('warning', 'runtime_unknown_nsfw_policy', '运行计划无法识别 nsfw 策略，已回退 none。', { field: 'nsfw' }))
  }
  return diagnostics
}

function compilePersonaRuntimePlan(options: CompilePersonaRuntimePlanOptions = {}) {
  const personaName = String(options.personaName || '').trim()
  const source = String(options.source || (personaName ? 'explicit' : 'default')).trim() || 'default'
  const type = String(options.type || (personaName ? 'persona' : 'default')).trim() || 'default'
  const content = String(options.personaContent || '')
  const doc = content
    ? parsePersonaDocument(content, { type: type === 'default' ? 'persona' : type, file: options.file || '' })
    : {
        type: 'default',
        file: '',
        schemaVersion: 0,
        hasFrontmatter: false,
        frontmatterText: '',
        meta: {},
        rawMeta: {},
        body: '',
        diagnostics: [],
      } as PersonaDocument
  const meta = doc.meta || {}
  const planName = normalizePersonaRuntimeText(meta.name || personaName || '', 80)
  const loreRefs = parsePersonaStringList(meta.lore_refs)
  const primaryLore = normalizePersonaRuntimeText(meta.lore, 120)
  if (primaryLore && primaryLore !== 'none' && !loreRefs.includes(primaryLore)) loreRefs.unshift(primaryLore)
  const voiceId = normalizePersonaRuntimeText(meta.voice_id || meta.voice || '', 80)
  const voiceAssetId = normalizePersonaRuntimeText(meta.voice_asset_id || '', 120)
  const willFallback = Object.prototype.hasOwnProperty.call(LEGACY_PERSONA_WILL, planName)
    ? LEGACY_PERSONA_WILL[planName]
    : DEFAULT_PERSONA_WILL
  const will = meta.will === undefined || meta.will === ''
    ? willFallback
    : clampPersonaRuntimeNumber(meta.will, willFallback, 0.1, 2.0)
  const diagnostics = buildPersonaRuntimeDiagnostics(doc, { personaName })

  return {
    version: PERSONA_RUNTIME_PLAN_VERSION,
    source,
    type,
    name: planName || null,
    displayName: planName || DEFAULT_PERSONA_RUNTIME_NAME,
    schemaVersion: Number(doc.schemaVersion) || 0,
    hasFrontmatter: !!doc.hasFrontmatter,
    prompt: {
      body: String(doc.body || '').trim(),
      hasBody: !!String(doc.body || '').trim(),
      budget: clampPersonaRuntimeNumber(meta.prompt_budget, 0, 0, 200000),
      styleFingerprint: normalizePersonaRuntimeText(meta.style_fingerprint || '', 240),
      memoryPolicy: normalizePersonaRuntimeText(meta.memory_policy || '', 120),
    },
    lore: {
      primary: primaryLore,
      refs: loreRefs,
    },
    random: {
      will,
    },
    voice: {
      id: voiceId || DEFAULT_PERSONA_RUNTIME_VOICE,
      rawId: voiceId,
      assetId: voiceAssetId,
      style: normalizePersonaRuntimeText(meta.voice_style || NEUTRAL_PERSONA_RUNTIME_VOICE_STYLE, 240),
    },
    safety: {
      nsfw: normalizePersonaRuntimeNsfw(meta.nsfw),
      hostileCapable: meta.hostile_capable === true,
    },
    diagnostics,
  }
}

function resolvePersonaRuntimePlan(options: ResolvePersonaRuntimePlanOptions = {}) {
  const resolved = options.resolution || resolvePersona(options.channelKey || '', options.userId || '')
  const personaName = String(options.personaName ?? resolved.name ?? '').trim()
  const personaContent = personaName ? (options.personaContent ?? loadPersonalSkill(personaName) ?? '') : ''
  return compilePersonaRuntimePlan({
    personaName,
    personaContent,
    source: options.source || resolved.source || 'default',
    type: options.type || (personaName ? 'persona' : 'default'),
    file: options.file || '',
  })
}

function getPersonaRuntimePlanLegacySnapshot(plan: PersonaRuntimePlan = {}) {
  return {
    personaName: plan.name || null,
    lore: plan.lore?.primary || '',
    loreRefs: Array.isArray(plan.lore?.refs) ? plan.lore.refs.slice() : [],
    will: plan.random?.will ?? DEFAULT_PERSONA_WILL,
    nsfw: plan.safety?.nsfw || 'none',
    voiceId: plan.voice?.rawId || '',
    voiceAssetId: plan.voice?.assetId || '',
    voiceStyle: plan.voice?.style || NEUTRAL_PERSONA_RUNTIME_VOICE_STYLE,
    promptBody: plan.prompt?.body || '',
  }
}

export = {
  PERSONA_RUNTIME_PLAN_VERSION,
  DEFAULT_PERSONA_RUNTIME_NAME,
  DEFAULT_PERSONA_RUNTIME_VOICE,
  NEUTRAL_PERSONA_RUNTIME_VOICE_STYLE,
  DEFAULT_PERSONA_WILL,
  LEGACY_PERSONA_WILL,
  normalizePersonaRuntimeText,
  normalizePersonaRuntimeNsfw,
  compilePersonaRuntimePlan,
  resolvePersonaRuntimePlan,
  getPersonaRuntimePlanLegacySnapshot,
}
