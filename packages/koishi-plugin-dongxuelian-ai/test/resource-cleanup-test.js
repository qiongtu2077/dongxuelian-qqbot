const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawnSync } = require('child_process')

let passed = 0
let failed = 0

function pass(label) {
  passed += 1
  console.log(`OK   ${label}`)
}

function fail(label, detail) {
  failed += 1
  console.log(`FAIL ${label}${detail ? ': ' + detail : ''}`)
}

function check(label, ok, detail = '') {
  if (ok) pass(label)
  else fail(label, detail)
}

function createTempDataDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(value), 'utf8')
}

function parseCleanupSummary(stdout) {
  const text = String(stdout || '')
  const marker = '[resource-cleanup] summary:'
  const markerIndex = text.lastIndexOf(marker)
  if (markerIndex < 0) throw new Error('summary marker missing')
  const braceStart = text.indexOf('{', markerIndex)
  if (braceStart < 0) throw new Error('summary json start missing')
  let depth = 0
  let end = -1
  for (let i = braceStart; i < text.length; i++) {
    const char = text[i]
    if (char === '{') depth += 1
    else if (char === '}') {
      depth -= 1
      if (depth === 0) {
        end = i
        break
      }
    }
  }
  if (end < 0) throw new Error('summary json end missing')
  return JSON.parse(text.slice(braceStart, end + 1))
}

function runCleanup(label, dataDir, args = []) {
  const result = spawnSync(process.execPath, ['scripts/resource-cleanup.js', ...args], {
    cwd: path.resolve(__dirname, '..', '..', '..'),
    env: { ...process.env, DONGXUELIAN_AI_DATA_DIR: dataDir },
    encoding: 'utf8',
    timeout: 30000,
  })
  check(`${label} exits 0`, result.status === 0, `status=${result.status} stdout=${result.stdout} stderr=${result.stderr}`)
  if (result.status !== 0) return null
  try {
    return {
      summary: parseCleanupSummary(result.stdout),
      stdout: result.stdout,
    }
  } catch (error) {
    fail(`${label} summary is JSON`, error instanceof Error ? error.message : String(error))
    return null
  }
}

function listTaskFiles(tasksRoot, taskId) {
  const files = []
  for (const status of ['pending', 'claiming', 'running', 'done', 'failed', 'cancelled', 'deferred']) {
    const statusDir = path.join(tasksRoot, status)
    if (!fs.existsSync(statusDir)) continue
    const stack = [statusDir]
    while (stack.length) {
      const current = stack.pop()
      for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
        const full = path.join(current, entry.name)
        if (entry.isDirectory()) stack.push(full)
        else if (entry.isFile() && entry.name === `${taskId}.json`) files.push(full)
      }
    }
  }
  return files
}

function testResourceCleanupLifecycle() {
  const dataDir = createTempDataDir('resource-cleanup-test-')
  const workersRoot = path.join(dataDir, 'resource-workers')
  const tasksRoot = path.join(workersRoot, 'tasks')
  const resultsRoot = path.join(workersRoot, 'results')
  const oldIso = '2026-05-01T00:00:00.000Z'
  const recentIso = new Date().toISOString()

  const baseTask = {
    id: 'dup-task-1',
    kind: 'daily_summary',
    source: 'test',
    channelKey: 'group-cleanup',
    userId: 'tester',
    priority: 70,
    createdAt: oldIso,
    updatedAt: oldIso,
    expiresAt: '',
    timeoutMs: 120000,
    payload: {},
    notify: { target: 'none', status: 'pending' },
  }

  writeJson(path.join(tasksRoot, 'done', 'dup-task-1.json'), { ...baseTask, status: 'done' })
  writeJson(path.join(tasksRoot, 'failed', 'dup-task-1.json'), {
    ...baseTask,
    status: 'failed',
    error: 'old failed copy',
    updatedAt: '2026-04-30T00:00:00.000Z',
  })
  writeJson(path.join(resultsRoot, 'dup-task-1', 'result.json'), {
    taskId: 'dup-task-1',
    createdAt: '2026-05-01T00:00:00.000Z',
    ok: true,
  })
  writeJson(path.join(resultsRoot, 'fresh-task', 'result.json'), {
    taskId: 'fresh-task',
    createdAt: recentIso,
    ok: true,
  })
  fs.mkdirSync(path.join(workersRoot), { recursive: true })
  fs.writeFileSync(path.join(workersRoot, `events-${recentIso.slice(0, 10)}.jsonl`), '', 'utf8')

  const dryRun1 = runCleanup('resource cleanup dry-run before apply', dataDir, ['--results-ttl-days', '7'])
  if (!dryRun1) return
  check('dry-run reports duplicate task ids', dryRun1.summary.duplicateTaskIds === 1, JSON.stringify(dryRun1.summary))
  check('dry-run reports duplicate copies to archive', dryRun1.summary.duplicateCopiesArchived === 1, JSON.stringify(dryRun1.summary))
  check('dry-run reports daily summary notify fix', dryRun1.summary.dailySummarySkippedFixed === 1, JSON.stringify(dryRun1.summary))
  check('dry-run reports expired result archive', dryRun1.summary.resultsExpiredArchived === 1, JSON.stringify(dryRun1.summary))

  const beforeApplyCopies = listTaskFiles(tasksRoot, 'dup-task-1').length
  check('fixture starts with duplicate task copies', beforeApplyCopies === 2, String(beforeApplyCopies))

  const applyRun = runCleanup('resource cleanup apply', dataDir, ['--apply', '--results-ttl-days', '7'])
  if (!applyRun) return
  const remainingCopies = listTaskFiles(tasksRoot, 'dup-task-1')
  check('apply keeps only one live task copy', remainingCopies.length === 1, JSON.stringify(remainingCopies))
  const keptTask = JSON.parse(fs.readFileSync(remainingCopies[0], 'utf8'))
  check('apply rewrites done daily_summary notify status to skipped', keptTask.status === 'done' && keptTask.notify && keptTask.notify.status === 'skipped', JSON.stringify(keptTask))
  check('apply archives duplicate task copy', fs.existsSync(path.join(workersRoot, '_archive')) && fs.readdirSync(path.join(workersRoot, '_archive')).length >= 1)
  check('apply archives expired result and keeps fresh result', !fs.existsSync(path.join(resultsRoot, 'dup-task-1', 'result.json')) && fs.existsSync(path.join(resultsRoot, 'fresh-task', 'result.json')))
  check('apply creates backup snapshot before mutation', fs.existsSync(path.join(workersRoot, '_backup')) && fs.readdirSync(path.join(workersRoot, '_backup')).length >= 1)
  const eventFile = path.join(workersRoot, `events-${recentIso.slice(0, 10)}.jsonl`)
  check('cleanup script does not append task events during apply', fs.readFileSync(eventFile, 'utf8') === '')

  const dryRun2 = runCleanup('resource cleanup dry-run after apply', dataDir, ['--results-ttl-days', '7'])
  if (!dryRun2) return
  check('second dry-run is near zero after apply', dryRun2.summary.duplicateTaskIds === 0 && dryRun2.summary.duplicateCopiesArchived === 0 && dryRun2.summary.dailySummarySkippedFixed === 0 && dryRun2.summary.resultsExpiredArchived === 0, JSON.stringify(dryRun2.summary))
}

function main() {
  testResourceCleanupLifecycle()
  console.log(`passed: ${passed}`)
  console.log(`failed: ${failed}`)
  process.exitCode = failed === 0 ? 0 : 1
}

main()
