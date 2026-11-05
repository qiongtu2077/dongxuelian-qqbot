/**
 * MODULE: 共用图片原图读取。
 * 职责: 有效记录校验、本地优先读取及跨进程合并下载，供缓存和识图入口复用。
 * 边界: 不加载模型配置、不请求模型、不创建常驻队列。
 */
const fs = require('fs/promises') as typeof import('fs/promises')
const path = require('path') as typeof import('path')
const { createHash, randomUUID } = require('crypto') as typeof import('crypto')
const { DATA_DIR } = require('../../core/constants') as typeof import('../../core/constants')
const { isProcessAlive } = require('../../resource-common/files') as typeof import('../../resource-common/files')
const { callGetImage, callGetFile, readImageAsBase64, downloadImageAsBase64 } = require('../../core/api') as typeof import('../../core/api')
const { getImageEntry, getImagesForSource, readCachedImage, cacheImageFile } = require('./image-store') as typeof import('./image-store')
const { validateImageContent } = require('../../core/image-content') as typeof import('../../core/image-content')
const { fileURLToPath } = require('url') as typeof import('url')

const SOURCE_LOCK_DIR = path.join(DATA_DIR, 'image-source-locks')
const MAX_ACTIVE_READS = 64
const SOURCE_WAIT_MS = 20000
const MAX_IMAGE_BYTES = 10 * 1024 * 1024
interface ImageReadResult { dataUrl: string | null; reason: string; bytes?: number; mime?: string; width?: number; height?: number; animated?: boolean }
const inFlight = new Map<string, Promise<ImageReadResult>>()

// --- 图片身份与下载所有权 --- //

// 用完整频道与原图片编号生成互不串图的稳定身份。
function getSourceKey(channelKey: string, messageId: string): string {
  return createHash('sha256').update(JSON.stringify([channelKey, messageId])).digest('hex')
}

// 同一平台原图出现在不同消息时共享已验证缓存，取图协议及频道必须一致。
async function readReusableImageCache(channelKey: string, imageId: string, entry: NonNullable<Awaited<ReturnType<typeof getImageEntry>>>): Promise<string | null> {
  const direct = await readCachedImage(channelKey, imageId)
  if (direct || !entry.file) return direct
  for (const other of await getImagesForSource(channelKey, entry.file, entry.sourceKind || 'image')) {
    if (other.messageId === imageId) continue
    const cached = await readCachedImage(channelKey, other.messageId)
    if (cached) {
      await cacheImageFile(channelKey, imageId, Buffer.from(cached.replace(/^data:[^;]+;base64,/, ''), 'base64'))
      return cached
    }
  }
  return null
}

// 在完整原图落盘后才释放所有权，其他入口等待同一目标而非普通缓存队列。
async function loadImageSource(channelKey: string, messageId: string, key: string, signal?: AbortSignal): Promise<string | null> {
  signal?.throwIfAborted()
  let entry = await getImageEntry(channelKey, messageId)
  if (!entry) return null
  if (entry.declaredSize != null && entry.declaredSize > MAX_IMAGE_BYTES) throw new Error('image_too_large')
  let cached = await readReusableImageCache(channelKey, messageId, entry)
  if (cached) return cached
  await fs.mkdir(SOURCE_LOCK_DIR, { recursive: true })
  const lock = path.join(SOURCE_LOCK_DIR, key + '.lock')
  const owner = `${process.pid}:${randomUUID()}`
  const candidate = `${lock}.${process.pid}.${randomUUID()}.tmp`
  await fs.writeFile(candidate, owner, { flag: 'wx' })
  let acquired = false
  try {
    const deadline = Date.now() + SOURCE_WAIT_MS
    while (!acquired) {
      signal?.throwIfAborted()
      try { await fs.link(candidate, lock); acquired = true }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        cached = await readReusableImageCache(channelKey, messageId, entry)
        if (cached) return cached
        if (!await getImageEntry(channelKey, messageId)) return null
        const existing = await fs.readFile(lock, 'utf8').catch(() => '')
        if (existing && !isProcessAlive(Number(existing.split(':')[0]))) {
          if (await fs.readFile(lock, 'utf8').catch(() => '') === existing) await fs.unlink(lock).catch(() => {})
        }
        if (Date.now() >= deadline) {
          console.warn(`[image-source] source_wait_timeout target=${key}`)
          return null
        }
        await new Promise(resolve => setTimeout(resolve, 100))
      }
    }

    // 排队期间另一进程可能已经填充缓存或淘汰记录，领取后必须再次读取。
    entry = await getImageEntry(channelKey, messageId)
    if (!entry) return null
    cached = await readReusableImageCache(channelKey, messageId, entry)
    if (cached) return cached
    let base64: string | null = null
    let failure = ''
    // 图片附件只使用 get_file；平台图片只使用 get_image，本地协议路径由真实消息段提供。
    if (entry.file) {
      try {
        if (entry.file.startsWith('file://')) base64 = await readImageAsBase64(fileURLToPath(entry.file), reason => { failure = reason }, signal)
        else {
          const info = entry.sourceKind === 'attachment' ? await callGetFile(entry.file, signal) : await callGetImage(entry.file, signal)
          signal?.throwIfAborted()
          if (info?.file) base64 = await readImageAsBase64(String(info.file), reason => { failure = reason }, signal)
          if (failure) throw new Error(failure)
          if (!base64 && entry.sourceKind === 'attachment' && info?.url) base64 = await downloadImageAsBase64(String(info.url), 10000, reason => { failure = reason }, signal)
        }
      } catch (error) {
        if (failure) throw new Error(failure)
        console.warn(`[image-source] onebot_get_image_failed target=${key} detail=${error instanceof Error ? error.message : String(error)}`)
      }
    }
    if (failure) throw new Error(failure)
    signal?.throwIfAborted()
    if (!base64 && entry.url) base64 = await downloadImageAsBase64(entry.url, 10000, reason => { failure = reason }, signal)
    if (failure) throw new Error(failure)
    if (!base64) {
      console.warn(`[image-source] source_unavailable target=${key}`)
      return null
    }
    const actual = await validateImageContent(base64)
    const buffer = Buffer.from(base64.replace(/^data:[^;]+;base64,/, ''), 'base64')
    if (entry.declaredMime && entry.declaredMime.split(';')[0] !== actual.mime) console.warn(`[image-source] mime_mismatch target=${key} actual=${actual.mime}`)
    if (!buffer.length || buffer.length > MAX_IMAGE_BYTES) {
      console.warn(`[image-source] image_size_limit target=${key}`)
      return null
    }
    // 缓存接口持有记录所有权并复检有效性；失效记录不能因下载完成被复活。
    if (!await cacheImageFile(channelKey, messageId, buffer)) return null
    return readCachedImage(channelKey, messageId)
  } finally {
    await fs.unlink(candidate).catch(() => {})
    if (acquired && await fs.readFile(lock, 'utf8').catch(() => '') === owner) await fs.unlink(lock).catch(() => {})
  }
}

