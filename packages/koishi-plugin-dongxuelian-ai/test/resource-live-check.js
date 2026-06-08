const fs = require('fs')
const path = require('path')

// --- CLI And Formatting --- #

// Return true when a CLI flag is present.
function hasFlag(name) {
  return process.argv.slice(2).includes(name)
}

// Return a CLI option value passed as --name value or --name=value.
function getArgValue(name) {
  const args = process.argv.slice(2)
  for (let i = 0; i < args.length; i += 1) {
    const item = String(args[i] || '')
    if (item === name) return String(args[i + 1] || '')
    if (item.startsWith(name + '=')) return item.slice(name.length + 1)
  }
  return ''
}

// Return a bounded positive integer CLI option.
function getArgInt(name, fallback, min, max) {
  const raw = getArgValue(name)
  if (raw === '') return fallback
  const value = Number(raw)
  if (!Number.isFinite(value)) return fallback
  return Math.max(min, Math.min(max, Math.floor(value)))
}

// Print the live-check report and set a strict failure code when requested.
function finish(report, strict) {
  console.log(JSON.stringify(report, null, 2))
  if (!strict) return
  const failed = report.verdicts.some(item => item.status !== 'confirmed')
  process.exitCode = failed ? 2 : 0
}

// --- Small File Readers --- #

// Read one JSON file and return a fallback when it is missing or malformed.
function readJsonFile(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}

// Return sorted child filenames for a directory.
function listDir(dir) {
  try {
    return fs.readdirSync(dir).sort()
  } catch {
    return []
  }
}

// Recursively count JSON files under a directory.
function countJsonFiles(dir) {
  let count = 0
  for (const name of listDir(dir)) {
    const file = path.join(dir, name)
    let stat = null
    try { stat = fs.statSync(file) } catch { stat = null }
    if (!stat) continue
    if (stat.isDirectory()) count += countJsonFiles(file)
    else if (stat.isFile() && name.endsWith('.json')) count += 1
  }
  return count
}

// Recursively list JSON files under a directory with a bounded max count.
function listJsonFilesRecursive(dir, maxFiles = 20000) {
  const result = []
  const walk = (current) => {
    if (result.length >= maxFiles) return
    for (const name of listDir(current)) {
      if (result.length >= maxFiles) return
      const file = path.join(current, name)
      let stat = null
      try { stat = fs.statSync(file) } catch { stat = null }
      if (!stat) continue
      if (stat.isDirectory()) walk(file)
      else if (stat.isFile() && name.endsWith('.json')) result.push(file)
    }
  }
  walk(dir)
  return result
}

// Read recent JSONL events matching a prefix from newest files first.
function readRecentJsonlEvents(dir, prefix, limit = 80) {
  const files = listDir(dir)
    .filter(name => name.startsWith(prefix) && name.endsWith('.jsonl'))
    .sort()
    .reverse()
  const events = []
  for (const name of files) {
    const file = path.join(dir, name)
    let lines = []
    try {
      lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).reverse()
    } catch {
      lines = []
    }
    for (const line of lines) {
      try {
        events.push({ sourceFile: name, ...JSON.parse(line) })
      } catch {
        events.push({ sourceFile: name, parseError: true, raw: line.slice(0, 300) })
      }
      if (events.length >= limit) return events
    }
  }
  return events
}

// Scan bounded JSONL files for matching target events without stopping at the recent tail.
function readMatchingJsonlEvents(dir, prefix, matcher, options = {}) {
  const limit = Math.max(1, Math.min(500, Number(options.limit || 80)))
  const maxFiles = Math.max(1, Math.min(500, Number(options.maxFiles || 120)))
  const maxLines = Math.max(limit, Math.min(200000, Number(options.maxLines || 60000)))
  const files = listDir(dir)
    .filter(name => name.startsWith(prefix) && name.endsWith('.jsonl'))
    .sort()
    .reverse()
    .slice(0, maxFiles)
  const events = []
  let scannedLines = 0
  for (const name of files) {
    const file = path.join(dir, name)
    let lines = []
    try {
      lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).reverse()
    } catch {
      lines = []
    }
    for (const line of lines) {
      scannedLines += 1
      let event = null
      try {
        event = { sourceFile: name, ...JSON.parse(line) }
      } catch {
        event = null
      }
      if (event && matcher(event)) events.push(event)
      if (events.length >= limit || scannedLines >= maxLines) return events
    }
  }
  return events
}

