import type { ExecFileOptions } from 'child_process'

const { segment } = require('koishi')
const { execFile } = require('child_process')
const fsSync = require('fs') as typeof import('fs')
const fs = require('fs/promises') as typeof import('fs/promises')
const path = require('path') as typeof import('path')
const { pathToFileURL } = require('url') as typeof import('url')
const biliInput = require('./bili-input') as typeof import('./bili-input')
const {
  buildBiliKeys,
  extractBvId,
  extractBiliUrl,
  isAllowedBiliRedirectUrl,
  isPrivateIpAddress,
  normalizeBiliP1Url,
  normalizeSharedText,
  resolveBiliShortLink,
  uniqueStrings,
} = biliInput
type ResolvedBiliInput = import('./bili-input').ResolvedBiliInput

const name = 'local-video-sender'

const DEFAULT_MAX_SIZE = 60_000_000
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
  middleware(handler: (session: VideoSessionLike, next: () => unknown) => unknown, prepend?: boolean): unknown
  logger(name: string): LoggerLike
  on?(event: 'dispose', handler: () => unknown): unknown
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
  bot?: {
    internal?: {
      sendPrivateMsg?: (userId: string, message: unknown) => Promise<unknown> | unknown
    }
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
  userError?: VideoUserError
}

type VideoFsApi = Pick<typeof fs, 'mkdir' | 'stat' | 'rm'>
type StagingFsApi = Pick<typeof fs, 'lstat' | 'realpath' | 'rm' | 'stat' | 'readFile'>

type VideoUserErrorNumber =
  | '001' | '002' | '003' | '004' | '005' | '006' | '007' | '008' | '009'
  | '010' | '011' | '012' | '013' | '014' | '015' | '016' | '017' | '018'
  | '019' | '020' | '021' | '022' | '023' | '024' | '025' | '026' | '027'

type VideoUserErrorId = `video-${VideoUserErrorNumber}`

interface VideoUserError {
  id: VideoUserErrorId
  message: string
  stage: string
}

type StaticVideoUserErrorId =
  | 'video-001' | 'video-003' | 'video-006' | 'video-007' | 'video-008' | 'video-009'
  | 'video-010' | 'video-013' | 'video-014' | 'video-016' | 'video-017' | 'video-018'
  | 'video-019' | 'video-020' | 'video-023' | 'video-025' | 'video-027'

type VideoUserErrorInput =
  | { id: StaticVideoUserErrorId }
  | { id: 'video-002', remainingSeconds: number }
  | { id: 'video-004', resourceState: string, availableMemoryMb: number, minimumMemoryMb: number, decision: string }
  | { id: 'video-005', resourceState: string, minimumMemoryMb: number, decision: string }
  | { id: 'video-011', bvId: string, partNumber: number }
  | { id: 'video-012' | 'video-022' | 'video-024' | 'video-026', retcode: number }
  | { id: 'video-015', estimatedBytes: number }
  | { id: 'video-021', actualBytes: number }

type SendOutcome =
  | { status: 'confirmed' }
  | { status: 'uncertain', reason: 'timeout', error: string }
  | { status: 'failed', reason: 'rejected', retcode: number, error: string }
  | { status: 'failed', reason: 'call_error', error: string }

type StagingPrepareResult =
  | { status: 'ready', path: string }
  | { status: 'create_failed', path: string, error: unknown }
  | { status: 'safety_validation_failed', path: string }

type StagingValidationResult =
  | { status: 'safe' }
  | { status: 'missing' }
  | { status: 'rejected', error: string }
  | { status: 'failed', code: string, error: string }

interface StagingCleanupFailure {
  event: 'staging_cleanup_failed' | 'staging_cleanup_rejected'
  taskId: string
  bvId: string
  stagingDir: string
  errorCode: string
  errorText: string
  beijingTime: string
}

interface StagingCleanupOptions {
  fs?: StagingFsApi
  adminIdsFile?: string
  now?: number
}

type AdminIdLoadResult =
  | { status: 'ready', ids: string[], invalidCount: number }
  | { status: 'failed', code: string, error: string }

interface RecentDuplicateMatch {
  entry: RecentParseEntry
  remainingSeconds: number
}

interface DownloadDeps {
  fs?: VideoFsApi
  run?: typeof run
  probeVideo?: typeof probeVideo
  createStagingDirectory?: typeof createRequestStagingDirectory
  removeStagingDirectory?: typeof removeRequestStagingDirectory
  resolveShortLink?: typeof resolveBiliShortLink
  resourceModules?: VideoResourceModules | null
  resourceGate?: false
}

interface DownloadRequestOptions {
  explicitCommand?: boolean
}

interface VideoResourceGateHandle {
  updateStep(step: string, memAvailableMb?: number | null): void
  release(reason?: string): void
}

