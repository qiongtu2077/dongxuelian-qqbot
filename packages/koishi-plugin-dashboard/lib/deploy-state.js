'use strict'

const fs = require('fs')
const path = require('path')
const { spawn } = require('child_process')
const { KOISHI_DIR, KOISHI_PID_FILE } = require('./paths')
const { readLastLogLines } = require('./logging')

const runtimePath = (...args) => path.join(KOISHI_DIR, 'runtime', ...args)

const localTasks = {
  npmInstall: { label: 'npm install', logFile: runtimePath('logs', 'npm-install.log'), state: 'idle', running: false, startedAt: 0, finishedAt: 0, exitCode: null, error: '', pid: 0, command: '', cwd: '', process: null },
  napcat: { label: 'NapCat', logFile: runtimePath('logs', 'napcat.log'), state: 'idle', running: false, startedAt: 0, finishedAt: 0, exitCode: null, error: '', pid: 0, command: '', cwd: '', process: null },
  koishi: { label: 'Koishi', logFile: runtimePath('logs', 'koishi-local.log'), state: 'idle', running: false, startedAt: 0, finishedAt: 0, exitCode: null, error: '', pid: 0, command: '', cwd: '', process: null },
}

let rebuildStatus = { state: 'idle', message: '', detail: '', startedAt: 0, finishedAt: 0 }
let npmDiagnosticsCache = { at: 0, data: null }

function getRebuildStatus() { return rebuildStatus }
function setRebuildStatus(s) { rebuildStatus = s }
function getNpmDiagnosticsCache() { return npmDiagnosticsCache }
function setNpmDiagnosticsCache(c) { npmDiagnosticsCache = c }

function appendLocalTaskLog(task, chunk) {
  try {
    fs.mkdirSync(path.dirname(task.logFile), { recursive: true })
    fs.appendFileSync(task.logFile, String(chunk), 'utf8')
  } catch {}
}

function getTaskPublicStatus(key, extra = {}) {
  const task = localTasks[key]
  return {
    state: task.state,
    running: !!task.running,
    startedAt: task.startedAt,
    finishedAt: task.finishedAt,
    exitCode: task.exitCode,
    error: task.error,
    pid: task.pid,
    command: task.command,
    cwd: task.cwd,
    logFile: task.logFile,
    logLines: readLastLogLines(task.logFile, 160),
    ...extra,
  }
}

function spawnLocalTask(key, command, args = [], options = {}) {
  const task = localTasks[key]
  if (!task) throw new Error('unknown local task')
  if (task.running && task.process && !task.process.killed) return { alreadyRunning: true, status: getTaskPublicStatus(key) }
  fs.mkdirSync(path.dirname(task.logFile), { recursive: true })
  task.state = 'running'
  task.running = true
  task.startedAt = Date.now()
  task.finishedAt = 0
  task.exitCode = null
  task.error = ''
  task.diagnostics = options.diagnostics || null
  task.pid = 0
  task.command = [command].concat(args).join(' ')
  task.cwd = options.cwd || KOISHI_DIR
  fs.writeFileSync(task.logFile, `[${new Date().toISOString()}] $ ${task.command}\n`, 'utf8')
  const child = spawn(command, args, {
    cwd: task.cwd,
    env: { ...process.env, ...(options.env || {}) },
    windowsHide: true,
    shell: options.shell === true,
    maxBuffer: 512 * 1024,
  })
  task.process = child
  task.pid = child.pid || 0
  if (key === 'koishi') {
    try {
      fs.mkdirSync(path.dirname(KOISHI_PID_FILE), { recursive: true })
      fs.writeFileSync(KOISHI_PID_FILE, String(task.pid), 'utf8')
    } catch {}
  }
  child.stdout?.on('data', chunk => appendLocalTaskLog(task, chunk))
  child.stderr?.on('data', chunk => appendLocalTaskLog(task, chunk))
  child.on('error', err => {
    task.error = err.message
    task.state = 'failed'
    task.running = false
    task.finishedAt = Date.now()
    appendLocalTaskLog(task, `\n[${new Date().toISOString()}] ERROR ${err.message}\n`)
  })
  child.on('close', code => {
    task.running = false
    task.process = null
    task.exitCode = code
    task.finishedAt = Date.now()
    task.state = code === 0 ? 'success' : 'failed'
    appendLocalTaskLog(task, `\n[${new Date().toISOString()}] EXIT ${code}\n`)
    if (key === 'koishi') {
      try {
        const cur = String(fs.readFileSync(KOISHI_PID_FILE, 'utf8') || '').trim()
        const curPid = parseInt(cur.split(/\r?\n/, 2)[0] || '', 10)
        if (Number.isFinite(curPid) && curPid === child.pid) fs.unlinkSync(KOISHI_PID_FILE)
      } catch {}
    }
  })
  return { alreadyRunning: false, status: getTaskPublicStatus(key) }
}

function waitKoishiPortFree() {
  const { checkPortState } = require('./tools')
  const { resolveKoishiListenPort } = require('./deploy-helpers')
  const port = resolveKoishiListenPort()
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    const state = checkPortState(port)
    if (state.available || state.status === 'free') return
    const { sleepSync } = require('./utils')
    sleepSync(300)
  }
}

module.exports = {
  localTasks,
  getRebuildStatus,
  setRebuildStatus,
  getNpmDiagnosticsCache,
  setNpmDiagnosticsCache,
  appendLocalTaskLog,
  getTaskPublicStatus,
  spawnLocalTask,
  waitKoishiPortFree,
}