// Trim a string field for diagnostic output without exposing large payloads.
function shortText(value, max = 240) {
  const text = String(value || '')
  return text.length > max ? text.slice(0, max) + '...' : text
}

// Parse an event or task timestamp into milliseconds.
function parseTimeMs(value) {
  const ms = Date.parse(String(value || ''))
  return Number.isFinite(ms) ? ms : null
}

// Return the newest timestamp found in target tasks or events.
function latestTargetTimeMs(tasks, eventGroups) {
  let latest = null
  const note = (value) => {
    const ms = parseTimeMs(value)
    if (ms !== null && (latest === null || ms > latest)) latest = ms
  }
  for (const task of tasks) {
    note(task.updatedAt)
    note(task.finishedAt)
    note(task.startedAt)
    note(task.createdAt)
  }
  for (const events of eventGroups) {
    for (const event of events) note(event.createdAt)
  }
  return latest
}

// Return true when a record matches the requested task or channel filter.
function matchesTarget(record, target) {
  if (!target || (!target.taskId && !target.channelKey)) return false
  const taskId = String(record && record.taskId || record && record.id || '')
  const channelKey = String(record && record.channelKey || record && record.target || '')
  if (target.taskId && taskId === target.taskId) return true
  if (target.channelKey && channelKey === target.channelKey) return true
  return false
}

// Remove sensitive or bulky task fields while preserving closure evidence.
function sanitizeTaskRecord(task) {
  const payload = task && typeof task.payload === 'object' && task.payload ? task.payload : {}
  const notify = task && typeof task.notify === 'object' && task.notify ? task.notify : {}
  return {
    id: task && task.id || '',
    kind: task && task.kind || '',
    status: task && task.status || '',
    source: task && task.source || '',
    channelKey: task && task.channelKey || '',
    userId: task && task.userId || '',
    priority: task && task.priority,
    createdAt: task && task.createdAt || '',
    updatedAt: task && task.updatedAt || '',
    claimedBy: task && task.claimedBy || '',
    startedAt: task && task.startedAt || '',
    finishedAt: task && task.finishedAt || '',
    step: task && task.step || '',
    error: shortText(task && task.error || ''),
    notify: {
      target: notify.target || '',
      channelKey: notify.channelKey || '',
      status: notify.status || '',
      error: shortText(notify.error || ''),
      updatedAt: notify.updatedAt || '',
    },
    payloadKeys: Object.keys(payload),
  }
}

// Remove sensitive or bulky event fields while preserving audit fields.
function sanitizeEventRecord(event) {
  return {
    sourceFile: event && event.sourceFile || '',
    createdAt: event && event.createdAt || '',
    event: event && event.event || '',
    source: event && event.source || '',
    resourceSource: event && event.resourceSource || '',
    businessSource: event && event.businessSource || '',
    taskId: event && event.taskId || '',
    kind: event && event.kind || '',
    channelKey: event && event.channelKey || '',
    userId: event && event.userId || '',
    workerName: event && event.workerName || '',
    owner: event && event.owner || '',
    status: event && event.status || '',
    step: event && event.step || '',
    decision: event && event.decision || '',
    resourceState: event && event.resourceState || '',
    botMode: event && event.botMode || '',
    memAvailableMb: event && event.memAvailableMb,
    memTotalMb: event && event.memTotalMb,
    memSource: event && event.memSource || '',
    fallback: event && event.fallback || '',
    reason: shortText(event && event.reason || ''),
    error: shortText(event && event.error || ''),
    rootPid: event && event.rootPid,
    browserPid: event && event.browserPid,
    pids: Array.isArray(event && event.pids) ? event.pids : undefined,
    resultEvents: Array.isArray(event && event.resultEvents) ? event.resultEvents : undefined,
  }
}

// Read all matching tasks across S2 status directories without exposing payload.
function readTargetTasks(dataDir, target, limit = 80) {
  const root = path.join(dataDir, 'resource-workers', 'tasks')
  const files = listJsonFilesRecursive(root, 20000)
  const tasks = []
  for (const file of files) {
    const task = readJsonFile(file, null)
    if (!task || !matchesTarget(task, target)) continue
    tasks.push(sanitizeTaskRecord(task))
    if (tasks.length >= limit) break
  }
  tasks.sort((a, b) => String(b.updatedAt || b.createdAt || '').localeCompare(String(a.updatedAt || a.createdAt || '')))
  return tasks
}

