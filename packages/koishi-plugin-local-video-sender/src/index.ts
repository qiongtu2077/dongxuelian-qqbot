import type { ExecFileOptions } from 'child_process'

const { segment } = require('koishi')
const { execFile } = require('child_process')
const fsSync = require('fs') as typeof import('fs')
const fs = require('fs/promises') as typeof import('fs/promises')
const path = require('path') as typeof import('path')
const { pathToFileURL } = require('url') as typeof import('url')

const name = 'local-video-sender'

const DEFAULT_MAX_SIZE = 200 * 1024 * 1024
const YTDLP = process.env.BILI_YTDLP || '/usr/local/bin/yt-dlp'
const COOKIES = process.env.BILI_COOKIES_FILE || '/root/bilibili-cookies.txt'
const WORKDIR = process.env.BILI_WORKDIR || '/root/koishi-bili-downloads'

interface LoggerLike {
  warn(...args: unknown[]): void
}

interface CommandLike {
  action(handler: (argv: { session: VideoSessionLike }, text?: string) => unknown): CommandLike
}

interface ContextLike {
  command(name: string, desc: string): CommandLike
  middleware(handler: (session: VideoSessionLike, next: () => unknown) => unknown): unknown
  logger(name: string): LoggerLike
}

interface VideoSessionLike {
  userId?: string | number
  guildId?: string | number
  channelId?: string | number
  isDirect?: boolean
  content?: string
  author?: { id?: string | number }
  event?: {
    user?: { id?: string | number }
    sender?: { userId?: string | number, id?: string | number }
  }
  send(message: unknown): Promise<unknown>
}

interface RuntimeConfig {
  ytdlp: string
  cookies: string
  workdir: string
  maxSize: number
  testVideoFile: string
  videoBlacklistFile: string
  videoMinMemMb: number
}

interface VideoFormat {
  format_id?: string | number
  format_note?: string
  ext?: string
  filesize?: number
  filesize_approx?: number
  height?: number
  fps?: number
  abr?: number
  vcodec?: string
  acodec?: string
  url?: string
}

interface VideoInfo {
  title?: string
  thumbnail?: string
  webpage_url?: string
  original_url?: string
  url?: string
  id?: string
  display_id?: string
  duration?: number
  formats?: VideoFormat[]
}

interface FormatCandidate {
  format: string
  label: string
}

interface FormatPick {
  format: string
  label: string
  totalSize: number
  height: number
}

interface RunResult {
  stdout: string
  stderr: string
}

interface ProbeResult {
  info?: VideoInfo
  picked?: FormatPick
  error?: string
}

type VideoFsApi = Pick<typeof fs, 'mkdir' | 'stat' | 'rm'>

interface DownloadDeps {
  fs?: VideoFsApi
  run?: typeof run
  probeVideo?: typeof probeVideo
  resourceGate?: false
}

interface VideoResourceGateHandle {
  updateStep(step: string, memAvailableMb?: number | null): void
  release(reason?: string): void
}

interface VideoResourceGateResult {
  ok: boolean
  message?: string
  handle?: VideoResourceGateHandle | null
}

type VideoAdmissionModule = typeof import('../../koishi-plugin-dongxuelian-ai/lib/resource-scheduler/admission')
type VideoResourceGateModule = typeof import('../../koishi-plugin-dongxuelian-ai/lib/resource-gate/gate')

interface VideoResourceModules {
  admitTask: VideoAdmissionModule['admitTask']
  acquireResourceGate: VideoResourceGateModule['acquireResourceGate']
}

interface RecentParseEntry {
  timestamp: number
  keys: string[]
}

interface VideoBlacklistCache {
  fingerprint: string
  groups: Set<string>
  users: Set<string>
}

interface ExecFileError extends Error {
  stdout?: string
  stderr?: string
}

function resolveRuntimeDataDir(): string {
  const configured = String(process.env.DONGXUELIAN_AI_DATA_DIR || '').trim()
  if (configured) return path.resolve(configured)
  const koishiDir = String(process.env.KOISHI_DIR || process.env.KOISHI_APP_DIR || '').trim()
  if (koishiDir) return path.resolve(koishiDir, 'data')
  return path.resolve(process.cwd(), 'data')
}

