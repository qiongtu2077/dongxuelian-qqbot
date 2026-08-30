'use strict'

import type { ExecException } from 'child_process'
import type { IncomingMessage, ServerResponse } from 'http'

const fs = require('fs') as typeof import('fs')
const path = require('path') as typeof import('path')
const { exec, execSync } = require('child_process') as typeof import('child_process')
const { json, collectBody, log, readFileSyncSafe, writeFileSyncSafe, sleepSync, shellQuote, getErrorMessage } = require('../utils') as {
  json(res: unknown, data: unknown, status?: number): void
  collectBody(req: unknown, res: unknown, callback: (body: string) => void | Promise<void>): void
  log(message: unknown): void
  readFileSyncSafe(filePath: string, maxBytes?: number): string
  writeFileSyncSafe(filePath: string, content: unknown): void
  sleepSync(ms: number): void
  shellQuote(value: unknown): string
  getErrorMessage(error: unknown): string
}
const { requireAdmin } = require('../auth') as { requireAdmin(req: unknown, res: unknown): boolean }
const { KOISHI_DIR, KOISHI_PID_FILE, DATA_DIR } = require('../paths') as { KOISHI_DIR: string; KOISHI_PID_FILE: string; DATA_DIR: string }
const { checkPortState } = require('../tools') as { checkPortState(port: unknown): PortState }
const { resolveNapcatWebuiListenPort, resolveNapcatOnebotListenPort, getLinuxNapcatQQExecutable, getNapcatToken } = require('../napcat') as {
  resolveNapcatWebuiListenPort(): number
  resolveNapcatOnebotListenPort(): number
  getLinuxNapcatQQExecutable(): string
  getNapcatToken(): string
}
const { readLoggingConfig, writeLoggingConfig, getFilteredLogEntries } = require('../logging') as {
  readLoggingConfig(): unknown
  writeLoggingConfig(config: unknown): { enabled?: boolean }
  getFilteredLogEntries(options: Record<string, unknown>): unknown
}
const { resolveKoishiListenPort } = require('../tools') as { resolveKoishiListenPort(): number }
const { waitKoishiPortFree } = require('../deploy-state') as { waitKoishiPortFree(): void }

interface PortState {
  status: string
}

interface LegacyNapcatStatus {
  running: boolean
  login: 'online' | 'waiting-login' | 'offline'
  webui: boolean
  onebot: boolean
  webuiPort: number
  onebotPort: number
  qqExecutable: string
  processes: string[]
}

interface BotJsonBody {
  enabled?: unknown
  maxPerMinute?: unknown
  selfId?: unknown
}

type RouteHandler = (req: IncomingMessage, res: ServerResponse, pathname: string, url: URL) => unknown

function parseJsonObject(body: string): BotJsonBody {
  const data = JSON.parse(body || '{}')
  return data && typeof data === 'object' && !Array.isArray(data) ? data as BotJsonBody : {}
}

function stopKoishiProcesses(): void {
  let pid = 0
  try {
    const raw = String(fs.readFileSync(KOISHI_PID_FILE, 'utf8') || '').trim().split(/\r?\n/, 2)[0] || ''
    pid = parseInt(raw, 10)
  } catch { /* non-critical: stale pid fallback */ }
  if (!(Number.isFinite(pid) && pid > 0)) pid = 0

  if (pid > 0) {
    if (process.platform === 'win32') {
      try { execSync(`taskkill /PID ${pid} /F /T`, { timeout: 8000, stdio: 'ignore' }) } catch { /* non-critical: process may already be stopped */ }
    } else {
      try { process.kill(pid, 'SIGTERM') } catch {
        try { execSync(`/bin/sh -lc 'kill -TERM ${pid} 2>/dev/null; kill -KILL ${pid} 2>/dev/null || true'`, { timeout: 4000, stdio: 'ignore' }) } catch { /* non-critical: process may already be stopped */ }
      }
    }
    try { fs.unlinkSync(KOISHI_PID_FILE) } catch { /* non-critical: stale pid cleanup */ }
    waitKoishiPortFree()
    return
  }

  if (process.platform === 'win32') {
    const { commandQuote } = require('../utils')
    const dirLit = commandQuote(path.resolve(KOISHI_DIR))
    execSync(
      `powershell -NoProfile -Command "$d=${dirLit}; Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine.Contains([string]$d) -and ($_.CommandLine -match 'koishi') } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"`,
      { timeout: 8000, stdio: 'ignore' },
    )
    waitKoishiPortFree()
    return
  }
  execSync("pkill -9 -f 'koishi/lib/worker' 2>/dev/null || true", { timeout: 5000 })
  execSync("pkill -9 -f 'node.*koishi start' 2>/dev/null || true", { timeout: 5000 })
  waitKoishiPortFree()
}

