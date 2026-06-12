/**
 * MODULE: 文件历史存储。
 * 职责: 存储群聊文件元数据、去重、过期清理、摘要回写。
 * 边界: 不调用 AI API、不发送消息。
 * 状态: 磁盘 JSON 文件 (data/file-history/{channelKey}.json)。
 */
const fs = require('fs/promises')
const path = require('path')
const { DATA_DIR } = require('../../core/constants') as typeof import('../../core/constants')
const { safeChannelKey } = require('../../core/utils') as typeof import('../../core/utils')

const FILE_HISTORY_DIR: string = path.join(DATA_DIR, 'file-history')
const FILE_CACHE_DIR: string = path.join(DATA_DIR, 'file-cache')
const FILE_EXPIRE_MS = 4 * 60 * 60 * 1000
const FILE_ANALYZED_EXPIRE_MS = 24 * 60 * 60 * 1000
const MAX_FILES_PER_CHANNEL = 20
const MAX_HISTORY_FILE_BYTES = 256 * 1024

interface FileEntry {
  fileName: string
  fileSize: number
  mimeType: string
  ext: string
  url: string
  fileId: string | null
  conversationKey: string
  userId: string
  ts: number
  skipped: boolean
  skipReason: string | null
  analyzed: boolean
  analysis: string | null
  localPath: string | null
}

interface FileHistoryData {
  files: Record<string, FileEntry>
}

interface StoredFileInfo {
  fileName?: unknown
  fileSize?: unknown
  mimeType?: unknown
  ext?: unknown
  url?: unknown
  fileId?: unknown
  conversationKey?: unknown
  userId?: unknown
  skipped?: unknown
  skipReason?: unknown
}

interface RecentFile extends FileEntry {
  messageId: string
}

interface FileStoreError {
  code?: string
}

interface CacheEntry {
  name: string
  mtimeMs: number
}

const fileHistoryCache: Map<string, FileHistoryData> = new Map()
const fileStoreQueues: Map<string, Promise<unknown>> = new Map()

function getSafeKey(channelKey: unknown): string {
  const key = String(channelKey || '')
  return key ? safeChannelKey(key) : ''
}

function getLegacyPrivateKey(channelKey: unknown): string {
  return /^private:/.test(String(channelKey || '')) ? 'private' : ''
}

function getPrivateUserId(channelKey: unknown): string {
  return /^private:/.test(String(channelKey || '')) ? String(channelKey).slice('private:'.length) : ''
}

function matchesPrivateUser(entry: Partial<FileEntry> | null | undefined, channelKey: unknown): boolean {
  const userId = getPrivateUserId(channelKey)
  if (!userId) return true
  return String(entry?.userId || '') === userId
}

function getFilePath(channelKey: unknown): string {
  return path.join(FILE_HISTORY_DIR, getSafeKey(channelKey) + '.json')
}

function getQueueKey(channelKey: unknown): string {
  return getSafeKey(channelKey) || 'unknown'
}

function getLegacyUnsafeKey(channelKey: unknown): string {
  return String(channelKey || '').replace(/[^a-zA-Z0-9.:_-]/g, '_')
}

function getLegacyUnsafeFilePath(channelKey: unknown): string {
  const legacyKey = getLegacyUnsafeKey(channelKey)
  const safeKey = getSafeKey(channelKey)
  return legacyKey && legacyKey !== safeKey ? path.join(FILE_HISTORY_DIR, legacyKey + '.json') : ''
}

function ignoreFileStoreQueueFailure(error: unknown): void {
  void error
}

function enqueueTask<T>(channelKey: unknown, task: () => Promise<T>): Promise<T> {
  const key = getQueueKey(channelKey)
  const previous = fileStoreQueues.get(key) || Promise.resolve()
  const current = previous.catch(ignoreFileStoreQueueFailure).then(task)
  const cleanup = current.finally(() => {
    if (fileStoreQueues.get(key) === cleanup) fileStoreQueues.delete(key)
  }).catch(ignoreFileStoreQueueFailure)
  fileStoreQueues.set(key, cleanup)
  return current
}

