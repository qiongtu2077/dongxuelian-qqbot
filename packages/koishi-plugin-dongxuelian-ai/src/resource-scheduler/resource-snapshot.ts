/**
 * MODULE: S1 资源快照。
 * 职责: 读取系统内存、S0 锁和维护状态，生成统一资源档位。
 * 边界: 不做任务排队，不修改 S0/S2 状态。
 */
const fs = require('fs') as typeof import('fs')
const path = require('path') as typeof import('path')
const { DATA_DIR, MAINTENANCE_FILE } = require('../core/constants') as typeof import('../core/constants')
const { readLockMeta } = require('../resource-gate/gate') as typeof import('../resource-gate/gate')
const { ensureDir, nowIso, readJsonFile, removePath, writeJsonAtomic } = require('../resource-common/files') as typeof import('../resource-common/files')
const { readResourceActivityLease } = require('./resource-activity-lease') as typeof import('./resource-activity-lease')
const { readServerModeState, normalizeServerMode } = require('./server-mode-policy') as typeof import('./server-mode-policy')

type ResourceState = 'green' | 'yellow' | 'red'
type BotMode = 'normal' | 'busy' | 'report_silent' | 'critical' | 'maintenance'

interface ResourceSnapshot {
  resourceState: ResourceState
  botMode: BotMode
  serverMode: string
  serverModeSource: string
  toolActive: boolean
  renderActive: boolean
  backgroundAllowed: boolean
  memAvailableMb: number | null
  memTotalMb: number | null
  memSource: string
  locked: boolean
  running: unknown | null
  maintenance: boolean
  createdAt: string
  resourceStateChangedAt: string
}

type ResourceSnapshotPersisted = Omit<ResourceSnapshot, 'createdAt'> & { createdAt?: string }

interface MemorySnapshot {
  availableMb: number | null
  totalMb: number | null
  source: string
}

interface RunningTaskLike {
  kind?: unknown
}

interface SnapshotStableRunningView {
  taskId?: unknown
  kind?: unknown
  owner?: unknown
  pid?: unknown
  channelKey?: unknown
  userId?: unknown
  startedAt?: unknown
  step?: unknown
  memAvailableMb?: unknown
  timeoutMs?: unknown
  ticketId?: unknown
}

function isRunningTaskLike(value: unknown): value is RunningTaskLike {
  return !!value && typeof value === 'object'
}

function buildStableRunningView(running: unknown): SnapshotStableRunningView | null {
  if (!running || typeof running !== 'object') return null
  const value = running as Record<string, unknown>
  return {
    taskId: value.taskId || null,
    kind: value.kind || null,
    owner: value.owner || null,
    pid: value.pid ?? null,
    channelKey: value.channelKey || null,
    userId: value.userId || null,
    startedAt: value.startedAt || null,
    step: value.step || null,
    memAvailableMb: value.memAvailableMb ?? null,
    timeoutMs: value.timeoutMs ?? null,
    ticketId: value.ticketId || null,
  }
}

const SCHEDULER_ROOT = path.join(DATA_DIR, 'resource-scheduler')
const SCHEDULER_STATE_FILE = path.join(SCHEDULER_ROOT, 'state.json')
const GREEN_MEM_AVAILABLE_MB = 600
const YELLOW_MEM_AVAILABLE_MB = 300

// 读取显式的低内存故障注入值，便于本地和运维验证资源档位分支。
function readMeminfoOverride(): { availableMb: number | null; totalMb: number | null } | null {
  const rawAvailable = process.env.RESOURCE_SCHEDULER_MEM_AVAILABLE_MB_OVERRIDE
  if (rawAvailable === undefined || rawAvailable === '') return null
  const availableMb = Math.floor(Number(rawAvailable))
  if (!Number.isFinite(availableMb) || availableMb < 0) return null

  const rawTotal = process.env.RESOURCE_SCHEDULER_MEM_TOTAL_MB_OVERRIDE
  const parsedTotal = rawTotal === undefined || rawTotal === '' ? null : Math.floor(Number(rawTotal))
  return {
    availableMb,
    totalMb: parsedTotal !== null && Number.isFinite(parsedTotal) && parsedTotal >= 0 ? parsedTotal : null,
  }
}

// 读取当前进程 cgroup v2 内存限额，便于 systemd/cgroup 隔离验收。
function readCgroupV2Meminfo(): MemorySnapshot | null {
  if (process.platform !== 'linux') return null
  try {
    const rawCgroup = fs.readFileSync('/proc/self/cgroup', 'utf8')
    const line = rawCgroup.split(/\r?\n/).find((item: string) => item.startsWith('0::'))
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
    const totalMb = Math.floor(maxBytes / 1024 / 1024)
    const availableMb = Math.max(0, Math.floor((maxBytes - currentBytes) / 1024 / 1024))
    return {
      availableMb,
      totalMb,
      source: 'cgroup-v2',
    }
  } catch {
    return null
  }
}

