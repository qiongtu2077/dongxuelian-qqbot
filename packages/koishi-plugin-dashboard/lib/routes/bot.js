'use strict'

const fs = require('fs')
const path = require('path')
const { exec, execSync } = require('child_process')
const { json, collectBody, log, readFileSyncSafe, writeFileSyncSafe, sleepSync, shellQuote } = require('../utils')
const { requireAdmin } = require('../auth')
const { KOISHI_DIR, KOISHI_PID_FILE, DATA_DIR } = require('../paths')
const { checkPortState } = require('../tools')
const { resolveNapcatWebuiListenPort, resolveNapcatOnebotListenPort, getLinuxNapcatQQExecutable, getNapcatToken } = require('../napcat')
const { readLoggingConfig, writeLoggingConfig, getFilteredLogEntries } = require('../logging')
const { resolveKoishiListenPort } = require('../tools')
const { waitKoishiPortFree } = require('../deploy-state')

function stopKoishiProcesses() {
  let pid = 0
  try {
    const raw = String(fs.readFileSync(KOISHI_PID_FILE, 'utf8') || '').trim().split(/\r?\n/, 2)[0] || ''
    pid = parseInt(raw, 10)
  } catch {}
  if (!(Number.isFinite(pid) && pid > 0)) pid = 0

  if (pid > 0) {
    if (process.platform === 'win32') {
      try { execSync(`taskkill /PID ${pid} /F /T`, { timeout: 8000, stdio: 'ignore' }) } catch {}
    } else {
      try { process.kill(pid, 'SIGTERM') } catch {
        try { execSync(`/bin/sh -lc 'kill -TERM ${pid} 2>/dev/null; kill -KILL ${pid} 2>/dev/null || true'`, { timeout: 4000, stdio: 'ignore' }) } catch {}
      }
    }
    try { fs.unlinkSync(KOISHI_PID_FILE) } catch {}
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

function getLegacyNapcatStatus() {
  const webuiPort = resolveNapcatWebuiListenPort()
  const onebotPort = resolveNapcatOnebotListenPort()
  const webui = checkPortState(webuiPort)
  const onebot = checkPortState(onebotPort)
  let processLines = []
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
  } catch {}
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


// --- Route Handlers ---

function handleGetBotStatus(req, res) {
  try {
    let running = 0
    if (process.platform === 'win32') {
      running = checkPortState(resolveKoishiListenPort()).status === 'occupied' ? 1 : 0
    } else {
      const out = execSync("ps aux | grep 'koishi/lib/worker' | grep -v grep", { encoding: 'utf8', timeout: 3000 }).trim()
      running = out.split('\n').filter(Boolean).length
    }
    let qq = ''
    try {
      const yml = fs.readFileSync(path.join(KOISHI_DIR, 'koishi.yml'), 'utf8')
      const m = yml.match(/selfId:\s*['\"]?(\d+)['\"]?/)
      if (m) qq = m[1]
    } catch {}
    return json(res, { running: running > 0, workers: running, qq })
  } catch { return json(res, { running: false, workers: 0 }) }
}

function handleGetLogging(req, res) {
  return json(res, { ok: true, config: readLoggingConfig() })
}

function handlePutLogging(req, res) {
  if (!requireAdmin(req, res)) return
  collectBody(req, res, (body) => {
    try {
      const data = JSON.parse(body || '{}')
      const config = writeLoggingConfig(data)
      return json(res, { ok: true, config, message: config.enabled ? '调试日志已开启' : '调试日志已关闭' })
    } catch (e) { return json(res, { ok: false, message: e.message }, 400) }
  })
}

function handlePostBotStart(req, res) {
  if (!requireAdmin(req, res)) return
  exec(`bash "${path.join(KOISHI_DIR, 'restart.sh').replace(/\\/g, '/')}"`, { maxBuffer: 512 * 1024 }, (err) => {
    if (err) log('start bot failed: ' + err.message)
  })
  return json(res, { ok: true, message: '启动命令已发送' })
}

function handlePostBotStop(req, res) {
  if (!requireAdmin(req, res)) return
  try {
    stopKoishiProcesses()
    return json(res, { ok: true, message: '已停止所有 koishi 进程' })
  } catch (e) { return json(res, { ok: false, message: e.message }) }
}

function handleGetMaintenance(req, res) {
  return json(res, { enabled: !!readFileSyncSafe(path.join(DATA_DIR, 'ai-paused.txt')) })
}

function handlePutMaintenance(req, res) {
  if (!requireAdmin(req, res)) return
  collectBody(req, res, (body) => {
    try {
      const { enabled } = JSON.parse(body)
      const f = path.join(DATA_DIR, 'ai-paused.txt')
      if (enabled) writeFileSyncSafe(f, '优化中，别急')
      else try { fs.unlinkSync(f) } catch {}
      return json(res, { ok: true, message: enabled ? '维护模式已开启' : '维护模式已关闭' })
    } catch (e) { return json(res, { ok: false, message: e.message }, 400) }
  })
}

function handleGetThrottle(req, res) {
  try {
    const raw = readFileSyncSafe(path.join(DATA_DIR, 'ai-throttle-config.json'))
    return json(res, JSON.parse(raw))
  } catch { return json(res, { maxPerMinute: 20 }) }
}

function handlePutThrottle(req, res) {
  if (!requireAdmin(req, res)) return
  collectBody(req, res, (body) => {
    try {
      const data = JSON.parse(body)
      if (typeof data.maxPerMinute !== 'number' || data.maxPerMinute < 1) {
        return json(res, { ok: false, message: 'maxPerMinute 必须 >= 1' }, 400)
      }
      const f = path.join(DATA_DIR, 'ai-throttle-config.json')
      fs.writeFileSync(f + '.tmp', JSON.stringify({ maxPerMinute: data.maxPerMinute }, null, 2), 'utf8')
      fs.renameSync(f + '.tmp', f)
      json(res, { ok: true, message: '节流配置已更新' })
    } catch (e) { json(res, { ok: false, message: e.message }, 400) }
  })
}

function handleGetQqToken(req, res) {
  if (!requireAdmin(req, res)) return
  return json(res, { token: process.env.NAPCAT_TOKEN || getNapcatToken() })
}

function handleGetQqSshInfo(req, res) {
  return json(res, { host: process.env.DASHBOARD_SSH_HOST || '', user: process.env.DASHBOARD_SSH_USER || 'root', port: 22 })
}

function handleGetQqSelfId(req, res) {
  try {
    const yml = fs.readFileSync(path.join(KOISHI_DIR, 'koishi.yml'), 'utf8')
    const m = yml.match(/selfId:\s*['\"]?(\d+)['\"]?/)
    return json(res, { selfId: m ? m[1] : '' })
  } catch { return json(res, { selfId: '' }) }
}

function handlePutQqSelfId(req, res) {
  if (!requireAdmin(req, res)) return
  collectBody(req, res, (body) => {
    try {
      const { selfId } = JSON.parse(body)
      if (!selfId || !/^\d+$/.test(selfId)) return json(res, { ok: false, message: '无效 QQ 号' }, 400)
      const ymlPath = path.join(KOISHI_DIR, 'koishi.yml')
      let yml = fs.readFileSync(ymlPath, 'utf8')
      yml = yml.replace(/(selfId:\s*['\"]?)\d+(['\"]?)/, '$1' + selfId + '$2')
      fs.writeFileSync(ymlPath, yml, 'utf8')
      exec(`bash "${path.join(KOISHI_DIR, 'restart.sh').replace(/\\/g, '/')}"`, { maxBuffer: 512 * 1024 })
      json(res, { ok: true, message: 'QQ 号已更新，Koishi 正在重启...' })
    } catch (e) { json(res, { ok: false, message: e.message }, 400) }
  })
}

function handleGetNapcatStatus(req, res) {
  return json(res, getLegacyNapcatStatus())
}

function handlePostNapcatRestart(req, res) {
  if (!requireAdmin(req, res)) return
  const raw = process.env.DASHBOARD_QQ_NUMBER || '3098291287'
  const qq = raw.replace(/[^0-9]/g, '')
  if (!qq) return json(res, { ok: false, message: '无效 QQ 号' }, 400)
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

function handleGetBotActivity(req, res, pathname, url) {
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

const routes = {
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

module.exports = {
  routes,
  resolveKoishiListenPort,
  stopKoishiProcesses,
  getLegacyNapcatStatus,
  readLoggingConfig,
  writeLoggingConfig,
}