const DATA_DIR = resolveRuntimeDataDir()
const VIDEO_BLACKLIST_FILE = process.env.BILI_VIDEO_BLACKLIST_FILE || path.join(DATA_DIR, 'video-blacklist.json')
const MAX_SIZE = parsePositiveInteger(process.env.BILI_MAX_SIZE_BYTES, DEFAULT_MAX_SIZE)
const TEST_VIDEO_FILE = process.env.BILI_TEST_VIDEO_FILE || '/root/test_bili.mp4'
const VIDEO_MIN_MEM_MB = parsePositiveInteger(process.env.BILI_MIN_MEM_MB, 450)
const MIN_720_HEIGHT = 700
const MAX_720_HEIGHT = 720
const PREFERRED_MAX_HEIGHT = 720
const DUPLICATE_WINDOW_MS = 60 * 1000
const DUPLICATE_HISTORY_LIMIT = 3
const MAX_YTDLP_STDIO_BYTES = 1024 * 1024
const MAX_VIDEO_BLACKLIST_BYTES = 128 * 1024
const EXTERNAL_VIDEO_TASK_KIND = 'external_video_download'
const VIDEO_RESOURCE_BUSY_MESSAGE = '服务器内存紧张，视频搬运稍后再试。'
const VIDEO_RESOURCE_UNAVAILABLE_MESSAGE = '资源系统不可用，视频下载暂时关闭。'

const recentParseHistory = new Map<string, RecentParseEntry[]>()
let videoBlacklistCache: VideoBlacklistCache = {
  fingerprint: '',
  groups: new Set(),
  users: new Set(),
}

function parsePositiveInteger(value: unknown, fallback: number): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback
}

function toFileUrl(filePath: string): string {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(String(filePath))) return String(filePath)
  return pathToFileURL(filePath).href
}

function getRuntimeConfig(): RuntimeConfig {
  return {
    ytdlp: YTDLP,
    cookies: COOKIES,
    workdir: WORKDIR,
    maxSize: MAX_SIZE,
    testVideoFile: TEST_VIDEO_FILE,
    videoBlacklistFile: VIDEO_BLACKLIST_FILE,
    videoMinMemMb: VIDEO_MIN_MEM_MB,
  }
}

const FORMAT_CANDIDATES: FormatCandidate[] = [
  { format: '30064+30280', label: '720P AVC' },
  { format: '30066+30280', label: '720P HEVC' },
  { format: '100024+30280', label: '720P AV1' },
]

const SINGLE_FILE_CANDIDATES: FormatCandidate[] = [
  { format: '64', label: '720P single file' },
  { format: '32', label: '480P single file' },
  { format: '16', label: '360P single file' },
]

function run(file: string, args: string[], options: ExecFileOptions = {}): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { maxBuffer: MAX_YTDLP_STDIO_BYTES, ...options }, (error: ExecFileError | null, stdout: string, stderr: string) => {
      if (error) {
        error.stdout = stdout
        error.stderr = stderr
        reject(error)
      } else {
        resolve({ stdout, stderr })
      }
    })
  })
}

// 将资源任务标识压成文件锁可接受的短字符串。
function sanitizeResourceId(value: unknown, fallback: string = 'unknown'): string {
  const text = String(value || fallback).replace(/[^a-zA-Z0-9_.:-]/g, '_').slice(0, 120)
  return text || fallback
}

// 计算 sibling AI 插件 lib 产物路径，避免本插件引入编译期跨包依赖。
function getAiResourceLibPath(...parts: string[]): string {
  return path.join(__dirname, '..', '..', 'koishi-plugin-dongxuelian-ai', 'lib', ...parts)
}