function getLegacyNapcatStatus(): LegacyNapcatStatus {
  const webuiPort = resolveNapcatWebuiListenPort()
  const onebotPort = resolveNapcatOnebotListenPort()
  const webui = checkPortState(webuiPort)
  const onebot = checkPortState(onebotPort)
  let processLines: string[] = []
  try {
    const output = execSync('ps -eo pid=,args=', { encoding: 'utf8', timeout: 3000 })
    processLines = output.split(/\r?\n/).map(line => line.trim()).filter(line => {
      if (!line) return false
      if (/\/opt\/QQ\/qq(?:\s|$)/.test(line)) return true
      if (/\bxvfb-run\b/.test(line) && /\/opt\/QQ\/qq/.test(line)) return true
      if (/\bXvfb\b/.test(line)) return true
      if (/\bSCREEN\b/.test(line) && /\bnapcat\b/i.test(line)) return true
      return false
    })
  } catch { /* non-critical: status probe fallback */ }
  const running = processLines.length > 0 || webui.status === 'occupied' || onebot.status === 'occupied'
  const login = onebot.status === 'occupied' ? 'online' : (webui.status === 'occupied' ? 'waiting-login' : 'offline')
  return {
    running, login,
    webui: webui.status === 'occupied', onebot: onebot.status === 'occupied',
    webuiPort, onebotPort,
    qqExecutable: getLinuxNapcatQQExecutable(),
    processes: processLines.slice(0, 12),
  }
}

function normalizeQqNumber(value: unknown): string {
  return String(value || '').replace(/[^0-9]/g, '')
}

