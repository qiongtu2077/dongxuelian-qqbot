/**
 * MODULE: 人格世界观路由器。
 * 职责: 根据 PersonaRuntimePlan/人格 lore 绑定、用户文本、lore frontmatter 和预算决定本轮注入哪些世界观片段。
 * 边界: 纯函数；不读写文件、不调用模型、不发送消息、不修改传入对象。
 * 状态: 无。
 */
const { LORE_TRIGGER_SET, TERRA_LORE_TRIGGER_SET } = require('../core/constants') as typeof import('../core/constants')
const { truncateText } = require('../core/utils') as typeof import('../core/utils')
const { parsePersonaNumber, parsePersonaStringList } = require('./persona-schema') as typeof import('./persona-schema')

const DEFAULT_LORE_MAX_CHARS = 1800
const DEFAULT_TOTAL_LORE_BUDGET = 2400
const LORE_BUDGET_MIN = 200
const LORE_BUDGET_MAX = 12000
const LORE_SCOPE_VALUES = new Set(['keyword', 'always', 'none'])

interface LorePlan {
  lore?: {
    primary?: unknown
    refs?: unknown[]
  }
}

interface SkillsContentCache {
  [key: string]: unknown
}

interface LoreEntry {
  id?: string
  label?: string
  description?: string
  scope?: string
  keywords?: string[]
  usesLegacyKeywords?: boolean
  summary?: string
  maxChars?: number
  priority?: number
  content?: string
  meta?: Record<string, unknown>
  order?: number
}

interface LoreSelection {
  text: string
  truncated: boolean
  source?: string
}

interface RoutePersonaLoreOptions {
  cleanInput?: string
  userText?: string
  skillsContentCache?: SkillsContentCache
  personaLore?: string
  plan?: LorePlan | null
  totalBudget?: unknown
  promptBudget?: { lore?: unknown }
}

