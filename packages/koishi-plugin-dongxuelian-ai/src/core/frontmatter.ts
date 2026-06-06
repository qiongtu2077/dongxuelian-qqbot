/**
 * MODULE: Markdown frontmatter parsing.
 * 职责: 解析文件开头连续的 frontmatter block，兼容 LF/CRLF 与中段 BOM。
 * 边界: 不读写文件，不校验 schema。
 */

interface ParseFrontmatterOptions {
  normalizeValue?: (value: string) => string
  firstWins?: boolean
}

interface ParsedFrontmatterLines {
  meta: Record<string, string>
  rawMeta: Record<string, string>
}

interface ParsedFrontmatterDocument extends ParsedFrontmatterLines {
  body: string
  hasFrontmatter: boolean
  frontmatterText: string
  blocks: string[]
}

function normalizeFrontmatterSource(content: string = ''): string {
  return String(content || '').replace(/\uFEFF/g, '')
}

function parseFrontmatterLines(frontmatterText: string = '', options: ParseFrontmatterOptions = {}): ParsedFrontmatterLines {
  const meta: Record<string, string> = {}
  const rawMeta: Record<string, string> = {}
  const normalizeValue = typeof options.normalizeValue === 'function'
    ? options.normalizeValue
    : (value: string): string => String(value ?? '').trim()
  const firstWins = options.firstWins !== false
  for (const line of String(frontmatterText || '').split(/\r?\n/)) {
    if (!line.trim() || /^\s*#/.test(line)) continue
    const kv = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line)
    if (!kv) continue
    if (firstWins && Object.prototype.hasOwnProperty.call(meta, kv[1])) continue
    rawMeta[kv[1]] = String(kv[2] || '').trim()
    meta[kv[1]] = normalizeValue(kv[2])
  }
  return { meta, rawMeta }
}

function parseFrontmatterDocument(content: string = '', options: ParseFrontmatterOptions = {}): ParsedFrontmatterDocument {
  const source = normalizeFrontmatterSource(content)
  if (!/^---\r?\n/.test(source)) {
    return { meta: {}, rawMeta: {}, body: source, hasFrontmatter: false, frontmatterText: '', blocks: [] }
  }

  const blocks = []
  let cursor = 0
  while (cursor < source.length) {
    if (blocks.length > 0) {
      const whitespace = (/^[ \t\r\n]*/.exec(source.slice(cursor)) || [''])[0]
      const candidate = cursor + whitespace.length
      if (!/^---\r?\n/.test(source.slice(candidate))) break
      cursor = candidate
    }

    const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(source.slice(cursor))
    if (!match) break
    blocks.push(match[1] || '')
    cursor += match[0].length
  }

  if (!blocks.length) {
    return { meta: {}, rawMeta: {}, body: source, hasFrontmatter: false, frontmatterText: '', blocks: [] }
  }

  const frontmatterText = blocks.join('\n---\n')
  const parsed = parseFrontmatterLines(frontmatterText, options)
  return {
    meta: parsed.meta,
    rawMeta: parsed.rawMeta,
    body: source.slice(cursor),
    hasFrontmatter: true,
    frontmatterText,
    blocks,
  }
}

export = {
  normalizeFrontmatterSource,
  parseFrontmatterLines,
  parseFrontmatterDocument,
}
