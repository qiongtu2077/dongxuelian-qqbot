/**
 * MODULE: 人格 schema 解析与校验。
 * 职责: 统一解析 persona/core/mode/lore 文档 frontmatter，输出只读诊断。
 * 边界: 不读写文件、不调用模型、不改变线上人格行为。
 * 状态: 无。
 */

const PERSONA_SCHEMA_VERSION = 1
const PERSONA_SCHEMA_WILL_MIN = 0.1
const PERSONA_SCHEMA_WILL_MAX = 2.0
const PERSONA_SCHEMA_KNOWN_FIELDS = Object.freeze([
  'schema',
  'name',
  'type',
  'description',
  'lore',
  'lore_refs',
  'will',
  'nsfw',
  'voice',
  'voice_id',
  'voice_asset_id',
  'voice_style',
  'hostile_capable',
  'examples',
  'prompt_budget',
  'style_fingerprint',
  'memory_policy',
  'keywords',
  'scope',
  'summary',
  'max_chars',
  'maxChars',
  'priority',
])
const PERSONA_SCHEMA_ALLOWED_TYPES = Object.freeze(['core', 'mode', 'persona', 'lore'])
const PERSONA_SCHEMA_FIELD_SET = new Set(PERSONA_SCHEMA_KNOWN_FIELDS)
const PERSONA_SCHEMA_NSFW_VALUES = new Set(['none', 'off', 'soft', 'adult', 'strict', 'reply'])
const { parseFrontmatterDocument } = require('../core/frontmatter') as typeof import('../core/frontmatter')

interface PersonaMeta {
  schema?: unknown
  name?: unknown
  will?: unknown
  nsfw?: unknown
  hostile_capable?: unknown
  voice_asset_id?: unknown
  voice_id?: unknown
  voice?: unknown
  [key: string]: unknown
}

interface PersonaSchemaContext {
  type?: string
  hasFrontmatter?: boolean
  file?: string
}

interface PersonaFrontmatterDocument {
  meta: PersonaMeta
  rawMeta: Record<string, string>
  body: string
  hasFrontmatter: boolean
  frontmatterText: string
  blocks: string[]
}

type PersonaDiagnosticLevel = 'error' | 'warning' | 'info'

interface PersonaDiagnostic {
  level: PersonaDiagnosticLevel
  code: string
  message: string
  [key: string]: unknown
}

function normalizePersonaSchemaScalar(value: unknown = ''): string | boolean | null {
  const text = String(value ?? '').trim()
  if (!text) return ''
  if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) {
    return text.slice(1, -1)
  }
  if (/^(true|false)$/i.test(text)) return /^true$/i.test(text)
  if (/^null$/i.test(text)) return null
  return text
}

function parsePersonaSchemaFrontmatter(content: string = ''): PersonaFrontmatterDocument {
  return parseFrontmatterDocument(content, { normalizeValue: normalizePersonaSchemaScalar, firstWins: false } as unknown as { normalizeValue: (value: string) => string; firstWins: boolean }) as unknown as PersonaFrontmatterDocument
}

function stripPersonaFrontmatter(content: string = ''): string {
  return parsePersonaSchemaFrontmatter(content).body
}

function createPersonaDiagnostic(level: PersonaDiagnosticLevel, code: string, message: string, details: Record<string, unknown> = {}): PersonaDiagnostic {
  return { level, code, message, ...details }
}

function parsePersonaNumber(value: unknown): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : NaN
  const parsed = Number(String(value ?? '').trim())
  return Number.isFinite(parsed) ? parsed : NaN
}

function parsePersonaStringList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(item => String(item || '').trim()).filter(Boolean)
  return String(value ?? '')
    .split(/[,，;；]/)
    .map(item => item.trim())
    .filter(Boolean)
}

function getPersonaSchemaKnownFields(): string[] {
  return PERSONA_SCHEMA_KNOWN_FIELDS.slice()
}

