#!/usr/bin/env node
/**
 * 阶段 0.5：S2 resource-workers 生产脏数据清理脚本。
 *
 * 背景与约束见 待完成与待审核任务/2026-06-10-S0-S8资源架构重整计划.md 9.13.2 阶段 0.5 / 9.14。
 *
 * 处理三类脏数据（只在 <DATA_DIR>/resource-workers 与其 results 范围内）：
 *   1. 同 taskId 多状态副本：保留单一可信最新状态，其余副本归档（不静默删除）。
 *   2. target=none 的 done daily_summary：notify.status=pending → skipped；已 skipped 不重复写。
 *   3. 超保留期 results/<taskId>/result.json：超期归档。
 *
 * 安全约束：
 *   - 默认 dry-run；只有显式 --apply 才写文件。
 *   - --apply 前自动备份目标目录。
 *   - 只触碰 resource-workers / results，绝不碰聊天、人格、记忆、配置。
 *   - 分批 + 上限（--max），有进度摘要。
 *   - 不逐任务写事件，只输出一行清理摘要。
 *   - 可重复执行，第二次应接近 0 变更。
 *   - 不打印真实生产路径全文，只打印相对结构。
 *
 * 用法：
 *   node scripts/resource-cleanup.js                  # dry-run，仅统计
 *   node scripts/resource-cleanup.js --apply          # 实际执行（先备份）
 *   node scripts/resource-cleanup.js --apply --max 2000 --results-ttl-days 7
 *   DONGXUELIAN_AI_DATA_DIR=/path/to/data node scripts/resource-cleanup.js
 */
'use strict'

const fs = require('fs')
const path = require('path')

// --- 配置与参数解析 ---

function resolveDataDir() {
  const configured = String(process.env.DONGXUELIAN_AI_DATA_DIR || '').trim()
  if (configured) return path.resolve(configured)
  const koishiDir = String(process.env.KOISHI_DIR || process.env.KOISHI_APP_DIR || '').trim()
  if (koishiDir) return path.resolve(koishiDir, 'data')
  return path.resolve(process.cwd(), 'data')
}

function parseArgs(argv) {
  const opts = { apply: false, max: 5000, resultsTtlDays: 7 }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--apply') opts.apply = true
    else if (arg === '--max') opts.max = Math.max(1, Number(argv[++i]) || 5000)
    else if (arg === '--results-ttl-days') opts.resultsTtlDays = Math.max(0, Number(argv[++i]) || 7)
    else if (arg === '--data-dir') opts.dataDir = String(argv[++i] || '')
  }
  return opts
}

// 递归列出目录下所有 .json 文件（带上限保护）。
function listJsonFilesRecursive(dir, maxFiles) {
  const out = []
  if (!fs.existsSync(dir)) return out
  const stack = [dir]
  while (stack.length && out.length < maxFiles) {
    const current = stack.pop()
    let entries
    try {
      entries = fs.readdirSync(current, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (out.length >= maxFiles) break
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) stack.push(full)
      else if (entry.isFile() && entry.name.endsWith('.json')) out.push(full)
    }
  }
  return out
}

