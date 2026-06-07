/**
 * MODULE: Agent 待确认管理。
 * 职责: 存储/查询/清理 confirm 模式下的待确认工具请求。
 * 边界: 不执行工具，不做安全检查。
 * 状态: pending (Map)。
 */
const crypto = require('crypto')
const path = require('path')
const { DATA_DIR } = require('../core/constants') as typeof import('../core/constants')
const {
  ensureDir,
  listJsonFiles,
  readJsonFile,
  removePath,
  sanitizeId,
  writeJsonAtomic,
} = require('../resource-common/files') as typeof import('../resource-common/files')
const pending: Map<string, PendingTool> = new Map()
const PENDING_DIR = path.join(DATA_DIR, 'agent-pending')

interface PendingTool {
  id: string
  toolName: string
  args: unknown
  userId: string
  channelKey: string
  channel: string
  expireAt: number
  resume: unknown
}

interface SetPendingToolOptions {
  toolName?: unknown
  args?: unknown
  channel?: unknown
  resume?: unknown
}

interface PendingExecutionContext {
  userName?: unknown
  userMessage?: unknown
  bot?: unknown
  isAdmin?: unknown
  resourceTaskId?: unknown
}

interface PendingListItem {
  id: string
  toolName: string
  userId: string
  channelKey: string
  channel: string
  argsSummary: string
  expireAt: number
}

type PendingNotFoundResult = { ok: false; status: number; message: string; pending?: undefined; toolName?: undefined; result?: undefined; error?: undefined }
type PendingExecutedResult = { ok: boolean; pending: PendingTool; toolName: string; result: string; error: string; message: string }
type PendingExecuteResult = PendingNotFoundResult | PendingExecutedResult
type PendingConfirmResult = PendingNotFoundResult | { ok: boolean; toolName: string; result: string; error: string; message: string }

// Return the persisted pending record path for one pending id.
function getPendingFile(id: unknown): string {
  return path.join(PENDING_DIR, `${sanitizeId(id)}.json`)
}

function pendingKey(channelKey: unknown, userId: unknown): string {
  return String(channelKey) + ':' + String(userId)
}

function pendingRecordFromValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function pendingText(value: unknown): string {
  return String(value || '')
}

// Normalize raw JSON into a valid pending tool record.
function normalizePendingTool(value: unknown): PendingTool | null {
  const record = pendingRecordFromValue(value)
  const id = pendingText(record.id)
  const toolName = pendingText(record.toolName)
  const userId = pendingText(record.userId)
  const channelKey = pendingText(record.channelKey)
  if (!id || !toolName || !userId || !channelKey) return null
  return {
    id,
    toolName,
    args: record.args,
    userId,
    channelKey,
    channel: pendingText(record.channel) || 'unknown',
    expireAt: Number(record.expireAt) || 0,
    resume: record.resume || null,
  }
}

// Cache one pending tool in the in-process map.
function cachePendingTool(tool: PendingTool): PendingTool {
  pending.set(pendingKey(tool.channelKey, tool.userId), tool)
  return tool
}

// Persist and cache one pending tool record.
function writePendingTool(tool: PendingTool): PendingTool {
  ensureDir(PENDING_DIR)
  writeJsonAtomic(getPendingFile(tool.id), tool)
  return cachePendingTool(tool)
}

// Read one pending tool file and discard it when expired.
function readPendingToolByFile(file: string, now: number = Date.now()): PendingTool | null {
  const tool = normalizePendingTool(readJsonFile(file, null))
  if (!tool) return null
  if (now > tool.expireAt) {
    removePath(file)
    pending.delete(pendingKey(tool.channelKey, tool.userId))
    return null
  }
  return cachePendingTool(tool)
}

// Scan persisted pending tools and return the first matching record.
function findPendingToolFromDisk(predicate: (tool: PendingTool) => boolean): PendingTool | null {
  ensureDir(PENDING_DIR)
  for (const file of listJsonFiles(PENDING_DIR, { maxFiles: 2000 })) {
    const tool = readPendingToolByFile(file)
    if (tool && predicate(tool)) return tool
  }
  return null
}

// Remove one pending tool from both memory and disk.
function removePendingTool(tool: PendingTool): void {
  pending.delete(pendingKey(tool.channelKey, tool.userId))
  removePath(getPendingFile(tool.id))
}

// Remove every pending tool belonging to one channel/user pair.
function removePendingToolsByKey(channelKey: unknown, userId: unknown): void {
  const key = pendingKey(channelKey, userId)
  const cached = pending.get(key)
  if (cached) removePendingTool(cached)
  ensureDir(PENDING_DIR)
  for (const file of listJsonFiles(PENDING_DIR, { maxFiles: 2000 })) {
    const tool = readPendingToolByFile(file)
    if (tool && pendingKey(tool.channelKey, tool.userId) === key) removePendingTool(tool)
  }
}

/** @returns {{ id, toolName, args, userId, channelKey, channel, expireAt, resume } | null } */
function getPendingTool(channelKey: string, userId: string): PendingTool | null {
  const key = pendingKey(channelKey, userId)
  trimPendingTools()
  const p = pending.get(key)
  if (!p) return findPendingToolFromDisk(tool => pendingKey(tool.channelKey, tool.userId) === key)
  if (Date.now() > p.expireAt) { pending.delete(key); return null }
  return p
}

function setPendingTool(channelKey: string, userId: string, { toolName, args, channel, resume }: SetPendingToolOptions): string {
  const id = 'pnd' + crypto.randomBytes(8).toString('hex')
  removePendingToolsByKey(channelKey, userId)
  writePendingTool({ id, toolName: pendingText(toolName), args, userId, channelKey, channel: pendingText(channel) || 'unknown', resume: resume || null, expireAt: Date.now() + 60000 })
  return id
}

