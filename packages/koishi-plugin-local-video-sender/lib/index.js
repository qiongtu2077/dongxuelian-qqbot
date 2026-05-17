const { segment } = require('koishi')
const { execFile } = require('child_process')
const fsSync = require('fs')
const fs = require('fs/promises')
const path = require('path')
const { pathToFileURL } = require('url')

exports.name = 'local-video-sender'

const DEFAULT_MAX_SIZE = 200 * 1024 * 1024
const YTDLP = process.env.BILI_YTDLP || '/usr/local/bin/yt-dlp'
const COOKIES = process.env.BILI_COOKIES_FILE || '/root/bilibili-cookies.txt'
const WORKDIR = process.env.BILI_WORKDIR || '/root/koishi-bili-downloads'
const DATA_DIR = process.env.DONGXUELIAN_AI_DATA_DIR || path.join(__dirname, '..', '..', 'koishi-plugin-dongxuelian-ai', 'data')
const VIDEO_BLACKLIST_FILE = process.env.BILI_VIDEO_BLACKLIST_FILE || path.join(DATA_DIR, 'video-blacklist.json')
const MAX_SIZE = parsePositiveInteger(process.env.BILI_MAX_SIZE_BYTES, DEFAULT_MAX_SIZE)
const TEST_VIDEO_FILE = process.env.BILI_TEST_VIDEO_FILE || '/root/test_bili.mp4'
const MIN_720_HEIGHT = 700
const MAX_720_HEIGHT = 720
const PREFERRED_MAX_HEIGHT = 720
const DUPLICATE_WINDOW_MS = 60 * 1000
const DUPLICATE_HISTORY_LIMIT = 3
const MAX_YTDLP_STDIO_BYTES = 1024 * 1024
const MAX_VIDEO_BLACKLIST_BYTES = 128 * 1024
const LEGACY_GROUP_BLACKLIST = new Set(['942033342'])

const recentParseHistory = new Map()
let videoBlacklistCache = {
  fingerprint: '',
  groups: new Set(LEGACY_GROUP_BLACKLIST),
  users: new Set(),
}

function parsePositiveInteger(value, fallback) {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback
}

function toFileUrl(filePath) {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(String(filePath))) return String(filePath)
  return pathToFileURL(filePath).href
}

function getRuntimeConfig() {
  return {
    ytdlp: YTDLP,
    cookies: COOKIES,
    workdir: WORKDIR,
    maxSize: MAX_SIZE,
    testVideoFile: TEST_VIDEO_FILE,
    videoBlacklistFile: VIDEO_BLACKLIST_FILE,
  }
}

const FORMAT_CANDIDATES = [
  { format: '30064+30280', label: '720P AVC' },
  { format: '30066+30280', label: '720P HEVC' },
  { format: '100024+30280', label: '720P AV1' },
]

const SINGLE_FILE_CANDIDATES = [
  { format: '64', label: '720P single file' },
  { format: '32', label: '480P single file' },
  { format: '16', label: '360P single file' },
]