function normalizeLoreText(value: unknown = '', maxLength: number = 240): string {
  return String(value || '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength)
}

function normalizeLoreId(value: unknown = ''): string {
  return String(value || '').trim()
}

function normalizeLoreScope(value: unknown = ''): string {
  const text = String(value || '').trim().toLowerCase()
  if (text === 'off' || text === 'disabled' || text === 'disable') return 'none'
  if (text === 'all' || text === 'global' || text === 'always') return 'always'
  if (!text) return 'keyword'
  return LORE_SCOPE_VALUES.has(text) ? text : 'keyword'
}

function clampLoreNumber(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof value === 'number' ? value : parsePersonaNumber(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(min, Math.min(max, parsed))
}

function normalizeLoreMaxChars(value: unknown, fallback: number = DEFAULT_LORE_MAX_CHARS): number {
  return clampLoreNumber(value, fallback, LORE_BUDGET_MIN, LORE_BUDGET_MAX)
}

function normalizeLorePriority(value: unknown): number {
  return clampLoreNumber(value, 0, -100, 100)
}

function normalizeLoreKeywords(value: unknown): string[] {
  const seen = new Set()
  const result: string[] = []
  for (const item of parsePersonaStringList(value)) {
    const keyword = normalizeLoreText(item, 80)
    if (!keyword || seen.has(keyword)) continue
    seen.add(keyword)
    result.push(keyword)
  }
  return result
}

function getLegacyLoreKeywords(loreId: string): string[] {
  if (loreId === 'terra-lore') return Array.from(TERRA_LORE_TRIGGER_SET)
  if (loreId === 'wuwa-lore') return Array.from(LORE_TRIGGER_SET)
  return []
}

function getLoreCacheValue(skillsContentCache: SkillsContentCache = {}, prefix: string, loreId: unknown): unknown {
  const id = normalizeLoreId(loreId)
  if (!id) return ''
  return skillsContentCache[prefix + id]
}

function normalizeLoreEntry(loreId: unknown, skillsContentCache: SkillsContentCache = {}): LoreEntry {
  const id = normalizeLoreId(loreId)
  const content = String(getLoreCacheValue(skillsContentCache, 'lore:', id) || '')
  const meta = (getLoreCacheValue(skillsContentCache, 'loreMeta:', id) || {}) as Record<string, unknown>
  const keywords = normalizeLoreKeywords(meta.keywords)
  const legacyKeywords = keywords.length ? [] : getLegacyLoreKeywords(id)
  const scope = normalizeLoreScope(meta.scope)
  return {
    id,
    label: id === 'terra-lore' ? '泰拉世界观设定' : '世界观设定',
    description: normalizeLoreText(meta.description || '', 240),
    scope,
    keywords: keywords.length ? keywords : legacyKeywords,
    usesLegacyKeywords: keywords.length === 0 && legacyKeywords.length > 0,
    summary: normalizeLoreText(meta.summary || '', 1200),
    maxChars: normalizeLoreMaxChars(meta.max_chars ?? meta.maxChars, DEFAULT_LORE_MAX_CHARS),
    priority: normalizeLorePriority(meta.priority),
    content,
    meta: { ...meta },
  }
}
function resolvePersonaLoreIds({ personaLore = '', plan = null }: { personaLore?: string; plan?: LorePlan | null } = {}): string[] {
  const ids: string[] = []
  function add(value: unknown): void {
    const id = normalizeLoreId(value)
    if (!id || id === 'none' || ids.includes(id)) return
    ids.push(id)
  }
  add(personaLore)
  if (plan && plan.lore) {
    add(plan.lore.primary)
    if (Array.isArray(plan.lore.refs)) {
      for (const id of plan.lore.refs) add(id)
    }
  }
  return ids
}

function findMatchedLoreKeywords(userText: string = '', keywords: string[] = []): string[] {
  const text = String(userText || '')
  return keywords.filter(keyword => keyword && text.includes(keyword))
}

function splitLoreChunks(content: string = ''): string[] {
  return String(content || '')
    .replace(/\r\n/g, '\n')
    .split(/\n{2,}/)
    .map(chunk => chunk.trim())
    .filter(Boolean)
}

function truncateLoreText(text: string = '', maxChars: unknown = DEFAULT_LORE_MAX_CHARS): { text: string; truncated: boolean } {
  const limit = normalizeLoreMaxChars(maxChars)
  const source = String(text || '').trim()
  if (source.length <= limit) return { text: source, truncated: false }
  const suffix = '\n...[已按世界观预算截断]'
  return {
    text: truncateText(source, Math.max(0, limit - suffix.length)).trimEnd() + suffix,
    truncated: true,
  }
}

function selectLoreText(entry: LoreEntry = {}, matchedKeywords: string[] = []): LoreSelection {
  const content = String(entry.content || '').trim()
  if (!content) return { text: '', truncated: false, source: 'empty' }
  const maxChars = normalizeLoreMaxChars(entry.maxChars)
  if (content.length <= maxChars) return { text: content, truncated: false, source: 'full' }

  const chunks = splitLoreChunks(content)
  const selected: string[] = []
  if (matchedKeywords.length > 0) {
    for (let index = 0; index < chunks.length; index += 1) {
      const chunk = chunks[index]
      if (!matchedKeywords.some(keyword => chunk.includes(keyword))) continue
      if (index > 0 && /^#{1,6}\s+/.test(chunks[index - 1]) && !selected.includes(chunks[index - 1])) {
        selected.push(chunks[index - 1])
      }
      selected.push(chunk)
    }
  }

  const fallbackChunks = selected.length ? selected : chunks
  const parts = []
  if (entry.summary) parts.push('摘要：' + entry.summary)
  for (const chunk of fallbackChunks) {
    const next = parts.concat(chunk).join('\n\n')
    if (next.length > maxChars && parts.length > 0) break
    parts.push(chunk)
    if (parts.join('\n\n').length >= maxChars) break
  }
  const compacted = parts.join('\n\n') || content
  const truncated = truncateLoreText(compacted, maxChars)
  return {
    ...truncated,
    source: selected.length ? 'matched_chunks' : 'leading_chunks',
  }
}
function routePersonaLore(options: RoutePersonaLoreOptions = {}) {
  const cleanInput = String(options.cleanInput || options.userText || '')
  const skillsContentCache = options.skillsContentCache || {}
  const ids = resolvePersonaLoreIds({ personaLore: options.personaLore, plan: options.plan })
  const totalBudget = normalizeLoreMaxChars(options.totalBudget ?? options.promptBudget?.lore, DEFAULT_TOTAL_LORE_BUDGET)
  const included: Array<Record<string, unknown>> = []
  const omitted: Array<Record<string, unknown>> = []
  let remaining = totalBudget

  const entries = ids.map((id, index) => ({ ...normalizeLoreEntry(id, skillsContentCache), order: index }))
    .sort((a, b) => ((b.priority || 0) - (a.priority || 0)) || ((a.order || 0) - (b.order || 0)))

  for (const entry of entries) {
    if (!entry.id) continue
    if (!entry.content) {
      omitted.push({ id: entry.id, reason: 'missing_content' })
      continue
    }
    if (entry.scope === 'none') {
      omitted.push({ id: entry.id, reason: 'disabled' })
      continue
    }
    const matchedKeywords = findMatchedLoreKeywords(cleanInput, entry.keywords)
    if (entry.scope !== 'always' && matchedKeywords.length === 0) {
      omitted.push({
        id: entry.id,
        reason: entry.keywords.length ? 'keyword_not_matched' : 'no_keywords',
        keywords: entry.keywords.slice(0, 12),
      })
      continue
    }
    if (remaining < LORE_BUDGET_MIN) {
      omitted.push({ id: entry.id, reason: 'budget_exhausted' })
      continue
    }
    const maxChars = Math.min(entry.maxChars || DEFAULT_LORE_MAX_CHARS, remaining)
    const selected = selectLoreText({ ...entry, maxChars }, matchedKeywords)
    if (!selected.text) {
      omitted.push({ id: entry.id, reason: 'empty_selected_text' })
      continue
    }
    included.push({
      id: entry.id,
      label: entry.label,
      text: selected.text,
      matchedKeywords,
      scope: entry.scope,
      priority: entry.priority,
      chars: selected.text.length,
      maxChars,
      truncated: selected.truncated,
      selection: selected.source,
      usesLegacyKeywords: entry.usesLegacyKeywords,
    })
    remaining -= selected.text.length
  }

  return {
    ok: included.length > 0,
    included,
    omitted,
    totalBudget,
    usedChars: included.reduce((sum, item) => sum + Number(item.chars || 0), 0),
    remainingChars: Math.max(0, remaining),
  }
}

export = {
  DEFAULT_LORE_MAX_CHARS,
  DEFAULT_TOTAL_LORE_BUDGET,
  normalizeLoreText,
  normalizeLoreId,
  normalizeLoreScope,
  normalizeLoreMaxChars,
  normalizeLorePriority,
  normalizeLoreKeywords,
  getLegacyLoreKeywords,
  normalizeLoreEntry,
  resolvePersonaLoreIds,
  findMatchedLoreKeywords,
  splitLoreChunks,
  truncateLoreText,
  selectLoreText,
  routePersonaLore,
}
