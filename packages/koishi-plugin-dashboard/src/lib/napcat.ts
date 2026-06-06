'use strict'
const fs = require('fs') as typeof import('fs')
const path = require('path') as typeof import('path')
const { uniquePaths, readFileContent } = require('./utils') as {
  uniquePaths(paths: string[]): string[]
  readFileContent(p: string, maxBytes?: number): string
}
const { KOISHI_DIR, LOCAL_NAPCAT_DIR_FILE, runtimePath } = require('./paths') as {
  KOISHI_DIR: string
  LOCAL_NAPCAT_DIR_FILE: string
  runtimePath(...parts: string[]): string
}

type NapcatMarkerType = 'installer' | 'entry' | 'config' | 'package'
type NapcatInspectionStatus = 'missing' | 'installed' | 'partial' | 'unknown' | 'unsupported'

interface NapcatMarker {
  path: string
  rel: string
  type: NapcatMarkerType
}

interface NapcatArchive {
  path: string
  rel: string
}

interface NapcatMarkersResult {
  markers: NapcatMarker[]
  archives: NapcatArchive[]
}

interface NapcatInspection {
  path: string
  exists: boolean
  found: boolean
  status: NapcatInspectionStatus
  reason?: string
  entry?: string
  markers?: NapcatMarker[]
  archives?: NapcatArchive[]
  qqExecutable?: string
}

interface NapcatCandidateSummary {
  path: string
  exists: boolean
  status: NapcatInspectionStatus
  reason?: string
  entry: string
  qqExecutable: string
}

interface NapcatDetection {
  found: boolean
  status: 'unsupported' | 'installed' | 'partial' | 'missing'
  path: string
  expectedPath: string
  entry: string
  reason: string
  candidates: NapcatCandidateSummary[]
}

function isNonEmptyString(value: string): value is string {
  return !!value
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function readJsonRecord(filePath: string): Record<string, unknown> | null {
  const parsed: unknown = JSON.parse(fs.readFileSync(filePath, 'utf8'))
  return isRecord(parsed) ? parsed : null
}

function getErrorMessage(e: unknown): string | undefined {
  if (!isRecord(e)) return undefined
  const message = e.message
  if (typeof message === 'string') return message
  if (message == null) return undefined
  return String(message)
}

function getLinuxNapcatQQExecutable(): string {
  const napcatDir = String(process.env.NAPCAT_DIR || '').trim()
  const candidates = [
    process.env.NAPCAT_QQ_EXECUTABLE || '',
    process.env.NAPCAT_QQ_PATH || '',
    napcatDir ? path.join(napcatDir, 'opt', 'QQ', 'qq') : '',
    napcatDir ? path.join(napcatDir, 'qq') : '',
    path.join(KOISHI_DIR, 'Napcat', 'opt', 'QQ', 'qq'),
    path.join(KOISHI_DIR, 'NapCat', 'opt', 'QQ', 'qq'),
    '/root/Napcat/opt/QQ/qq',
  ].filter(isNonEmptyString)
  return uniquePaths(candidates).find((item: string) => fs.existsSync(item)) || candidates[0] || '/root/Napcat/opt/QQ/qq'
}

function findNapcatMarkers(root: string): NapcatMarkersResult {
  const markers: NapcatMarker[] = []
  const archives: NapcatArchive[] = []
  let count = 0
  function walk(dir: string, depth: number): void {
    if (depth > 4 || count > 240) return
    let entries: import('fs').Dirent[] = []
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      if (count > 240) return
      count += 1
      const full = path.join(dir, entry.name)
      const rel = path.relative(root, full).replace(/\\/g, '/')
      if (entry.isDirectory()) {
        if (!['node_modules', 'resources', 'config', 'app'].includes(entry.name) && depth >= 2) continue
        walk(full, depth + 1)
        continue
      }
      if (!entry.isFile()) continue
      if (/^NapCatInstaller\.exe$/i.test(entry.name)) markers.push({ path: full, rel, type: 'installer' })
      else if ((/^napcat.*\.(exe|bat|cmd|js|mjs)$/i.test(entry.name) && !/kill/i.test(entry.name)) || /^NapCatWinBootMain\.exe$/i.test(entry.name) || /NapCat.*\.exe$/i.test(entry.name)) markers.push({ path: full, rel, type: 'entry' })
      else if (/^config\/webui\.json$/i.test(rel)) markers.push({ path: full, rel, type: 'config' })
      else if (/^package\.json$/i.test(entry.name)) {
        try {
          const pkg = readJsonRecord(full)
          if (pkg && /napcat/i.test(String(pkg.name || '') + ' ' + String(pkg.description || ''))) markers.push({ path: full, rel, type: 'package' })
        } catch { /* non-critical: marker probe fallback */ }
      } else if (/\.(zip|7z|rar|tar\.gz)$/i.test(entry.name)) archives.push({ path: full, rel })
    }
  }
  walk(root, 0)
  return { markers, archives }
}

