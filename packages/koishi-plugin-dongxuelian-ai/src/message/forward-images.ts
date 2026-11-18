/**
 * MODULE: 合并转发图片材料。
 * 职责: 复用本轮转发响应，按记录顺序提取最多十张图片及图片附件。
 * 边界: 不下载图片、不调用模型、不读写持久数据。
 * 状态: 每次解析独享响应缓存，结束后随本轮会话释放。
 */
const { parseImageMediaSegments } = require('../media/image/image-manifest') as typeof import('../media/image/image-manifest')
const { isImageFileCandidate } = require('../media/file/file-safety') as typeof import('../media/file/file-safety')

type ForwardGetter = (id: string) => Promise<unknown>
interface ForwardImageMessage { messageId: string; message: Array<{ type: string; data: Record<string, unknown> }> }
const MAX_FORWARD_IMAGES = 10
const MAX_FORWARD_DEPTH = 4

// --- 已核实的 OneBot 节点结构 --- //

// 将 OneBot 对象转换为可读取字段；非对象不构成消息节点。
function forwardImageRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

// 接受统一 API 返回的数组及其 messages 容器。
function forwardImageNodes(value: unknown): unknown[] {
  if (Array.isArray(value)) return value
  const messages = forwardImageRecord(value).messages
  return Array.isArray(messages) ? messages : []
}

// --- 本轮响应与图片来源 --- //

// 缓存本轮已拉取的正文，图片和文字解析共享响应，避免重复下载转发资源。
function createForwardImageReader(getter: ForwardGetter, checkActive: () => void = () => {}) {
  const responses = new Map<string, Promise<unknown>>()
  // 同一资源在文字和图片遍历中只请求一次。
  function getForwardMsg(id: string): Promise<unknown> {
    checkActive()
    let result = responses.get(id)
    if (!result) { result = getter(id); responses.set(id, result) }
    return result
  }

  // 按节点和消息段顺序收集图片，使用资源及路径生成稳定的材料身份。
  async function collectImages(rootId: string): Promise<ForwardImageMessage[]> {
    const images: ForwardImageMessage[] = []
    // 限制嵌套深度并检查当前祖先链，防止循环转发阻塞整轮读取。
    async function visit(nodes: unknown[], resourceId: string, prefix: string, depth: number, ancestors: string[]): Promise<void> {
      checkActive()
      if (depth > MAX_FORWARD_DEPTH || images.length >= MAX_FORWARD_IMAGES) return
      for (const [index, value] of nodes.entries()) {
        checkActive()
        if (images.length >= MAX_FORWARD_IMAGES) break
        const node = forwardImageRecord(value)
        const data = forwardImageRecord(node.data)
        const body = node.type === 'node' ? data.content ?? data.message : node.message
        const location = `${prefix}.${index}`
        const segments = parseImageMediaSegments({ message: Array.isArray(body) ? body : undefined, content: node.raw_message })
        if (!Array.isArray(body) && typeof node.raw_message === 'string') {
          const nested = node.raw_message.match(/\[CQ:forward,id=([^,\]]+)\]/)
          if (nested) segments.push({ type: 'forward', data: { id: nested[1] } })
        }
        for (const [mediaIndex, segment] of segments.entries()) {
          if (images.length >= MAX_FORWARD_IMAGES) break
          const media = segment.data
          const isImage = ['image', 'img'].includes(segment.type) || (segment.type === 'file'
            && isImageFileCandidate(String(media.name || media.fileName || media.filename || ''), String(media.mime || media.mimeType || ''), String(media.url || media.src || '')))
          if (isImage) {
            images.push({ messageId: `forward:${resourceId}:${location}:${mediaIndex}`, message: [segment] })
          } else if (segment.type === 'node') {
            await visit([{ type: 'node', data: media }], resourceId, `${location}.${mediaIndex}`, depth + 1, ancestors)
          } else if (segment.type === 'forward') {
            if (Array.isArray(media.content)) await visit(media.content, resourceId, `${location}.${mediaIndex}`, depth + 1, ancestors)
            else {
              const nestedId = String(media.id || media['forward-id'] || media.res_id || '')
              if (nestedId && !ancestors.includes(nestedId) && depth < MAX_FORWARD_DEPTH) {
                await visit(forwardImageNodes(await getForwardMsg(nestedId)), nestedId, `${location}.${mediaIndex}`, depth + 1, [...ancestors, nestedId])
              }
            }
          }
        }
      }
    }
    await visit(forwardImageNodes(await getForwardMsg(rootId)), rootId, 'root', 0, [rootId])
    return images
  }
  return { getForwardMsg, collectImages }
}

export = { createForwardImageReader }
