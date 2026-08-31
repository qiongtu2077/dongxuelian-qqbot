/**
 * MODULE: Bilibili Cookie 文件边界。
 * 职责: 统一运行路径、严格校验 Netscape Cookie 文件，并提供无敏感信息的动态健康摘要与原子替换。
 * 边界: 不加载 Koishi、不执行 yt-dlp、不记录 Cookie 行、名称或值。
 */
const crypto = require('crypto') as typeof import('crypto')
const fs = require('fs') as typeof import('fs')
const path = require('path') as typeof import('path')
const { TextDecoder } = require('util') as typeof import('util')

export type CookieValidationResult =
  | { ok: true, recordCount: number }
  | { ok: false, code: string, line?: number }

export type StrictBase64DecodeResult =
  | { ok: true, buffer: Buffer }
  | { ok: false, code: 'invalid_base64' | 'file_too_large' | 'empty_file' }

export interface BiliCookieHealth {
  ok: boolean
  path: string
  recordCount: number
  size: number
  mtimeMs: number
  code: string
}

interface CookieHealthCacheEntry {
  fingerprint: string
  health: BiliCookieHealth
}

export interface AtomicCookieWriteOptions {
  fsApi?: typeof fs
  randomBytes?: (size: number) => Buffer
}

export interface AtomicCookieWriteResult {
  path: string
  size: number
  recordCount: number
  mode: number
}

export const MAX_BILI_COOKIE_FILE_BYTES = 4 * 1024 * 1024
const NETSCAPE_COOKIE_HEADER = '# Netscape HTTP Cookie File'
const cookieHealthCache = new Map<string, CookieHealthCacheEntry>()

// 将运行数据目录和可选环境变量解析为视频插件与 Dashboard 共用的唯一 Cookie 路径。
export function resolveBiliCookiePath(dataDir: string, envValue: unknown = ''): string {
  const configured = String(envValue || '').trim()
  return configured ? path.resolve(configured) : path.resolve(dataDir, 'bilibili-cookies.txt')
}

