/* ==========================================================================
 * MODULE: message-segment
 * 职责：从 Koishi/Satori/CQ 消息结构中提取图片与文件 segment 元数据。
 * 边界：不注册 middleware、不读写文件、不写 conversation；只做入站消息片段解析与属性归一。
 * 状态：无模块状态。
 * ========================================================================== */
const {
  normalizeUrl,
  extractImageUrls,
} = require('../core/utils')

function decodeEntityAttribute(value = '') {
  return String(value || '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
}

function extractAttrValue(tag = '', name = '') {
  const pattern = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i')
  const match = String(tag || '').match(pattern)
  return match ? decodeEntityAttribute(match[1] || match[2] || match[3] || '') : ''
}

function extractCqAttrValue(body = '', name = '') {
  const pattern = new RegExp(`(?:^|,)${name}\\s*=\\s*([^,\\]]*)`, 'i')
  const match = String(body || '').match(pattern)
  return match ? decodeEntityAttribute(match[1] || '') : ''
}

function extractImageRefFromContent(content = '') {
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

function appendUniqueSegments(target, segments) {
  if (!Array.isArray(segments)) return
  for (const segment of segments) {
    if (segment && !target.includes(segment)) target.push(segment)
  }
}

function getMessageSegments(session = {}) {
  const segments = []
  appendUniqueSegments(segments, Array.isArray(session.event?.message) ? session.event.message : null)
  appendUniqueSegments(segments, Array.isArray(session.event?.message?.elements) ? session.event.message.elements : null)
  appendUniqueSegments(segments, Array.isArray(session.elements) ? session.elements : null)
  return segments
}

function normalizeSegmentData(segment = {}) {
  return Object.assign({}, segment.attributes || {}, segment.attrs || {}, segment.data || {})
}

function extractFileRefFromContent(content = '') {
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

function getFileSegmentData(session = {}) {
  const segments = getMessageSegments(session)
  const fileSeg = segments.find(s => String(s?.type || '') === 'file')
  if (fileSeg) return normalizeSegmentData(fileSeg)
  return extractFileRefFromContent(session.content || '') || null
}

module.exports = {
  decodeEntityAttribute,
  extractAttrValue,
  extractCqAttrValue,
  extractImageRefFromContent,
  appendUniqueSegments,
  getMessageSegments,
  normalizeSegmentData,
  extractFileRefFromContent,
  getFileSegmentData,
}