function readKoishiSelfId(): string {
  try {
    const yml = fs.readFileSync(path.join(KOISHI_DIR, 'koishi.yml'), 'utf8')
    const m = yml.match(/selfId:\s*['"]?(\d+)['"]?/)
    return m ? m[1] : ''
  } catch {
    return ''
  }
}

// Replaces a configuration file in its own directory while preserving its existing mode.
function writeConfigAtomic(filePath: string, content: string): void {
  const nextPath = filePath + '.next'
  const mode = fs.statSync(filePath).mode & 0o777
  fs.writeFileSync(nextPath, content, { encoding: 'utf8', mode })
  fs.renameSync(nextPath, filePath)
  fs.chmodSync(filePath, mode)
}

function resolveNapcatRestartQq(): string {
  for (const raw of [process.env.DASHBOARD_QQ_NUMBER, process.env.QQ_NUMBER, readKoishiSelfId()]) {
    const qq = normalizeQqNumber(raw)
    if (qq) return qq
  }
  return ''
}


// --- Route Handlers ---

function handleGetBotStatus(req: IncomingMessage, res: ServerResponse): void {
  try {
    let running = 0
    if (process.platform === 'win32') {
      running = checkPortState(resolveKoishiListenPort()).status === 'occupied' ? 1 : 0
    } else {
      const out = execSync("ps aux | grep 'koishi/lib/worker' | grep -v grep", { encoding: 'utf8', timeout: 3000 }).trim()
      running = out.split('\n').filter(Boolean).length
    }
    const qq = readKoishiSelfId()
    return json(res, { running: running > 0, workers: running, qq })
  } catch { return json(res, { running: false, workers: 0 }) }
}

function handleGetLogging(req: IncomingMessage, res: ServerResponse): void {
  return json(res, { ok: true, config: readLoggingConfig() })
}

function handlePutLogging(req: IncomingMessage, res: ServerResponse): void {
  if (!requireAdmin(req, res)) return
  collectBody(req, res, (body) => {
    try {
      const data = parseJsonObject(body)
      const config = writeLoggingConfig(data)
      return json(res, { ok: true, config, message: config.enabled ? '调试日志已开启' : '调试日志已关闭' })
    } catch (e) { return json(res, { ok: false, message: getErrorMessage(e) }, 400) }
  })
}

function handlePostBotStart(req: IncomingMessage, res: ServerResponse): void {
  if (!requireAdmin(req, res)) return
  const restartScript = path.join(KOISHI_DIR, 'restart.sh')
  if (!fs.existsSync(restartScript)) return json(res, { ok: false, message: '启动脚本不存在，请检查部署目录' }, 400)
  exec(`bash "${restartScript.replace(/\\/g, '/')}"`, { maxBuffer: 512 * 1024 }, (err: ExecException | null) => {
    if (err) log('start bot failed: ' + err.message)
  })
  return json(res, { ok: true, message: '启动命令已发送' })
}

function handlePostBotStop(req: IncomingMessage, res: ServerResponse): void {
  if (!requireAdmin(req, res)) return
  try {
    stopKoishiProcesses()
    return json(res, { ok: true, message: '已停止所有 koishi 进程' })
  } catch (e) { return json(res, { ok: false, message: getErrorMessage(e) }) }
}

function handleGetMaintenance(req: IncomingMessage, res: ServerResponse): void {
  return json(res, { enabled: !!readFileSyncSafe(path.join(DATA_DIR, 'ai-paused.txt')) })
}

function handlePutMaintenance(req: IncomingMessage, res: ServerResponse): void {
  if (!requireAdmin(req, res)) return
  collectBody(req, res, (body) => {
    try {
      const { enabled } = parseJsonObject(body)
      const f = path.join(DATA_DIR, 'ai-paused.txt')
      if (enabled) writeFileSyncSafe(f, '优化中，别急')
      else try { fs.unlinkSync(f) } catch { /* non-critical: stale token cleanup */ }
      return json(res, { ok: true, message: enabled ? '维护模式已开启' : '维护模式已关闭' })
    } catch (e) { return json(res, { ok: false, message: getErrorMessage(e) }, 400) }
  })
}

function handleGetThrottle(req: IncomingMessage, res: ServerResponse): void {
  try {
    const raw = readFileSyncSafe(path.join(DATA_DIR, 'ai-throttle-config.json'))
    return json(res, JSON.parse(raw))
  } catch { return json(res, { maxPerMinute: 20 }) }
}

function handlePutThrottle(req: IncomingMessage, res: ServerResponse): void {
  if (!requireAdmin(req, res)) return
  collectBody(req, res, (body) => {
    try {
      const data = parseJsonObject(body)
      if (typeof data.maxPerMinute !== 'number' || data.maxPerMinute < 1) {
        return json(res, { ok: false, message: 'maxPerMinute 必须 >= 1' }, 400)
      }
      const f = path.join(DATA_DIR, 'ai-throttle-config.json')
      fs.writeFileSync(f + '.tmp', JSON.stringify({ maxPerMinute: data.maxPerMinute }, null, 2), 'utf8')
      fs.renameSync(f + '.tmp', f)
      json(res, { ok: true, message: '节流配置已更新' })
    } catch (e) { json(res, { ok: false, message: getErrorMessage(e) }, 400) }
  })
}

function handleGetQqToken(req: IncomingMessage, res: ServerResponse): void {
  if (!requireAdmin(req, res)) return
  return json(res, { token: process.env.NAPCAT_TOKEN || getNapcatToken() })
}

function handleGetQqSshInfo(req: IncomingMessage, res: ServerResponse): void {
  if (!requireAdmin(req, res)) return
  return json(res, { host: process.env.DASHBOARD_SSH_HOST || '', user: process.env.DASHBOARD_SSH_USER || 'root', port: 22 })
}

function handleGetQqSelfId(req: IncomingMessage, res: ServerResponse): void {
  return json(res, { selfId: readKoishiSelfId() })
}

function handlePutQqSelfId(req: IncomingMessage, res: ServerResponse): void {
  if (!requireAdmin(req, res)) return
  collectBody(req, res, (body) => {
    try {
      const { selfId } = parseJsonObject(body)
      const nextSelfId = String(selfId || '')
      if (!nextSelfId || !/^\d+$/.test(nextSelfId)) return json(res, { ok: false, message: '无效 QQ 号' }, 400)
      const ymlPath = path.join(KOISHI_DIR, 'koishi.yml')
      const restartScript = path.join(KOISHI_DIR, 'restart.sh')
      if (!fs.existsSync(restartScript)) return json(res, { ok: false, message: '重启脚本不存在，配置未修改' }, 400)
      const previousYml = fs.readFileSync(ymlPath, 'utf8')
      if (!/selfId:\s*['\"]?\d+['\"]?/.test(previousYml)) return json(res, { ok: false, message: 'koishi.yml 中未找到可更新的 selfId' }, 400)
      const nextYml = previousYml.replace(/(selfId:\s*['\"]?)\d+(['\"]?)/, '$1' + nextSelfId + '$2')
      writeConfigAtomic(ymlPath, nextYml)
      exec(`bash "${restartScript.replace(/\\/g, '/')}"`, { maxBuffer: 512 * 1024 }, (restartError: ExecException | null) => {
        if (!restartError) {
          return json(res, { ok: true, message: 'QQ 号已更新，机器人已通过重启健康检查', stages: { configWritten: true, restartStarted: true, onlineConfirmed: true, rolledBack: false } })
        }
        try {
          writeConfigAtomic(ymlPath, previousYml)
        } catch (restoreError) {
          return json(res, { ok: false, message: '机器人重启失败，且旧配置自动恢复失败', code: 'QQ_CONFIG_ROLLBACK_FAILED', stages: { configWritten: true, restartStarted: true, onlineConfirmed: false, rolledBack: false }, detail: getErrorMessage(restoreError) }, 500)
        }
        exec(`bash "${restartScript.replace(/\\/g, '/')}"`, { maxBuffer: 512 * 1024 }, (restoreRestartError: ExecException | null) => {
          return json(res, { ok: false, message: restoreRestartError ? '机器人重启失败；旧 QQ 配置已恢复，但旧配置重启也失败' : '机器人重启失败；旧 QQ 配置已恢复并重新上线', code: 'QQ_RESTART_FAILED', stages: { configWritten: true, restartStarted: true, onlineConfirmed: false, rolledBack: true, rollbackRestarted: !restoreRestartError } }, 500)
        })
      })
    } catch (e) { json(res, { ok: false, message: getErrorMessage(e) }, 400) }
  })
}

function handleGetNapcatStatus(req: IncomingMessage, res: ServerResponse): void {
  if (!requireAdmin(req, res)) return
  return json(res, getLegacyNapcatStatus())
}

function handlePostNapcatRestart(req: IncomingMessage, res: ServerResponse): void {
  if (!requireAdmin(req, res)) return
  const qq = resolveNapcatRestartQq()
  if (!qq) return json(res, { ok: false, message: '未配置 QQ 号，请设置 DASHBOARD_QQ_NUMBER/QQ_NUMBER 或在 koishi.yml 写入 selfId' }, 400)
  const qqExecutable = getLinuxNapcatQQExecutable()
  const logFile = process.env.NAPCAT_LOG_FILE || '/root/napcat.log'
  const args = ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '-q', qq]
  const inner = ['xvfb-run', '-a', qqExecutable].concat(args).map(shellQuote).join(' ') + ' >> ' + shellQuote(logFile) + ' 2>&1'
  const command = [
    'screen -S napcat -X quit 2>/dev/null || true',
    'sleep 2',
    'printf %s\\\\n ' + shellQuote('=== DASHBOARD NAPCAT RESTART ' + new Date().toISOString() + ' ===') + ' >> ' + shellQuote(logFile),
    'screen -dmS napcat bash -lc ' + shellQuote(inner),
  ].join('; ')
  exec(command, { maxBuffer: 512 * 1024 })
  return json(res, { ok: true, message: 'NapCat 重启命令已发送', qqExecutable, args })
}

function handleGetBotActivity(req: IncomingMessage, res: ServerResponse, pathname: string, url: URL): void {
  if (!requireAdmin(req, res)) return
  try {
    return json(res, getFilteredLogEntries({
      limit: url.searchParams.get('limit'),
      levels: url.searchParams.get('levels'),
      module: url.searchParams.get('module'),
      q: url.searchParams.get('q'),
      errorsOnly: url.searchParams.get('errorsOnly'),
      since: url.searchParams.get('since'),
      filterKey: url.searchParams.get('filterKey'),
    }))
  } catch { return json(res, { entries: [], lines: [], total: 0 }) }
}

const routes: Record<string, RouteHandler> = {
  'GET /dashboard/api/bot/status': handleGetBotStatus,
  'GET /dashboard/api/bot/activity': handleGetBotActivity,
  'GET /dashboard/api/logging': handleGetLogging,
  'PUT /dashboard/api/logging': handlePutLogging,
  'POST /dashboard/api/bot/start': handlePostBotStart,
  'POST /dashboard/api/bot/stop': handlePostBotStop,
  'GET /dashboard/api/maintenance': handleGetMaintenance,
  'PUT /dashboard/api/maintenance': handlePutMaintenance,
  'GET /dashboard/api/throttle': handleGetThrottle,
  'PUT /dashboard/api/throttle': handlePutThrottle,
  'GET /dashboard/api/qq/token': handleGetQqToken,
  'GET /dashboard/api/qq/ssh-info': handleGetQqSshInfo,
  'GET /dashboard/api/qq/selfid': handleGetQqSelfId,
  'PUT /dashboard/api/qq/selfid': handlePutQqSelfId,
  'GET /dashboard/api/napcat/status': handleGetNapcatStatus,
  'POST /dashboard/api/napcat/restart': handlePostNapcatRestart,
}

export = {
  routes,
  resolveKoishiListenPort,
  stopKoishiProcesses,
  getLegacyNapcatStatus,
  readKoishiSelfId,
  resolveNapcatRestartQq,
  readLoggingConfig,
  writeLoggingConfig,
}