// 运行时加载 S1/S0 模块；缺失时 fail closed，防止无门控下载。
function loadVideoResourceModules(ctx: ContextLike): VideoResourceModules | null {
  try {
    const admission = require(getAiResourceLibPath('resource-scheduler', 'admission')) as VideoAdmissionModule
    const gate = require(getAiResourceLibPath('resource-gate', 'gate')) as VideoResourceGateModule
    if (typeof admission.admitTask !== 'function' || typeof gate.acquireResourceGate !== 'function') {
      throw new Error('resource modules missing admitTask/acquireResourceGate')
    }
    return { admitTask: admission.admitTask, acquireResourceGate: gate.acquireResourceGate }
  } catch (error) {
    ctx.logger('bvidl').warn(`resource gate unavailable: ${getErrorMessage(error)}`)
    return null
  }
}

// 为视频下载任务生成跨插件可识别的频道键。
function getVideoChannelKey(session: VideoSessionLike): string {
  return String(session.guildId || session.channelId || (session.isDirect ? `private:${session.userId || 'unknown'}` : 'unknown'))
}

// 从 Koishi session 的多种形态中提取触发用户 ID。
function getVideoUserId(session: VideoSessionLike): string {
  return String(session.userId || session.author?.id || session.event?.user?.id || session.event?.sender?.userId || session.event?.sender?.id || '')
}

