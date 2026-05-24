/**
 * Agent 工具: create_uploaded_file_variant
 * 只基于当前会话最近上传文件创建安全副本，可选择发回当前 QQ 群/私聊。
 */
const fsp = require('fs/promises')
const fs = require('fs')
const path = require('path')
const { DATA_DIR } = require('../../constants')
const { getFileEntry, getRecentFiles, setLocalPath } = require('../../file-store')
const { analyzeFileNow } = require('../../file-analyzer')
const { sanitizeFileName, getExtension } = require('../../file-safety')
const sendFileToUser = require('./send-file-to-user')

const OUTPUT_DIR = path.join(DATA_DIR, 'agent-user-files')
const MAX_VARIANT_FILE_BYTES = 10 * 1024 * 1024
const TEXT_EXTENSIONS = new Set(['txt', 'md', 'json', 'csv', 'yml', 'yaml', 'xml', 'toml', 'ini', 'conf', 'log'])

function isPathInside(target, root) {
  const resolvedTarget = path.resolve(target)
  const resolvedRoot = path.resolve(root)
  const a = process.platform === 'win32' ? resolvedTarget.toLowerCase() : resolvedTarget
  const b = process.platform === 'win32' ? resolvedRoot.toLowerCase() : resolvedRoot
  return a === b || a.startsWith(b + path.sep)
}

function safeUploadedFileVariantChannelKey(value = '') {
  return String(value || 'unknown').replace(/[^a-zA-Z0-9.:_-]/g, '_').slice(0, 120) || 'unknown'
}

function resolveTargetFileName(params = {}, entry = {}) {
  const originalName = sanitizeFileName(entry.fileName || 'file')
  const originalExt = getExtension(originalName)
  const rawName = String(params.name || params.fileName || params.title || '').trim()
  if (!rawName) return originalName
  let nextName = sanitizeFileName(rawName)
  if (!path.extname(nextName) && originalExt) nextName += `.${originalExt}`
  return nextName
}

async function resolveSourceFile(channelKey, messageId, entry) {
  if (entry.localPath) {
    try {
      const stat = await fsp.stat(entry.localPath)
      if (stat.isFile()) return entry.localPath
    } catch {}
  }
  const analyzed = await analyzeFileNow(channelKey, messageId)
  const fresh = await getFileEntry(channelKey, messageId)
  if (fresh && fresh.localPath) {
    try {
      const stat = await fsp.stat(fresh.localPath)
      if (stat.isFile()) return fresh.localPath
    } catch {}
  }
  if (analyzed && fresh?.localPath) return fresh.localPath
  return null
}

async function pickRecentFile(channelKey, params = {}) {
  const messageId = String(params.messageId || '').trim()
  if (messageId) {
    const entry = await getFileEntry(channelKey, messageId)
    return entry ? { messageId, entry } : null
  }
  const recent = await getRecentFiles(channelKey, 15)
  const keyword = String(params.keyword || '').trim().toLowerCase()
  const candidates = recent.filter(item => item && !item.skipped)
  if (!keyword) {
    const entry = candidates[0]
    return entry ? { messageId: entry.messageId, entry } : null
  }
  const matched = candidates.find(item =>
    String(item.fileName || '').toLowerCase().includes(keyword) ||
    String(item.ext || '').toLowerCase().includes(keyword)
  ) || candidates[0]
  return matched ? { messageId: matched.messageId, entry: matched } : null
}

function applyTextReplacement(buffer, params = {}, ext = '') {
  const replacement = params.replace && typeof params.replace === 'object' ? params.replace : null
  if (!replacement || !TEXT_EXTENSIONS.has(ext)) return buffer
  const from = String(replacement.from || '')
  const to = String(replacement.to || '')
  if (!from) return buffer
  const text = buffer.toString('utf8')
  return Buffer.from(text.split(from).join(to), 'utf8')
}

async function createVariant(params = {}, context = {}) {
  const channelKey = String(context.channelKey || '').trim()
  if (!channelKey) throw new Error('无法确定当前会话。')
  const picked = await pickRecentFile(channelKey, params)
  if (!picked) throw new Error('当前会话没有可处理的近期文件。')
  const { messageId, entry } = picked
  if (entry.skipped) throw new Error(`这个文件被跳过了：${entry.skipReason || '不支持的类型'}`)
  const sourcePath = await resolveSourceFile(channelKey, messageId, entry)
  if (!sourcePath) throw new Error(`这个文件还没有可用本地副本，可能已过期：${entry.fileName}`)
  const stat = await fsp.stat(sourcePath)
  if (!stat.isFile()) throw new Error('源文件不是普通文件。')
  if (stat.size > MAX_VARIANT_FILE_BYTES) throw new Error(`文件过大，拒绝创建副本：${stat.size} bytes`)

  const fileName = resolveTargetFileName(params, entry)
  const ext = getExtension(fileName)
  const dir = path.join(OUTPUT_DIR, safeUploadedFileVariantChannelKey(channelKey), String(Date.now()))
  const destPath = path.join(dir, fileName)
  if (!isPathInside(destPath, OUTPUT_DIR)) throw new Error('目标路径越界。')
  await fsp.mkdir(dir, { recursive: true })
  const buffer = await fsp.readFile(sourcePath)
  await fsp.writeFile(destPath, applyTextReplacement(buffer, params, ext))

  return {
    sourceMessageId: messageId,
    sourceName: entry.fileName,
    path: destPath,
    name: fileName,
    size: fs.statSync(destPath).size,
  }
}

async function executeCreateUploadedFileVariant(params = {}, context = {}) {
  const variant = await createVariant(params, context)
  const shouldSend = params.send !== false && params.sendBack !== false
  if (!shouldSend) return `已创建文件副本：${variant.path}`
  const sendResult = await sendFileToUser.execute({ path: variant.path, name: variant.name }, context)
  return `${sendResult}\n文件副本：${variant.path}`
}

module.exports = {
  definition: {
    name: 'create_uploaded_file_variant',
    description: '基于当前会话最近上传文件创建安全副本，可改显示文件名并发回当前 QQ 群或私聊。只处理用户刚发过的文件，不读取任意本地路径。',
    parameters: {
      type: 'object',
      properties: {
        messageId: { type: 'string', description: '可选，文件消息 ID；不确定时留空使用最近文件' },
        keyword: { type: 'string', description: '可选，按文件名关键词选择近期文件' },
        name: { type: 'string', description: '新文件名，例如 1.txt；不带后缀时沿用原后缀' },
        sendBack: { type: 'boolean', description: '是否发回当前 QQ 群/私聊，默认 true' },
        replace: {
          type: 'object',
          description: '可选轻量文本替换，仅文本文件生效',
          properties: {
            from: { type: 'string' },
            to: { type: 'string' },
          },
        },
      },
      required: ['name'],
    },
  },
  execute: executeCreateUploadedFileVariant,
  createVariant,
  resolveTargetFileName,
  dangerous: false,
  defaultChannels: ['qq'],
}