function rankNapcatEntry(filePath: string | null | undefined): number {
  const name = path.basename(filePath || '')
  if (/^napcat\.quick\.(bat|cmd)$/i.test(name)) return 0
  if (/^napcat\.(bat|cmd)$/i.test(name)) return 1
  if (/^NapCatWinBootMain\.exe$/i.test(name)) return 2
  if (/^napcat.*\.exe$/i.test(name)) return 3
  if (/\.(bat|cmd)$/i.test(name)) return 4
  if (/\.(js|mjs)$/i.test(name)) return 5
  if (/NapCat.*\.exe$/i.test(name)) return 6
  return 20
}

function sortNapcatEntries(markers: NapcatMarker[] = []): NapcatMarker[] {
  return markers
    .filter((item: NapcatMarker) => item.type === 'entry')
    .slice()
    .sort((a: NapcatMarker, b: NapcatMarker) => rankNapcatEntry(a.path) - rankNapcatEntry(b.path) || String(a.rel || a.path).localeCompare(String(b.rel || b.path)))
}

function findNapcatQQExecutable(root: string): string {
  for (const candidate of [path.join(root, 'QQ.exe'), path.join(root, 'bootmain', 'QQ.exe')]) {
    try { if (fs.statSync(candidate).isFile()) return candidate } catch { /* non-critical: candidate probe fallback */ }
  }
  return ''
}

function entryRequiresBundledQQ(entry: NapcatMarker | string | null | undefined): boolean {
  const name = path.basename(typeof entry === 'string' ? entry : (entry?.path || ''))
  return /^(?:napcat(?:\.quick)?\.(?:bat|cmd)|NapCatWinBootMain\.exe)$/i.test(name)
}

function inspectNapcatCandidate(candidate: string): NapcatInspection {
  const result: NapcatInspection = { path: candidate, exists: false, found: false, status: 'missing', reason: '路径不存在' }
  try {
    const stat = fs.statSync(candidate)
    result.exists = true
    if (stat.isFile()) {
      const name = path.basename(candidate)
      if (/napcat.*\.(exe|bat|cmd|zip|7z)$/i.test(name)) return { ...result, found: /\.(exe|bat|cmd)$/i.test(name), status: /\.(exe|bat|cmd)$/i.test(name) ? 'installed' : 'partial', entry: candidate, reason: /\.(exe|bat|cmd)$/i.test(name) ? '找到 NapCat 启动文件' : '只发现下载包，尚未解压安装' }
      return { ...result, status: 'partial', reason: '路径是文件但不是 NapCat 启动文件' }
    }
    if (!stat.isDirectory()) return { ...result, status: 'partial', reason: '路径不是目录' }
    const entries = fs.readdirSync(candidate)
    if (!entries.length) return { ...result, status: 'partial', reason: '目录为空' }
    const { markers, archives } = findNapcatMarkers(candidate)
    const entryMarkers = sortNapcatEntries(markers)
    const qqExecutable = findNapcatQQExecutable(candidate)
    if (entryMarkers.some(entryRequiresBundledQQ) && !qqExecutable) return { ...result, status: 'partial', entry: entryMarkers[0]?.path || '', reason: 'NapCat 启动文件存在，但 bootmain/QQ.exe 缺失，当前包不完整或未完成安装', markers: markers.slice(0, 8) }
    if (entryMarkers.length || markers.some((item: NapcatMarker) => item.type === 'config')) return { ...result, found: true, status: 'installed', entry: entryMarkers[0]?.path || '', reason: '找到 NapCat 启动或配置标记', markers: markers.slice(0, 8), qqExecutable }
    if (archives.length) return { ...result, status: 'partial', reason: '目录里只有下载包或压缩包，尚未解压安装', archives: archives.slice(0, 8) }
    return { ...result, status: 'partial', reason: '目录存在但未找到 NapCat 启动文件' }
  } catch (e) {
    return { ...result, status: 'unknown', reason: getErrorMessage(e) }
  }
}

