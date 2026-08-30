'use strict'

const crypto = require('crypto')
const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')

const ROOT = path.resolve(__dirname, '..')
const GENERATED_ROOTS = [
  'packages/agent-console/dist',
  'packages/koishi-plugin-daily-report/lib',
  'packages/koishi-plugin-dashboard/lib',
  'packages/koishi-plugin-dashboard/frontend/dist',
  'packages/koishi-plugin-defense/lib',
  'packages/koishi-plugin-dongxuelian-ai/lib',
  'packages/koishi-plugin-dongxuelian-help/lib',
  'packages/koishi-plugin-dongxuelian-poke/lib',
  'packages/koishi-plugin-group-leave-notice/lib',
  'packages/koishi-plugin-group-name-at/lib',
  'packages/koishi-plugin-local-video-sender/lib',
  'packages/koishi-plugin-pet-bridge/lib',
]

/** Collects files below one generated output root in stable path order. */
function collectFiles(directory, files = []) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const file = path.join(directory, entry.name)
    if (entry.isDirectory()) collectFiles(file, files)
    else if (entry.isFile()) files.push(file)
  }
  return files
}

/** Hashes all generated roots into a repository-relative manifest. */
function snapshotGeneratedRoots() {
  const snapshot = new Map()
  for (const relativeRoot of GENERATED_ROOTS) {
    const absoluteRoot = path.join(ROOT, relativeRoot)
    if (!fs.existsSync(absoluteRoot)) throw new Error(`缺少生成物目录：${relativeRoot}`)
    for (const file of collectFiles(absoluteRoot)) {
      const relativeFile = path.relative(ROOT, file).replace(/\\/g, '/')
      const hash = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
      snapshot.set(relativeFile, hash)
    }
  }
  return snapshot
}

/** Runs every declared production build and preserves its console output. */
function runAllBuilds() {
  const npmCli = process.env.npm_execpath
  const executable = npmCli ? process.execPath : (process.platform === 'win32' ? 'npm.cmd' : 'npm')
  const args = npmCli ? [npmCli, 'run', 'build:all'] : ['run', 'build:all']
  const result = spawnSync(executable, args, {
    cwd: ROOT,
    stdio: 'inherit',
    shell: !npmCli && process.platform === 'win32',
  })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`全量构建失败，退出码 ${result.status}`)
}

/** Compares two generated manifests and returns readable drift records. */
function compareSnapshots(before, after) {
  const drift = []
  const paths = [...new Set([...before.keys(), ...after.keys()])].sort()
  for (const file of paths) {
    if (!before.has(file)) drift.push(`新增 ${file}`)
    else if (!after.has(file)) drift.push(`删除 ${file}`)
    else if (before.get(file) !== after.get(file)) drift.push(`变更 ${file}`)
  }
  return drift
}

/** Verifies checked-in build outputs already match a clean full rebuild. */
function main() {
  const before = snapshotGeneratedRoots()
  runAllBuilds()
  const drift = compareSnapshots(before, snapshotGeneratedRoots())
  if (drift.length > 0) {
    console.error('生成物与源码不一致；全量构建已刷新以下文件：')
    for (const item of drift.slice(0, 80)) console.error(`- ${item}`)
    if (drift.length > 80) console.error(`- 其余 ${drift.length - 80} 项省略`)
    process.exit(1)
  }
  console.log(`Generated artifact verification passed (${before.size} files)`)
}

main()