function readJsonSafe(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

function writeJsonSafe(file, value) {
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`
  fs.writeFileSync(tmp, JSON.stringify(value))
  fs.renameSync(tmp, file)
}

// 复制单个文件到归档/备份目录，保留相对结构。
function copyFileInto(srcFile, srcRoot, destRoot) {
  const rel = path.relative(srcRoot, srcFile)
  const dest = path.join(destRoot, rel)
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  fs.copyFileSync(srcFile, dest)
  return dest
}

// 把文件移动进归档目录（先复制再删原文件）。
function moveFileInto(srcFile, srcRoot, destRoot) {
  const dest = copyFileInto(srcFile, srcRoot, destRoot)
  fs.rmSync(srcFile, { force: true })
  return dest
}

// PLACEHOLDER_MAIN

// 状态可信优先级：值越大越权威，作为多副本去重时的首要排序键。
const STATUS_RANK = {
  done: 6,
  failed: 5,
  cancelled: 4,
  deferred: 3,
  running: 2,
  claiming: 1,
  pending: 0,
}

function statusRank(status) {
  return Object.prototype.hasOwnProperty.call(STATUS_RANK, status) ? STATUS_RANK[status] : -1
}

// 在一组同 taskId 副本里挑出最可信的那个：先按状态优先级，再按 updatedAt/createdAt 时间。
function pickCanonical(copies) {
  return copies.slice().sort((a, b) => {
    const rankDiff = statusRank(b.status) - statusRank(a.status)
    if (rankDiff !== 0) return rankDiff
    const at = String(a.task.updatedAt || a.task.createdAt || '')
    const bt = String(b.task.updatedAt || b.task.createdAt || '')
    return bt.localeCompare(at)
  })[0]
}

function main() {
  const opts = parseArgs(process.argv.slice(2))
  const dataDir = opts.dataDir ? path.resolve(opts.dataDir) : resolveDataDir()
  const workersRoot = path.join(dataDir, 'resource-workers')
  const tasksRoot = path.join(workersRoot, 'tasks')
  const resultsRoot = path.join(workersRoot, 'results')

  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const archiveRoot = path.join(workersRoot, '_archive', stamp)
  const backupRoot = path.join(workersRoot, '_backup', stamp)

  console.log(`[resource-cleanup] mode=${opts.apply ? 'APPLY' : 'DRY-RUN'} max=${opts.max} resultsTtlDays=${opts.resultsTtlDays}`)
  console.log(`[resource-cleanup] data dir resolved (resource-workers ${fs.existsSync(workersRoot) ? 'found' : 'MISSING'})`)

  if (!fs.existsSync(workersRoot)) {
    console.log('[resource-cleanup] nothing to do: resource-workers directory not found')
    return 0
  }

  // --apply 前先整体备份 tasks + results（仅 .json），避免误操作不可逆。
  if (opts.apply) {
    const toBackup = [
      ...listJsonFilesRecursive(tasksRoot, opts.max),
      ...listJsonFilesRecursive(resultsRoot, opts.max),
    ]
    for (const file of toBackup) copyFileInto(file, workersRoot, backupRoot)
    console.log(`[resource-cleanup] backed up ${toBackup.length} json files before apply`)
  }

  const summary = {
    scannedTaskFiles: 0,
    duplicateTaskIds: 0,
    duplicateCopiesArchived: 0,
    dailySummarySkippedFixed: 0,
    resultsExpiredArchived: 0,
  }

  // === 1. 扫描 tasks，按 taskId 建索引，识别多状态副本 ===
  const statusDirs = ['pending', 'claiming', 'running', 'done', 'failed', 'cancelled', 'deferred']
  const byId = new Map()
  for (const status of statusDirs) {
    const dir = path.join(tasksRoot, status)
    for (const file of listJsonFilesRecursive(dir, opts.max)) {
      const task = readJsonSafe(file)
      if (!task || !task.id) continue
      summary.scannedTaskFiles++
      const id = String(task.id)
      if (!byId.has(id)) byId.set(id, [])
      byId.get(id).push({ file, status, task })
    }
  }

  // === 2. 多副本归档：保留 canonical，其余移入 _archive ===
  for (const [id, copies] of byId) {
    if (copies.length <= 1) continue
    summary.duplicateTaskIds++
    const canonical = pickCanonical(copies)
    for (const copy of copies) {
      if (copy === canonical) continue
      summary.duplicateCopiesArchived++
      if (opts.apply) moveFileInto(copy.file, workersRoot, archiveRoot)
    }
    void id
  }

  // === 3. target=none 的 done daily_summary：notify.status pending → skipped ===
  // 只处理 canonical 仍在 done 目录的实体，避免改到已归档副本。
  for (const [, copies] of byId) {
    const canonical = pickCanonical(copies)
    const task = canonical.task
    if (canonical.status !== 'done') continue
    if (String(task.kind || '') !== 'daily_summary') continue
    const notify = task.notify || {}
    const target = String(notify.target || 'none')
    if (target !== 'none') continue
    if (String(notify.status || '') === 'skipped') continue
    summary.dailySummarySkippedFixed++
    if (opts.apply) {
      const next = { ...task, updatedAt: new Date().toISOString(), notify: { ...notify, status: 'skipped', updatedAt: new Date().toISOString() } }
      writeJsonSafe(canonical.file, next)
    }
  }

  // === 4. 超保留期 results 归档 ===
  if (fs.existsSync(resultsRoot) && opts.resultsTtlDays > 0) {
    const cutoff = Date.now() - opts.resultsTtlDays * 24 * 60 * 60 * 1000
    for (const file of listJsonFilesRecursive(resultsRoot, opts.max)) {
      if (path.basename(file) !== 'result.json') continue
      const result = readJsonSafe(file)
      const createdAt = result && Date.parse(String(result.createdAt || ''))
      let mtime = NaN
      try { mtime = fs.statSync(file).mtimeMs } catch { mtime = NaN }
      const ts = Number.isFinite(createdAt) ? createdAt : mtime
      if (!Number.isFinite(ts) || ts >= cutoff) continue
      summary.resultsExpiredArchived++
      if (opts.apply) moveFileInto(file, workersRoot, archiveRoot)
    }
  }

  console.log('[resource-cleanup] summary:')
  console.log(JSON.stringify(summary, null, 2))
  if (!opts.apply) {
    console.log('[resource-cleanup] DRY-RUN only — no files changed. Re-run with --apply to execute.')
  } else {
    console.log(`[resource-cleanup] APPLY done. backup + archive written under resource-workers/_backup and _archive.`)
  }
  return 0
}

process.exitCode = main()


