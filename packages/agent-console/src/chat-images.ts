import type { ChatHistoryItem } from './api/types'

export const MAX_CHAT_IMAGES = 4
export const MAX_CHAT_IMAGE_BYTES = 4 * 1024 * 1024
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])

// --- Clipboard attachments ---

/** Returns the decoded byte size of a FileReader image data URL. */
export function chatImageBytes(url: string): number {
  const base64 = url.slice(url.indexOf(',') + 1)
  return base64.length * 3 / 4 - (base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0)
}

/** Validates a clipboard batch before reading it, keeping the existing draft on failure. */
export async function readChatImages(files: File[], current: string[]): Promise<string[]> {
  if (files.length + current.length > MAX_CHAT_IMAGES) throw new Error('最多可附带 4 张图片')
  if (files.some(file => !IMAGE_TYPES.has(file.type))) throw new Error('仅支持 PNG、JPEG、WebP 和 GIF 图片')
  if (files.some(file => !file.size)) throw new Error('图片内容为空，请重新复制')
  if (files.reduce((sum, file) => sum + file.size, current.reduce((sum, url) => sum + chatImageBytes(url), 0)) > MAX_CHAT_IMAGE_BYTES) {
    throw new Error('图片总大小不能超过 4 MB，请缩小图片后重试')
  }
  return Promise.all(files.map(file => new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(new Error('读取图片失败，请重新复制'))
    reader.onabort = () => reject(new Error('图片读取已取消'))
    reader.readAsDataURL(file)
  })))
}

// --- Conversation context ---

/** Keeps recent images within the request budget, reserving space for the current draft. */
export function buildChatHistory(messages: ChatHistoryItem[], currentImages: string[]): ChatHistoryItem[] {
  let count = currentImages.length
  let bytes = currentImages.reduce((sum, url) => sum + chatImageBytes(url), 0)
  return messages.slice(-10).reverse().map(item => {
    const history: ChatHistoryItem = { role: item.role, content: item.content }
    const images = item.role === 'user' ? item.images || [] : []
    const size = images.reduce((sum, url) => sum + chatImageBytes(url), 0)
    if (images.length && count + images.length <= MAX_CHAT_IMAGES && bytes + size <= MAX_CHAT_IMAGE_BYTES) {
      history.images = images
      count += images.length
      bytes += size
    } else if (images.length || item.imageCount) {
      history.content += '\n[历史图片未附带，需要原图时请用户重新粘贴。]'
    }
    return history
  }).reverse()
}