// 读取 Linux /proc/meminfo，非 Linux 或读取失败时返回 null。
function readProcMeminfo(): MemorySnapshot {
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
  } catch {
    return { availableMb: null, totalMb: null, source: '/proc/meminfo-unavailable' }
  }
}

// 读取统一内存口径；有限 cgroup 限额优先，否则回退到主机 /proc/meminfo。
function readLinuxMeminfo(): MemorySnapshot {
  const override = readMeminfoOverride()
  if (override) return { ...override, source: 'env-override' }
  return readCgroupV2Meminfo() || readProcMeminfo()
}

// 根据可用内存归档资源状态；未知内存按 yellow 处理，避免盲目放开。
function classifyResourceState(memAvailableMb: number | null): ResourceState {
  if (memAvailableMb === null) return 'yellow'
  if (memAvailableMb >= GREEN_MEM_AVAILABLE_MB) return 'green'
  if (memAvailableMb >= YELLOW_MEM_AVAILABLE_MB) return 'yellow'
  return 'red'
}

// 根据资源状态、维护文件和 S0 锁推导 Bot 模式。
function classifyBotMode(resourceState: ResourceState, running: unknown, maintenance: boolean): BotMode {
  if (maintenance) return 'maintenance'
  if (resourceState === 'red') return 'critical'
  if (isRunningTaskLike(running) && running.kind === 'daily_report') return 'report_silent'
  if (running) return 'busy'
  return 'normal'
}

function buildSnapshotStableKey(snapshot: ResourceSnapshotPersisted | null | undefined): string {
  return JSON.stringify({
    resourceState: snapshot?.resourceState || 'yellow',
    botMode: snapshot?.botMode || 'normal',
    serverMode: normalizeServerMode(snapshot?.serverMode),
    serverModeSource: snapshot?.serverModeSource || '',
    toolActive: !!snapshot?.toolActive,
    renderActive: !!snapshot?.renderActive,
    backgroundAllowed: snapshot?.backgroundAllowed !== undefined ? !!snapshot?.backgroundAllowed : true,
    memAvailableMb: snapshot?.memAvailableMb === undefined ? null : snapshot?.memAvailableMb,
    memTotalMb: snapshot?.memTotalMb === undefined ? null : snapshot?.memTotalMb,
    memSource: snapshot?.memSource || '',
    locked: !!snapshot?.locked,
    running: buildStableRunningView(snapshot?.running || null),
    maintenance: !!snapshot?.maintenance,
    resourceStateChangedAt: snapshot?.resourceStateChangedAt || '',
  })
}

// 删除上一次进程留下的资源快照，避免启动早期展示已结束任务。
function clearPersistedResourceSnapshot(): boolean {
  if (!fs.existsSync(SCHEDULER_STATE_FILE)) return false
  return removePath(SCHEDULER_STATE_FILE)
}

// 读取当前资源快照，并写入 state.json 供 Dashboard 低成本读取。
function readResourceSnapshot(): ResourceSnapshot {
  ensureDir(SCHEDULER_ROOT)
  const mem = readLinuxMeminfo()
  const previous = readJsonFile<ResourceSnapshotPersisted>(SCHEDULER_STATE_FILE, null)
  const running = readLockMeta()
  const resourceState = classifyResourceState(mem.availableMb)
  const maintenance = fs.existsSync(MAINTENANCE_FILE)
  const toolActive = !!readResourceActivityLease('tool_active')
  const renderActive = !!readResourceActivityLease('render_active')
  const serverModeState = readServerModeState({
    serverMode: undefined,
    resourceState,
    maintenance,
    toolActive,
    renderActive,
  })
  const snapshot: ResourceSnapshot = {
    resourceState,
    botMode: classifyBotMode(resourceState, running, maintenance),
    serverMode: serverModeState.serverMode,
    serverModeSource: serverModeState.serverModeSource,
    toolActive,
    renderActive,
    backgroundAllowed: serverModeState.backgroundAllowed,
    memAvailableMb: mem.availableMb,
    memTotalMb: mem.totalMb,
    memSource: mem.source,
    locked: !!running,
    running,
    maintenance,
    createdAt: nowIso(),
    resourceStateChangedAt: previous?.resourceState === resourceState && previous.resourceStateChangedAt
      ? previous.resourceStateChangedAt
      : nowIso(),
  }
  if (buildSnapshotStableKey(previous) !== buildSnapshotStableKey(snapshot)) {
    writeJsonAtomic(SCHEDULER_STATE_FILE, snapshot)
  }
  return snapshot
}

export = {
  SCHEDULER_ROOT,
  SCHEDULER_STATE_FILE,
  GREEN_MEM_AVAILABLE_MB,
  YELLOW_MEM_AVAILABLE_MB,
  readMeminfoOverride,
  readCgroupV2Meminfo,
  readProcMeminfo,
  readLinuxMeminfo,
  classifyResourceState,
  classifyBotMode,
  clearPersistedResourceSnapshot,
  readResourceSnapshot,
}
