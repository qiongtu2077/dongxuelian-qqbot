/**
 * Agent 工具: create_uploaded_file_variant
 * 只基于当前会话最近上传文件创建安全副本，可选择发回当前 QQ 群/私聊。
 */
const fsp = require('fs/promises')
const fs = require('fs')
const path = require('path')
const { DATA_DIR } = require('../../core/constants') as typeof import('../../core/constants')
const { getFileEntry, getRecentFiles } = require('../../media/file/file-store') as typeof import('../../media/file/file-store')
const { analyzeFileNow } = require('../../media/file/file-analyzer') as typeof import('../../media/file/file-analyzer')
const { sanitizeFileName, getExtension } = require('../../media/file/file-safety') as typeof import('../../media/file/file-safety')
const sendFileToUser = require('./send-file-to-user') as typeof import('./send-file-to-user')

interface UploadedFileVariantParams {
  messageId?: unknown
  activeFileMessageId?: unknown
  keyword?: unknown
  name?: unknown
  fileName?: unknown
  title?: unknown
  send?: unknown
  sendBack?: unknown
  replace?: unknown
  [key: string]: unknown
}

interface UploadedFileEntry {
  messageId?: string
  fileName: string
  ext: string
  localPath: string | null
  skipped: boolean
  skipReason: string | null
  userId: string
}

interface PickedUploadedFile {
  messageId: string
  entry: UploadedFileEntry
  reason: 'messageId' | 'activeFileAnchor' | 'recent' | 'keyword'
}

interface FileTargetEvidence {
  messageId?: unknown
  type?: unknown
  [key: string]: unknown
}

interface UploadedFileVariantContext {
  channelKey?: string
  activeFileMessageId?: unknown
  isDirect?: boolean
  explicitFileTarget?: unknown
  publicFileTaskEvidence?: unknown
  activeScenePublicFileTask?: unknown
  allowCrossUserFileVariant?: unknown
  fileTargetEvidence?: unknown
  userId?: string
  [key: string]: unknown
}

interface CreatedUploadedFileVariant {
  sourceMessageId: string
  sourceName?: string
  path: string
  name: string
  size: number
}

interface ReplacementParams {
  from?: unknown
  to?: unknown
}

const OUTPUT_DIR = path.join(DATA_DIR, 'agent-user-files')
const MAX_VARIANT_FILE_BYTES = 10 * 1024 * 1024
const TEXT_EXTENSIONS = new Set(['txt', 'md', 'json', 'csv', 'yml', 'yaml', 'xml', 'toml', 'ini', 'conf', 'log'])

function isPathInside(target: string, root: string): boolean {
  const resolvedTarget = path.resolve(target)
  const resolvedRoot = path.resolve(root)
  const a = process.platform === 'win32' ? resolvedTarget.toLowerCase() : resolvedTarget
  const b = process.platform === 'win32' ? resolvedRoot.toLowerCase() : resolvedRoot
  return a === b || a.startsWith(b + path.sep)
}

function safeUploadedFileVariantChannelKey(value: unknown = ''): string {
  return String(value || 'unknown').replace(/[^a-zA-Z0-9.:_-]/g, '_').slice(0, 120) || 'unknown'
}

function resolveTargetFileName(params: UploadedFileVariantParams = {}, entry: Partial<UploadedFileEntry> = {}): string {
  const originalName = sanitizeFileName(entry.fileName || 'file')
  const originalExt = getExtension(originalName)
  const rawName = String(params.name || params.fileName || params.title || '').trim()
  if (!rawName) return originalName
  let nextName = sanitizeFileName(rawName)
  if (!path.extname(nextName) && originalExt) nextName += `.${originalExt}`
  return nextName
}

async function resolveSourceFile(channelKey: string, messageId: string, entry: UploadedFileEntry): Promise<string | null> {
  if (entry.localPath) {
    try {
      const stat = await fsp.stat(entry.localPath)
      if (stat.isFile()) return entry.localPath
    } catch {
      /* non-critical: cached uploaded-file path may have expired */
    }
  }
  const analyzed = await analyzeFileNow(channelKey, messageId)
  const fresh = await getFileEntry(channelKey, messageId)
  if (fresh && fresh.localPath) {
    try {
      const stat = await fsp.stat(fresh.localPath)
      if (stat.isFile()) return fresh.localPath
    } catch {
      /* non-critical: refreshed uploaded-file path may have expired */
    }
  }
  if (analyzed && fresh?.localPath) return fresh.localPath
  return null
}

