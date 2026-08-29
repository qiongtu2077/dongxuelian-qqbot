'use strict'

const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawnSync } = require('child_process')
const remoteRelease = require('../lib/remote-release')
const deployHelpers = require('../lib/deploy-helpers')
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..')

// Runs one Git command inside the isolated source repository.
function runGit(repoRoot, args) {
  const result = spawnSync('git', args, { cwd: repoRoot, encoding: 'utf8' })
  assert.strictEqual(result.status, 0, result.stderr || result.stdout)
  return result.stdout.trim()
}

// Creates a one-commit repository for deterministic clean and dirty source checks.
function createSourceRepo(tempRoot) {
  const repoRoot = path.join(tempRoot, 'source')
  fs.mkdirSync(repoRoot)
  runGit(repoRoot, ['init'])
  fs.writeFileSync(path.join(repoRoot, 'tracked.txt'), 'v1\n')
  runGit(repoRoot, ['add', 'tracked.txt'])
  runGit(repoRoot, ['-c', 'user.name=Dashboard Test', '-c', 'user.email=dashboard@example.invalid', 'commit', '-m', 'initial'])
  return repoRoot
}

// Builds one structurally complete preview for pure validation checks.
function makePreview(now) {
  const release = { schemaVersion: 1, releaseId: 'old-release', version: '1', commit: 'a'.repeat(40), builtAt: '', files: [], contentHash: 'b'.repeat(64), manifestHash: 'c'.repeat(64) }
  return {
    schemaVersion: 1,
    previewId: 'd'.repeat(32),
    createdAt: now,
    expiresAt: now + remoteRelease.PREVIEW_TTL_MS,
    startedAt: 0,
    source: { hostname: 'source-host', repoRoot: '/source', commit: 'a'.repeat(40), clean: true, changes: [] },
    target: { server: 'root@target-host', requestedAppDir: '/srv/app', hostname: 'target-host', appDir: '/srv/app', availableBytes: 1024 * 1024 * 1024, release, releaseError: '', lock: { present: false, owner: '' } },
    release: { releaseDir: '/releases/new-release', releaseId: 'new-release', commit: 'a'.repeat(40), manifestHash: 'e'.repeat(64), contentHash: 'f'.repeat(64), files: [], totalBytes: 0 },
    requiredBytes: 64 * 1024 * 1024,
    changes: { added: 0, modified: 0, removed: 0, unchanged: 0, totalFiles: 0, totalBytes: 0 },
    blockers: [],
  }
}

// Verifies trusted SSH options and strict source identity handling.
function testConnectionAndSource(tempRoot) {
  const ssh = deployHelpers.sshCommand('root@example.invalid', 'hostname')
  const scp = deployHelpers.scpCommand('source', 'root@example.invalid:/srv/app')
  for (const command of [ssh, scp]) {
    assert.match(command, /StrictHostKeyChecking=accept-new/)
    assert.match(command, /BatchMode=yes/)
    assert.doesNotMatch(command, /StrictHostKeyChecking=no/)
  }
  assert.throws(() => deployHelpers.validateDeployTarget({ server: 'root@example.invalid', appDir: '/', mode: 'update' }), /filesystem root/)
  assert.throws(() => deployHelpers.validateDeployTarget({ server: 'root@example.invalid', appDir: '/srv/../app', mode: 'update' }), /dot path segments/)

  const repoRoot = createSourceRepo(tempRoot)
  const clean = remoteRelease.inspectGitSource(repoRoot)
  assert.strictEqual(clean.clean, true)
  assert.match(clean.commit, /^[a-f0-9]{40,64}$/)
  fs.writeFileSync(path.join(repoRoot, 'untracked.txt'), 'not committed\n')
  const dirty = remoteRelease.inspectGitSource(repoRoot)
  assert.strictEqual(dirty.clean, false)
  assert(dirty.changes.some(item => item.includes('untracked.txt')))
}