// 生成一次外部视频下载任务的 S0/S1 追踪 ID。
function buildVideoTaskId(session: VideoSessionLike, source: string): string {
  const channelKey = sanitizeResourceId(getVideoChannelKey(session))
  const sourceKey = sanitizeResourceId(source || 'bili')
  return `${EXTERNAL_VIDEO_TASK_KIND}-${channelKey}-${sourceKey}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

// 在启动 yt-dlp 前申请 S1 准入和 S0 独占锁。
async function acquireVideoResourceGate(ctx: ContextLike, session: VideoSessionLike, source: string, deps: DownloadDeps = {}): Promise<VideoResourceGateResult> {
  if (deps.resourceGate === false) return { ok: true, handle: null }
  const modules = loadVideoResourceModules(ctx)
  if (!modules) return { ok: false, message: VIDEO_RESOURCE_UNAVAILABLE_MESSAGE }

  const taskId = buildVideoTaskId(session, source)
  const channelKey = getVideoChannelKey(session)
  const userId = getVideoUserId(session)
  const admission = modules.admitTask({
    taskId,
    kind: EXTERNAL_VIDEO_TASK_KIND,
    source: 'local-video-sender',
    channelKey,
    userId,
    exclusive: true,
    priority: 75,
    minMemMb: VIDEO_MIN_MEM_MB,
    deferable: false,
    queueTimeoutMs: 5000,
    runTimeoutMs: 900000,
  })
  if (admission.decision !== 'run_now') {
    ctx.logger('bvidl').warn(`video download rejected by resource scheduler: ${admission.reason || admission.decision}; state=${admission.resourceState || 'unknown'} mem=${admission.memAvailableMb ?? 'unknown'}MB min=${VIDEO_MIN_MEM_MB}MB`)
    return { ok: false, message: VIDEO_RESOURCE_BUSY_MESSAGE }
  }

  try {
    const handle = await modules.acquireResourceGate({
      taskId,
      kind: EXTERNAL_VIDEO_TASK_KIND,
      owner: 'local-video-sender',
      channelKey,
      userId,
      priority: 75,
      timeoutMs: 900000,
      waitTimeoutMs: 5000,
      pollMs: 500,
      memAvailableMb: admission.memAvailableMb,
      step: 'video_prepare',
    })
    return { ok: true, handle }
  } catch (error) {
    ctx.logger('bvidl').warn(`video download gate wait failed: ${getErrorMessage(error)}`)
    return { ok: false, message: VIDEO_RESOURCE_BUSY_MESSAGE }
  }
}

function normalizeSharedText(input: string = ''): string {
  let text = String(input)

  for (let index = 0; index < 3; index++) {
    const previous = text
    text = text
      .replace(/\\\//g, '/')
      .replace(/&amp;/g, '&')
      .replace(/&quot;/g, '"')
      .replace(/&#44;/g, ',')
      .replace(/&#91;/g, '[')
      .replace(/&#93;/g, ']')
      .replace(/&#123;/g, '{')
      .replace(/&#125;/g, '}')
      .replace(/&#58;/g, ':')
      .replace(/\\u([0-9a-fA-F]{4})/g, (_, code: string) => String.fromCharCode(parseInt(code, 16)))

    try {
      const decoded = decodeURIComponent(text)
      if (decoded !== text) text = decoded
    } catch { /* non-critical: malformed shared text can continue undecoded */
    }

    if (text === previous) break
  }

  return text
}

function uniqueStrings(values: unknown[] = []): string[] {
  return [...new Set(values.filter(Boolean).map(value => String(value)))]
}

function normalizeBiliIdentifier(identifier: string = ''): string {
  const value = String(identifier).trim()
  if (!value) return ''
  return `bv:${value.replace(/^bv/i, '').toLowerCase()}`
}

function normalizeBiliUrlKey(input: string = ''): string {
  const value = normalizeSharedText(input).trim()
  if (!value) return ''

  try {
    const parsed = new URL(value)
    const host = parsed.hostname.toLowerCase()
    const pathname = parsed.pathname.replace(/\/+$/, '')
    if (!host) return ''
    return `url:${host}${pathname.toLowerCase()}`
  } catch {
    return `url:${value.replace(/[?#].*$/, '').replace(/\/+$/, '').toLowerCase()}`
  }
}

function extractBiliUrl(input: string = ''): string | null {
  const text = normalizeSharedText(input)
  const urlMatch = text.match(/https?:\/\/(?:www\.bilibili\.com|m\.bilibili\.com|bilibili\.com|b23\.tv)\/[^\s"'<>\\\]}),，。！？、]+/i)
  if (urlMatch) return urlMatch[0]

  const bvMatch = text.match(/\bBV[0-9A-Za-z]{10}\b/i)
  if (bvMatch) return `https://www.bilibili.com/video/${bvMatch[0]}`

  return null
}

function buildBiliKeys(input: string = ''): string[] {
  const text = normalizeSharedText(input)
  const keys: string[] = []
  const bvMatches = text.match(/\bBV[0-9A-Za-z]{10}\b/gi) || []

  for (const bv of bvMatches) {
    keys.push(normalizeBiliIdentifier(bv))
  }

  const url = extractBiliUrl(text)
  if (url) keys.push(normalizeBiliUrlKey(url))

  return uniqueStrings(keys)
}

function getParseChannelKey(session: VideoSessionLike): string {
  return String(session.guildId || session.channelId || session.userId || 'private')
}

function getGroupBlacklistCandidates(session: VideoSessionLike): string[] {
  const ids: string[] = []
  if (session.guildId) ids.push(String(session.guildId))
  if (!session.isDirect && session.channelId) ids.push(String(session.channelId))
  return [...new Set(ids.filter(Boolean))]
}

function getUserBlacklistCandidates(session: VideoSessionLike): string[] {
  return uniqueStrings([
    session.userId,
    session.author?.id,
    session.event?.user?.id,
    session.event?.sender?.userId,
    session.event?.sender?.id,
  ])
}

function getFileFingerprint(filePath: string): string {
  try {
    const stat = fsSync.statSync(filePath)
    return `${stat.mtimeMs}:${stat.size}`
  } catch {
    return 'missing'
  }
}

function parseStringList(value: unknown): string[] {
  return Array.isArray(value) ? uniqueStrings(value) : []
}

function loadVideoBlacklist(force: boolean = false): VideoBlacklistCache {
  const fingerprint = getFileFingerprint(VIDEO_BLACKLIST_FILE)
  if (!force && videoBlacklistCache.fingerprint === fingerprint) return videoBlacklistCache

  let groups: string[] = []
  let users: string[] = []
  if (fingerprint !== 'missing') {
    try {
      const stat = fsSync.statSync(VIDEO_BLACKLIST_FILE)
      if (!stat.isFile() || stat.size > MAX_VIDEO_BLACKLIST_BYTES) throw new Error('video blacklist too large')
      const raw: unknown = JSON.parse(fsSync.readFileSync(VIDEO_BLACKLIST_FILE, 'utf8'))
      groups = Array.isArray(raw) ? parseStringList(raw) : raw && typeof raw === 'object' && Array.isArray((raw as { groups?: unknown }).groups) ? parseStringList((raw as { groups?: unknown }).groups) : []
      users = raw && typeof raw === 'object' && Array.isArray((raw as { users?: unknown }).users) ? parseStringList((raw as { users?: unknown }).users) : []
    } catch {
      groups = []
      users = []
    }
  }

  videoBlacklistCache = {
    fingerprint,
    groups: new Set(uniqueStrings(groups)),
    users: new Set(uniqueStrings(users)),
  }
  return videoBlacklistCache
}

function isBlacklistedGroup(session: VideoSessionLike): boolean {
  const blacklist = loadVideoBlacklist()
  return getGroupBlacklistCandidates(session).some(groupId => blacklist.groups.has(groupId)) ||
    getUserBlacklistCandidates(session).some(userId => blacklist.users.has(userId))
}

function pruneRecentParseHistory(session: VideoSessionLike, now: number = Date.now()): RecentParseEntry[] {
  const channelKey = getParseChannelKey(session)
  const history = recentParseHistory.get(channelKey) || []
  const nextHistory = history
    .filter(entry => now - entry.timestamp <= DUPLICATE_WINDOW_MS)
    .slice(-DUPLICATE_HISTORY_LIMIT)

  if (nextHistory.length) {
    recentParseHistory.set(channelKey, nextHistory)
  } else {
    recentParseHistory.delete(channelKey)
  }

  return nextHistory
}

function isRecentDuplicateParse(session: VideoSessionLike, keys: string[], now: number = Date.now()): boolean {
  if (!keys.length) return false
  const history = pruneRecentParseHistory(session, now)
  return history.some(entry => entry.keys.some(key => keys.includes(key)))
}

function rememberRecentParse(session: VideoSessionLike, keys: string[], now: number = Date.now()): RecentParseEntry | null {
  if (!keys.length) return null

  const history = pruneRecentParseHistory(session, now)
  const entry = {
    timestamp: now,
    keys: uniqueStrings(keys),
  }

  history.push(entry)
  recentParseHistory.set(getParseChannelKey(session), history.slice(-DUPLICATE_HISTORY_LIMIT))
  return entry
}

// Removes a failed parse attempt so the same link can be retried immediately.
function forgetRecentParse(session: VideoSessionLike, entry: RecentParseEntry | null): void {
  if (!entry) return

  const channelKey = getParseChannelKey(session)
  const history = recentParseHistory.get(channelKey) || []
  const nextHistory = history.filter(item => item !== entry)
  if (nextHistory.length) {
    recentParseHistory.set(channelKey, nextHistory)
  } else {
    recentParseHistory.delete(channelKey)
  }
}

function mergeRecentParseKeys(entry: RecentParseEntry | null, keys: string[]): void {
  if (!entry || !keys.length) return
  entry.keys = uniqueStrings(entry.keys.concat(keys))
}

function getCanonicalBiliUrl(info: VideoInfo = {}): string {
  const source = info.webpage_url || info.original_url || ''
  const bvMatch = source.match(/\bBV[0-9A-Za-z]{10}\b/i)
  if (bvMatch) {
    return `https://www.bilibili.com/video/${bvMatch[0]}/`
  }
  return source ? source.split('?')[0] : ''
}

function getShortestBiliUrl(info: VideoInfo = {}): string {
  const values = [
    info.webpage_url,
    info.original_url,
    info.url,
    info.id,
    info.display_id,
  ].filter(Boolean)

  for (const value of values) {
    const match = String(value).match(/\bBV[0-9A-Za-z]{10}\b/i)
    if (match) return `https://b23.tv/${match[0]}`
  }

  return getCanonicalBiliUrl(info)
}

function safeNumber(value: unknown): number {
  return Number.isFinite(value) ? Number(value) : 0
}

function estimateFormatSize(format: VideoFormat): number {
  return safeNumber(format.filesize) || safeNumber(format.filesize_approx)
}

function isAudioOnlyFormat(format: VideoFormat): boolean {
  return !!(format && format.vcodec === 'none' && format.acodec && format.acodec !== 'none')
}

function isVideoFormat(format: VideoFormat): boolean {
  return !!(format && format.vcodec && format.vcodec !== 'none')
}

function pickBestAudio(formats: VideoFormat[]): VideoFormat | undefined {
  return formats
    .filter(isAudioOnlyFormat)
    .sort((left, right) => {
      const abrDiff = safeNumber(right.abr) - safeNumber(left.abr)
      if (abrDiff) return abrDiff
      return estimateFormatSize(right) - estimateFormatSize(left)
    })[0]
}

function sortVideoCandidates(left: VideoFormat, right: VideoFormat, targetHeight: number = PREFERRED_MAX_HEIGHT): number {
  const leftHeight = safeNumber(left.height)
  const rightHeight = safeNumber(right.height)
  const leftDistance = Math.abs(leftHeight - targetHeight)
  const rightDistance = Math.abs(rightHeight - targetHeight)
  if (leftDistance !== rightDistance) return leftDistance - rightDistance

  const leftPreferred = leftHeight <= targetHeight ? 1 : 0
  const rightPreferred = rightHeight <= targetHeight ? 1 : 0
  if (leftPreferred !== rightPreferred) return rightPreferred - leftPreferred

  const heightDiff = rightHeight - leftHeight
  if (heightDiff) return heightDiff

  const fpsDiff = safeNumber(right.fps) - safeNumber(left.fps)
  if (fpsDiff) return fpsDiff

  return estimateFormatSize(right) - estimateFormatSize(left)
}

function buildSplitPick(video: VideoFormat, audio: VideoFormat, label: string): FormatPick {
  return {
    format: `${video.format_id}+${audio.format_id}`,
    label,
    totalSize: estimateFormatSize(video) + estimateFormatSize(audio),
    height: safeNumber(video.height),
  }
}

function pickFormat(info: VideoInfo): FormatPick | null {
  const formats = Array.isArray(info.formats) ? info.formats : []

  for (const candidate of FORMAT_CANDIDATES) {
    const [videoId, audioId] = candidate.format.split('+')
    const video = formats.find(item => String(item.format_id) === videoId)
    const audio = formats.find(item => String(item.format_id) === audioId)
    if (!video || !audio) continue

    const totalSize = estimateFormatSize(video) + estimateFormatSize(audio)

    return {
      format: candidate.format,
      label: candidate.label,
      totalSize,
      height: safeNumber(video.height),
    }
  }

  const audio = pickBestAudio(formats)

  const exact720Candidates = formats
    .filter(item => {
      const height = safeNumber(item.height)
      return isVideoFormat(item) && height >= MIN_720_HEIGHT && height <= MAX_720_HEIGHT
    })
    .sort((left, right) => sortVideoCandidates(left, right, PREFERRED_MAX_HEIGHT))

  if (exact720Candidates.length && audio) {
    return buildSplitPick(exact720Candidates[0], audio, `${safeNumber(exact720Candidates[0].height)}P split stream`)
  }

  const preferredVideoCandidates = formats
    .filter(item => {
      const height = safeNumber(item.height)
      return isVideoFormat(item) && height > 0 && height <= PREFERRED_MAX_HEIGHT
    })
    .sort((left, right) => sortVideoCandidates(left, right, PREFERRED_MAX_HEIGHT))

  if (preferredVideoCandidates.length && audio) {
    return buildSplitPick(preferredVideoCandidates[0], audio, `${safeNumber(preferredVideoCandidates[0].height)}P split stream`)
  }

  for (const candidate of SINGLE_FILE_CANDIDATES) {
    const merged = formats.find(item => String(item.format_id) === candidate.format)
    if (!merged) continue

    return {
      format: candidate.format,
      label: candidate.label,
      totalSize: estimateFormatSize(merged),
      height: safeNumber(merged.height),
    }
  }

  const anyVideoCandidates = formats
    .filter(item => isVideoFormat(item) && safeNumber(item.height) > 0)
    .sort((left, right) => sortVideoCandidates(left, right, PREFERRED_MAX_HEIGHT))

  if (anyVideoCandidates.length && audio) {
    return buildSplitPick(anyVideoCandidates[0], audio, `${safeNumber(anyVideoCandidates[0].height)}P fallback split stream`)
  }

  const anyMergedCandidates = formats
    .filter(item => isVideoFormat(item) && item.acodec && item.acodec !== 'none')
    .sort((left, right) => sortVideoCandidates(left, right, PREFERRED_MAX_HEIGHT))

  if (anyMergedCandidates.length) {
    const merged = anyMergedCandidates[0]
    return {
      format: String(merged.format_id),
      label: `${safeNumber(merged.height)}P fallback single file`,
      totalSize: estimateFormatSize(merged),
      height: safeNumber(merged.height),
    }
  }

  return null
}

function formatBytes(bytes: number): string {
  if (!bytes) return 'unknown'
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`
}

function formatDuration(seconds: number): string {
  seconds = Math.floor(safeNumber(seconds))
  if (!seconds) return 'unknown'

  const minutes = Math.floor(seconds / 60)
  const rest = seconds % 60
  return `${minutes}:${String(rest).padStart(2, '0')}`
}

function formatVideoInfo(info: VideoInfo, picked: FormatPick): string {
  const shortestUrl = getShortestBiliUrl(info)
  return [
    info.title || 'Unknown title',
    segment.image(info.thumbnail),
    shortestUrl,
  ].filter(Boolean).join('\n')
}

function buildInfoMessage(info: VideoInfo, picked: FormatPick): string {
  return formatVideoInfo(info, picked)
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function getCommandErrorMessage(error: unknown): string {
  if (error && typeof error === 'object') {
    const commandError = error as { stderr?: unknown, message?: unknown }
    return String(commandError.stderr || commandError.message || error)
  }
  return String(error)
}

async function safeSend(ctx: ContextLike, session: VideoSessionLike, message: unknown, label: string = 'message'): Promise<boolean> {
  try {
    await session.send(message)
    return true
  } catch (error) {
    ctx.logger('bvidl').warn(`${label} send failed: ${getErrorMessage(error)}`)
    return false
  }
}

async function probeVideo(url: string): Promise<ProbeResult> {
  const { stdout } = await run(YTDLP, [
    '--cookies', COOKIES,
    '--dump-single-json',
    '--no-warnings',
    url,
  ], { timeout: 2 * 60 * 1000 })

  const info = JSON.parse(stdout) as VideoInfo
  const picked = pickFormat(info)

  if (!picked) {
    return { error: 'No available video format found.' }
  }

  return { info, picked }
}

// 探测、下载并发送 B 站视频；真正启动 yt-dlp 前必须先通过 S1/S0。
async function downloadAndSend(ctx: ContextLike, session: VideoSessionLike, url: string, source: string = url, deps: DownloadDeps = {}): Promise<string | undefined> {
  if (isBlacklistedGroup(session)) {
    return
  }

  const now = Date.now()
  const initialKeys = buildBiliKeys(source)

  if (isRecentDuplicateParse(session, initialKeys, now)) {
    return
  }

  const recentEntry = rememberRecentParse(session, initialKeys, now)
  const gateResult = await acquireVideoResourceGate(ctx, session, source, deps)
  if (!gateResult.ok) {
    forgetRecentParse(session, recentEntry)
    return gateResult.message || VIDEO_RESOURCE_BUSY_MESSAGE
  }
  const gateHandle = gateResult.handle || null

  try {
    const fsApi = deps.fs || fs
    const runCommand = deps.run || run
    const probe = deps.probeVideo || probeVideo

    try {
      await fsApi.mkdir(WORKDIR, { recursive: true })
    } catch (error) {
      forgetRecentParse(session, recentEntry)
      ctx.logger('bvidl').warn(getErrorMessage(error))
      return 'Failed to prepare download directory. Please check logs later.'
    }

    let info: VideoInfo
    let picked: FormatPick
    gateHandle?.updateStep('video_probe')
    try {
      const result = await probe(url)
      if (result.error) {
        forgetRecentParse(session, recentEntry)
        return result.error
      }
      if (!result.info || !result.picked) {
        forgetRecentParse(session, recentEntry)
        return 'No available video format found.'
      }
      info = result.info
      picked = result.picked
    } catch (error) {
      forgetRecentParse(session, recentEntry)
      ctx.logger('bvidl').warn(getCommandErrorMessage(error))
      return 'Failed to probe video. Please try again later.'
    }

    mergeRecentParseKeys(recentEntry, buildBiliKeys(getCanonicalBiliUrl(info)))

    gateHandle?.updateStep('video_preview')
    const previewSent = await safeSend(ctx, session, buildInfoMessage(info, picked), 'preview')
    if (!previewSent) {
      forgetRecentParse(session, recentEntry)
      return 'Failed to send video preview. Please try again later.'
    }

    if (picked.totalSize && picked.totalSize > MAX_SIZE) {
      return `视频太大（${formatBytes(picked.totalSize)}），无法通过 QQ 发送，建议去 B 站观看。`
    }

    const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`
    const outputTemplate = path.join(WORKDIR, `${id}.%(ext)s`)
    const outputFile = path.join(WORKDIR, `${id}.mp4`)

    gateHandle?.updateStep('video_download')
    try {
      await runCommand(YTDLP, [
        '--cookies', COOKIES,
        '-f', picked.format,
        '--merge-output-format', 'mp4',
        '-o', outputTemplate,
        url,
      ], { timeout: 10 * 60 * 1000 })

      const stat = await fsApi.stat(outputFile)
      if (stat.size > MAX_SIZE) {
        await fsApi.rm(outputFile, { force: true }).catch(() => { /* non-critical: oversized temp cleanup is best-effort */
        })
        return `视频太大（${formatBytes(stat.size)}），无法通过 QQ 发送，建议去 B 站观看。`
      }

      gateHandle?.updateStep('video_send')
      const videoSent = await safeSend(ctx, session, segment.video(toFileUrl(outputFile)), 'video')
      if (!videoSent) {
        forgetRecentParse(session, recentEntry)
        await fsApi.rm(outputFile, { force: true }).catch(() => { /* non-critical: failed-send temp cleanup is best-effort */
        })
        return 'Failed to send video. Please try again later.'
      }
      await fsApi.rm(outputFile, { force: true }).catch(() => { /* non-critical: sent video temp cleanup is best-effort */
      })
    } catch (error) {
      forgetRecentParse(session, recentEntry)
      await fsApi.rm(outputFile, { force: true }).catch(() => { /* non-critical: failed download temp cleanup is best-effort */
      })
      ctx.logger('bvidl').warn(getCommandErrorMessage(error))
      return 'Failed to download or send video. Please check logs later.'
    }
  } finally {
    try { gateHandle?.release('external-video-finally') } catch { /* non-critical: release failure is already reflected by stale lock checks */
    }
  }
}

function apply(ctx: ContextLike): void {
  ctx.command('sendtestvideo', 'send local test video').action(() => {
    return segment.video(toFileUrl(TEST_VIDEO_FILE))
  })

  ctx.command('bvidl <text:text>', 'download and send Bilibili video').action(async ({ session }, text) => {
    if (isBlacklistedGroup(session)) return

    const url = extractBiliUrl(text)
    if (!url) return 'Usage: bvidl Bilibili_URL_or_BV_ID'
    return downloadAndSend(ctx, session, url, text || url)
  })

  ctx.middleware(async (session, next) => {
    if (isBlacklistedGroup(session)) return next()

    const content = session.content || ''
    if (/^\s*bvidl\b/i.test(content)) return next()

    const url = extractBiliUrl(content)
    if (!url) return next()

    return downloadAndSend(ctx, session, url, content)
  })
}

const clearRecentParseHistory = (): void => recentParseHistory.clear()

export = {
  name,
  apply,
  extractBiliUrl,
  buildBiliKeys,
  pickFormat,
  getShortestBiliUrl,
  downloadAndSend,
  getRuntimeConfig,
  toFileUrl,
  safeSend,
  isBlacklistedGroup,
  loadVideoBlacklist,
  isRecentDuplicateParse,
  rememberRecentParse,
  clearRecentParseHistory,
}