// 按固定顺序验证 Netscape Cookie 文件结构，错误结果只包含代码和行号。
export function validateNetscapeCookieFile(buffer: Buffer): CookieValidationResult {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) return { ok: false, code: 'empty_file' }
  if (buffer.length > MAX_BILI_COOKIE_FILE_BYTES) return { ok: false, code: 'file_too_large' }
  if (buffer.includes(0)) return { ok: false, code: 'nul_byte' }

  let text = ''
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(buffer)
  } catch {
    return { ok: false, code: 'invalid_utf8' }
  }

  const lines = text.split(/\r?\n/)
  const firstContentIndex = lines.findIndex(line => line.trim().length > 0)
  if (firstContentIndex < 0) return { ok: false, code: 'empty_file' }
  if (lines[firstContentIndex].trim() !== NETSCAPE_COOKIE_HEADER) {
    return { ok: false, code: 'missing_header', line: firstContentIndex + 1 }
  }

  let recordCount = 0
  for (let index = firstContentIndex + 1; index < lines.length; index++) {
    const rawLine = lines[index]
    if (!rawLine.trim() || (/^\s*#/.test(rawLine) && !/^#HttpOnly_/.test(rawLine))) continue
    const columns = rawLine.split('\t')
    if (columns.length !== 7) return { ok: false, code: 'invalid_column_count', line: index + 1 }
    const [domain, includeSubdomains, cookiePath, secure, expires, name] = columns
    if (!domain || !name) return { ok: false, code: 'empty_required_field', line: index + 1 }
    if (!['TRUE', 'FALSE'].includes(includeSubdomains) || !['TRUE', 'FALSE'].includes(secure)) {
      return { ok: false, code: 'invalid_boolean', line: index + 1 }
    }
    if (!cookiePath.startsWith('/')) return { ok: false, code: 'invalid_path', line: index + 1 }
    if (!/^\d+$/.test(expires)) return { ok: false, code: 'invalid_expires', line: index + 1 }
    recordCount += 1
  }
  return recordCount > 0 ? { ok: true, recordCount } : { ok: false, code: 'empty_records' }
}

// 严格解码规范 base64，并在返回 Buffer 前执行上传大小门禁。
export function decodeStrictBase64(input: unknown, maxBytes: number): StrictBase64DecodeResult {
  const raw = String(input || '').trim()
  if (!raw) return { ok: false, code: 'empty_file' }
  const safeMaxBytes = Math.max(1, Math.floor(maxBytes))
  if (raw.length > Math.ceil(safeMaxBytes / 3) * 4 + 4) return { ok: false, code: 'file_too_large' }
  if (raw.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(raw)) {
    return { ok: false, code: 'invalid_base64' }
  }
  const buffer = Buffer.from(raw, 'base64')
  if (buffer.length > safeMaxBytes) return { ok: false, code: 'file_too_large' }
  if (buffer.toString('base64') !== raw) return { ok: false, code: 'invalid_base64' }
  return buffer.length > 0 ? { ok: true, buffer } : { ok: false, code: 'empty_file' }
}

// 根据 path、size 和 mtime 指纹缓存校验结果，文件变化后自动重新读取并校验。
export function getBiliCookieHealth(filePath: string): BiliCookieHealth {
  const resolvedPath = path.resolve(filePath)
  let stat: import('fs').Stats
  try {
    stat = fs.statSync(resolvedPath)
  } catch (error) {
    const code = String((error as NodeJS.ErrnoException)?.code || 'file_unavailable')
    const fingerprint = `missing:${code}`
    const cached = cookieHealthCache.get(resolvedPath)
    if (cached?.fingerprint === fingerprint) return cached.health
    const health = { ok: false, path: resolvedPath, recordCount: 0, size: 0, mtimeMs: 0, code }
    cookieHealthCache.set(resolvedPath, { fingerprint, health })
    return health
  }
  const fingerprint = `${stat.size}:${stat.mtimeMs}`
  const cached = cookieHealthCache.get(resolvedPath)
  if (cached?.fingerprint === fingerprint) return cached.health
  if (!stat.isFile()) {
    const health = { ok: false, path: resolvedPath, recordCount: 0, size: stat.size, mtimeMs: stat.mtimeMs, code: 'not_file' }
    cookieHealthCache.set(resolvedPath, { fingerprint, health })
    return health
  }
  let validation: CookieValidationResult
  try {
    validation = validateNetscapeCookieFile(fs.readFileSync(resolvedPath))
  } catch (error) {
    validation = { ok: false, code: String((error as NodeJS.ErrnoException)?.code || 'read_failed') }
  }
  const health: BiliCookieHealth = validation.ok
    ? { ok: true, path: resolvedPath, recordCount: validation.recordCount, size: stat.size, mtimeMs: stat.mtimeMs, code: 'ok' }
    : { ok: false, path: resolvedPath, recordCount: 0, size: stat.size, mtimeMs: stat.mtimeMs, code: validation.code }
  cookieHealthCache.set(resolvedPath, { fingerprint, health })
  return health
}

// 清空运行健康缓存，供插件关闭和测试隔离使用。
export function clearBiliCookieHealthCache(): void {
  cookieHealthCache.clear()
}

// 删除本次事务的临时文件；清理失败交由原始写入异常继续向上报告。
function removeTemporaryFile(fsApi: typeof fs, filePath: string): void {
  try { fsApi.rmSync(filePath, { force: true }) } catch { /* 原始事务错误优先返回。 */ }
}

// 在正式目标已被替换后恢复原文件内容，保证失败响应不会丢失旧有效 Cookie。
function restorePreviousCookieFile(fsApi: typeof fs, target: string, backup: string, hadPrevious: boolean): void {
  if (hadPrevious) {
    fsApi.copyFileSync(backup, target)
    return
  }
  removeTemporaryFile(fsApi, target)
}

// 用同目录临时文件完成 sync、权限收紧、校验和原子替换，失败时恢复旧正式文件。
export function replaceBiliCookieFileAtomic(filePath: string, buffer: Buffer, options: AtomicCookieWriteOptions = {}): AtomicCookieWriteResult {
  const validation = validateNetscapeCookieFile(buffer)
  if (!validation.ok) throw Object.assign(new Error(validation.code), { code: validation.code, line: validation.line })
  const fsApi = options.fsApi || fs
  const randomBytes = options.randomBytes || crypto.randomBytes
  const target = path.resolve(filePath)
  const directory = path.dirname(target)
  const token = randomBytes(8).toString('hex')
  const temporary = path.join(directory, `.${path.basename(target)}.${token}.tmp`)
  const backup = path.join(directory, `.${path.basename(target)}.${token}.backup.tmp`)
  let descriptor: number | null = null
  let targetReplaced = false
  let hadPrevious = false
  fsApi.mkdirSync(directory, { recursive: true })
  try {
    hadPrevious = fsApi.existsSync(target)
    if (hadPrevious) {
      fsApi.copyFileSync(target, backup)
      fsApi.chmodSync(backup, 0o600)
    }
    descriptor = fsApi.openSync(temporary, 'wx', 0o600)
    fsApi.writeFileSync(descriptor, buffer)
    fsApi.fsyncSync(descriptor)
    fsApi.closeSync(descriptor)
    descriptor = null
    fsApi.chmodSync(temporary, 0o600)
    const temporaryValidation = validateNetscapeCookieFile(fsApi.readFileSync(temporary))
    if (!temporaryValidation.ok) throw Object.assign(new Error(temporaryValidation.code), { code: temporaryValidation.code, line: temporaryValidation.line })
    fsApi.renameSync(temporary, target)
    targetReplaced = true
    fsApi.chmodSync(target, 0o600)
    const finalStat = fsApi.statSync(target)
    const finalValidation = validateNetscapeCookieFile(fsApi.readFileSync(target))
    if (!finalStat.isFile() || !finalValidation.ok || finalStat.size !== buffer.length) throw new Error('cookie_file_post_write_verification_failed')
    const observedMode = finalStat.mode & 0o777
    if (process.platform !== 'win32' && observedMode !== 0o600) throw new Error('cookie_file_mode_verification_failed')
    clearBiliCookieHealthCache()
    return { path: target, size: finalStat.size, recordCount: finalValidation.recordCount, mode: process.platform === 'win32' ? 0o600 : observedMode }
  } catch (error) {
    if (descriptor !== null) {
      try { fsApi.closeSync(descriptor) } catch { /* 关闭失败不覆盖原始错误。 */ }
    }
    if (targetReplaced) restorePreviousCookieFile(fsApi, target, backup, hadPrevious)
    throw error
  } finally {
    removeTemporaryFile(fsApi, temporary)
    removeTemporaryFile(fsApi, backup)
  }
}
