/**
 * MODULE: 文件历史存储。
 * 职责: 存储群聊文件元数据、去重、过期清理、摘要回写。
 * 边界: 不调用 AI API、不发送消息。
 * 状态: 磁盘 JSON 文件 (data/file-history/{channelKey}.json)。
 */
const fs = require('fs/promises')
const path = require('path')
const { DATA_DIR } = require('../../core/constants')

const FILE_HISTORY_DIR = path.join(DATA_DIR, 'file-history')
const FILE_CACHE_DIR = path.join(DATA_DIR, 'file-cache')
const FILE_EXPIRE_MS = 4 * 60 * 60 * 1000
const FILE_ANALYZED_EXPIRE_MS = 24 * 60 * 60 * 1000
const MAX_FILES_PER_CHANNEL = 20
const MAX_HISTORY_FILE_BYTES = 256 * 1024

const fileHistoryCache = new Map()
const fileStoreQueues = new Map()

function getSafeKey(channelKey) {
  return String(channelKey || '').replace(/[^a-zA-Z0-9._-]/g, '_')
}

function getLegacyPrivateKey(channelKey) {
  return /^private:/.test(String(channelKey || '')) ? 'private' : ''
}

function getPrivateUserId(channelKey) {
  return /^private:/.test(String(channelKey || '')) ? String(channelKey).slice('private:'.length) : ''
}

function matchesPrivateUser(entry, channelKey) {
  const userId = getPrivateUserId(channelKey)
  if (!userId) return true
  return String(entry?.userId || '') === userId
}

function getFilePath(channelKey) {
  return path.join(FILE_HISTORY_DIR, getSafeKey(channelKey) + '.json')
}

function getQueueKey(channelKey) {
  return getSafeKey(channelKey) || 'unknown'
}

function getLegacyUnsafeKey(channelKey) {
  return String(channelKey || '').replace(/[^a-zA-Z0-9.:_-]/g, '_')
}

function getLegacyUnsafeFilePath(channelKey) {
  const legacyKey = getLegacyUnsafeKey(channelKey)
  const safeKey = getSafeKey(channelKey)
  return legacyKey && legacyKey !== safeKey ? path.join(FILE_HISTORY_DIR, legacyKey + '.json') : ''
}

function enqueueTask(channelKey, task) {
  const key = getQueueKey(channelKey)
  const previous = fileStoreQueues.get(key) || Promise.resolve()
  const current = previous.catch(() => {}).then(task)
  const cleanup = current.finally(() => {
    if (fileStoreQueues.get(key) === cleanup) fileStoreQueues.delete(key)
  }).catch(() => {})
  fileStoreQueues.set(key, cleanup)
  return current
}

function normalizeEntry(entry) {
  if (!entry || typeof entry !== 'object') return null
  return {
    fileName: String(entry.fileName || ''),
    fileSize: Number(entry.fileSize) || 0,
    mimeType: String(entry.mimeType || ''),
    ext: String(entry.ext || ''),
    url: String(entry.url || ''),
    fileId: entry.fileId ? String(entry.fileId) : null,
    conversationKey: entry.conversationKey ? String(entry.conversationKey) : '',
    userId: entry.userId ? String(entry.userId) : '',
    ts: Number(entry.ts) || 0,
    skipped: !!entry.skipped,
    skipReason: entry.skipReason ? String(entry.skipReason) : null,
    analyzed: !!entry.analyzed,
    analysis: entry.analysis == null ? null : String(entry.analysis),
    localPath: entry.localPath ? String(entry.localPath) : null,
  }
}

function normalizeData(data) {
  const files = {}
  const source = data && typeof data === 'object' && data.files && typeof data.files === 'object'
    ? data.files : {}
  for (const [id, entry] of Object.entries(source)) {
    const norm = normalizeEntry(entry)
    if (norm) files[String(id)] = norm
  }
  return { files }
}

