/**
 * MODULE: 图片聊天轮次准备。
 * 职责: 将获准的图片会话绑定到持久识图所有权及原图片身份。
 * 边界: 不调用模型、不发送消息、不保存聊天历史。
 * 状态: 所有权由 image-request 统一管理，无本地缓存。
 */
const { acquireImageRequest } = require('./image-request') as typeof import('./image-request')
const { getVisionPayload, isVisionSession, clearVisionSession } = require('./vision') as typeof import('./vision')
const { getImageEntry } = require('./image-store') as typeof import('./image-store')

interface ImageSession {
  content?: string
  _visionUrls?: unknown
  _visionFile?: unknown
  _isVisionRequest?: unknown
  _visionTargetMessageId?: unknown
  _visionTargetChannelKey?: unknown
  quote?: { messageId?: string }
  [key: string]: unknown
}
interface ImageTurnBase { targetMessageId: string; targetChannelKey: string; candidateMessageIds?: string[] }
interface ImageTurnDiagnostic { source: 'explicit-image' | 'random-image' | 'history-tool'; target: string; demandId: string }
type ImageTurnResult = ImageTurnBase & (
  | { status: 'none' | 'pending' | 'unavailable' | 'selection' }
  | { status: 'reused'; diagnostic: ImageTurnDiagnostic; analysis: string }
  | { status: 'owned'; diagnostic: ImageTurnDiagnostic; complete(analysis: string): Promise<void>; release(): Promise<void> }
)

// 获得原图识别权，或复用已完成事实；等待中的任务不能假装已有结果。
async function prepareImageTurn(session: ImageSession, options: { question: string; randomTriggered: boolean }): Promise<ImageTurnResult> {
  if (!isVisionSession(session)) return { status: 'none' as const, targetMessageId: '', targetChannelKey: '' }
  const payload = getVisionPayload(session)
  const targetMessageId = payload.targetMessageId || ''
  const targetChannelKey = payload.targetChannelKey || ''
  const quotedMessageId = String(session.quote?.messageId || '')
  // 当前图与有效引用图是两个不同候选时，由获准聊天本身选择，不能先识别当前图。
  if (!options.randomTriggered && quotedMessageId && quotedMessageId !== targetMessageId && await getImageEntry(targetChannelKey, quotedMessageId)) {
    clearVisionSession(session)
    return { status: 'selection', targetMessageId: '', targetChannelKey, candidateMessageIds: [targetMessageId, quotedMessageId] }
  }
  const result = await acquireImageRequest(targetChannelKey, targetMessageId, {
    source: options.randomTriggered ? 'random-image' : 'explicit-image',
    question: options.question,
    force: false,
  })
  if (result.status !== 'owned') clearVisionSession(session)
  return { ...result, targetMessageId, targetChannelKey }
}

// 根据实际消息内容判断本轮是否必须使用视觉能力链，包括工具续轮与恢复轮次。
function messagesContainImage(messages: Array<{ content?: unknown }>): boolean {
  return messages.some(message => Array.isArray(message.content)
    && message.content.some(part => part && typeof part === 'object' && part.type === 'image_url'))
}

export = { prepareImageTurn, messagesContainImage }