async function pickRecentFile(channelKey: string, params: UploadedFileVariantParams = {}): Promise<PickedUploadedFile | null> {
  const messageId = String(params.messageId || '').trim()
  if (messageId) {
    const entry = await getFileEntry(channelKey, messageId)
    return entry ? { messageId, entry, reason: 'messageId' } : null
  }
  const activeFileMessageId = String(params.activeFileMessageId || '').trim()
  if (activeFileMessageId) {
    const entry = await getFileEntry(channelKey, activeFileMessageId)
    return entry ? { messageId: activeFileMessageId, entry, reason: 'activeFileAnchor' } : null
  }
  const recent = await getRecentFiles(channelKey, 15)
  const keyword = String(params.keyword || '').trim().toLowerCase()
  const candidates = recent.filter(item => item && !item.skipped)
  if (!keyword) {
    const entry = candidates[0]
    return entry ? { messageId: entry.messageId as string, entry, reason: 'recent' } : null
  }
  const matched = candidates.find(item =>
    String(item.fileName || '').toLowerCase().includes(keyword) ||
    String(item.ext || '').toLowerCase().includes(keyword)
  )
  return matched ? { messageId: matched.messageId as string, entry: matched, reason: 'keyword' } : null
}

function normalizeId(value: unknown = ''): string {
  return String(value || '').trim()
}

function hasTrustedCrossUserFileEvidence(context: UploadedFileVariantContext = {}, picked: Partial<PickedUploadedFile> = {}): boolean {
  if (context.explicitFileTarget || context.publicFileTaskEvidence || context.activeScenePublicFileTask || context.allowCrossUserFileVariant) {
    return true
  }
  const evidence = context.fileTargetEvidence && typeof context.fileTargetEvidence === 'object'
    ? context.fileTargetEvidence as FileTargetEvidence
    : null
  if (!evidence) return false
  const evidenceMessageId = normalizeId(evidence.messageId)
  if (evidenceMessageId && evidenceMessageId === normalizeId(picked.messageId)) return true
  return ['public_task', 'joined_public_task', 'quoted_file', 'referenced_file'].includes(String(evidence.type || ''))
}

function assertFileVariantTargetAllowed(picked: PickedUploadedFile | null, context: UploadedFileVariantContext = {}): void {
  if (!picked || context.isDirect) return
  if (picked.reason === 'messageId' || picked.reason === 'keyword') return
  if (hasTrustedCrossUserFileEvidence(context, picked)) return

  const ownerId = normalizeId(picked.entry?.userId)
  const currentUserId = normalizeId(context.userId)
  if (ownerId && currentUserId && ownerId === currentUserId) return

  throw new Error('我不确定要处理哪一个文件，请说明文件名或引用那条文件消息。')
}

function applyTextReplacement(buffer: Buffer, params: UploadedFileVariantParams = {}, ext: string = ''): Buffer {
  const replacement = params.replace && typeof params.replace === 'object' ? params.replace as ReplacementParams : null
  if (!replacement || !TEXT_EXTENSIONS.has(ext)) return buffer
  const from = String(replacement.from || '')
  const to = String(replacement.to || '')
  if (!from) return buffer
  const text = buffer.toString('utf8')
  return Buffer.from(text.split(from).join(to), 'utf8')
}

async function createVariant(params: UploadedFileVariantParams = {}, context: UploadedFileVariantContext = {}): Promise<CreatedUploadedFileVariant> {
  const channelKey = String(context.channelKey || '').trim()
  if (!channelKey) throw new Error('无法确定当前会话。')
  const picked = await pickRecentFile(channelKey, { activeFileMessageId: context.activeFileMessageId, ...params })
  if (!picked) throw new Error('当前会话没有可处理的近期文件。')
  assertFileVariantTargetAllowed(picked, context)
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

async function executeCreateUploadedFileVariant(params: UploadedFileVariantParams = {}, context: UploadedFileVariantContext = {}): Promise<string> {
  const variant = await createVariant(params, context)
  const shouldSend = params.send !== false && params.sendBack !== false
  if (!shouldSend) return `已创建文件副本：${variant.name}`
  const sendResult = await sendFileToUser.execute({ path: variant.path, name: variant.name }, context)
  return `${sendResult}\n文件副本：${variant.name}`
}

export = {
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
  dangerous: true,
  defaultChannels: ['qq'],
}