function validatePersonaMeta(meta: PersonaMeta = {}, context: PersonaSchemaContext = {}): PersonaDiagnostic[] {
  const diagnostics: PersonaDiagnostic[] = []
  const contextType = String(context.type || '')
  const type = PERSONA_SCHEMA_ALLOWED_TYPES.includes(contextType) ? contextType : 'persona'
  const keys = Object.keys(meta || {})
  if (!context.hasFrontmatter) {
    diagnostics.push(createPersonaDiagnostic('warning', 'missing_frontmatter', '文档缺少 frontmatter，后续只能按文件名和正文兼容扫描。'))
  }
  if (!meta.schema) {
    diagnostics.push(createPersonaDiagnostic('info', 'legacy_schema_missing', '未声明 schema，按 v0 人格文档兼容处理。', { field: 'schema' }))
  } else {
    const schemaText = String(meta.schema).trim().replace(/^v/i, '')
    const schemaVersion = parseInt(schemaText, 10)
    if (schemaVersion !== PERSONA_SCHEMA_VERSION) {
      diagnostics.push(createPersonaDiagnostic('warning', 'unsupported_schema_version', `schema 版本不是 ${PERSONA_SCHEMA_VERSION}，将按兼容模式扫描。`, { field: 'schema' }))
    }
  }
  for (const key of keys) {
    if (!PERSONA_SCHEMA_FIELD_SET.has(key)) {
      diagnostics.push(createPersonaDiagnostic('warning', 'unknown_frontmatter_field', `未知 frontmatter 字段：${key}。`, { field: key }))
    }
  }
  if (!meta.name && type !== 'lore') {
    diagnostics.push(createPersonaDiagnostic('error', 'missing_name', '人格/core/mode 文档必须声明 name。', { field: 'name' }))
  }
  if (meta.will !== undefined && meta.will !== '') {
    const will = parsePersonaNumber(meta.will)
    if (!Number.isFinite(will)) {
      diagnostics.push(createPersonaDiagnostic('warning', 'invalid_will', 'will 不是有效数字，将无法安全接入主动回复意愿。', { field: 'will' }))
    } else if (will < PERSONA_SCHEMA_WILL_MIN || will > PERSONA_SCHEMA_WILL_MAX) {
      diagnostics.push(createPersonaDiagnostic('warning', 'will_out_of_range', `will 超出建议范围 ${PERSONA_SCHEMA_WILL_MIN}-${PERSONA_SCHEMA_WILL_MAX}。`, { field: 'will' }))
    }
  }
  if (meta.nsfw !== undefined && meta.nsfw !== '') {
    const nsfw = String(meta.nsfw).trim().toLowerCase()
    if (!PERSONA_SCHEMA_NSFW_VALUES.has(nsfw)) {
      diagnostics.push(createPersonaDiagnostic('warning', 'unknown_nsfw_policy', 'nsfw 字段不是已知策略值。', { field: 'nsfw' }))
    }
  }
  if (meta.hostile_capable !== undefined && typeof meta.hostile_capable !== 'boolean') {
    diagnostics.push(createPersonaDiagnostic('warning', 'invalid_hostile_capable', 'hostile_capable 应为 true/false。', { field: 'hostile_capable' }))
  }
  if (meta.voice_asset_id && meta.voice_id !== '__cloned__' && meta.voice !== '__cloned__') {
    diagnostics.push(createPersonaDiagnostic('warning', 'voice_asset_without_clone_voice', '声明了 voice_asset_id，但 voice_id/voice 不是 __cloned__。', { field: 'voice_asset_id' }))
  }
  return diagnostics
}

function parsePersonaDocument(content: string = '', context: PersonaSchemaContext = {}) {
  const parsed = parsePersonaSchemaFrontmatter(content)
  const schemaText = parsed.meta.schema ? String(parsed.meta.schema).trim().replace(/^v/i, '') : ''
  const schemaVersion = schemaText ? parseInt(schemaText, 10) : 0
  const contextType = String(context.type || '')
  const diagnostics = validatePersonaMeta(parsed.meta, {
    type: contextType,
    hasFrontmatter: parsed.hasFrontmatter,
  })
  return {
    type: PERSONA_SCHEMA_ALLOWED_TYPES.includes(contextType) ? contextType : 'persona',
    file: context.file || '',
    schemaVersion: Number.isFinite(schemaVersion) ? schemaVersion : 0,
    hasFrontmatter: parsed.hasFrontmatter,
    frontmatterText: parsed.frontmatterText,
    meta: parsed.meta,
    rawMeta: parsed.rawMeta,
    body: parsed.body,
    diagnostics,
    warnings: diagnostics,
  }
}

export = {
  PERSONA_SCHEMA_VERSION,
  PERSONA_SCHEMA_KNOWN_FIELDS,
  PERSONA_SCHEMA_ALLOWED_TYPES,
  PERSONA_SCHEMA_WILL_MIN,
  PERSONA_SCHEMA_WILL_MAX,
  normalizePersonaSchemaScalar,
  parsePersonaSchemaFrontmatter,
  stripPersonaFrontmatter,
  createPersonaDiagnostic,
  parsePersonaNumber,
  parsePersonaStringList,
  getPersonaSchemaKnownFields,
  validatePersonaMeta,
  parsePersonaDocument,
}