// Read result.json metadata for matching tasks without reading report body or payload.
function readTargetResults(dataDir, tasks) {
  return tasks.map(task => {
    const resultFile = path.join(dataDir, 'resource-workers', 'results', String(task.id || ''), 'result.json')
    const result = readJsonFile(resultFile, null)
    const textPath = result && result.textPath ? String(result.textPath) : ''
    const imagePath = result && result.imagePath ? String(result.imagePath) : ''
    return {
      taskId: task.id,
      exists: !!result,
      keys: result && typeof result === 'object' ? Object.keys(result).filter(key => !['text', 'html', 'messages', 'payload'].includes(key)) : [],
      ok: result && result.ok,
      kind: result && result.kind || '',
      mode: result && result.mode || '',
      level: result && result.level || '',
      reason: shortText(result && result.reason || ''),
      error: shortText(result && result.error || ''),
      notifyTarget: task.notify && task.notify.target || '',
      notifyStatus: task.notify && task.notify.status || '',
      textPathBasename: textPath ? path.basename(textPath) : '',
      textExists: textPath ? fs.existsSync(textPath) : false,
      imagePathBasename: imagePath ? path.basename(imagePath) : '',
      imageExists: imagePath ? fs.existsSync(imagePath) : false,
    }
  })
}

// Filter recent events for a task/channel and return a safe audit subset.
function filterTargetEvents(events, target, includeMemoryEvents = false) {
  return events
    .filter(event => matchesTarget(event, target) || (includeMemoryEvents && String(event.event || '').startsWith('memory_')))
    .map(sanitizeEventRecord)
}

