/**
 * MODULE: 本轮关联图片清单。
 * 职责: 从真实消息段收集普通图片和图片附件，保留来源顺序、逐图身份与别名。
 * 边界: 纯解析，不访问网络、不读任意路径、不截断历史数量。
 */
const { createHash } = require('crypto') as typeof import('crypto')
const { normalizeSegmentData, extractAttrValue, extractCqAttrValue } = require('../../message/message-segment') as typeof import('../../message/message-segment')
const { isImageFileCandidate } = require('../file/file-safety') as typeof import('../file/file-safety')

type ImageGroup = 'quoted' | 'current'
interface ImageAlias { group: ImageGroup; ordinal: number; originalMessageId: string; mediaIndex: number }
interface ImageTarget {
  id: string
  channelKey: string
  conversationKey: string
  originalMessageId: string
  mediaIndex: number
  sourceKind: 'image' | 'attachment'
  platformId: string
  url: string
  file: string | null
  fileName: string
  declaredSize: number | null
  declaredMime: string
  timestamp?: number
  aliases: ImageAlias[]
}
interface ImageMessageView {
  messageId?: unknown
  content?: unknown
  timestamp?: number
  elements?: unknown[]
  message?: unknown[]
  event?: { message?: unknown[] | { elements?: unknown[] } }
}

// --- 协议解析 --- //

// 只解析实际媒体消息段，普通文字中的文件名和链接不会创建图片。
function parseImageMediaSegments(view: ImageMessageView): Array<{ type: string; data: Record<string, unknown> }> {
  const raw = view.event?.message
  const segments = Array.isArray(raw) ? raw : raw?.elements || view.elements || view.message
  if (segments?.length) return segments.filter((segment): segment is { type: string } => !!segment && typeof segment === 'object' && 'type' in segment)
    .map(segment => ({ type: String(segment.type), data: normalizeSegmentData(segment) }))
  const result: Array<{ type: string; data: Record<string, unknown> }> = []
  for (const match of String(view.content || '').matchAll(/\[CQ:(image|img|file),([^\]]*)\]|<(image|img|file)\b[^>]*>/gi)) {
    const type = String(match[1] || match[3]).toLowerCase()
    // CQ 与 Koishi 序列化内容有各自已核实的属性规则，不能把两种视图叠加。
    const attr = (name: string): string => match[1] ? extractCqAttrValue(match[2], name) : extractAttrValue(match[0], name)
    result.push({ type, data: {
      url: attr('url') || attr('src'), file: attr('file') || attr('file_id') || attr('fileId') || attr('id'),
      name: attr('name') || attr('filename') || attr('fileName'), size: attr('size') || attr('fileSize') || attr('file_size'), mime: attr('mime') || attr('mimeType'),
    } })
  }
  return result
}

// 给原消息中的每个媒体位置生成独立身份；签名 URL 不参与平台资源身份。
function collectMessageImageTargets(view: ImageMessageView, context: { channelKey: string; conversationKey: string; group: ImageGroup }): ImageTarget[] {
  const originalMessageId = String(view.messageId || '')
  if (!originalMessageId || !context.channelKey) return []
  const targets: ImageTarget[] = []
  parseImageMediaSegments(view).forEach((segment, mediaIndex) => {
    const data = segment.data
    const sourceKind = ['image', 'img'].includes(segment.type) ? 'image' : segment.type === 'file' ? 'attachment' : null
    if (!sourceKind) return
    const fileName = String(data.name || data.fileName || data.filename || '')
    const declaredMime = String(data.mime || data.mimeType || '')
    const rawFile = String(data.file || data.id || data.fileId || data.file_id || '')
    const url = String(data.url || data.src || (/^https?:\/\//i.test(rawFile) ? rawFile : ''))
    if (sourceKind === 'attachment' && !isImageFileCandidate(fileName, declaredMime, url)) return
    const platformId = /^https?:\/\//i.test(rawFile) ? '' : rawFile
    // 线上实包已核实：Koishi img 使用 fileSize，OneBot image 使用 file_size，单位均为字节。
    const declared = data.size ?? data.fileSize ?? data.file_size
    const size = Number(declared)
    const id = 'im2-' + createHash('sha256').update(JSON.stringify([context.channelKey, originalMessageId, mediaIndex, sourceKind, platformId])).digest('hex')
    targets.push({
      id, channelKey: context.channelKey, conversationKey: context.conversationKey, originalMessageId, mediaIndex, sourceKind,
      platformId, url: /^https?:\/\//i.test(url) ? url : '', file: platformId || (/^file:\/\//i.test(url) ? url : null),
      fileName, declaredSize: declared !== '' && declared != null && Number.isFinite(size) && size >= 0 ? size : null, declaredMime,
      timestamp: typeof view.timestamp === 'number' && view.timestamp > 0 ? view.timestamp : undefined,
      aliases: [{ group: context.group, ordinal: targets.length + 1, originalMessageId, mediaIndex }],
    })
  })
  return targets
}

// --- 本轮清单与去重 --- //

// 引用组在前、当前组在后；只按同频道中已核实的平台媒体编号合并来源。
function collectImageManifest(session: ImageMessageView & { quote?: ImageMessageView }, channelKey: string, conversationKey: string, includeQuote = true): ImageTarget[] {
  const all = [
    ...(includeQuote && session.quote ? collectMessageImageTargets(session.quote, { channelKey, conversationKey, group: 'quoted' }) : []),
    ...collectMessageImageTargets(session, { channelKey, conversationKey, group: 'current' }),
  ]
  const unique = new Map<string, ImageTarget>()
  for (const target of all) {
    const key = target.platformId ? JSON.stringify([channelKey, target.sourceKind, target.platformId]) : target.id
    const existing = unique.get(key)
    if (existing) {
      const aliases = [...existing.aliases, ...target.aliases.filter(alias => !existing.aliases.some(old => old.group === alias.group && old.originalMessageId === alias.originalMessageId && old.mediaIndex === alias.mediaIndex))]
      // 同平台资源优先使用本轮较新的有效来源；新重发不会复活旧消息编号的历史记录。
      if (existing.timestamp && Date.now() - existing.timestamp >= 2 * 60 * 60 * 1000 && (!target.timestamp || Date.now() - target.timestamp < 2 * 60 * 60 * 1000)) unique.set(key, { ...target, aliases })
      else { existing.aliases = aliases; existing.url = target.url || existing.url }
    }
    else unique.set(key, target)
  }
  return [...unique.values()]
}

export = { parseImageMediaSegments, collectMessageImageTargets, collectImageManifest }
