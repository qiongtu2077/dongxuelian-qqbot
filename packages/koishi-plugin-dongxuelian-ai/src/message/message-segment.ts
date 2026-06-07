/* ==========================================================================
 * MODULE: message-segment
 * 职责：从 Koishi/Satori/CQ 消息结构中提取图片与文件 segment 元数据。
 * 边界：不注册 middleware、不读写文件、不写 conversation；只做入站消息片段解析与属性归一。
 * 状态：无模块状态。
 * ========================================================================== */
const {
  normalizeUrl,
  extractImageUrls,
} = require('../core/utils') as typeof import('../core/utils')

interface SegmentSession {
  content?: unknown
  event?: {
    message?: unknown[] | { elements?: unknown[] }
  }
  elements?: unknown[]
}

interface SegmentRef {
  type?: unknown
  attributes?: unknown
  attrs?: unknown
  data?: unknown
}

interface ImageRef {
  url: string
  file: string
  [key: string]: unknown
}

interface FileRef {
  name: string
  file: string
  url: string
  size: number
  mime: string
  fileName?: unknown
  filename?: unknown
  id?: unknown
  fileId?: unknown
  file_id?: unknown
  mimeType?: unknown
  [key: string]: unknown
}

interface VoiceRef {
  url: string
  file: string
  [key: string]: unknown
}

function isMessageSegmentRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object'
}

function decodeEntityAttribute(value: unknown = ''): string {
  return String(value || '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
}

function extractAttrValue(tag: unknown = '', name: string = ''): string {
  const pattern = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i')
  const match = String(tag || '').match(pattern)
  return match ? decodeEntityAttribute(match[1] || match[2] || match[3] || '') : ''
}

function extractCqAttrValue(body: unknown = '', name: string = ''): string {
  const pattern = new RegExp(`(?:^|,)${name}\\s*=\\s*([^,\\]]*)`, 'i')
  const match = String(body || '').match(pattern)
  return match ? decodeEntityAttribute(match[1] || '') : ''
}

function extractImageRefFromContent(content: unknown = ''): ImageRef {
  const value = String(content || '')
  const cq = value.match(/\[CQ:(?:image|img),([^\]]+)\]/i)
  if (cq) {
    const body = cq[1] || ''
    const url = extractCqAttrValue(body, 'url')
    const file = extractCqAttrValue(body, 'file')
    if (url || file) return { url, file }
  }
  const tag = value.match(/<(?:img|image)\b[^>]*>/i)
  if (tag) {
    const raw = tag[0]
    const src = extractAttrValue(raw, 'src') || extractAttrValue(raw, 'url')
    const file = extractAttrValue(raw, 'file')
    if (/^https?:\/\//i.test(src)) return { url: src, file }
    if (/^file:\/\//i.test(src)) return { url: '', file: src }
    if (src) return { url: '', file: src }
    if (file) return { url: '', file }
  }
  const urls = extractImageUrls(value)
  if (urls[0]) return { url: urls[0], file: '' }
  return { url: '', file: '' }
}

function appendUniqueSegments(target: unknown[], segments: unknown): void {
  if (!Array.isArray(segments)) return
  for (const segment of segments) {
    if (segment && !target.includes(segment)) target.push(segment)
  }
}

function getMessageSegments(session: SegmentSession = {}): unknown[] {
  const segments: unknown[] = []
  const message = session.event?.message
  appendUniqueSegments(segments, Array.isArray(message) ? message : null)
  appendUniqueSegments(segments, isMessageSegmentRecord(message) && Array.isArray(message.elements) ? message.elements : null)
  appendUniqueSegments(segments, Array.isArray(session.elements) ? session.elements : null)
  return segments
}

function normalizeSegmentData(segment: unknown = {}): Record<string, unknown> {
  const value = isMessageSegmentRecord(segment) ? segment as SegmentRef : {}
  return Object.assign(
    {},
    isMessageSegmentRecord(value.attributes) ? value.attributes : {},
    isMessageSegmentRecord(value.attrs) ? value.attrs : {},
    isMessageSegmentRecord(value.data) ? value.data : {},
  )
}

function extractFileRefFromContent(content: unknown = ''): FileRef | null {
  const value = String(content || '')
  const cq = value.match(/\[CQ:file,([^\]]+)\]/i)
  if (cq) {
    const body = cq[1] || ''
    return {
      name: extractCqAttrValue(body, 'name') || extractCqAttrValue(body, 'file') || 'unknown',
      file: extractCqAttrValue(body, 'file') || extractCqAttrValue(body, 'id') || extractCqAttrValue(body, 'file_id'),
      url: normalizeUrl(extractCqAttrValue(body, 'url')),
      size: Number(extractCqAttrValue(body, 'size')) || 0,
      mime: extractCqAttrValue(body, 'mime') || extractCqAttrValue(body, 'mimeType'),
    }
  }
  const tag = value.match(/<file\b[^>]*>/i)
  if (!tag) return null
  const raw = tag[0]
  const src = extractAttrValue(raw, 'src') || extractAttrValue(raw, 'url')
  const file = extractAttrValue(raw, 'file') || extractAttrValue(raw, 'id') || extractAttrValue(raw, 'fileId') || src
  return {
    name: extractAttrValue(raw, 'name') || extractAttrValue(raw, 'filename') || extractAttrValue(raw, 'fileName') || file || 'unknown',
    file,
    url: normalizeUrl(src),
    size: Number(extractAttrValue(raw, 'size')) || 0,
    mime: extractAttrValue(raw, 'mime') || extractAttrValue(raw, 'mimeType'),
  }
}

function getFileSegmentData(session: SegmentSession = {}): Record<string, unknown> | FileRef | null {
  const segments = getMessageSegments(session)
  const fileSeg = segments.find(s => String(isMessageSegmentRecord(s) ? s.type || '' : '') === 'file')
  if (fileSeg) return normalizeSegmentData(fileSeg)
  return extractFileRefFromContent(session.content || '') || null
}

function extractVoiceRefFromContent(content: unknown = ''): VoiceRef | null {
  const value = String(content || '')
  const cq = value.match(/\[CQ:record,([^\]]+)\]/i)
  if (cq) {
    const body = cq[1] || ''
    return {
      url: normalizeUrl(extractCqAttrValue(body, 'url')),
      file: extractCqAttrValue(body, 'file') || extractCqAttrValue(body, 'id'),
    }
  }
  const tag = value.match(/<(?:audio|record)\b[^>]*>/i)
  if (!tag) return null
  const raw = tag[0]
  const src = extractAttrValue(raw, 'src') || extractAttrValue(raw, 'url')
  return {
    url: normalizeUrl(src),
    file: extractAttrValue(raw, 'file') || extractAttrValue(raw, 'id') || src,
  }
}

function getVoiceSegmentData(session: SegmentSession = {}): Record<string, unknown> | VoiceRef | null {
  const segments = getMessageSegments(session)
  const voiceSeg = segments.find(s => {
    const type = String(isMessageSegmentRecord(s) ? s.type || '' : '')
    return type === 'record' || type === 'audio'
  })
  if (voiceSeg) return normalizeSegmentData(voiceSeg)
  return extractVoiceRefFromContent(session.content || '') || null
}

export = {
  decodeEntityAttribute,
  extractAttrValue,
  extractCqAttrValue,
  extractImageRefFromContent,
  appendUniqueSegments,
  getMessageSegments,
  normalizeSegmentData,
  extractFileRefFromContent,
  getFileSegmentData,
  extractVoiceRefFromContent,
  getVoiceSegmentData,
}