// Build target evidence for a real operator-observed run.
function buildTargetEvidence(dataDir, target, snapshot, gate, tasks, system, dashboard, limit, targetWindowMinutes) {
  if (!target.taskId && !target.channelKey) return null
  const schedulerRoot = path.join(dataDir, 'resource-scheduler')
  const gateRoot = path.join(dataDir, 'resource-gate')
  const workersRoot = path.join(dataDir, 'resource-workers')
  const systemRoot = path.join(dataDir, 'resource-system')
  const targetTasks = readTargetTasks(dataDir, target, limit)
  const targetTaskIds = new Set(targetTasks.map(task => String(task.id || '')).filter(Boolean))
  const expandedTarget = { ...target }
  const eventMatches = event => matchesTarget(event, expandedTarget) || (event && targetTaskIds.has(String(event.taskId || '')))
  const scanOptions = { limit, maxFiles: 160, maxLines: 80000 }
  const gateEvents = readMatchingJsonlEvents(gateRoot, 'events-', eventMatches, scanOptions).map(sanitizeEventRecord)
  const workerEvents = readMatchingJsonlEvents(workersRoot, 'events-', eventMatches, scanOptions).map(sanitizeEventRecord)
  const admissionEvents = readMatchingJsonlEvents(schedulerRoot, 'admissions-', eventMatches, scanOptions).map(sanitizeEventRecord)
  const cleanupEvents = readMatchingJsonlEvents(systemRoot, 'process-cleanup-', eventMatches, scanOptions).map(sanitizeEventRecord)
  const memoryEvents = readMatchingJsonlEvents(systemRoot, 'memory-alerts-', eventMatches, scanOptions).map(sanitizeEventRecord)
  const resultSummaries = readTargetResults(dataDir, targetTasks)
  const lowMemoryObserved = snapshot.memAvailableMb !== null && snapshot.memAvailableMb < 600
  const admissionStates = [...new Set(admissionEvents.map(event => String(event.resourceState || '')).filter(state => state === 'red' || state === 'black'))]
  const memoryAlertNames = [...new Set(memoryEvents.map(event => String(event.event || '')).filter(name => name.startsWith('memory_')))]
  const latestTargetMs = latestTargetTimeMs(targetTasks, [gateEvents, workerEvents, admissionEvents, cleanupEvents, memoryEvents])
  const targetAgeMinutes = latestTargetMs === null ? null : Math.max(0, Math.floor((Date.now() - latestTargetMs) / 60000))
  const taskTerminal = targetTasks.some(task => ['done', 'failed', 'deferred', 'cancelled'].includes(String(task.status || '')))
  const notifyTerminal = targetTasks.some(task => ['sent', 'failed', 'skipped'].includes(String(task.notify && task.notify.status || '')))
  const lowMemoryContextConfirmed = admissionStates.length > 0 || memoryAlertNames.length > 0
  const lowMemoryEvidence = admissionStates.length
    ? `target admission resourceState=${admissionStates.join(',')}`
    : memoryAlertNames.length
      ? `memory alerts observed for target: ${memoryAlertNames.join(',')}`
      : lowMemoryObserved
        ? `current MemAvailable=${snapshot.memAvailableMb}MB classified as ${snapshot.resourceState}, but no target red/black admission or matching target memory event was found`
        : latestTargetMs !== null
          ? `target latest evidence is ${targetAgeMinutes} minutes old; no target red/black admission or matching target memory event was found`
          : 'no red/black memory context found for target admission or target memory events'
  return {
    target,
    targetWindowMinutes,
    targetAgeMinutes,
    taskCount: targetTasks.length,
    tasks: targetTasks,
    results: resultSummaries,
    events: {
      gate: gateEvents,
      admissions: admissionEvents,
      workers: workerEvents,
      memory: memoryEvents,
      cleanup: cleanupEvents,
    },
    dashboard: {
      routeLoadable: dashboard.exists && dashboard.loadable,
      routeCount: dashboard.routeCount,
      resourceState: snapshot.resourceState,
      memAvailableMb: snapshot.memAvailableMb,
      memTotalMb: snapshot.memTotalMb,
      memSource: snapshot.memSource,
    },
    verdicts: [
      {
        id: 'target_task_found',
        status: targetTasks.length ? 'confirmed' : 'unverified',
        evidence: targetTasks.length ? `matchedTasks=${targetTasks.length}` : 'no task matched taskId/channelKey in S2 files',
      },
      {
        id: 'target_worker_terminal_state',
        status: taskTerminal ? 'confirmed' : 'unverified',
        evidence: taskTerminal ? 'matched task reached done/failed/deferred/cancelled' : 'matched task has not reached a terminal state',
      },
      {
        id: 'target_notify_state',
        status: notifyTerminal ? 'confirmed' : 'unverified',
        evidence: notifyTerminal ? 'matched task notify status reached sent/failed/skipped' : 'no terminal notify status found',
      },
      {
        id: 'target_low_memory_context',
        status: lowMemoryContextConfirmed ? 'confirmed' : 'unverified',
        evidence: lowMemoryEvidence,
      },
      {
        id: 'target_dashboard_route',
        status: dashboard.exists && dashboard.loadable && dashboard.routeCount > 0 ? 'confirmed' : 'unverified',
        evidence: `routeLoadable=${dashboard.exists && dashboard.loadable}, routeCount=${dashboard.routeCount}`,
      },
      {
        id: 'operator_observed_group_closure',
        status: 'unverified',
        evidence: 'this script cannot prove the operator saw the real group message; attach group screenshot/log after triggering the test group run',
      },
    ],
  }
}

// --- Runtime State Readers --- #

// Load runtime constants after the caller has set DONGXUELIAN_AI_DATA_DIR.
function loadRuntimeConstants() {
  try {
    return require('../lib/core/constants')
  } catch (error) {
    return {
      DATA_DIR: path.resolve(process.cwd(), 'data'),
      loadError: error instanceof Error ? error.message : String(error),
    }
  }
}

// Read cgroup v2 memory when the current process has a finite limit.
function readCgroupV2MeminfoReadonly() {
  if (process.platform !== 'linux') return null
  try {
    const rawCgroup = fs.readFileSync('/proc/self/cgroup', 'utf8')
    const line = rawCgroup.split(/\r?\n/).find(item => item.startsWith('0::'))
    if (!line) return null
    const cgroupPath = line.slice(3).trim()
    const normalized = cgroupPath.startsWith('/') ? cgroupPath.slice(1) : cgroupPath
    const cgroupRoot = path.join('/sys/fs/cgroup', normalized)
    const maxRaw = fs.readFileSync(path.join(cgroupRoot, 'memory.max'), 'utf8').trim()
    if (!maxRaw || maxRaw === 'max') return null
    const currentRaw = fs.readFileSync(path.join(cgroupRoot, 'memory.current'), 'utf8').trim()
    const maxBytes = Number(maxRaw)
    const currentBytes = Number(currentRaw)
    if (!Number.isFinite(maxBytes) || !Number.isFinite(currentBytes) || maxBytes <= 0 || currentBytes < 0) return null
    return {
      availableMb: Math.max(0, Math.floor((maxBytes - currentBytes) / 1024 / 1024)),
      totalMb: Math.floor(maxBytes / 1024 / 1024),
      source: 'cgroup-v2',
    }
  } catch {
    return null
  }
}