// Verifies exact file differences and self-deployment detection.
function testPreviewComparison() {
  const summary = remoteRelease.summarizeReleaseChanges([
    { path: 'same.js', size: 1, sha256: '1'.repeat(64) },
    { path: 'changed.js', size: 2, sha256: '2'.repeat(64) },
    { path: 'new.js', size: 3, sha256: '3'.repeat(64) },
  ], [
    { path: 'same.js', size: 1, sha256: '1'.repeat(64) },
    { path: 'changed.js', size: 2, sha256: '4'.repeat(64) },
    { path: 'removed.js', size: 4, sha256: '5'.repeat(64) },
  ])
  assert.deepStrictEqual(summary, { added: 1, modified: 1, removed: 1, unchanged: 1, totalFiles: 3, totalBytes: 6 })
  assert.strictEqual(remoteRelease.isSelfDeploy('bot-host', 'root@bot-host', 'bot-host'), true)
  assert.strictEqual(remoteRelease.isSelfDeploy('source-host', 'root@target-host', 'target-host'), false)
  assert.strictEqual(remoteRelease.isAllowedBuildChange(' M packages/koishi-plugin-dashboard/frontend/dist/index.html'), true)
  assert.strictEqual(remoteRelease.isAllowedBuildChange(' M packages/koishi-plugin-dashboard/lib/routes/deploy.js'), true)
  assert.strictEqual(remoteRelease.isAllowedBuildChange(' M packages/koishi-plugin-dashboard/src/lib/routes/deploy.ts'), false)
  assert.match(remoteRelease.describeRemoteProbeFailure('REMOTE HOST IDENTIFICATION HAS CHANGED'), /主机密钥校验失败/)

  const blockers = remoteRelease.collectPreviewBlockers(
    { hostname: 'same-host', repoRoot: '/source', commit: 'a'.repeat(40), clean: true, changes: [] },
    'root@same-host',
    '/srv/app',
    { hostname: 'same-host', appDir: '/srv/app', availableBytes: 1, release: { schemaVersion: 1, releaseId: 'old', version: '', commit: 'a'.repeat(40), builtAt: '', files: [], contentHash: 'b'.repeat(64), manifestHash: 'c'.repeat(64) }, releaseError: '', lock: { present: true, owner: 'pid=42' } },
    { releaseDir: '/release/new', releaseId: 'new', commit: 'a'.repeat(40), manifestHash: 'd'.repeat(64), contentHash: 'e'.repeat(64), files: [], totalBytes: 1024 },
  )
  assert(blockers.some(item => item.includes('禁止控制台给自身发布')))
  assert(blockers.some(item => item.includes('发布锁')))
  assert(blockers.some(item => item.includes('磁盘不足')))
}

// Verifies preview confirmation, expiry, single-use and remote-baseline gates.
function testPreviewGates() {
  const now = Date.now()
  const preview = makePreview(now)
  assert.doesNotThrow(() => remoteRelease.assertPreviewCanStart(preview, true, now + 1))
  assert.throws(() => remoteRelease.assertPreviewCanStart(preview, false, now + 1), /必须确认/)
  assert.throws(() => remoteRelease.assertPreviewCanStart(preview, true, preview.expiresAt), /已过期/)
  preview.startedAt = now + 1
  assert.throws(() => remoteRelease.assertPreviewCanStart(preview, true, now + 2), /已经使用/)
  preview.startedAt = 0
  preview.blockers = ['远端存在发布锁']
  assert.throws(() => remoteRelease.assertPreviewCanStart(preview, true, now + 2), /阻止项/)
  preview.blockers = []
  assert.strictEqual(remoteRelease.isPreviewReleaseDirectory('/releases', '/releases/new-release', 'new-release'), true)
  assert.strictEqual(remoteRelease.isPreviewReleaseDirectory('/releases', '/releases', 'releases'), false)

  const exactTarget = { hostname: preview.target.hostname, appDir: preview.target.appDir, availableBytes: preview.target.availableBytes, release: preview.target.release, releaseError: '', lock: { present: false, owner: '' } }
  assert.deepStrictEqual(remoteRelease.compareRemoteBaseline(preview, exactTarget), [])
  const changedTarget = { ...exactTarget, release: { ...exactTarget.release, manifestHash: '0'.repeat(64) }, lock: { present: true, owner: 'pid=42' } }
  const changes = remoteRelease.compareRemoteBaseline(preview, changedTarget)
  assert(changes.some(item => item.includes('发布锁')))
  assert(changes.some(item => item.includes('基线已变化')))
}

// Verifies the detached build freezes artifacts without changing the active source worktree.
function testDetachedBuild(tempRoot) {
  const before = spawnSync('git', ['status', '--porcelain=v1', '--untracked-files=all'], { cwd: REPO_ROOT, encoding: 'utf8' }).stdout
  const commit = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' }).stdout.trim()
  const worktreeRoot = path.join(tempRoot, 'detached-build')
  const releasesRoot = path.join(tempRoot, 'releases')
  const built = remoteRelease.buildFrozenRelease(REPO_ROOT, worktreeRoot, releasesRoot, commit)
  assert(built.release, `committed build artifacts changed: ${built.changes.join(', ')}`)
  assert.strictEqual(built.release.commit, commit)
  assert.strictEqual(fs.existsSync(worktreeRoot), false)
  const after = spawnSync('git', ['status', '--porcelain=v1', '--untracked-files=all'], { cwd: REPO_ROOT, encoding: 'utf8' }).stdout
  assert.strictEqual(after, before, 'detached preview build changed the active source worktree')
}

// Runs all remote release security unit checks in an isolated temporary directory.
function main() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dashboard-remote-release-'))
  try {
    testConnectionAndSource(tempRoot)
    testPreviewComparison()
    testPreviewGates()
    testDetachedBuild(tempRoot)
    console.log('remote release preview tests passed')
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true })
  }
}

main()