function cleanExpired(data) {
  const now = Date.now()
  const files = data.files || {}
  for (const id of Object.keys(files)) {
    const expiry = files[id].analyzed ? FILE_ANALYZED_EXPIRE_MS : FILE_EXPIRE_MS
    if (now - (files[id].ts || 0) > expiry) delete files[id]
  }
  const keys = Object.keys(files)
  if (keys.length > MAX_FILES_PER_CHANNEL) {
    keys.sort((a, b) => (files[a].ts || 0) - (files[b].ts || 0))
    for (let i = 0; i < keys.length - MAX_FILES_PER_CHANNEL; i++) delete files[keys[i]]
  }
  data.files = files
  return data
}

async function readFileHistory(channelKey) {
  const cacheKey = getQueueKey(channelKey)
  try {
    await fs.mkdir(FILE_HISTORY_DIR, { recursive: true })
    let fp = getFilePath(channelKey)
    let stat
    try {
      stat = await fs.stat(fp)
    } catch (error) {
      const legacyPath = getLegacyUnsafeFilePath(channelKey)
      if (!legacyPath || error?.code !== 'ENOENT') throw error
      fp = legacyPath
      stat = await fs.stat(fp)
    }
    if (!stat.isFile() || stat.size > MAX_HISTORY_FILE_BYTES) return { files: {} }
    const parsed = JSON.parse(await fs.readFile(fp, 'utf8'))
    const data = normalizeData(parsed)
    fileHistoryCache.set(cacheKey, data)
    return data
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      fileHistoryCache.delete(cacheKey)
      return { files: {} }
    }
    const cached = fileHistoryCache.get(cacheKey)
    return cached ? normalizeData(cached) : { files: {} }
  }
}

async function writeFileHistory(channelKey, data) {
  try {
    await fs.mkdir(FILE_HISTORY_DIR, { recursive: true })
    const normalized = normalizeData(data)
    await fs.writeFile(getFilePath(channelKey), JSON.stringify(normalized), 'utf8')
    fileHistoryCache.set(getQueueKey(channelKey), normalized)
    return true
  } catch {
    return false
  }
}

async function storeFile(channelKey, messageId, fileInfo) {
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
      skipReason: fileInfo.skipReason || null,
      analyzed: false,
      analysis: null,
      localPath: null,
    }
    return writeFileHistory(channelKey, data)
  })
}

async function getFileEntry(channelKey, messageId) {
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

async function markFileAnalyzed(channelKey, messageId, analysis) {
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

async function markFileSkipped(channelKey, messageId, reason) {
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

async function setLocalPath(channelKey, messageId, localPath) {
  if (!channelKey || !messageId) return false
  return enqueueTask(channelKey, async () => {
    const data = await readFileHistory(channelKey)
    const id = String(messageId)
    if (!data.files[id]) return false
    data.files[id].localPath = String(localPath)
    return writeFileHistory(channelKey, data)
  })
}

async function getRecentFiles(channelKey, limit = 5) {
  if (!channelKey) return []
  const current = await enqueueTask(channelKey, async () => {
    const data = cleanExpired(await readFileHistory(channelKey))
    await writeFileHistory(channelKey, data)
    return Object.entries(data.files || {})
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

function getRecentFilesCached(channelKey, limit = 5) {
  const cached = fileHistoryCache.get(getQueueKey(channelKey))
  const files = []
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

function getSafeCacheDir(channelKey) {
  return path.join(FILE_CACHE_DIR, getSafeKey(channelKey))
}

async function enforceFileCacheLimit(channelKey) {
  try {
    const dir = getSafeCacheDir(channelKey)
    const names = await fs.readdir(dir)
    if (names.length <= MAX_CACHED_FILES_PER_CHANNEL) return
    const entries = []
    for (const name of names) {
      try {
        const stat = await fs.stat(path.join(dir, name))
        entries.push({ name, mtimeMs: stat.mtimeMs })
      } catch {}
    }
    entries.sort((a, b) => a.mtimeMs - b.mtimeMs)
    const toDelete = entries.slice(0, entries.length - MAX_CACHED_FILES_PER_CHANNEL)
    for (const entry of toDelete) {
      try { await fs.unlink(path.join(dir, entry.name)) } catch {}
    }
  } catch {}
}

async function cacheFileLocally(channelKey, messageId, buffer, ext) {
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
  } catch {
    return null
  }
}

module.exports = {
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