function run(file, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { maxBuffer: MAX_YTDLP_STDIO_BYTES, ...options }, (error, stdout, stderr) => {
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

function normalizeSharedText(input = '') {
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
      .replace(/\\u([0-9a-fA-F]{4})/g, (_, code) => String.fromCharCode(parseInt(code, 16)))

    try {
      const decoded = decodeURIComponent(text)
      if (decoded !== text) text = decoded
    } catch {}

    if (text === previous) break
  }

  return text
}

function uniqueStrings(values = []) {
  return [...new Set(values.filter(Boolean).map(value => String(value)))]
}

function normalizeBiliIdentifier(identifier = '') {
  const value = String(identifier).trim()
  if (!value) return ''
  return `bv:${value.replace(/^bv/i, '').toLowerCase()}`
}

function normalizeBiliUrlKey(input = '') {
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

function extractBiliUrl(input = '') {
  const text = normalizeSharedText(input)
  const urlMatch = text.match(/https?:\/\/(?:www\.bilibili\.com|m\.bilibili\.com|bilibili\.com|b23\.tv)\/[^\s"'<>\\\]}),，。！？、]+/i)
  if (urlMatch) return urlMatch[0]

  const bvMatch = text.match(/\bBV[0-9A-Za-z]{10}\b/i)
  if (bvMatch) return `https://www.bilibili.com/video/${bvMatch[0]}`

  return null
}

function buildBiliKeys(input = '') {
  const text = normalizeSharedText(input)
  const keys = []
  const bvMatches = text.match(/\bBV[0-9A-Za-z]{10}\b/gi) || []

  for (const bv of bvMatches) {
    keys.push(normalizeBiliIdentifier(bv))
  }

  const url = extractBiliUrl(text)
  if (url) keys.push(normalizeBiliUrlKey(url))

  return uniqueStrings(keys)
}

function getParseChannelKey(session) {
  return String(session.guildId || session.channelId || session.userId || 'private')
}

function getGroupBlacklistCandidates(session) {
  const ids = []
  if (session.guildId) ids.push(String(session.guildId))
  if (!session.isDirect && session.channelId) ids.push(String(session.channelId))
  return [...new Set(ids.filter(Boolean))]
}

function getUserBlacklistCandidates(session) {
  return uniqueStrings([
    session.userId,
    session.author?.id,
    session.event?.user?.id,
    session.event?.sender?.userId,
    session.event?.sender?.id,
  ])
}

function getFileFingerprint(filePath) {
  try {
    const stat = fsSync.statSync(filePath)
    return `${stat.mtimeMs}:${stat.size}`
  } catch {
    return 'missing'
  }
}

function loadVideoBlacklist(force = false) {
  const fingerprint = getFileFingerprint(VIDEO_BLACKLIST_FILE)
  if (!force && videoBlacklistCache.fingerprint === fingerprint) return videoBlacklistCache

  let groups = [...LEGACY_GROUP_BLACKLIST]
  let users = []
  if (fingerprint !== 'missing') {
    try {
      const stat = fsSync.statSync(VIDEO_BLACKLIST_FILE)
      if (!stat.isFile() || stat.size > MAX_VIDEO_BLACKLIST_BYTES) throw new Error('video blacklist too large')
      const raw = JSON.parse(fsSync.readFileSync(VIDEO_BLACKLIST_FILE, 'utf8'))
      groups = Array.isArray(raw) ? raw : Array.isArray(raw.groups) ? raw.groups : []
      users = raw && typeof raw === 'object' && Array.isArray(raw.users) ? raw.users : []
    } catch {
      groups = [...LEGACY_GROUP_BLACKLIST]
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

function isBlacklistedGroup(session) {
  const blacklist = loadVideoBlacklist()
  return getGroupBlacklistCandidates(session).some(groupId => blacklist.groups.has(groupId)) ||
    getUserBlacklistCandidates(session).some(userId => blacklist.users.has(userId))
}

function pruneRecentParseHistory(session, now = Date.now()) {
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

function isRecentDuplicateParse(session, keys, now = Date.now()) {
  if (!keys.length) return false
  const history = pruneRecentParseHistory(session, now)
  return history.some(entry => entry.keys.some(key => keys.includes(key)))
}

function rememberRecentParse(session, keys, now = Date.now()) {
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

function mergeRecentParseKeys(entry, keys) {
  if (!entry || !keys.length) return
  entry.keys = uniqueStrings(entry.keys.concat(keys))
}

function getCanonicalBiliUrl(info = {}) {
  const source = info.webpage_url || info.original_url || ''
  const bvMatch = source.match(/\bBV[0-9A-Za-z]{10}\b/i)
  if (bvMatch) {
    return `https://www.bilibili.com/video/${bvMatch[0]}/`
  }
  return source ? source.split('?')[0] : ''
}

function getShortestBiliUrl(info = {}) {
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

function safeNumber(value) {
  return Number.isFinite(value) ? value : 0
}

function estimateFormatSize(format) {
  return safeNumber(format.filesize) || safeNumber(format.filesize_approx)
}

function isAudioOnlyFormat(format) {
  return format && format.vcodec === 'none' && format.acodec && format.acodec !== 'none'
}

function isVideoFormat(format) {
  return format && format.vcodec && format.vcodec !== 'none'
}

function pickBestAudio(formats) {
  return formats
    .filter(isAudioOnlyFormat)
    .sort((left, right) => {
      const abrDiff = safeNumber(right.abr) - safeNumber(left.abr)
      if (abrDiff) return abrDiff
      return estimateFormatSize(right) - estimateFormatSize(left)
    })[0]
}

function sortVideoCandidates(left, right, targetHeight = PREFERRED_MAX_HEIGHT) {
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

function buildSplitPick(video, audio, label) {
  return {
    format: `${video.format_id}+${audio.format_id}`,
    label,
    totalSize: estimateFormatSize(video) + estimateFormatSize(audio),
    height: safeNumber(video.height),
  }
}

function pickFormat(info) {
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

function formatBytes(bytes) {
  if (!bytes) return 'unknown'
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`
}

function formatDuration(seconds) {
  seconds = Math.floor(safeNumber(seconds))
  if (!seconds) return 'unknown'

  const minutes = Math.floor(seconds / 60)
  const rest = seconds % 60
  return `${minutes}:${String(rest).padStart(2, '0')}`
}

function formatVideoInfo(info, picked) {
  const shortestUrl = getShortestBiliUrl(info)
  return [
    info.title || 'Unknown title',
    segment.image(info.thumbnail),
    shortestUrl,
  ].filter(Boolean).join('\n')
}

function buildInfoMessage(info, picked) {
  return formatVideoInfo(info, picked)
}

async function probeVideo(url) {
  const { stdout } = await run(YTDLP, [
    '--cookies', COOKIES,
    '--dump-single-json',
    '--no-warnings',
    url,
  ], { timeout: 2 * 60 * 1000 })

  const info = JSON.parse(stdout)
  const picked = pickFormat(info)

  if (!picked) {
    return { error: 'No available video format found.' }
  }

  return { info, picked }
}

async function downloadAndSend(ctx, session, url, source = url, deps = {}) {
  if (isBlacklistedGroup(session)) {
    return
  }

  const now = Date.now()
  const initialKeys = buildBiliKeys(source)

  if (isRecentDuplicateParse(session, initialKeys, now)) {
    return
  }

  const recentEntry = rememberRecentParse(session, initialKeys, now)

  const fsApi = deps.fs || fs
  const runCommand = deps.run || run
  const probe = deps.probeVideo || probeVideo

  try {
    await fsApi.mkdir(WORKDIR, { recursive: true })
  } catch (error) {
    ctx.logger('bvidl').warn(error.message)
    return 'Failed to prepare download directory. Please check logs later.'
  }

  let info
  let picked
  try {
    const result = await probe(url)
    if (result.error) return result.error
    info = result.info
    picked = result.picked
  } catch (error) {
    ctx.logger('bvidl').warn(error.stderr || error.message)
    return 'Failed to probe video. Please try again later.'
  }

  mergeRecentParseKeys(recentEntry, buildBiliKeys(getCanonicalBiliUrl(info)))

  await session.send(buildInfoMessage(info, picked))

  if (picked.totalSize && picked.totalSize > MAX_SIZE) {
    return `Video is too large. Please watch it on Bilibili. Size: ${formatBytes(picked.totalSize)}`
  }

  const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`
  const outputTemplate = path.join(WORKDIR, `${id}.%(ext)s`)
  const outputFile = path.join(WORKDIR, `${id}.mp4`)

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
      await fsApi.rm(outputFile, { force: true }).catch(() => {})
      return `Video is too large. Please watch it on Bilibili. Actual size: ${formatBytes(stat.size)}`
    }

    await session.send(segment.video(`file://${outputFile}`))
    await fsApi.rm(outputFile, { force: true }).catch(() => {})
  } catch (error) {
    await fsApi.rm(outputFile, { force: true }).catch(() => {})
    ctx.logger('bvidl').warn(error.stderr || error.message)
    return 'Failed to download or send video. Please check logs later.'
  }
}

exports.apply = (ctx) => {
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

exports.extractBiliUrl = extractBiliUrl
exports.buildBiliKeys = buildBiliKeys
exports.pickFormat = pickFormat
exports.getShortestBiliUrl = getShortestBiliUrl
exports.downloadAndSend = downloadAndSend
exports.getRuntimeConfig = getRuntimeConfig
exports.isBlacklistedGroup = isBlacklistedGroup
exports.loadVideoBlacklist = loadVideoBlacklist
exports.isRecentDuplicateParse = isRecentDuplicateParse
exports.rememberRecentParse = rememberRecentParse
exports.clearRecentParseHistory = () => recentParseHistory.clear()