function normalizeEntry(entry: unknown): FileEntry | null {
  if (!entry || typeof entry !== 'object') return null
  const data = entry as Record<string, unknown>
  return {
    fileName: String(data.fileName || ''),
    fileSize: Number(data.fileSize) || 0,
    mimeType: String(data.mimeType || ''),
    ext: String(data.ext || ''),
    url: String(data.url || ''),
    fileId: data.fileId ? String(data.fileId) : null,
    conversationKey: data.conversationKey ? String(data.conversationKey) : '',
    userId: data.userId ? String(data.userId) : '',
    ts: Number(data.ts) || 0,
    skipped: !!data.skipped,
    skipReason: data.skipReason ? String(data.skipReason) : null,
    analyzed: !!data.analyzed,
    analysis: data.analysis == null ? null : String(data.analysis),
    localPath: data.localPath ? String(data.localPath) : null,
  }
}

function normalizeData(data: unknown): FileHistoryData {
  const files: Record<string, FileEntry> = {}
  const record = data && typeof data === 'object' ? data as Record<string, unknown> : {}
  const source = record.files && typeof record.files === 'object'
    ? record.files as Record<string, unknown> : {}
  for (const [id, entry] of Object.entries(source)) {
    const norm = normalizeEntry(entry)
    if (norm) files[String(id)] = norm
  }
  return { files }
}

function cleanExpiredWithChange(data: FileHistoryData): { data: FileHistoryData; changed: boolean } {
  const now = Date.now()
  const files = data.files || {}
  let changed = false
  for (const id of Object.keys(files)) {
    const expiry = files[id].analyzed ? FILE_ANALYZED_EXPIRE_MS : FILE_EXPIRE_MS
    if (now - (files[id].ts || 0) > expiry) {
      delete files[id]
      changed = true
    }
  }
  const keys = Object.keys(files)
  if (keys.length > MAX_FILES_PER_CHANNEL) {
    keys.sort((a, b) => (files[a].ts || 0) - (files[b].ts || 0))
    for (let i = 0; i < keys.length - MAX_FILES_PER_CHANNEL; i++) {
      delete files[keys[i]]
      changed = true
    }
  }
  data.files = files
  return { data, changed }
}

function cleanExpired(data: FileHistoryData): FileHistoryData {
  return cleanExpiredWithChange(data).data
}

async function readFileHistory(channelKey: unknown): Promise<FileHistoryData> {
  const cacheKey = getQueueKey(channelKey)
  try {
    await fs.mkdir(FILE_HISTORY_DIR, { recursive: true })
    let fp = getFilePath(channelKey)
    let stat
    try {
      stat = await fs.stat(fp)
    } catch (error) {
      const legacyPath = getLegacyUnsafeFilePath(channelKey)
      if (!legacyPath || (error as FileStoreError | null)?.code !== 'ENOENT') throw error
      fp = legacyPath
      stat = await fs.stat(fp)
    }
    if (!stat.isFile() || stat.size > MAX_HISTORY_FILE_BYTES) return { files: {} }
    const parsed = JSON.parse(await fs.readFile(fp, 'utf8'))
    const data = normalizeData(parsed)
    fileHistoryCache.set(cacheKey, data)
    return data
  } catch (error) {
    if (error && (error as FileStoreError).code === 'ENOENT') {
      fileHistoryCache.delete(cacheKey)
      return { files: {} }
    }
    const cached = fileHistoryCache.get(cacheKey)
    return cached ? normalizeData(cached) : { files: {} }
  }
}