// --- 共用原图入口 --- //

// 合并当前进程的同目标读取，容量满时直接退让，不新增内存下载队列。
async function readImageSourceResult(channelKey: string, messageId: string, signal?: AbortSignal): Promise<ImageReadResult> {
  if (!channelKey || !messageId) return Promise.resolve({ dataUrl: null, reason: 'source_unavailable' })
  const entry = await getImageEntry(channelKey, messageId)
  if (!entry) return { dataUrl: null, reason: 'source_unavailable' }
  messageId = entry.imageId || messageId
  const key = getSourceKey(channelKey, entry.file ? JSON.stringify([entry.sourceKind || 'image', entry.file]) : messageId)
  const active = inFlight.get(key)
  if (active) return active
  if (inFlight.size >= MAX_ACTIVE_READS) {
    console.warn(`[image-source] source_capacity_full target=${key}`)
    return Promise.resolve({ dataUrl: null, reason: 'source_capacity_full' })
  }
  const work = loadImageSource(channelKey, messageId, key, signal).then(async dataUrl => {
    if (!dataUrl) return { dataUrl: null, reason: 'source_unavailable' }
    // 旧缓存同样完整验证，不能绕过大小和内容校验。
    const actual = await validateImageContent(dataUrl)
    return { dataUrl: dataUrl.replace(/^data:[^;]+;/, `data:${actual.mime};`), reason: '', ...actual }
  }).catch(error => {
    console.warn(`[image-source] source_failed target=${key} detail=${error instanceof Error ? error.message : String(error)}`)
    const code = error instanceof Error ? error.message : ''
    return { dataUrl: null, reason: ['image_too_large', 'image_empty', 'image_invalid', 'image_unsupported_format'].includes(code) ? code : 'image_invalid_or_unavailable' }
  }).finally(() => {
    if (inFlight.get(key) === work) inFlight.delete(key)
  })
  inFlight.set(key, work)
  return work
}

// 既有单图入口保持返回契约，共用逐目标读取和校验结果。
async function readImageSource(channelKey: string, messageId: string): Promise<string | null> {
  return (await readImageSourceResult(channelKey, messageId)).dataUrl
}

// 回收崩溃进程遗留的下载锁及候选文件，活所有者始终保留。
async function cleanupImageSourceLocks(): Promise<number> {
  let removed = 0
  for (const entry of await fs.readdir(SOURCE_LOCK_DIR, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isFile() || !/^[a-f0-9]{64}\.lock(?:\.\d+\.[\w-]+\.tmp)?$/.test(entry.name)) continue
    const file = path.join(SOURCE_LOCK_DIR, entry.name)
    const owner = await fs.readFile(file, 'utf8').catch(() => '')
    const pid = Number(owner.split(':')[0] || entry.name.match(/\.lock\.(\d+)\./)?.[1])
    const stat = await fs.stat(file).catch(() => null)
    if (isProcessAlive(pid) || (!pid && (!stat || Date.now() - stat.mtimeMs < 60000))) continue
    if (await fs.readFile(file, 'utf8').catch(() => '') === owner) {
      try { await fs.unlink(file); removed++ } catch { /* 已由执行者或并行维护移除。 */ }
    }
  }
  return removed
}

export = { readImageSource, readImageSourceResult, cleanupImageSourceLocks }