function detectNapcatInstallation(): NapcatDetection {
  const expectedPath = runtimePath('napcat')
  if (process.platform !== 'win32') {
    const reason = `当前 Dashboard 后端是 ${process.platform}/${process.arch}，Windows 本地部署需要在 Windows 部署器软件中运行。远端网页不能检测浏览器所在的 Windows 电脑。`
    return { found: false, status: 'unsupported', path: '', expectedPath, entry: '', reason, candidates: [] }
  }
  const candidates = uniquePaths([
    expectedPath,
    readFileContent(LOCAL_NAPCAT_DIR_FILE),
    path.join(KOISHI_DIR, 'NapCat'),
    process.env.NAPCAT_DIR || '',
    path.join(KOISHI_DIR, 'runtime', 'NapCat'),
  ].filter(isNonEmptyString))
  const inspected = candidates.map(inspectNapcatCandidate)
  const installed = inspected.find((item: NapcatInspection) => item.found)
  const partial = inspected.find((item: NapcatInspection) => item.exists)
  const selected = installed || partial || inspected[0] || { found: false, exists: false, path: expectedPath, status: 'missing', reason: '未找到 NapCat' }
  return {
    found: !!installed,
    status: installed ? 'installed' : (partial ? 'partial' : 'missing'),
    path: selected.path,
    expectedPath,
    entry: selected.entry || '',
    reason: selected.reason || (installed ? '已安装' : '未检测到 NapCat'),
    candidates: inspected.map((item: NapcatInspection) => ({ path: item.path, exists: item.exists, status: item.status, reason: item.reason, entry: item.entry || '', qqExecutable: item.qqExecutable || '' })),
  }
}

function getNapcatStartEntry(): { detected: NapcatDetection, entry: string } {
  const detected = detectNapcatInstallation()
  const entryRe = /\.(exe|bat|cmd|js|mjs)$/i
  const direct = detected.entry && entryRe.test(detected.entry) ? detected.entry : ''
  if (direct) return { detected, entry: direct }
  const roots = uniquePaths([detected.path, detected.expectedPath, readFileContent(LOCAL_NAPCAT_DIR_FILE)].filter(isNonEmptyString))
  for (const root of roots) {
    const marker = sortNapcatEntries(findNapcatMarkers(root).markers).find((item: NapcatMarker) => entryRe.test(item.path))
    if (marker) return { detected, entry: marker.path }
  }
  return { detected, entry: '' }
}

function listNapcatConfigDirs(): string[] {
  const recordedDir = readFileContent(LOCAL_NAPCAT_DIR_FILE)
  const dirs = [
    recordedDir ? path.join(recordedDir, 'config') : '',
    path.join(KOISHI_DIR, 'runtime', 'napcat', 'config'),
    path.join(KOISHI_DIR, 'runtime', 'NapCat', 'config'),
    '/root/Napcat/opt/QQ/resources/app/app_launcher/napcat/config',
  ].filter(isNonEmptyString)
  const extra = String(process.env.NAPCAT_CONFIG || '').trim()
  if (extra) {
    try {
      const st = fs.statSync(extra)
      dirs.push(st.isDirectory() ? extra : path.dirname(extra))
    } catch { /* non-critical: optional config probe */ }
  }
  return uniquePaths(dirs)
}