async function writeFileHistory(channelKey: unknown, data: FileHistoryData): Promise<boolean> {
  try {
    await fs.mkdir(FILE_HISTORY_DIR, { recursive: true })
    const normalized = normalizeData(data)
    await fs.writeFile(getFilePath(channelKey), JSON.stringify(normalized), 'utf8')
    fileHistoryCache.set(getQueueKey(channelKey), normalized)
    return true
  } catch (error) {
    console.warn(`[file-store] write history failed: ${error instanceof Error ? error.message : String(error)}`)
    return false
  }
}

async function storeFile(channelKey: string, messageId: string, fileInfo: StoredFileInfo): Promise<boolean> {
  if (!channelKey || !messageId || !fileInfo) return false
  return enqueueTask(channelKey, async () => {
    const data = cleanExpired(await readFileHistory(channelKey))
    const id = String(messageId)
    if (data.files[id]) return false
    data.files[id] = {
      fileName: String(fileInfo.fileName || ''),
      fileSize: Number(fileInfo.fileSize) || 0,
      mimeType: String(fileInfo.mimeType || ''),
      ext: String(fileInfo.ext || ''),
      url: String(fileInfo.url || ''),
      fileId: fileInfo.fileId ? String(fileInfo.fileId) : null,
      conversationKey: fileInfo.conversationKey ? String(fileInfo.conversationKey) : '',
      userId: fileInfo.userId ? String(fileInfo.userId) : '',
      ts: Date.now(),
      skipped: !!fileInfo.skipped,
      skipReason: fileInfo.skipReason ? String(fileInfo.skipReason) : null,
      analyzed: false,
      analysis: null,
      localPath: null,
    }
    return writeFileHistory(channelKey, data)
  })
}

async function getFileEntry(channelKey: string, messageId: string): Promise<FileEntry | null> {
  if (!channelKey || !messageId) return null
  return enqueueTask(channelKey, async () => {
    const data = await readFileHistory(channelKey)
    const entry = data.files[String(messageId)] || null
    return entry ? { ...entry } : null
  }).then(async (entry) => {
    if (entry) return entry
    const legacyKey = getLegacyPrivateKey(channelKey)
    if (!legacyKey) return null
    const legacyEntry = await getFileEntry(legacyKey, messageId)
    return matchesPrivateUser(legacyEntry, channelKey) ? legacyEntry : null
  })
}

async function markFileAnalyzed(channelKey: string, messageId: string, analysis: unknown): Promise<boolean> {
  if (!channelKey || !messageId) return false
  return enqueueTask(channelKey, async () => {
    const data = await readFileHistory(channelKey)
    const id = String(messageId)
    if (!data.files[id]) return false
    data.files[id].analyzed = true
    data.files[id].analysis = String(analysis || '').slice(0, 1000)
    return writeFileHistory(channelKey, data)
  })
}

async function markFileSkipped(channelKey: string, messageId: string, reason: unknown): Promise<boolean> {
  if (!channelKey || !messageId) return false
  return enqueueTask(channelKey, async () => {
    const data = await readFileHistory(channelKey)
    const id = String(messageId)
    if (!data.files[id]) return false
    data.files[id].skipped = true
    data.files[id].skipReason = String(reason || 'unknown')
    return writeFileHistory(channelKey, data)
  })
}

async function setLocalPath(channelKey: string, messageId: string, localPath: string): Promise<boolean> {
  if (!channelKey || !messageId) return false
  return enqueueTask(channelKey, async () => {
    const data = await readFileHistory(channelKey)
    const id = String(messageId)
    if (!data.files[id]) return false
    data.files[id].localPath = String(localPath)
    return writeFileHistory(channelKey, data)
  })
}

