/**
 * MODULE: 图片历史存储。
 * 职责: 存储群聊图片 URL + 本地二进制缓存、去重、占位符替换、过期清理。
 * 边界: 不调用 AI API、不发送消息。
 * 状态: 磁盘 JSON 文件 (data/image-history/{channelKey}.json) + 本地图片文件。
 */
const fs = require('fs')
const path = require('path')
const { DATA_DIR } = require('./constants')

const IMAGE_HISTORY_DIR = path.join(DATA_DIR, 'image-history')
const IMAGE_CACHE_DIR = path.join(DATA_DIR, 'image-cache')
const IMAGE_EXPIRE_MS = 2 * 60 * 60 * 1000
const MAX_IMAGES_PER_CHANNEL = 10
const MAX_FILE_BYTES = 128 * 1024
const MAX_CACHED_IMAGE_BYTES = 10 * 1024 * 1024

function getSafeKey(channelKey) {
  return String(channelKey || '').replace(/[^a-zA-Z0-9.:_-]/g, '_')
}

function getFilePath(channelKey) {
  return path.join(IMAGE_HISTORY_DIR, getSafeKey(channelKey) + '.json')
}

function readImageHistory(channelKey) {
  try {
    fs.mkdirSync(IMAGE_HISTORY_DIR, { recursive: true })
    const file = getFilePath(channelKey)
    const stat = fs.statSync(file)
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) return { images: {} }
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return { images: {} }
  }
}

function writeImageHistory(channelKey, data) {
  try {
    fs.mkdirSync(IMAGE_HISTORY_DIR, { recursive: true })
    fs.writeFileSync(getFilePath(channelKey), JSON.stringify(data), 'utf8')
  } catch {}
}

function cleanExpired(data) {
  const now = Date.now()
  const images = data.images || {}
  for (const id of Object.keys(images)) {
    if (now - (images[id].ts || 0) > IMAGE_EXPIRE_MS) delete images[id]
  }
  const keys = Object.keys(images)
  if (keys.length > MAX_IMAGES_PER_CHANNEL) {
    keys.sort((a, b) => (images[a].ts || 0) - (images[b].ts || 0))
    for (let i = 0; i < keys.length - MAX_IMAGES_PER_CHANNEL; i++) delete images[keys[i]]
  }
  return data
}
function storeImageUrl(channelKey, messageId, url, file) {
  if (!channelKey || !messageId || !url) return
  const data = cleanExpired(readImageHistory(channelKey))
  if (data.images[messageId]) return
  data.images[messageId] = { url: String(url), file: file || null, ts: Date.now(), analyzed: false, analysis: null }
  writeImageHistory(channelKey, data)
}

function getImageEntry(channelKey, messageId) {
  const data = readImageHistory(channelKey)
  return data.images[messageId] || null
}

function getRecentImages(channelKey, limit = 5) {
  const data = cleanExpired(readImageHistory(channelKey))
  writeImageHistory(channelKey, data)
  const entries = Object.entries(data.images || {})
    .map(([id, entry]) => ({ messageId: id, ...entry }))
    .sort((a, b) => (b.ts || 0) - (a.ts || 0))
    .slice(0, limit)
  return entries
}

function markAnalyzed(channelKey, messageId, analysis) {
  const data = readImageHistory(channelKey)
  if (!data.images[messageId]) return false
  data.images[messageId].analyzed = true
  data.images[messageId].analysis = String(analysis || '').slice(0, 500)
  writeImageHistory(channelKey, data)
  return true
}

function isAlreadyAnalyzed(channelKey, messageId) {
  const entry = getImageEntry(channelKey, messageId)
  return !!(entry && entry.analyzed)
}

function getCachedAnalysis(channelKey, messageId) {
  const entry = getImageEntry(channelKey, messageId)
  return entry && entry.analyzed ? entry.analysis : null
}