function readNapcatWebuiPortFromConfigFiles(): number | null {
  for (const dir of listNapcatConfigDirs()) {
    const webUiPath = path.join(dir, 'webui.json')
    try {
      const cfg = readJsonRecord(webUiPath)
      const n = Number(cfg ? cfg.port : undefined)
      if (Number.isFinite(n) && n > 0 && n <= 65535) return n
    } catch { /* non-critical: optional config probe */ }
    const napcatPath = path.join(dir, 'napcat.json')
    try {
      const cfg = readJsonRecord(napcatPath)
      const webui = cfg && isRecord(cfg.webui) ? cfg.webui : null
      const nested = webui && webui.port != null ? Number(webui.port) : NaN
      if (Number.isFinite(nested) && nested > 0 && nested <= 65535) return nested
    } catch { /* non-critical: optional config probe */ }
  }
  return null
}

function resolveNapcatWebuiListenPort(): number {
  const raw = String(process.env.NAPCAT_PORT || '').trim()
  if (raw) {
    const n = Number(raw)
    if (Number.isFinite(n) && n > 0 && n <= 65535) return n
  }
  const fromCfg = readNapcatWebuiPortFromConfigFiles()
  return fromCfg != null ? fromCfg : 6099
}

function resolveNapcatOnebotListenPort(): number {
  const raw = String(process.env.NAPCAT_ONEBOT_PORT || '').trim()
  if (raw) {
    const n = Number(raw)
    if (Number.isFinite(n) && n > 0 && n <= 65535) return n
  }
  return 8080
}

interface NapcatTokenFn {
  (): string
  _cached?: string
  _mtimeMs?: number
  _cachePath?: string
}

const getNapcatToken: NapcatTokenFn = function () {
  const recordedDir = readFileContent(LOCAL_NAPCAT_DIR_FILE)
  const candidates = [
    recordedDir ? path.join(recordedDir, 'config', 'webui.json') : '',
    path.join(KOISHI_DIR, 'runtime', 'napcat', 'config', 'webui.json'),
    path.join(KOISHI_DIR, 'runtime', 'NapCat', 'config', 'webui.json'),
    '/root/Napcat/opt/QQ/resources/app/app_launcher/napcat/config/webui.json',
    process.env.NAPCAT_CONFIG || '',
  ].filter(isNonEmptyString)
  try {
    const cachePath = getNapcatToken._cachePath
    if (cachePath) {
      const st = fs.statSync(cachePath)
      if (getNapcatToken._mtimeMs === st.mtimeMs && typeof getNapcatToken._cached === 'string') {
        return getNapcatToken._cached
      }
    }
  } catch { /* non-critical: token cache probe fallback */ }
  getNapcatToken._cached = ''
  getNapcatToken._mtimeMs = 0
  getNapcatToken._cachePath = ''
  for (const p of candidates) {
    try {
      const st = fs.statSync(p)
      const cfg = readJsonRecord(p)
      const token = cfg ? cfg.token : undefined
      if (token) {
        const tokenText = String(token)
        getNapcatToken._cached = tokenText
        getNapcatToken._mtimeMs = st.mtimeMs
        getNapcatToken._cachePath = p
        return tokenText
      }
    } catch { /* non-critical: token candidate probe fallback */ }
  }
  return ''
}

export = {
  getLinuxNapcatQQExecutable,
  findNapcatMarkers,
  rankNapcatEntry,
  sortNapcatEntries,
  findNapcatQQExecutable,
  entryRequiresBundledQQ,
  inspectNapcatCandidate,
  detectNapcatInstallation,
  getNapcatStartEntry,
  listNapcatConfigDirs,
  readNapcatWebuiPortFromConfigFiles,
  resolveNapcatWebuiListenPort,
  resolveNapcatOnebotListenPort,
  getNapcatToken,
}