async function getRecentFiles(channelKey: string, limit: number = 5): Promise<RecentFile[]> {
  if (!channelKey) return []
  const current = await enqueueTask(channelKey, async () => {
    const cleaned = cleanExpiredWithChange(await readFileHistory(channelKey))
    if (cleaned.changed) await writeFileHistory(channelKey, cleaned.data)
    return Object.entries(cleaned.data.files || {})
      .map(([id, entry]) => ({ messageId: id, ...entry }))
      .sort((a, b) => (b.ts || 0) - (a.ts || 0))
      .slice(0, limit)
  })
  const legacyKey = getLegacyPrivateKey(channelKey)
  if (!legacyKey || current.length >= limit) return current
  const seen = new Set(current.map(file => String(file.messageId || '')))
  const legacy = await getRecentFiles(legacyKey, limit)
  return current
    .concat(legacy.filter(file => matchesPrivateUser(file, channelKey) && !seen.has(String(file.messageId || ''))))
    .sort((a, b) => (b.ts || 0) - (a.ts || 0))
    .slice(0, limit)
}

function getRecentFilesCached(channelKey: string, limit: number = 5): RecentFile[] {
  const cached = fileHistoryCache.get(getQueueKey(channelKey))
  const files: RecentFile[] = []
  if (cached) {
    const data = normalizeData(cached)
    files.push(...Object.entries(data.files || {}).map(([id, entry]) => ({ messageId: id, ...entry })))
  }
  const legacyKey = getLegacyPrivateKey(channelKey)
  const legacyCached = legacyKey ? fileHistoryCache.get(getQueueKey(legacyKey)) : null
  if (legacyCached) {
    const seen = new Set(files.map(file => String(file.messageId || '')))
    const data = normalizeData(legacyCached)
    for (const [id, entry] of Object.entries(data.files || {})) {
      const file = { messageId: id, ...entry }
      if (matchesPrivateUser(file, channelKey) && !seen.has(String(id))) files.push(file)
    }
  }
  return files
    .sort((a, b) => (b.ts || 0) - (a.ts || 0))
    .slice(0, limit)
}

const MAX_CACHED_FILES_PER_CHANNEL = 10

function getSafeCacheDir(channelKey: unknown): string {
  return path.join(FILE_CACHE_DIR, getSafeKey(channelKey))
}

async function enforceFileCacheLimit(channelKey: string): Promise<void> {
  try {
    const dir = getSafeCacheDir(channelKey)
    const names = await fs.readdir(dir)
    if (names.length <= MAX_CACHED_FILES_PER_CHANNEL) return
    const entries: CacheEntry[] = []
    for (const name of names) {
      try {
        const stat = await fs.stat(path.join(dir, name))
        entries.push({ name, mtimeMs: stat.mtimeMs })
      } catch { /* non-critical: skip one unreadable cached file while enforcing cache limit */
      }
    }
    entries.sort((a, b) => a.mtimeMs - b.mtimeMs)
    const toDelete = entries.slice(0, entries.length - MAX_CACHED_FILES_PER_CHANNEL)
    for (const entry of toDelete) {
      try { await fs.unlink(path.join(dir, entry.name)) } catch { /* non-critical: best-effort cached file cleanup */
      }
    }
  } catch { /* non-critical: cache limit cleanup should not block file analysis */
  }
}

async function cacheFileLocally(channelKey: string, messageId: string, buffer: Buffer, ext: string): Promise<string | null> {
  if (!channelKey || !messageId || !Buffer.isBuffer(buffer)) return null
  if (buffer.length > 1024 * 1024) return null
  try {
    const dir = getSafeCacheDir(channelKey)
    await fs.mkdir(dir, { recursive: true })
    const safeId = String(messageId).replace(/[^a-zA-Z0-9_-]/g, '_')
    const filePath = path.join(dir, `${safeId}.${ext || 'bin'}`)
    await fs.writeFile(filePath, buffer)
    await enforceFileCacheLimit(channelKey)
    return filePath
  } catch (error) {
    console.warn(`[file-store] cache file locally failed: ${error instanceof Error ? error.message : String(error)}`)
    return null
  }
}

export = {
  storeFile,
  getFileEntry,
  markFileAnalyzed,
  markFileSkipped,
  setLocalPath,
  getRecentFiles,
  getRecentFilesCached,
  cacheFileLocally,
  FILE_HISTORY_DIR,
  FILE_CACHE_DIR,
}