// Read host /proc/meminfo without writing S1 state files.
function readProcMeminfoReadonly() {
  if (process.platform !== 'linux') return { availableMb: null, totalMb: null, source: 'not-linux' }
  try {
    const raw = fs.readFileSync('/proc/meminfo', 'utf8')
    const available = /^MemAvailable:\s+(\d+)\s+kB/m.exec(raw)
    const total = /^MemTotal:\s+(\d+)\s+kB/m.exec(raw)
    return {
      availableMb: available ? Math.floor(Number(available[1]) / 1024) : null,
      totalMb: total ? Math.floor(Number(total[1]) / 1024) : null,
      source: '/proc/meminfo',
    }
  } catch (error) {
    return { availableMb: null, totalMb: null, source: error instanceof Error ? error.message : String(error) }
  }
}

// Read memory using the same precedence as S1: finite cgroup first, host meminfo second.
function readLinuxMeminfoReadonly() {
  return readCgroupV2MeminfoReadonly() || readProcMeminfoReadonly()
}

// Classify memory using the same S1 thresholds.
function classifyResourceState(memAvailableMb) {
  if (memAvailableMb === null || memAvailableMb === undefined) return 'yellow'
  if (memAvailableMb >= 900) return 'green'
  if (memAvailableMb >= 450) return 'yellow'
  if (memAvailableMb >= 300) return 'red'
  return 'black'
}

// Return S0 gate state by directly reading files.
function readGateState(dataDir) {
  const root = path.join(dataDir, 'resource-gate')
  const lockMeta = readJsonFile(path.join(root, 'lock', 'meta.json'), null)
  const tickets = listDir(path.join(root, 'tickets')).filter(name => name.endsWith('.json')).length
  return {
    root,
    locked: !!lockMeta,
    meta: lockMeta,
    tickets,
    recentEvents: readRecentJsonlEvents(root, 'events-', 20),
  }
}

// Return S2 task counts and recent worker events.
function readTaskState(dataDir) {
  const root = path.join(dataDir, 'resource-workers')
  const tasksRoot = path.join(root, 'tasks')
  const statuses = ['pending', 'claiming', 'running', 'done', 'failed', 'deferred', 'cancelled']
  const counts = {}
  for (const status of statuses) counts[status] = countJsonFiles(path.join(tasksRoot, status))
  const workers = listDir(path.join(root, 'workers'))
    .filter(name => name.endsWith('.json'))
    .map(name => readJsonFile(path.join(root, 'workers', name), null))
    .filter(Boolean)
  return {
    root,
    counts,
    workers,
    recentEvents: readRecentJsonlEvents(root, 'events-', 40),
  }
}

// Return S8 system protection events by directly reading JSONL files.
function readSystemState(dataDir) {
  const root = path.join(dataDir, 'resource-system')
  return {
    root,
    memoryAlerts: readRecentJsonlEvents(root, 'memory-alerts-', 40),
    processMetrics: readRecentJsonlEvents(root, 'process-metrics-', 40),
    cleanupEvents: readRecentJsonlEvents(root, 'process-cleanup-', 60),
  }
}

// Check whether Dashboard resource-center code is installed and route exports exist.
function inspectDashboardResourceRoute() {
  const routeFile = path.resolve(__dirname, '..', '..', 'koishi-plugin-dashboard', 'lib', 'routes', 'resource.js')
  const result = {
    routeFile,
    exists: fs.existsSync(routeFile),
    loadable: false,
    routeCount: 0,
    error: '',
  }
  if (!result.exists) return result
  try {
    const route = require(routeFile)
    result.loadable = true
    result.routeCount = route && route.routes ? Object.keys(route.routes).length : 0
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error)
  }
  return result
}

// --- Verdicts --- #

// Return true when an event list contains one of the requested event names.
function hasEvent(events, names) {
  const set = new Set(names)
  return events.some(event => set.has(String(event.event || '')))
}