function clearPendingTool(channelKey: string, userId: string): void {
  removePendingToolsByKey(channelKey, userId)
}

function clearPendingToolById(id: unknown): boolean {
  const target = String(id || '')
  if (!target) return false
  trimPendingTools()
  for (const [key, value] of pending) {
    if (value.id === target) {
      pending.delete(key)
      removePath(getPendingFile(value.id))
      return true
    }
  }
  const found = findPendingToolFromDisk(tool => tool.id === target)
  if (found) {
    removePendingTool(found)
    return true
  }
  return false
}

/** 清理过期 */
function trimPendingTools(now: number = Date.now()): void {
  for (const [k, v] of pending) {
    if (now > v.expireAt) {
      pending.delete(k)
      removePath(getPendingFile(v.id))
    }
  }
  ensureDir(PENDING_DIR)
  for (const file of listJsonFiles(PENDING_DIR, { maxFiles: 2000 })) {
    readPendingToolByFile(file, now)
  }
}
const cleanupTimer: NodeJS.Timeout = setInterval(() => trimPendingTools(), 60000)
if (cleanupTimer.unref) cleanupTimer.unref()

function findPendingToolById(id: unknown): PendingTool | null {
  trimPendingTools()
  const target = String(id || '')
  if (!target) return null
  for (const p of pending.values()) {
    if (p.id === target) return p
  }
  return findPendingToolFromDisk(tool => tool.id === target)
}

function getPendingToolById(id: unknown): PendingTool | null {
  return findPendingToolById(id)
}

function summarizePendingArgs(toolName: string, args: unknown = {}): string {
  const src = pendingRecordFromValue(args)
  const fields: string[] = []
  for (const key of ['path', 'cwd', 'command', 'url', 'selector', 'expression', 'query', 'action']) {
    if (src[key] !== undefined) fields.push(`${key}=${String(src[key]).slice(0, 160)}`)
  }
  if (src.content !== undefined) fields.push(`content=${Buffer.byteLength(String(src.content), 'utf8')} bytes`)
  if (src.text !== undefined) fields.push(`text=${String(src.text).slice(0, 80)}`)
  return fields.length ? fields.join('; ') : `${toolName} 参数 ${JSON.stringify(src).slice(0, 200)}`
}

function listPendingTools(): PendingListItem[] {
  trimPendingTools()
  const unique = new Map<string, PendingTool>()
  for (const p of pending.values()) unique.set(p.id, p)
  return Array.from(unique.values()).map(p => ({
    id: p.id,
    toolName: p.toolName,
    userId: p.userId,
    channelKey: p.channelKey,
    channel: p.channel || 'unknown',
    argsSummary: summarizePendingArgs(p.toolName, p.args),
    expireAt: p.expireAt,
  }))
}

// Persist a pending snapshot created in another process.
function upsertPendingToolSnapshot(snapshot: unknown): PendingTool | null {
  const tool = normalizePendingTool(snapshot)
  if (!tool || Date.now() > tool.expireAt) return null
  return writePendingTool(tool)
}

async function executePendingTool(channelKey: string, userId: string, channel: string = 'unknown', expectedId: string = '', context: PendingExecutionContext = {}): Promise<PendingExecuteResult> {
  const p = getPendingTool(channelKey, userId)
  if (!p) return { ok: false, status: 404, message: '没有待确认工具' }
  if (expectedId && p.id !== expectedId) return { ok: false, status: 404, message: '没有匹配的待确认工具' }

  const { isToolEnabled } = require('./config') as typeof import('./config')
  const safety = require('./safety') as typeof import('./safety')
  if (!isToolEnabled(channel, p.toolName)) return { ok: false, status: 403, message: `工具 '${p.toolName}' 当前渠道未启用，拒绝执行。` }
  const safeResult = safety.check(p.toolName)
  if (safeResult.action === 'block') return { ok: false, status: 403, message: safeResult.error || '' }
  if (!safeResult.allowed && safeResult.action !== 'confirm') return { ok: false, status: 403, message: safeResult.error || `工具 '${p.toolName}' 未通过安全检查` }

  clearPendingTool(channelKey, userId)
  const registry = require('./tools/registry') as typeof import('./tools/registry')
  const resume = pendingRecordFromValue(p.resume)
  const result = await registry.executeTool(p.toolName, pendingRecordFromValue(p.args), {
    channel,
    channelKey,
    userId,
    userName: resume.userName || context.userName || '',
    userMessage: resume.userMessage || context.userMessage || '',
    bot: context.bot,
    isAdmin: !!context.isAdmin,
    resourceTaskId: String(context.resourceTaskId || ''),
    taskId: String(context.resourceTaskId || ''),
  })
  return { ok: result.ok, pending: p, toolName: p.toolName, result: result.text, error: result.error || '', message: result.ok ? '' : result.text }
}

async function confirmPendingTool(channelKey: string, userId: string, channel: string = 'unknown', expectedId: string = '', context: PendingExecutionContext = {}): Promise<PendingConfirmResult> {
  const executed = await executePendingTool(channelKey, userId, channel, expectedId, context)
  if (!executed.ok && !executed.pending) return executed
  const { recordCall } = require('./stats') as typeof import('./stats')
  if (executed.ok) recordCall(executed.toolName, channel)
  return { ok: executed.ok, toolName: executed.toolName, result: executed.result, error: executed.error || '', message: executed.ok ? '' : executed.result }
}

export = { getPendingTool, findPendingToolById, getPendingToolById, setPendingTool, clearPendingTool, clearPendingToolById, trimPendingTools, summarizePendingArgs, listPendingTools, upsertPendingToolSnapshot, executePendingTool, confirmPendingTool }