function getChannelCacheDir(channelKey) {
  return path.join(IMAGE_CACHE_DIR, getSafeKey(channelKey))
}

function cacheImageFile(channelKey, messageId, buffer) {
  if (!channelKey || !messageId || !Buffer.isBuffer(buffer)) return null
  if (buffer.length > MAX_CACHED_IMAGE_BYTES) return null
  try {
    const dir = getChannelCacheDir(channelKey)
    fs.mkdirSync(dir, { recursive: true })
    const ext = detectImageExt(buffer)
    const filePath = path.join(dir, `${getSafeKey(messageId)}.${ext}`)
    fs.writeFileSync(filePath, buffer)
    enforceChannelCacheLimit(channelKey)
    return filePath
  } catch {
    return null
  }
}

function readCachedImage(channelKey, messageId) {
  try {
    const dir = getChannelCacheDir(channelKey)
    const prefix = getSafeKey(messageId)
    const files = fs.readdirSync(dir).filter(f => f.startsWith(prefix))
    if (!files.length) return null
    const filePath = path.join(dir, files[0])
    const stat = fs.statSync(filePath)
    if (!stat.isFile() || stat.size > MAX_CACHED_IMAGE_BYTES) return null
    const buf = fs.readFileSync(filePath)
    const mime = mimeFromExt(path.extname(filePath))
    return `data:${mime};base64,${buf.toString('base64')}`
  } catch {
    return null
  }
}

function enforceChannelCacheLimit(channelKey) {
  try {
    const dir = getChannelCacheDir(channelKey)
    if (!fs.existsSync(dir)) return
    const files = fs.readdirSync(dir)
      .map(f => {
        try {
          const fp = path.join(dir, f)
          const stat = fs.statSync(fp)
          return { name: f, path: fp, mtime: stat.mtimeMs }
        } catch { return null }
      })
      .filter(Boolean)
      .sort((a, b) => b.mtime - a.mtime)
    if (files.length > MAX_IMAGES_PER_CHANNEL) {
      for (let i = MAX_IMAGES_PER_CHANNEL; i < files.length; i++) {
        try { fs.unlinkSync(files[i].path) } catch {}
      }
    }
  } catch {}
}

function detectImageExt(buffer) {
  if (buffer[0] === 0x89 && buffer[1] === 0x50) return 'png'
  if (buffer[0] === 0x47 && buffer[1] === 0x49) return 'gif'
  if (buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[8] === 0x57 && buffer[9] === 0x45) return 'webp'
  return 'jpg'
}

function mimeFromExt(ext) {
  const e = String(ext).replace('.', '').toLowerCase()
  if (e === 'png') return 'image/png'
  if (e === 'gif') return 'image/gif'
  if (e === 'webp') return 'image/webp'
  return 'image/jpeg'
}

function replaceImagePlaceholder(channelKey, messageId, analysis) {
  const { readConversationDisk, writeConversationDisk } = require('./conversation')
  const convKey = channelKey
  const diskData = readConversationDisk(convKey)
  if (!diskData || !Array.isArray(diskData.messages)) return false
  let replaced = false
  for (let i = diskData.messages.length - 1; i >= 0; i--) {
    const msg = diskData.messages[i]
    if (msg.role === 'user' && msg.content && msg.content.includes('[图片]') && !msg.content.includes('[图片]:')) {
      msg.content = msg.content.replace('[图片]', `[图片]: ${String(analysis).slice(0, 200)}`)
      replaced = true
      break
    }
  }
  if (replaced) writeConversationDisk(convKey, diskData)
  return replaced
}

module.exports = {
  storeImageUrl,
  getImageEntry,
  getRecentImages,
  markAnalyzed,
  isAlreadyAnalyzed,
  getCachedAnalysis,
  replaceImagePlaceholder,
  cacheImageFile,
  readCachedImage,
  enforceChannelCacheLimit,
  IMAGE_HISTORY_DIR,
  IMAGE_CACHE_DIR,
}
