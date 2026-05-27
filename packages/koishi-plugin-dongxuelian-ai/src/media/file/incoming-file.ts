/**
 * MODULE: incoming-file
 * 职责: 处理入口收到文件后的轻量后台缓存辅助逻辑。
 * 边界: 不解析消息、不决定是否回复、不调用 AI API；只做小文件下载缓存与本地路径回写。
 * 状态: 无模块级缓存；文件缓存状态归属 file-store。
 */
const path = require('path')
const fsp = require('fs/promises')

interface IncomingCacheEntry {
  name: string
  mtimeMs: number
}

function getIncomingFileErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function cacheSmallFileBackground(channelKey: string, messageId: string, url: string, ext: string): void {
  const { downloadFile } = require('./file-analyzer') as typeof import('./file-analyzer')
  const { FILE_CACHE_DIR, setLocalPath } = require('./file-store') as typeof import('./file-store')
  const safeChannel = String(channelKey).replace(/[^a-zA-Z0-9.:_-]/g, '_')
  const safeId = String(messageId).replace(/[^a-zA-Z0-9_-]/g, '_')
  const cacheDir = path.join(FILE_CACHE_DIR, safeChannel)
  const destFile = path.join(cacheDir, `${safeId}.${ext || 'bin'}`)
  fsp.mkdir(cacheDir, { recursive: true })
    .then(() => downloadFile(url, destFile))
    .then((savedPath) => setLocalPath(channelKey, messageId, savedPath))
    .then(() => fsp.readdir(cacheDir))
    .then(async (names) => {
      if (names.length <= 10) return
      const entries: IncomingCacheEntry[] = []
      for (const n of names) {
        try {
          const s = await fsp.stat(path.join(cacheDir, n))
          entries.push({ name: n, mtimeMs: s.mtimeMs })
        } catch { /* non-critical: skip unreadable cached file while pruning incoming cache */
        }
      }
      entries.sort((a, b) => a.mtimeMs - b.mtimeMs)
      for (const e of entries.slice(0, entries.length - 10)) {
        try { await fsp.unlink(path.join(cacheDir, e.name)) } catch { /* non-critical: best-effort incoming cache cleanup */
        }
      }
    })
    .catch((error) => {
      console.warn(`[incoming-file] cache small file failed: ${getIncomingFileErrorMessage(error)}`)
    })
}

export = {
  cacheSmallFileBackground,
}
