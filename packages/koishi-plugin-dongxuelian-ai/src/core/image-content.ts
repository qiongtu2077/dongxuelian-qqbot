/** 原图内容校验：验证实际可解码格式，不根据文件名或响应声明猜图片内容。 */
const sharp = require('sharp') as typeof import('sharp')
const { MAX_IMAGE_BYTES } = require('./constants') as typeof import('./constants')

// 在十兆原始字节边界内完整解码首帧，并返回实际 MIME；不会压缩或替换原图。
async function validateImageContent(dataUrl: string): Promise<{ mime: string; bytes: number; width: number; height: number; animated: boolean }> {
  const buffer = Buffer.from(dataUrl.replace(/^data:[^;]*;base64,/, ''), 'base64')
  if (!buffer.length) throw new Error('image_empty')
  if (buffer.length > MAX_IMAGE_BYTES) throw new Error('image_too_large')
  if (buffer.subarray(0, 2).toString('ascii') === 'BM') throw new Error('image_unsupported_format')
  const image = sharp(buffer, { animated: false })
  const metadata = await image.metadata()
  if (!metadata.format || !['jpeg', 'png', 'webp', 'gif'].includes(metadata.format)) throw new Error('image_unsupported_format')
  // metadata 仅读头不足以验证内容；stats 触发解码，也会拒绝伪装和损坏的数据。
  await image.stats()
  return { mime: 'image/' + metadata.format, bytes: buffer.length, width: metadata.width || 0, height: metadata.height || 0, animated: (metadata.pages || 1) > 1 }
}

export = { MAX_IMAGE_BYTES, validateImageContent }
