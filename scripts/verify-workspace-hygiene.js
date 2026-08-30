'use strict'

const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')

const ROOT = path.resolve(__dirname, '..')
const AI_DATA_ROOT = path.join(ROOT, 'packages', 'koishi-plugin-dongxuelian-ai', 'data')

/** Lists Git-tracked files with normalized repository-relative paths. */
function listTrackedFiles() {
  const result = spawnSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`git ls-files 失败，退出码 ${result.status}`)
  return String(result.stdout || '').split('\0').filter(Boolean).map(file => file.replace(/\\/g, '/'))
}

/** Finds forbidden cascade runtime files that still exist in the package data tree. */
function findPhysicalRuntimeArtifacts() {
  const artifacts = []
  const toolDirectory = path.join(AI_DATA_ROOT, 'agent-tool-results')
  if (fs.existsSync(toolDirectory)) {
    for (const name of fs.readdirSync(toolDirectory)) {
      if (/cascade-test-tool\.txt$/i.test(name)) artifacts.push(path.relative(ROOT, path.join(toolDirectory, name)).replace(/\\/g, '/'))
    }
  }
  const imageHistoryTest = path.join(AI_DATA_ROOT, 'image-history', 'test')
  if (fs.existsSync(imageHistoryTest)) artifacts.push(path.relative(ROOT, imageHistoryTest).replace(/\\/g, '/'))
  return artifacts.sort()
}

/** Verifies test runtime files and deployment archives cannot re-enter version control. */
function main() {
  const tracked = listTrackedFiles()
  // A pre-commit deletion is still present in the index; only files that also remain on disk are violations.
  const trackedRuntime = tracked.filter(file =>
    (/\/data\/agent-tool-results\/.*cascade-test-tool\.txt$/i.test(file) || /\/data\/image-history\/test$/i.test(file))
    && fs.existsSync(path.join(ROOT, file))
  )
  const trackedArchives = tracked.filter(file => /\.tgz$/i.test(file) && fs.existsSync(path.join(ROOT, file)))
  const physicalRuntime = findPhysicalRuntimeArtifacts()
  const failures = [
    ...trackedRuntime.map(file => `仍被 Git 跟踪的测试产物：${file}`),
    ...trackedArchives.map(file => `仍被 Git 跟踪的运维压缩包：${file}`),
    ...physicalRuntime.map(file => `测试后残留的运行产物：${file}`),
  ]
  if (failures.length > 0) {
    for (const failure of failures) console.error(failure)
    process.exit(1)
  }
  console.log('Workspace hygiene verification passed')
}

main()