interface VideoResourceGateResult {
  ok: boolean
  userError?: VideoUserError
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

interface VideoFileCacheEntry {
  primaryKey: string
  bvKey: string
  aliases: string[]
  filePath: string
  sizeBytes: number
  infoMessage: string
  createdAt: number
  expiresAt: number
  hardCleanupAt: number
  activeSends: number
  lastSendStatus: SendOutcome['status']
  expired: boolean
  expiryTimer: NodeJS.Timeout | null
}

type SharedVideoResult =
  | { kind: 'cached', entry: VideoFileCacheEntry }
  | { kind: 'rejected', infoMessage: string, userError: VideoUserError }
  | { kind: 'failed', userError: VideoUserError }
  | { kind: 'sent' }

interface VideoBlacklistCache {
  fingerprint: string
  groups: Set<string>
  users: Set<string>
}

interface ExecFileError extends Error {
  code?: string | number
  signal?: NodeJS.Signals | string
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
const ADMIN_IDS_FILE = path.join(DATA_DIR, 'ai-admin-ids.json')
const VIDEO_BLACKLIST_FILE = process.env.BILI_VIDEO_BLACKLIST_FILE || path.join(DATA_DIR, 'video-blacklist.json')
const MAX_SIZE = parsePositiveInteger(process.env.BILI_MAX_SIZE_BYTES, DEFAULT_MAX_SIZE)
const TEST_VIDEO_FILE = process.env.BILI_TEST_VIDEO_FILE || '/root/test_bili.mp4'
const VIDEO_MIN_MEM_MB = Math.max(300, parsePositiveInteger(process.env.BILI_MIN_MEM_MB, 300))
const MIN_720_HEIGHT = 700
const MAX_720_HEIGHT = 720
const PREFERRED_MAX_HEIGHT = 720
const DUPLICATE_WINDOW_MS = 300 * 1000
const DUPLICATE_HISTORY_LIMIT = 3
const VIDEO_CACHE_TTL_MS = 5 * 60 * 1000
const VIDEO_CACHE_HARD_CLEANUP_MS = 10 * 60 * 1000
const VIDEO_CACHE_SWEEP_MS = 60 * 1000
const MAX_YTDLP_STDIO_BYTES = 1024 * 1024
const MAX_VIDEO_BLACKLIST_BYTES = 128 * 1024
const MAX_ADMIN_IDS_BYTES = 128 * 1024
const EXTERNAL_VIDEO_TASK_KIND = 'external_video_download'
const CACHE_FILE_RE = /^bili-cache-[a-z0-9]+-\d+-[a-z0-9]+\.mp4$/
const STAGING_DIR_RE = /^bili-job-[a-z0-9]+-\d+-[a-z0-9]+$/
const CACHE_DIR = path.join(WORKDIR, 'cache')
const STAGING_ROOT = path.join(WORKDIR, '.staging')

const STATIC_VIDEO_USER_ERRORS: Record<StaticVideoUserErrorId, { stage: string, message: string }> = {
  'video-001': { stage: 'command_usage', message: '视频解析命令格式错误。详细信息：请在“bvidl”后填写B站链接；也可以填写BV号。错误编号：video-001。' },
  'video-003': { stage: 'resource_module_load', message: '视频下载暂时关闭。详细信息：视频资源门禁模块加载失败。错误编号：video-003。' },
  'video-006': { stage: 'resource_gate_acquire', message: '视频搬运暂时无法执行，请稍后再试。详细信息：视频资源锁在5秒内未申请成功。错误编号：video-006。' },
  'video-007': { stage: 'workdir_create', message: '视频目录准备失败，请稍后再试。详细信息：视频工作目录创建失败。错误编号：video-007。' },
  'video-008': { stage: 'cache_dir_create', message: '视频目录准备失败，请稍后再试。详细信息：五分钟视频缓存目录创建失败。错误编号：video-008。' },
  'video-009': { stage: 'staging_root_create', message: '视频目录准备失败，请稍后再试。详细信息：下载暂存根目录创建失败。错误编号：video-009。' },
  'video-010': { stage: 'video_probe', message: '视频信息获取失败，请稍后再试。详细信息：视频信息探测命令执行失败。错误编号：video-010。' },
  'video-013': { stage: 'preview_send_call', message: '视频信息发送失败，请稍后再试。详细信息：封面、标题和链接消息调用接口失败。错误编号：video-013。' },
  'video-014': { stage: 'size_estimate', message: '视频文件大小无法预估，请自行去 bilibili 观看。详细信息：所选清晰度缺少可用的文件大小、码率和时长数据。错误编号：video-014。' },
  'video-016': { stage: 'staging_create', message: '视频目录准备失败，请稍后再试。详细信息：本次下载的独立暂存目录创建失败。错误编号：video-016。' },
  'video-017': { stage: 'staging_validate', message: '视频目录准备失败，请稍后再试。详细信息：本次下载的独立暂存目录未通过安全校验。错误编号：video-017。' },
  'video-018': { stage: 'video_download', message: '视频下载失败，请稍后再试。详细信息：视频下载命令执行失败。错误编号：video-018。' },
  'video-019': { stage: 'output_path_validate', message: '视频文件校验失败，请稍后再试。详细信息：下载结果未通过视频缓存路径安全校验。错误编号：video-019。' },
  'video-020': { stage: 'output_stat', message: '视频文件校验失败，请稍后再试。详细信息：下载结果的文件信息读取失败。错误编号：video-020。' },
  'video-023': { stage: 'video_send_call', message: '视频发送失败，请稍后再试。详细信息：视频发送接口调用失败。错误编号：video-023。' },
  'video-025': { stage: 'cached_preview_send_call', message: '缓存视频信息发送失败，请稍后再试。详细信息：缓存视频的封面、标题和链接消息调用接口失败。错误编号：video-025。' },
  'video-027': { stage: 'cached_video_send_call', message: '缓存视频发送失败，请稍后再试。详细信息：缓存视频发送接口调用失败。错误编号：video-027。' },
}

const RESOURCE_STATE_LABELS: Record<string, string> = {
  green: '正常',
  yellow: '注意',
  red: '紧张',
}

const ADMISSION_DECISION_LABELS: Record<string, string> = {
  reject: '拒绝',
  defer: '延后',
  queue: '排队',
  downgrade: '降级',
  silent_drop: '静默丢弃',
}

const recentParseHistory = new Map<string, RecentParseEntry[]>()
const videoFileCache = new Map<string, VideoFileCacheEntry>()
const videoCacheAliases = new Map<string, string>()
const inflightDownloads = new Map<string, Promise<SharedVideoResult>>()
let videoCacheSweepTimer: NodeJS.Timeout | null = null
let cacheDisposed = false
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
async function acquireVideoResourceGate(ctx: ContextLike, session: VideoSessionLike, source: string, deps: DownloadDeps = {}, existingTaskId: string = ''): Promise<VideoResourceGateResult> {
  if (deps.resourceGate === false) return { ok: true, handle: null }
  const modules = Object.prototype.hasOwnProperty.call(deps, 'resourceModules') ? deps.resourceModules || null : loadVideoResourceModules(ctx)
  if (!modules) {
    const userError = buildVideoUserError({ id: 'video-003' })
    logVideoUserError(ctx, userError)
    return { ok: false, userError }
  }

  const taskId = existingTaskId || buildVideoTaskId(session, source)
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
    const userError = typeof admission.memAvailableMb === 'number' && Number.isFinite(admission.memAvailableMb)
      ? buildVideoUserError({
        id: 'video-004',
        resourceState: admission.resourceState,
        availableMemoryMb: admission.memAvailableMb,
        minimumMemoryMb: VIDEO_MIN_MEM_MB,
        decision: admission.decision,
      })
      : buildVideoUserError({
        id: 'video-005',
        resourceState: admission.resourceState,
        minimumMemoryMb: VIDEO_MIN_MEM_MB,
        decision: admission.decision,
      })
    logVideoUserError(ctx, userError)
    return { ok: false, userError }
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
    const userError = buildVideoUserError({ id: 'video-006' })
    logVideoUserError(ctx, userError)
    return { ok: false, userError }
  }
}

// 按固定编号生成只包含安全动态数据的中文用户报错。
function buildVideoUserError(input: VideoUserErrorInput): VideoUserError {
  switch (input.id) {
    case 'video-002': {
      const remainingSeconds = Math.min(300, Math.max(1, Math.ceil(safeNumber(input.remainingSeconds))))
      return {
        id: input.id,
        stage: 'duplicate_request',
        message: `请勿在短时间内重复解析。详细信息：当前群对相同视频的300秒限制仍在生效，剩余${remainingSeconds}秒。错误编号：video-002。`,
      }
    }
    case 'video-004': {
      const resourceState = RESOURCE_STATE_LABELS[String(input.resourceState)] || '未识别'
      const decision = ADMISSION_DECISION_LABELS[String(input.decision)] || '未识别'
      const availableMemoryMb = Math.max(0, Math.round(safeNumber(input.availableMemoryMb)))
      const minimumMemoryMb = Math.max(1, Math.round(safeNumber(input.minimumMemoryMb)))
      return {
        id: input.id,
        stage: 'resource_admission_with_memory',
        message: `视频搬运暂时无法执行，请稍后再试。详细信息：资源状态为${resourceState}，当前可用内存${availableMemoryMb}MB，视频任务最低需要${minimumMemoryMb}MB，调度结果为${decision}。错误编号：video-004。`,
      }
    }
    case 'video-005': {
      const resourceState = RESOURCE_STATE_LABELS[String(input.resourceState)] || '未识别'
      const decision = ADMISSION_DECISION_LABELS[String(input.decision)] || '未识别'
      const minimumMemoryMb = Math.max(1, Math.round(safeNumber(input.minimumMemoryMb)))
      return {
        id: input.id,
        stage: 'resource_admission_without_memory',
        message: `视频搬运暂时无法执行，请稍后再试。详细信息：资源状态为${resourceState}，当前可用内存数据未取得，视频任务最低需要${minimumMemoryMb}MB，调度结果为${decision}。错误编号：video-005。`,
      }
    }
    case 'video-011': {
      const bvMatch = String(input.bvId || '').match(/^BV[0-9A-Za-z]{10}$/i)
      const partNumber = Math.max(1, Math.floor(safeNumber(input.partNumber)))
      const target = bvMatch ? `${bvMatch[0]}第${partNumber}P` : `当前链接第${partNumber}P`
      return {
        id: input.id,
        stage: 'format_select',
        message: `视频信息获取失败，请稍后再试。详细信息：${target}未找到可用的视频格式。错误编号：video-011。`,
      }
    }
    case 'video-012':
      return {
        id: input.id,
        stage: 'preview_send_rejected',
        message: `视频信息发送失败，请稍后再试。详细信息：封面、标题和链接消息被消息接口拒绝，返回码为${Math.trunc(input.retcode)}。错误编号：video-012。`,
      }
    case 'video-015': {
      const estimatedBytes = Math.max(0, Math.round(safeNumber(input.estimatedBytes)))
      return {
        id: input.id,
        stage: 'estimated_size_limit',
        message: `视频文件过大（${formatDecimalMb(estimatedBytes)}），请自行去 bilibili 观看。详细信息：预计大小为${estimatedBytes}字节，上传限制为${MAX_SIZE}字节。错误编号：video-015。`,
      }
    }
    case 'video-021': {
      const actualBytes = Math.max(0, Math.round(safeNumber(input.actualBytes)))
      return {
        id: input.id,
        stage: 'actual_size_limit',
        message: `视频文件过大（${formatDecimalMb(actualBytes)}），请自行去 bilibili 观看。详细信息：实际大小为${actualBytes}字节，上传限制为${MAX_SIZE}字节。错误编号：video-021。`,
      }
    }
    case 'video-022':
      return {
        id: input.id,
        stage: 'video_send_rejected',
        message: `视频发送失败，请稍后再试。详细信息：视频发送请求被消息接口拒绝，返回码为${Math.trunc(input.retcode)}。错误编号：video-022。`,
      }
    case 'video-024':
      return {
        id: input.id,
        stage: 'cached_preview_send_rejected',
        message: `缓存视频信息发送失败，请稍后再试。详细信息：缓存视频的封面、标题和链接消息被消息接口拒绝，返回码为${Math.trunc(input.retcode)}。错误编号：video-024。`,
      }
    case 'video-026':
      return {
        id: input.id,
        stage: 'cached_video_send_rejected',
        message: `缓存视频发送失败，请稍后再试。详细信息：缓存视频发送请求被消息接口拒绝，返回码为${Math.trunc(input.retcode)}。错误编号：video-026。`,
      }
    default: {
      const definition = STATIC_VIDEO_USER_ERRORS[input.id]
      return { id: input.id, stage: definition.stage, message: definition.message }
    }
  }
}

// 记录用户错误编号和固定阶段，原始技术详情只进入服务端日志。
function logVideoUserError(ctx: ContextLike, userError: VideoUserError, technicalDetail: string = ''): void {
  const suffix = technicalDetail ? ` detail=${technicalDetail}` : ''
  ctx.logger('bvidl').warn(`user_error_id=${userError.id} stage=${userError.stage}${suffix}`)
}

// 将主插件上下文适配到独立的 B 站输入与短链安全边界。
async function resolveInputBiliTarget(ctx: ContextLike, url: string, source: string, deps: DownloadDeps = {}): Promise<ResolvedBiliInput> {
  return biliInput.resolveBiliInput({
    url,
    source,
    resolveShortLink: deps.resolveShortLink,
    onError: message => ctx.logger('bvidl').warn(`short link resolution failed: ${message}`),
  })
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
    .filter(entry => now - entry.timestamp < DUPLICATE_WINDOW_MS)
    .slice(-DUPLICATE_HISTORY_LIMIT)

  if (nextHistory.length) {
    recentParseHistory.set(channelKey, nextHistory)
  } else {
    recentParseHistory.delete(channelKey)
  }

  return nextHistory
}

// 返回当前群命中的重复记录和剩余限制秒数。
function findRecentDuplicateParse(session: VideoSessionLike, keys: string[], now: number = Date.now()): RecentDuplicateMatch | null {
  if (!keys.length) return null
  const history = pruneRecentParseHistory(session, now)
  const entry = history.find(item => item.keys.some(key => keys.includes(key)))
  if (!entry) return null
  const remainingMs = Math.max(1, DUPLICATE_WINDOW_MS - Math.max(0, now - entry.timestamp))
  return { entry, remainingSeconds: Math.ceil(remainingMs / 1000) }
}

// 判断当前群是否仍处于相同视频的重复解析窗口。
function isRecentDuplicateParse(session: VideoSessionLike, keys: string[], now: number = Date.now()): boolean {
  return !!findRecentDuplicateParse(session, keys, now)
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

// 生成十进制 MB 文案，和 60,000,000 字节业务阈值保持同一单位。
function formatDecimalMb(bytes: number): string {
  return `${(Math.max(0, safeNumber(bytes)) / 1_000_000).toFixed(1)} MB`
}

// 生成下载前预计体积超限的详细中文提示。
function buildOversizeMessage(bytes: number): string {
  return buildVideoUserError({ id: 'video-015', estimatedBytes: bytes }).message
}

// 生成下载后实际体积超限的详细中文提示。
function buildActualOversizeMessage(bytes: number): string {
  return buildVideoUserError({ id: 'video-021', actualBytes: bytes }).message
}

// --- 视频缓存与暂存目录安全 ---

// 检查缓存文件路径、类型和真实位置均留在专用缓存目录内。
function isSafeVideoCacheFile(filePath: string): boolean {
  try {
    const cacheRoot = path.resolve(CACHE_DIR)
    const resolved = path.resolve(filePath)
    if (!resolved.startsWith(`${cacheRoot}${path.sep}`) || !CACHE_FILE_RE.test(path.basename(resolved))) return false
    const stat = fsSync.lstatSync(resolved)
    if (!stat.isFile() || stat.isSymbolicLink()) return false
    const realRoot = fsSync.realpathSync(cacheRoot)
    const realFile = fsSync.realpathSync(resolved)
    return realFile.startsWith(`${realRoot}${path.sep}`)
  } catch {
    return false
  }
}

// 判断路径是否为暂存根目录下命名合规的直接子目录。
function isStagingPathShapeSafe(stagingDir: string): boolean {
  const stagingRoot = path.resolve(STAGING_ROOT)
  const resolved = path.resolve(stagingDir)
  return path.dirname(resolved) === stagingRoot && STAGING_DIR_RE.test(path.basename(resolved))
}

// 读取系统错误码；缺少错误码时返回固定占位值。
function getNodeErrorCode(error: unknown, fallback: string = 'UNKNOWN'): string {
  const code = error && typeof error === 'object' ? (error as NodeJS.ErrnoException).code : ''
  return typeof code === 'string' && code.trim() ? code.trim() : fallback
}

// 校验暂存目录类型与真实路径，并保留读取失败的准确原因。
async function validateStagingDirectory(stagingDir: string, fsApi: StagingFsApi = fs): Promise<StagingValidationResult> {
  const resolved = path.resolve(stagingDir)
  if (!isStagingPathShapeSafe(resolved)) return { status: 'rejected', error: '暂存目录不是暂存根目录下命名合规的直接子目录' }

  let stat: Awaited<ReturnType<StagingFsApi['lstat']>>
  try {
    stat = await fsApi.lstat(resolved)
  } catch (error) {
    if (getNodeErrorCode(error) === 'ENOENT') return { status: 'missing' }
    return { status: 'failed', code: getNodeErrorCode(error), error: `读取暂存目录信息失败：${getErrorMessage(error)}` }
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) return { status: 'rejected', error: '暂存目标不是普通目录或目标是符号链接' }

  let realRoot: string
  try {
    realRoot = await fsApi.realpath(STAGING_ROOT)
  } catch (error) {
    return { status: 'failed', code: getNodeErrorCode(error), error: `解析暂存根目录真实路径失败：${getErrorMessage(error)}` }
  }

  let realDir: string
  try {
    realDir = await fsApi.realpath(resolved)
  } catch (error) {
    if (getNodeErrorCode(error) === 'ENOENT') return { status: 'missing' }
    return { status: 'failed', code: getNodeErrorCode(error), error: `解析暂存目录真实路径失败：${getErrorMessage(error)}` }
  }
  if (path.dirname(realDir) !== realRoot) return { status: 'rejected', error: '暂存目录真实路径已离开暂存根目录' }
  return { status: 'safe' }
}

// 校验暂存目录是否可以由当前任务安全删除。
async function isSafeStagingDirectory(stagingDir: string, fsApi: StagingFsApi = fs): Promise<boolean> {
  return (await validateStagingDirectory(stagingDir, fsApi)).status === 'safe'
}

// 为单次首次下载创建权限受限的暂存目录，并返回精确失败阶段。
async function createRequestStagingDirectory(cacheSlug: string): Promise<StagingPrepareResult> {
  const stagingName = `bili-job-${cacheSlug}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const stagingDir = path.join(STAGING_ROOT, stagingName)
  try {
    await fs.mkdir(stagingDir, { mode: 0o700 })
  } catch (error) {
    return { status: 'create_failed', path: stagingDir, error }
  }
  if (!await isSafeStagingDirectory(stagingDir)) {
    return { status: 'safety_validation_failed', path: stagingDir }
  }
  return { status: 'ready', path: stagingDir }
}

// 把时间转换为固定的北京时间文本。
function formatBeijingTime(now: number = Date.now()): string {
  const parts = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(now))
  const values = Object.fromEntries(parts.map(item => [item.type, item.value]))
  return `${values.year}-${values.month}-${values.day} ${values.hour}:${values.minute}:${values.second}`
}

// 清理错误文本中的换行、完整地址和登录凭据路径。
function sanitizeStagingCleanupError(error: unknown): string {
  return getErrorMessage(error)
    .replace(/https?:\/\/\S+/gi, '[url]')
    .split(COOKIES).join('[cookies-file]')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 1000) || '未提供错误文本'
}

// 从运行数据目录读取并严格筛选纯数字超级管理员账号。
async function loadStagingCleanupAdminIds(adminIdsFile: string, fsApi: StagingFsApi): Promise<AdminIdLoadResult> {
  try {
    const stat = await fsApi.stat(adminIdsFile)
    if (!stat.isFile()) return { status: 'failed', code: 'ADMIN_IDS_NOT_FILE', error: '超级管理员名单路径不是普通文件' }
    if (stat.size > MAX_ADMIN_IDS_BYTES) return { status: 'failed', code: 'ADMIN_IDS_TOO_LARGE', error: `超级管理员名单文件超过${MAX_ADMIN_IDS_BYTES}字节` }
  } catch (error) {
    return { status: 'failed', code: getNodeErrorCode(error), error: `读取超级管理员名单文件信息失败：${sanitizeStagingCleanupError(error)}` }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(String(await fsApi.readFile(adminIdsFile, 'utf8')))
  } catch (error) {
    return { status: 'failed', code: 'ADMIN_IDS_INVALID_JSON', error: `超级管理员名单不是有效 JSON：${sanitizeStagingCleanupError(error)}` }
  }
  if (!Array.isArray(parsed)) return { status: 'failed', code: 'ADMIN_IDS_NOT_ARRAY', error: '超级管理员名单顶层结构不是数组' }

  const values = parsed.map(value => value === null || value === undefined ? '' : String(value).trim())
  const ids = [...new Set(values.filter(value => /^\d+$/.test(value)))]
  const invalidCount = values.filter(value => !/^\d+$/.test(value)).length
  if (!ids.length) return { status: 'failed', code: 'ADMIN_IDS_EMPTY', error: '超级管理员名单中没有有效的纯数字 QQ 号' }
  return { status: 'ready', ids, invalidCount }
}

// 构造发给超级管理员的固定清理失败文本。
function buildStagingCleanupAdminMessage(failure: StagingCleanupFailure): string {
  return [
    '【视频暂存目录清理失败】',
    `任务：${failure.taskId}`,
    `视频：${failure.bvId}`,
    `暂存目录：${failure.stagingDir}`,
    `错误码：${failure.errorCode}`,
    `错误信息：${failure.errorText}`,
    `时间：${failure.beijingTime}`,
    '请登录服务器人工处理。',
  ].join('\n')
}

// 将一次清理失败逐个私聊给有效超级管理员，不重试失败通知。
async function notifyStagingCleanupFailure(ctx: ContextLike, session: VideoSessionLike, failure: StagingCleanupFailure, options: StagingCleanupOptions): Promise<void> {
  const fsApi = options.fs || fs
  const adminIdsFile = options.adminIdsFile || ADMIN_IDS_FILE
  const adminResult = await loadStagingCleanupAdminIds(adminIdsFile, fsApi)
  if (adminResult.status === 'failed') {
    ctx.logger('bvidl').warn(`staging_cleanup_admin_ids_unavailable: file=${JSON.stringify(path.resolve(adminIdsFile))} code=${adminResult.code} error=${JSON.stringify(adminResult.error)}`)
    return
  }
  if (adminResult.invalidCount > 0) {
    ctx.logger('bvidl').warn(`staging_cleanup_admin_ids_invalid: invalid_count=${adminResult.invalidCount}`)
  }

  const internal = session.bot?.internal
  const sendPrivateMsg = internal?.sendPrivateMsg
  if (typeof sendPrivateMsg !== 'function') {
    ctx.logger('bvidl').warn(`staging_cleanup_admin_notify_unavailable: reason=sendPrivateMsg_unavailable admin_count=${adminResult.ids.length}`)
    return
  }

  const message = buildStagingCleanupAdminMessage(failure)
  await Promise.all(adminResult.ids.map(async adminId => {
    try {
      await sendPrivateMsg.call(internal, adminId, message)
    } catch (error) {
      ctx.logger('bvidl').warn(`staging_cleanup_admin_notify_failed: admin=${adminId} code=${getNodeErrorCode(error)} error=${JSON.stringify(sanitizeStagingCleanupError(error))}`)
    }
  }))
}

// 记录并通知同一份结构化暂存目录清理失败信息。
async function reportStagingCleanupFailure(ctx: ContextLike | null, session: VideoSessionLike, failure: StagingCleanupFailure, options: StagingCleanupOptions): Promise<void> {
  if (!ctx) return
  ctx.logger('bvidl').warn(`${failure.event}: task=${failure.taskId} bv=${failure.bvId} dir=${JSON.stringify(failure.stagingDir)} code=${failure.errorCode} error=${JSON.stringify(failure.errorText)} beijing_time=${JSON.stringify(failure.beijingTime)}`)
  await notifyStagingCleanupFailure(ctx, session, failure, options)
}

// 在当前任务 finally 中安全删除一次暂存目录；失败时只告警，不重删。
async function removeRequestStagingDirectory(ctx: ContextLike | null, session: VideoSessionLike, stagingDir: string, bvId: string, taskId: string, options: StagingCleanupOptions = {}): Promise<boolean> {
  const fsApi = options.fs || fs
  const resolved = path.resolve(stagingDir)
  const normalizedBvId = extractBvId(bvId) || 'unknown'
  const normalizedTaskId = String(taskId || '').trim() || 'unknown'
  const validation = await validateStagingDirectory(resolved, fsApi)
  if (validation.status === 'missing') return true
  if (validation.status === 'rejected' || validation.status === 'failed') {
    const failure: StagingCleanupFailure = {
      event: validation.status === 'rejected' ? 'staging_cleanup_rejected' : 'staging_cleanup_failed',
      taskId: normalizedTaskId,
      bvId: normalizedBvId,
      stagingDir: resolved,
      errorCode: validation.status === 'rejected' ? 'SAFETY_VALIDATION_FAILED' : validation.code,
      errorText: sanitizeStagingCleanupError(validation.error),
      beijingTime: formatBeijingTime(options.now),
    }
    await reportStagingCleanupFailure(ctx, session, failure, options)
    return false
  }

  try {
    await fsApi.rm(resolved, { recursive: true, force: true })
    return true
  } catch (error) {
    if (getNodeErrorCode(error) === 'ENOENT') return true
    const failure: StagingCleanupFailure = {
      event: 'staging_cleanup_failed',
      taskId: normalizedTaskId,
      bvId: normalizedBvId,
      stagingDir: resolved,
      errorCode: getNodeErrorCode(error),
      errorText: sanitizeStagingCleanupError(error),
      beijingTime: formatBeijingTime(options.now),
    }
    await reportStagingCleanupFailure(ctx, session, failure, options)
    return false
  }
}

// 移除缓存项的全部查询键，但保留对象供活动发送 finally 收口。
function detachVideoCacheEntry(entry: VideoFileCacheEntry): void {
  entry.expired = true
  for (const alias of entry.aliases) {
    if (videoCacheAliases.get(alias) === entry.primaryKey) videoCacheAliases.delete(alias)
  }
}

// 安全删除一个空闲缓存文件和对应内存状态。
async function deleteVideoCacheEntry(ctx: ContextLike | null, entry: VideoFileCacheEntry): Promise<boolean> {
  detachVideoCacheEntry(entry)
  if (entry.activeSends > 0) return false
  if (entry.expiryTimer) clearTimeout(entry.expiryTimer)
  entry.expiryTimer = null
  videoFileCache.delete(entry.primaryKey)
  try {
    if (isSafeVideoCacheFile(entry.filePath)) await fs.rm(entry.filePath, { force: true })
    return true
  } catch (error) {
    videoFileCache.set(entry.primaryKey, entry)
    ctx?.logger('bvidl').warn(`video cache delete failed: ${getErrorMessage(error)}`)
    return false
  }
}

// 在固定五分钟边界停止新命中，并在无活动发送时删除文件。
function expireVideoCacheEntry(ctx: ContextLike | null, entry: VideoFileCacheEntry): void {
  detachVideoCacheEntry(entry)
  if (entry.activeSends === 0) void deleteVideoCacheEntry(ctx, entry)
}

// 把首次成功上传的 MP4 登记为五分钟全局 BV 缓存。
function registerVideoFileCache(ctx: ContextLike, filePath: string, sizeBytes: number, infoMessage: string, keys: string[], lastSendStatus: SendOutcome['status'], now: number = Date.now()): VideoFileCacheEntry | null {
  if (cacheDisposed || !isSafeVideoCacheFile(filePath) || sizeBytes <= 0 || sizeBytes > MAX_SIZE) return null
  const aliases = uniqueStrings(keys)
  const primaryKey = aliases.find(key => key.startsWith('bv:')) || ''
  if (!primaryKey) return null
  const previous = videoFileCache.get(primaryKey)
  if (previous && previous.filePath !== filePath) void deleteVideoCacheEntry(ctx, previous)

  const entry: VideoFileCacheEntry = {
    primaryKey,
    bvKey: primaryKey,
    aliases: uniqueStrings(aliases.concat(primaryKey)),
    filePath,
    sizeBytes,
    infoMessage,
    createdAt: now,
    expiresAt: now + VIDEO_CACHE_TTL_MS,
    hardCleanupAt: now + VIDEO_CACHE_HARD_CLEANUP_MS,
    activeSends: 0,
    lastSendStatus,
    expired: false,
    expiryTimer: null,
  }
  videoFileCache.set(primaryKey, entry)
  for (const alias of entry.aliases) videoCacheAliases.set(alias, primaryKey)
  entry.expiryTimer = setTimeout(() => expireVideoCacheEntry(ctx, entry), VIDEO_CACHE_TTL_MS)
  entry.expiryTimer.unref?.()
  return entry
}

// 查找并校验一个仍在五分钟复用窗口内的缓存项。
function findVideoFileCache(ctx: ContextLike, keys: string[], now: number = Date.now()): VideoFileCacheEntry | null {
  for (const key of keys) {
    const primaryKey = videoCacheAliases.get(key) || (videoFileCache.has(key) ? key : '')
    if (!primaryKey) continue
    const entry = videoFileCache.get(primaryKey)
    if (!entry) {
      videoCacheAliases.delete(key)
      continue
    }
    if (entry.expired || entry.expiresAt <= now) {
      expireVideoCacheEntry(ctx, entry)
      continue
    }
    if (!isSafeVideoCacheFile(entry.filePath)) {
      void deleteVideoCacheEntry(ctx, entry)
      continue
    }
    const stat = fsSync.statSync(entry.filePath)
    if (stat.size !== entry.sizeBytes || stat.size > MAX_SIZE) {
      void deleteVideoCacheEntry(ctx, entry)
      continue
    }
    return entry
  }
  return null
}

// 判断消息是否只包含一个可直接搬运的 B 站视频标识或地址。
function isStandaloneBilibiliVideoInput(input: string = ''): boolean {
  const text = normalizeSharedText(input).trim()
  if (!text) return false
  if (/^BV[0-9A-Za-z]{10}(?:\?p=\d+)?$/i.test(text)) return true

  try {
    const parsed = new URL(text)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false

    const host = parsed.hostname.toLowerCase()
    if (host === 'b23.tv') return parsed.pathname !== '/'
    if (host !== 'bilibili.com' && host !== 'www.bilibili.com' && host !== 'm.bilibili.com') return false
    return /^\/video\/(?:BV[0-9A-Za-z]{10}|av\d+)\/?$/i.test(parsed.pathname)
  } catch {
    return false
  }
}

// 使用现有封面信息和磁盘 MP4 向当前会话发送缓存视频。
async function sendCachedVideo(ctx: ContextLike, session: VideoSessionLike, entry: VideoFileCacheEntry): Promise<VideoUserError | undefined> {
  entry.activeSends += 1
  try {
    const previewOutcome = await safeSend(ctx, session, entry.infoMessage, 'cached preview')
    if (previewOutcome.status === 'uncertain') return undefined
    if (previewOutcome.status === 'failed') {
      const userError = previewOutcome.reason === 'rejected'
        ? buildVideoUserError({ id: 'video-024', retcode: previewOutcome.retcode })
        : buildVideoUserError({ id: 'video-025' })
      logVideoUserError(ctx, userError)
      return userError
    }
    const videoOutcome = await safeSend(ctx, session, segment.video(toFileUrl(entry.filePath)), 'cached video')
    entry.lastSendStatus = videoOutcome.status
    if (videoOutcome.status === 'uncertain') return undefined
    if (videoOutcome.status === 'failed') {
      const userError = videoOutcome.reason === 'rejected'
        ? buildVideoUserError({ id: 'video-026', retcode: videoOutcome.retcode })
        : buildVideoUserError({ id: 'video-027' })
      logVideoUserError(ctx, userError)
      return userError
    }
    return undefined
  } finally {
    entry.activeSends = Math.max(0, entry.activeSends - 1)
    if (entry.expired && entry.activeSends === 0) await deleteVideoCacheEntry(ctx, entry)
  }
}

// 扫描内存缓存与专用目录，回收五分钟失效项和十分钟遗留文件。
async function cleanupVideoCache(ctx: ContextLike | null, now: number = Date.now()): Promise<{ entriesRemoved: number, filesRemoved: number, staleActive: number }> {
  let entriesRemoved = 0
  let filesRemoved = 0
  let staleActive = 0
  const activePaths = new Set<string>()

  for (const entry of [...videoFileCache.values()]) {
    if (entry.activeSends > 0) activePaths.add(path.resolve(entry.filePath))
    if (entry.expiresAt <= now) detachVideoCacheEntry(entry)
    if (entry.hardCleanupAt <= now && entry.activeSends > 0) {
      staleActive += 1
      ctx?.logger('bvidl').warn(`stale_active_cache: key=${entry.primaryKey} active=${entry.activeSends}`)
    }
    if (entry.expired && entry.activeSends === 0) {
      if (await deleteVideoCacheEntry(ctx, entry)) {
        entriesRemoved += 1
        filesRemoved += 1
      }
    }
  }

  try {
    const entries = await fs.readdir(CACHE_DIR, { withFileTypes: true })
    for (const item of entries) {
      if (!item.isFile() || !CACHE_FILE_RE.test(item.name)) continue
      const filePath = path.join(CACHE_DIR, item.name)
      if (activePaths.has(path.resolve(filePath))) continue
      const stat = await fs.stat(filePath)
      if (now - stat.mtimeMs < VIDEO_CACHE_HARD_CLEANUP_MS) continue
      await fs.rm(filePath, { force: true })
      filesRemoved += 1
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') ctx?.logger('bvidl').warn(`video cache sweep failed: ${getErrorMessage(error)}`)
  }
  return { entriesRemoved, filesRemoved, staleActive }
}

// 启动一分钟最终缓存清理，并注册插件关闭时的收口动作。
function startVideoCacheMaintenance(ctx: ContextLike): void {
  cacheDisposed = false
  if (!videoCacheSweepTimer) {
    videoCacheSweepTimer = setInterval(() => { void cleanupVideoCache(ctx) }, VIDEO_CACHE_SWEEP_MS)
    videoCacheSweepTimer.unref?.()
  }
  void cleanupVideoCache(ctx)
  ctx.on?.('dispose', async () => {
    cacheDisposed = true
    if (videoCacheSweepTimer) clearInterval(videoCacheSweepTimer)
    videoCacheSweepTimer = null
    for (const entry of [...videoFileCache.values()]) {
      detachVideoCacheEntry(entry)
      if (entry.activeSends === 0) await deleteVideoCacheEntry(ctx, entry)
    }
    biliInput.clearBiliInputCache()
    inflightDownloads.clear()
  })
}

// 返回可用于测试和运行时验收的无敏感缓存摘要。
function getVideoCacheStatus(): Record<string, unknown> {
  return {
    entries: videoFileCache.size,
    aliases: videoCacheAliases.size,
    inflight: inflightDownloads.size,
    shortLinks: biliInput.getBiliInputCacheSize(),
    items: [...videoFileCache.values()].map(entry => ({
      bvKey: entry.bvKey,
      sizeBytes: entry.sizeBytes,
      expiresAt: entry.expiresAt,
      activeSends: entry.activeSends,
      lastSendStatus: entry.lastSendStatus,
      expired: entry.expired,
    })),
  }
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

// 将消息接口异常严格区分为超时、明确拒绝和普通调用异常。
async function safeSend(ctx: ContextLike, session: VideoSessionLike, message: unknown, label: string = 'message'): Promise<SendOutcome> {
  try {
    await session.send(message)
    return { status: 'confirmed' }
  } catch (error) {
    const candidate = error as Error & { url?: unknown, code?: unknown }
    const constructorName = error instanceof Error ? error.constructor.name : ''
    if (constructorName === 'TimeoutError' && candidate.url === 'send_group_msg') {
      const messageText = getErrorMessage(error)
      ctx.logger('bvidl').warn(`${label} send failed: ${messageText} send_status=uncertain`)
      return { status: 'uncertain', reason: 'timeout', error: messageText }
    }
    if (constructorName === 'SenderError' && candidate.url === 'send_group_msg' && typeof candidate.code === 'number' && Number.isFinite(candidate.code)) {
      const messageText = getErrorMessage(error)
      ctx.logger('bvidl').warn(`${label} send failed: ${messageText} send_status=failed reason=rejected retcode=${Math.trunc(candidate.code)}`)
      return { status: 'failed', reason: 'rejected', retcode: Math.trunc(candidate.code), error: messageText }
    }
    const messageText = getErrorMessage(error)
    ctx.logger('bvidl').warn(`${label} send failed: ${messageText} send_status=failed reason=call_error`)
    return { status: 'failed', reason: 'call_error', error: messageText }
  }
}

// 从探测目标和元数据中提取可安全显示的规范 BV 号。
function getProbeBvId(url: string, info: VideoInfo): string {
  const candidates = [info.id, info.display_id, info.webpage_url, info.original_url, url]
  for (const candidate of candidates) {
    const match = String(candidate || '').match(/\bBV[0-9A-Za-z]{10}\b/i)
    if (match) return match[0]
  }
  return ''
}

// 从显式查询参数和 yt-dlp 条目标识中解析正整数分 P，缺省为 P1。
function getProbePartNumber(url: string, info: VideoInfo): number {
  try {
    const value = Number(new URL(url).searchParams.get('p'))
    if (Number.isInteger(value) && value > 0) return value
  } catch { /* canonical BV input may be supplied without a URL wrapper */
  }
  const entryMatch = String(info.id || '').match(/_p(\d+)$/i)
  const entryPart = entryMatch ? Number(entryMatch[1]) : 0
  return Number.isInteger(entryPart) && entryPart > 0 ? entryPart : 1
}

// 探测视频元数据，并将无可用格式转换为受控中文错误。
async function probeVideo(url: string, runCommand: typeof run = run): Promise<ProbeResult> {
  const { stdout } = await runCommand(YTDLP, [
    '--cookies', COOKIES,
    '--dump-single-json',
    '--no-warnings',
    '--no-playlist',
    url,
  ], { timeout: 2 * 60 * 1000 })

  const info = JSON.parse(stdout) as VideoInfo
  const picked = pickFormat(info)

  if (!picked) {
    return {
      info,
      userError: buildVideoUserError({
        id: 'video-011',
        bvId: getProbeBvId(url, info),
        partNumber: getProbePartNumber(url, info),
      }),
    }
  }

  return { info, picked }
}

// 生成不含完整 URL 和 Cookie 路径的 yt-dlp 错误摘要。
function getSafeCommandErrorSummary(error: unknown): string {
  return getCommandErrorMessage(error)
    .replace(/https?:\/\/\S+/gi, '[url]')
    .split(COOKIES).join('[cookies-file]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 1000) || 'unknown'
}

// 显式发送拒绝提示，避免 action 返回值造成重复消息。
async function sendRejectedVideo(ctx: ContextLike, session: VideoSessionLike, infoMessage: string, message: string, includePreview: boolean = true): Promise<void> {
  if (includePreview) await safeSend(ctx, session, infoMessage, 'preview')
  await safeSend(ctx, session, message, 'video refusal')
}

// 给缓存命中请求单独申请资源锁并发送磁盘视频。
async function sendCachedVideoWithGate(ctx: ContextLike, session: VideoSessionLike, entry: VideoFileCacheEntry, source: string, deps: DownloadDeps): Promise<string | undefined> {
  const gateResult = await acquireVideoResourceGate(ctx, session, source, deps)
  if (!gateResult.ok) return (gateResult.userError || buildVideoUserError({ id: 'video-003' })).message
  const gateHandle = gateResult.handle || null
  try {
    gateHandle?.updateStep('video_cached_send')
    const userError = await sendCachedVideo(ctx, session, entry)
    return userError?.message
  } finally {
    try { gateHandle?.release('external-video-cache-finally') } catch { /* resource gate records stale releases independently */
    }
  }
}

// 创建一个视频运行目录，并把失败转换为指定的目录错误编号。
async function ensureVideoDirectory(ctx: ContextLike, fsApi: VideoFsApi, directory: string, errorId: 'video-007' | 'video-008' | 'video-009'): Promise<VideoUserError | null> {
  try {
    await fsApi.mkdir(directory, { recursive: true })
    return null
  } catch (error) {
    const userError = buildVideoUserError({ id: errorId })
    logVideoUserError(ctx, userError, getErrorMessage(error))
    return userError
  }
}

// 对最终视频文件只执行一次删除，失败只记录服务端日志。
async function removeOutputFileOnce(ctx: ContextLike, fsApi: VideoFsApi, filePath: string, reason: string): Promise<void> {
  try {
    await fsApi.rm(filePath, { force: true })
  } catch (error) {
    ctx.logger('bvidl').warn(`video output delete failed: reason=${reason} error=${getErrorMessage(error)}`)
  }
}

// 为首次请求执行探测、大小门禁、下载、首发和缓存登记。
async function processInitialVideoRequest(ctx: ContextLike, session: VideoSessionLike, url: string, source: string, keys: string[], recentEntry: RecentParseEntry | null, deps: DownloadDeps): Promise<SharedVideoResult> {
  const taskId = buildVideoTaskId(session, source)
  const gateResult = await acquireVideoResourceGate(ctx, session, source, deps, taskId)
  if (!gateResult.ok) return { kind: 'failed', userError: gateResult.userError || buildVideoUserError({ id: 'video-003' }) }
  const gateHandle = gateResult.handle || null
  const fsApi = deps.fs || fs
  const runCommand = deps.run || run
  const probe = deps.probeVideo || probeVideo
  const createStagingDirectory = deps.createStagingDirectory || createRequestStagingDirectory
  const removeStagingDirectory = deps.removeStagingDirectory || removeRequestStagingDirectory
  let outputFile = ''
  let stagingDir = ''
  let bvId = ''
  let bvKey = ''
  let cacheId = ''
  let pickedFormat = ''
  let downloadStartedAt = 0
  let commandFailure: ExecFileError | null = null

  try {
    const workdirError = await ensureVideoDirectory(ctx, fsApi, WORKDIR, 'video-007')
    if (workdirError) return { kind: 'failed', userError: workdirError }
    const cacheDirError = await ensureVideoDirectory(ctx, fsApi, CACHE_DIR, 'video-008')
    if (cacheDirError) return { kind: 'failed', userError: cacheDirError }
    const stagingRootError = await ensureVideoDirectory(ctx, fsApi, STAGING_ROOT, 'video-009')
    if (stagingRootError) return { kind: 'failed', userError: stagingRootError }

    let info: VideoInfo
    let picked: FormatPick
    gateHandle?.updateStep('video_probe')
    try {
      const result = await probe(url)
      if (result.userError) {
        logVideoUserError(ctx, result.userError)
        return { kind: 'failed', userError: result.userError }
      }
      if (!result.info || !result.picked) {
        const userError = buildVideoUserError({
          id: 'video-011',
          bvId: getProbeBvId(url, result.info || {}),
          partNumber: getProbePartNumber(url, result.info || {}),
        })
        logVideoUserError(ctx, userError)
        return { kind: 'failed', userError }
      }
      info = result.info
      picked = result.picked
    } catch (error) {
      ctx.logger('bvidl').warn(getCommandErrorMessage(error))
      const userError = buildVideoUserError({ id: 'video-010' })
      logVideoUserError(ctx, userError, getSafeCommandErrorSummary(error))
      return { kind: 'failed', userError }
    }

    const canonicalKeys = uniqueStrings(keys
      .concat(buildBiliKeys(getCanonicalBiliUrl(info)))
      .concat(buildBiliKeys(getShortestBiliUrl(info))))
    mergeRecentParseKeys(recentEntry, canonicalKeys)
    const infoMessage = buildInfoMessage(info, picked)
    bvId = getProbeBvId(url, info)

    gateHandle?.updateStep('video_preview')
    const previewOutcome = await safeSend(ctx, session, infoMessage, 'preview')
    if (previewOutcome.status === 'uncertain') return { kind: 'sent' }
    if (previewOutcome.status === 'failed') {
      const userError = previewOutcome.reason === 'rejected'
        ? buildVideoUserError({ id: 'video-012', retcode: previewOutcome.retcode })
        : buildVideoUserError({ id: 'video-013' })
      logVideoUserError(ctx, userError)
      return { kind: 'failed', userError }
    }

    if (picked.totalSize <= 0) {
      const userError = buildVideoUserError({ id: 'video-014' })
      await sendRejectedVideo(ctx, session, infoMessage, userError.message, false)
      ctx.logger('bvidl').warn(`rejected_before_download: reason=size_unknown keys=${canonicalKeys.join(',')} user_error_id=${userError.id}`)
      return { kind: 'rejected', infoMessage, userError }
    }
    if (picked.totalSize > MAX_SIZE) {
      const userError = buildVideoUserError({ id: 'video-015', estimatedBytes: picked.totalSize })
      await sendRejectedVideo(ctx, session, infoMessage, userError.message, false)
      ctx.logger('bvidl').warn(`rejected_before_download: reason=oversize estimated=${picked.totalSize} limit=${MAX_SIZE} keys=${canonicalKeys.join(',')} user_error_id=${userError.id}`)
      return { kind: 'rejected', infoMessage, userError }
    }

    bvKey = canonicalKeys.find(key => key.startsWith('bv:')) || ''
    const cacheSlug = (bvKey.replace(/^bv:/, '') || 'unknown').replace(/[^a-z0-9]/g, '').slice(0, 32) || 'unknown'
    cacheId = `bili-cache-${cacheSlug}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    outputFile = path.join(CACHE_DIR, `${cacheId}.mp4`)

    let stagingResult: StagingPrepareResult
    try {
      stagingResult = await createStagingDirectory(cacheSlug)
    } catch (error) {
      stagingResult = { status: 'create_failed', path: '', error }
    }
    stagingDir = stagingResult.path
    if (stagingResult.status !== 'ready') {
      const userError = buildVideoUserError({ id: stagingResult.status === 'create_failed' ? 'video-016' : 'video-017' })
      const technicalDetail = stagingResult.status === 'create_failed' ? getErrorMessage(stagingResult.error) : 'safety_validation_failed'
      ctx.logger('bvidl').warn(`staging_prepare_failed: bv=${bvKey || 'unknown'} reason=${stagingResult.status} user_error_id=${userError.id} error=${technicalDetail}`)
      logVideoUserError(ctx, userError)
      return { kind: 'failed', userError }
    }

    gateHandle?.updateStep('video_download')
    pickedFormat = picked.format
    downloadStartedAt = Date.now()
    try {
      await runCommand(YTDLP, [
        '--cookies', COOKIES,
        '--no-playlist',
        '-f', picked.format,
        '--merge-output-format', 'mp4',
        '-P', `home:${CACHE_DIR}`,
        '-P', `temp:${stagingDir}`,
        '-o', `${cacheId}.%(ext)s`,
        url,
      ], { timeout: 10 * 60 * 1000 })
    } catch (error) {
      commandFailure = error instanceof Error ? error as ExecFileError : new Error(String(error)) as ExecFileError
      const userError = buildVideoUserError({ id: 'video-018' })
      logVideoUserError(ctx, userError, getSafeCommandErrorSummary(commandFailure))
      return { kind: 'failed', userError }
    }

    if (!isSafeVideoCacheFile(outputFile)) {
      const userError = buildVideoUserError({ id: 'video-019' })
      logVideoUserError(ctx, userError)
      return { kind: 'failed', userError }
    }

    let actualSize: number
    try {
      actualSize = (await fsApi.stat(outputFile)).size
    } catch (error) {
      const userError = buildVideoUserError({ id: 'video-020' })
      logVideoUserError(ctx, userError, getErrorMessage(error))
      return { kind: 'failed', userError }
    }

    if (actualSize > MAX_SIZE) {
      const userError = buildVideoUserError({ id: 'video-021', actualBytes: actualSize })
      await removeOutputFileOnce(ctx, fsApi, outputFile, 'actual_size_limit')
      outputFile = ''
      await sendRejectedVideo(ctx, session, infoMessage, userError.message, false)
      ctx.logger('bvidl').warn(`rejected_after_download: estimated=${picked.totalSize} actual=${actualSize} limit=${MAX_SIZE} keys=${canonicalKeys.join(',')} user_error_id=${userError.id}`)
      return { kind: 'rejected', infoMessage, userError }
    }

    gateHandle?.updateStep('video_send')
    const videoOutcome = await safeSend(ctx, session, segment.video(toFileUrl(outputFile)), 'video')
    if (videoOutcome.status === 'failed') {
      const userError = videoOutcome.reason === 'rejected'
        ? buildVideoUserError({ id: 'video-022', retcode: videoOutcome.retcode })
        : buildVideoUserError({ id: 'video-023' })
      await removeOutputFileOnce(ctx, fsApi, outputFile, userError.stage)
      outputFile = ''
      logVideoUserError(ctx, userError)
      return { kind: 'failed', userError }
    }

    const cacheEntry = registerVideoFileCache(ctx, outputFile, actualSize, infoMessage, canonicalKeys, videoOutcome.status)
    if (!cacheEntry) {
      await removeOutputFileOnce(ctx, fsApi, outputFile, videoOutcome.status === 'uncertain' ? 'uncertain_cache_registration' : 'cache_registration')
      outputFile = ''
      return { kind: 'sent' }
    }
    outputFile = ''
    return { kind: 'cached', entry: cacheEntry }
  } finally {
    if (outputFile) await removeOutputFileOnce(ctx, fsApi, outputFile, 'request_finally')
    const cleanupOk = stagingDir ? await removeStagingDirectory(ctx, session, stagingDir, bvId, taskId) : true
    if (commandFailure) {
      ctx.logger('bvidl').warn(`video_download_failed: cacheId=${cacheId || 'unknown'} bv=${bvKey || 'unknown'} format=${pickedFormat || 'unknown'} duration_ms=${downloadStartedAt ? Date.now() - downloadStartedAt : 0} exit_code=${commandFailure.code ?? 'unknown'} signal=${commandFailure.signal || 'none'} cleanup_ok=${cleanupOk} user_error_id=video-018 error=${getSafeCommandErrorSummary(commandFailure)}`)
    }
    try { gateHandle?.release('external-video-finally') } catch { /* resource gate records stale releases independently */
    }
  }
}

// 把共享首次处理结果投递给等待中的其他群请求。
async function deliverSharedVideoResult(ctx: ContextLike, session: VideoSessionLike, result: SharedVideoResult, source: string, deps: DownloadDeps): Promise<string | undefined> {
  if (result.kind === 'cached') return sendCachedVideoWithGate(ctx, session, result.entry, source, deps)
  if (result.kind === 'rejected') {
    await sendRejectedVideo(ctx, session, result.infoMessage, result.userError.message)
    return undefined
  }
  if (result.kind === 'failed') return result.userError.message
  return undefined
}

// 找到任一 BV/alias 正在执行的首次处理任务。
function findInflightDownload(keys: string[]): Promise<SharedVideoResult> | null {
  for (const key of keys) {
    const inflight = inflightDownloads.get(key)
    if (inflight) return inflight
  }
  return null
}

// 用一组等价键登记同一个首次处理 Promise。
function registerInflightDownload(keys: string[], promise: Promise<SharedVideoResult>): string[] {
  const registered = uniqueStrings(keys)
  for (const key of registered) inflightDownloads.set(key, promise)
  return registered
}

// 清除仍指向指定 Promise 的 inflight 键，避免误删后来的任务。
function unregisterInflightDownload(keys: string[], promise: Promise<SharedVideoResult>): void {
  for (const key of keys) {
    if (inflightDownloads.get(key) === promise) inflightDownloads.delete(key)
  }
}

// 编排同群去重、短链归一化、缓存命中、并发合并和首次处理。
async function downloadAndSend(ctx: ContextLike, session: VideoSessionLike, url: string, source: string = url, deps: DownloadDeps = {}, options: DownloadRequestOptions = {}): Promise<string | undefined> {
  if (isBlacklistedGroup(session)) return

  const now = Date.now()
  const resolvedInput = await resolveInputBiliTarget(ctx, url, source, deps)
  const keys = resolvedInput.keys
  if (!resolvedInput.p1Url) {
    const userError = buildVideoUserError({ id: 'video-010' })
    logVideoUserError(ctx, userError, 'input_normalization_failed')
    return userError.message
  }
  const resolvedDuplicate = findRecentDuplicateParse(session, keys, now)
  const cached = findVideoFileCache(ctx, keys, now)
  const canRetryUncertainCache = !!(options.explicitCommand && resolvedDuplicate && cached?.lastSendStatus === 'uncertain')
  if (resolvedDuplicate && !canRetryUncertainCache) {
    const userError = buildVideoUserError({ id: 'video-002', remainingSeconds: resolvedDuplicate.remainingSeconds })
    logVideoUserError(ctx, userError, `remaining_seconds=${resolvedDuplicate.remainingSeconds}`)
    await safeSend(ctx, session, userError.message, 'duplicate parse notice')
    return undefined
  }
  const recentEntry = canRetryUncertainCache ? null : rememberRecentParse(session, keys, now)

  if (cached) {
    const result = await sendCachedVideoWithGate(ctx, session, cached, source, deps)
    if (result) forgetRecentParse(session, recentEntry)
    return result
  }

  const inflight = findInflightDownload(keys)
  if (inflight) {
    const result = await inflight
    const delivered = await deliverSharedVideoResult(ctx, session, result, source, deps)
    if (result.kind === 'failed' || delivered) forgetRecentParse(session, recentEntry)
    return delivered
  }

  let work!: Promise<SharedVideoResult>
  work = processInitialVideoRequest(ctx, session, resolvedInput.p1Url, source, keys, recentEntry, deps)
  const registeredKeys = registerInflightDownload(keys, work)
  try {
    const result = await work
    if (result.kind === 'failed') {
      forgetRecentParse(session, recentEntry)
      return result.userError.message
    }
    return undefined
  } finally {
    unregisterInflightDownload(registeredKeys, work)
  }
}

// 处理独立 B 站视频输入；不匹配时继续消息链，命中时复用统一下载与准入流程。
async function handleStandaloneBilibiliVideoInput(ctx: ContextLike, session: VideoSessionLike, next: () => unknown, deps: DownloadDeps = {}): Promise<unknown> {
  if (isBlacklistedGroup(session)) return next()

  const content = session.content || ''
  if (!isStandaloneBilibiliVideoInput(content)) return next()

  const url = extractBiliUrl(content)
  if (!url) return next()
  return downloadAndSend(ctx, session, url, content, deps)
}

function apply(ctx: ContextLike): void {
  startVideoCacheMaintenance(ctx)
  ctx.command('sendtestvideo', 'send local test video').action(() => {
    return segment.video(toFileUrl(TEST_VIDEO_FILE))
  })

  ctx.command('bvidl <text:text>', 'download and send Bilibili video').action(async ({ session }, text) => {
    if (isBlacklistedGroup(session)) return

    const url = extractBiliUrl(text)
    if (!url) return buildVideoUserError({ id: 'video-001' }).message
    return downloadAndSend(ctx, session, url, text || url, {}, { explicitCommand: true })
  })

  ctx.middleware((session, next) => handleStandaloneBilibiliVideoInput(ctx, session, next), true)

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

// 清理测试可见的内存状态和无活动缓存文件。
async function clearVideoRuntimeState(): Promise<void> {
  recentParseHistory.clear()
  biliInput.clearBiliInputCache()
  inflightDownloads.clear()
  for (const entry of [...videoFileCache.values()]) {
    detachVideoCacheEntry(entry)
    entry.activeSends = 0
    await deleteVideoCacheEntry(null, entry)
  }
  videoCacheAliases.clear()
}

export = {
  name,
  apply,
  extractBiliUrl,
  isStandaloneBilibiliVideoInput,
  handleStandaloneBilibiliVideoInput,
  buildBiliKeys,
  pickFormat,
  getShortestBiliUrl,
  downloadAndSend,
  formatDecimalMb,
  buildOversizeMessage,
  buildActualOversizeMessage,
  buildVideoUserError,
  getRuntimeConfig,
  toFileUrl,
  safeSend,
  isBlacklistedGroup,
  loadVideoBlacklist,
  isRecentDuplicateParse,
  rememberRecentParse,
  clearRecentParseHistory,
  resolveBiliShortLink,
  normalizeBiliP1Url,
  probeVideo,
  isAllowedBiliRedirectUrl,
  isPrivateIpAddress,
  cleanupVideoCache,
  removeRequestStagingDirectory,
  getVideoCacheStatus,
  clearVideoRuntimeState,
}
