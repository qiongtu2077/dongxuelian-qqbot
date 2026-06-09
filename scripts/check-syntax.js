const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')

const ROOT = path.resolve(__dirname, '..')

const CHECK_DIRS = [
  'packages/koishi-plugin-dongxuelian-ai/lib',
  'packages/koishi-plugin-dashboard/lib',
  'packages/koishi-plugin-daily-report/lib',
  'local-deployer',
]

const CHECK_FILES = [
  'packages/agent-console/lib/index.js',
  'packages/koishi-plugin-dashboard/index.js',
  'packages/koishi-plugin-dashboard/standalone.js',
  'packages/koishi-plugin-defense/lib/index.js',
  'packages/koishi-plugin-dongxuelian-help/lib/index.js',
  'packages/koishi-plugin-dongxuelian-poke/lib/index.js',
  'packages/koishi-plugin-group-leave-notice/lib/index.js',
  'packages/koishi-plugin-group-name-at/lib/index.js',
  'packages/koishi-plugin-local-video-sender/lib/index.js',
  'packages/koishi-plugin-pet-bridge/lib/index.js',
  'packages/koishi-plugin-pet-bridge/lib/protocol.js',
  'scripts/agent-console-admin-smoke.js',
  'scripts/dashboard-click-smoke.js',
  'scripts/skill-hub.js',
]

const MODULE_INPUT_CHECKS = []

const SKIP_DIRS = new Set(['.git', 'dist', 'node_modules'])

function normalizeRel(file) {
  return file.replace(/\\/g, '/')
}

function absolute(relPath) {
  return path.join(ROOT, relPath)
}

function listCheckFiles(dir) {
  const absDir = absolute(dir)
  const files = []
  if (!fs.existsSync(absDir)) return files
  for (const entry of fs.readdirSync(absDir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue
    const rel = normalizeRel(path.join(dir, entry.name))
    if (entry.isDirectory()) {
      files.push(...listCheckFiles(rel))
    } else if (/\.(?:cjs|js)$/i.test(entry.name)) {
      files.push(rel)
    }
  }
  return files
}

function listMissingDirs() {
  return CHECK_DIRS.filter(dir => !fs.existsSync(absolute(dir)))
}

function uniqueSorted(values) {
  return [...new Set(values.map(normalizeRel))].sort()
}

function buildCheckTargets() {
  return {
    fileChecks: uniqueSorted([
      ...CHECK_FILES,
      ...CHECK_DIRS.flatMap(listCheckFiles),
    ]),
    moduleInputChecks: uniqueSorted(MODULE_INPUT_CHECKS),
    missingDirs: listMissingDirs(),
  }
}

function formatFailure(label, result) {
  const pieces = [`[syntax] ${label}`]
  if (result.error) pieces.push(result.error.message)
  if (result.stdout) pieces.push(result.stdout.trimEnd())
  if (result.stderr) pieces.push(result.stderr.trimEnd())
  return pieces.filter(Boolean).join('\n')
}

function runNodeCheck(relPath) {
  const abs = absolute(relPath)
  if (!fs.existsSync(abs)) {
    return { ok: false, message: `[syntax] missing file: ${relPath}` }
  }
  const result = spawnSync(process.execPath, ['-c', abs], {
    cwd: ROOT,
    encoding: 'utf8',
  })
  if (result.status === 0) return { ok: true }
  return { ok: false, message: formatFailure(`node -c ${relPath}`, result) }
}

function runModuleInputCheck(relPath) {
  const abs = absolute(relPath)
  if (!fs.existsSync(abs)) {
    return { ok: false, message: `[syntax] missing file: ${relPath}` }
  }
  const result = spawnSync(process.execPath, ['--check', '--input-type=module'], {
    cwd: ROOT,
    encoding: 'utf8',
    input: fs.readFileSync(abs, 'utf8'),
  })
  if (result.status === 0) return { ok: true }
  return { ok: false, message: formatFailure(`node --check --input-type=module < ${relPath}`, result) }
}

function runChecks() {
  const targets = buildCheckTargets()
  const failures = []

  for (const relPath of targets.missingDirs) {
    failures.push(`[syntax] missing directory: ${relPath}`)
  }
  for (const relPath of targets.fileChecks) {
    const result = runNodeCheck(relPath)
    if (!result.ok) failures.push(result.message)
  }
  for (const relPath of targets.moduleInputChecks) {
    const result = runModuleInputCheck(relPath)
    if (!result.ok) failures.push(result.message)
  }

  if (failures.length) {
    console.error(failures.join('\n\n'))
    return false
  }
  console.log(`[syntax] checked ${targets.fileChecks.length + targets.moduleInputChecks.length} files`)
  return true
}

if (require.main === module) {
  process.exit(runChecks() ? 0 : 1)
}

module.exports = {
  CHECK_DIRS,
  CHECK_FILES,
  MODULE_INPUT_CHECKS,
  buildCheckTargets,
  listMissingDirs,
  runChecks,
}