// Build concrete live-verification verdicts without overstating remaining real tests.
function buildVerdicts(snapshot, gate, tasks, system, dashboard) {
  const verdicts = []
  const actualLowMemory = snapshot.memAvailableMb !== null && snapshot.memAvailableMb < 600
  verdicts.push({
    id: 'real_low_memory_red_black',
    status: actualLowMemory ? 'confirmed' : 'unverified',
    evidence: actualLowMemory
      ? `current MemAvailable=${snapshot.memAvailableMb}MB classified as ${snapshot.resourceState}`
      : `current MemAvailable=${snapshot.memAvailableMb === null ? 'unknown' : snapshot.memAvailableMb + 'MB'}; no live red/black pressure observed`,
  })

  const cleanupEventPresent = hasEvent(system.cleanupEvents, [
    'process_tree_terminated',
    'recorded_process_cleanup_completed',
    'task_timed_out',
    'chromium_close_failed',
    'daily_chromium_close_failed',
  ])
  verdicts.push({
    id: 'real_oom_or_chromium_residual_cleanup',
    status: cleanupEventPresent ? 'partial' : 'unverified',
    evidence: cleanupEventPresent
      ? 'S8 cleanup/timeout events exist in live data; manual review still needed to prove real OOM or real Chromium residual cleanup'
      : 'no S8 cleanup/timeout event found in live data',
  })

  const hasDoneWork = Number(tasks.counts.done || 0) > 0
  const hasWorkers = tasks.workers.length > 0
  const dashboardOk = dashboard.exists && dashboard.loadable && dashboard.routeCount > 0
  verdicts.push({
    id: 'real_end_to_end_bot_dashboard_low_memory',
    status: hasDoneWork && hasWorkers && dashboardOk ? 'partial' : 'unverified',
    evidence: `doneTasks=${tasks.counts.done || 0}, workers=${tasks.workers.length}, dashboardResourceRoute=${dashboardOk}; real bot/group/low-memory interaction still needs an operator-observed run`,
  })

  verdicts.push({
    id: 'current_s0_s2_health',
    status: gate.locked || hasWorkers || Object.values(tasks.counts).some(Number) ? 'confirmed' : 'partial',
    evidence: `locked=${gate.locked}, tickets=${gate.tickets}, taskCounts=${JSON.stringify(tasks.counts)}, workers=${tasks.workers.length}`,
  })

  return verdicts
}

// --- Main --- #

// Run the live resource evidence collector.
function main() {
  const constants = loadRuntimeConstants()
  const dataDir = path.resolve(constants.DATA_DIR || process.env.DONGXUELIAN_AI_DATA_DIR || path.join(process.cwd(), 'data'))
  const target = {
    taskId: String(getArgValue('--task-id') || '').trim(),
    channelKey: String(getArgValue('--channel-key') || '').trim(),
  }
  const targetLimit = getArgInt('--target-limit', 80, 1, 500)
  const targetWindowMinutes = getArgInt('--target-window-minutes', 15, 1, 1440)
  const mem = readLinuxMeminfoReadonly()
  const gate = readGateState(dataDir)
  const tasks = readTaskState(dataDir)
  const system = readSystemState(dataDir)
  const dashboard = inspectDashboardResourceRoute()
  const snapshot = {
    resourceState: classifyResourceState(mem.availableMb),
    memAvailableMb: mem.availableMb,
    memTotalMb: mem.totalMb,
    memSource: mem.source,
    locked: gate.locked,
    running: gate.meta,
    dataDir,
  }
  const report = {
    ok: true,
    generatedAt: new Date().toISOString(),
    platform: process.platform,
    node: process.version,
    dataDir,
    dataDirExists: fs.existsSync(dataDir),
    constantsLoadError: constants.loadError || '',
    snapshot,
    gate,
    tasks,
    system,
    dashboard,
    targetEvidence: buildTargetEvidence(dataDir, target, snapshot, gate, tasks, system, dashboard, targetLimit, targetWindowMinutes),
    verdicts: buildVerdicts(snapshot, gate, tasks, system, dashboard),
    note: 'Default mode is evidence collection only: no low-memory pressure, no Chromium launch, no process termination, no task mutation.',
  }
  finish(report, hasFlag('--strict'))
}

main()
