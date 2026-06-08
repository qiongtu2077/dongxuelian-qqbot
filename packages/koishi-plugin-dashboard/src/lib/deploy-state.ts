'use strict'

import type { ChildProcessWithoutNullStreams, SpawnOptionsWithoutStdio } from 'child_process'

const fs = require('fs') as typeof import('fs')
const path = require('path') as typeof import('path')
const { spawn } = require('child_process') as typeof import('child_process')
const { KOISHI_DIR, KOISHI_PID_FILE } = require('./paths') as { KOISHI_DIR: string; KOISHI_PID_FILE: string }
const { readLastLogLines } = require('./logging') as { readLastLogLines(file: string, limit?: number): string[] }

type LocalTaskKey = 'npmInstall' | 'napcat' | 'koishi'
type LocalTaskState = 'idle' | 'running' | 'success' | 'failed'

interface LocalTask {
  label: string
  logFile: string
  state: LocalTaskState
  running: boolean
  startedAt: number
  finishedAt: number
  exitCode: number | null
  error: string
  pid: number
  command: string
  cwd: string
  process: ChildProcessWithoutNullStreams | null
  diagnostics?: unknown
}

interface SpawnLocalTaskOptions {
  diagnostics?: unknown
  cwd?: string
  env?: Record<string, string | undefined>
  shell?: boolean
}

interface RebuildStatus {
  state: string
  message: string
  detail: string
  startedAt: number
  finishedAt: number
}

interface NpmDiagnosticsCache {
  at: number
  data: unknown | null
}

interface LocalTaskPublicStatus {
  state: LocalTaskState
  running: boolean
  startedAt: number
  finishedAt: number
  exitCode: number | null
  error: string
  pid: number
  command: string
  cwd: string
  logFile: string
  logLines: string[]
  [key: string]: unknown
}

interface SpawnLocalTaskResult {
  alreadyRunning: boolean
  status: LocalTaskPublicStatus
}

type LocalSpawnOptions = SpawnOptionsWithoutStdio & { maxBuffer: number }

const runtimePath = (...args: string[]): string => path.join(KOISHI_DIR, 'runtime', ...args)

const localTasks: Record<LocalTaskKey, LocalTask> = {
  npmInstall: { label: 'npm install', logFile: runtimePath('logs', 'npm-install.log'), state: 'idle', running: false, startedAt: 0, finishedAt: 0, exitCode: null, error: '', pid: 0, command: '', cwd: '', process: null },
  napcat: { label: 'NapCat', logFile: runtimePath('logs', 'napcat.log'), state: 'idle', running: false, startedAt: 0, finishedAt: 0, exitCode: null, error: '', pid: 0, command: '', cwd: '', process: null },
  koishi: { label: 'Koishi', logFile: runtimePath('logs', 'koishi-local.log'), state: 'idle', running: false, startedAt: 0, finishedAt: 0, exitCode: null, error: '', pid: 0, command: '', cwd: '', process: null },
}

let rebuildStatus: RebuildStatus = { state: 'idle', message: '', detail: '', startedAt: 0, finishedAt: 0 }
let npmDiagnosticsCache: NpmDiagnosticsCache = { at: 0, data: null }

function getRebuildStatus() { return rebuildStatus }
function setRebuildStatus(s: RebuildStatus) { rebuildStatus = s }
function getNpmDiagnosticsCache() { return npmDiagnosticsCache }
function setNpmDiagnosticsCache(c: NpmDiagnosticsCache) { npmDiagnosticsCache = c }

function appendLocalTaskLog(task: LocalTask, chunk: Buffer | string) {
  try {
    fs.mkdirSync(path.dirname(task.logFile), { recursive: true })
    fs.appendFileSync(task.logFile, String(chunk), 'utf8')
  } catch { /* non-critical: task log best effort */ }
}

function getTaskPublicStatus(key: LocalTaskKey, extra: Record<string, unknown> = {}): LocalTaskPublicStatus {
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

function spawnLocalTask(key: LocalTaskKey, command: string, args: string[] = [], options: SpawnLocalTaskOptions = {}): SpawnLocalTaskResult {
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
  const spawnOptions: LocalSpawnOptions = {
    cwd: task.cwd,
    env: { ...process.env, ...(options.env || {}) },
    windowsHide: true,
    shell: options.shell === true,
    maxBuffer: 512 * 1024,
  }
  const child = spawn(command, args, spawnOptions)
  task.process = child
  task.pid = child.pid || 0
  if (key === 'koishi') {
    try {
      fs.mkdirSync(path.dirname(KOISHI_PID_FILE), { recursive: true })
      fs.writeFileSync(KOISHI_PID_FILE, String(task.pid), 'utf8')
    } catch { /* non-critical: pid file best effort */ }
  }
  child.stdout?.on('data', (chunk: Buffer | string) => appendLocalTaskLog(task, chunk))
  child.stderr?.on('data', (chunk: Buffer | string) => appendLocalTaskLog(task, chunk))
  child.on('error', (err: Error) => {
    task.error = err.message
    task.state = 'failed'
    task.running = false
    task.finishedAt = Date.now()
    appendLocalTaskLog(task, `\n[${new Date().toISOString()}] ERROR ${err.message}\n`)
  })
  child.on('close', (code: number | null) => {
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
      } catch { /* non-critical: stale pid cleanup */ }
    }
  })
  return { alreadyRunning: false, status: getTaskPublicStatus(key) }
}

function waitKoishiPortFree() {
  const { checkPortState, resolveKoishiListenPort } = require('./tools')
  const { sleepSync, log } = require('./utils')
  const port = resolveKoishiListenPort()
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    const state = checkPortState(port)
    if (state.available || state.status === 'free') return
    sleepSync(300)
  }
  log(`WARNING: 端口 ${port} 在停止进程后 5s 内未释放`)
}

export = {
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
