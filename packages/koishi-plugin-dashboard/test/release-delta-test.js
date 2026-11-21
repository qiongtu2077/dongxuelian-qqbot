'use strict'

const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const { execFileSync, spawnSync } = require('node:child_process')
const { planReleaseDelta, buildDeltaArchive } = require('../lib/remote-release')
const { verifyReleaseManifest } = require('../lib/release')

// --- 发布夹具 ---

// 根据给定的文件内容生成可用正式校验器验证的 v1 版本。
function writeVersion(root, id, contents) {
  const dir = path.join(root, id)
  const files = Object.keys(contents).sort().map(name => {
    const filename = path.join(dir, name)
    fs.mkdirSync(path.dirname(filename), { recursive: true })
    const data = Buffer.from(contents[name])
    fs.writeFileSync(filename, data)
    return { path: name, size: data.length, sha256: crypto.createHash('sha256').update(data).digest('hex') }
  })
  const manifest = { schemaVersion: 1, releaseId: id, version: '1', commit: 'a'.repeat(40), builtAt: new Date().toISOString(), files,
    contentHash: crypto.createHash('sha256').update(JSON.stringify(files)).digest('hex') }
  manifest.manifestHash = crypto.createHash('sha256').update(JSON.stringify(manifest)).digest('hex')
  fs.writeFileSync(path.join(dir, 'release-manifest.json'), JSON.stringify(manifest))
  verifyReleaseManifest(dir)
  return { dir, manifest }
}

// 通过标准输入执行同一份远端程序，每次启动都使用本测试拥有的新暂存目录。
function assemble(root, bundle, hash, old, next) {
  const releaseId = next.manifest.releaseId
  const stage = path.join(root, releaseId + '.next')
  fs.rmSync(stage, { force: true, recursive: true })
  fs.mkdirSync(stage)
  fs.copyFileSync(bundle, path.join(stage, '.upload.tgz'))
  return spawnSync(process.execPath, ['-', root, releaseId, old, next.manifest.manifestHash, hash], {
    input: fs.readFileSync(require.resolve('../lib/assemble-release-delta')), encoding: 'utf8', timeout: 30000,
  })
}

// --- 增量传输与基线隔离 ---

// 实际打包、解包和组装，覆盖旧版首次升级、增删改、路径类型变化和传输失败。
function runReleaseDeltaTests(tempRoot) {
  const root = path.join(tempRoot, 'release root')
  fs.mkdirSync(root)
  const shared = { 'packages/koishi-plugin-dashboard/lib/release.js': fs.readFileSync(require.resolve('../lib/release')),
    'assets/immutable.bin': crypto.randomBytes(256 * 1024) }
  for (const base of ['packages', 'node_modules']) {
    for (const browser of ['agent-console/dist', 'koishi-plugin-dashboard/frontend/dist']) shared[base + '/' + browser + '/index.html'] = '<main></main>'
  }
  const oldContents = { ...shared, 'old-file': 'removed', 'x': 'file', 'y/child': 'child', 'scripts/start.sh': 'before' }
  const old = writeVersion(root, 'old-release', oldContents)
  const next = writeVersion(tempRoot, 'new-release', { ...shared, 'x/child': 'child', 'y': 'file', '中文 目录/卡片.txt': 'added', 'scripts/start.sh': 'after' })
  fs.symlinkSync(old.dir, path.join(root, 'current'), process.platform === 'win32' ? 'junction' : 'dir')
  const plan = planReleaseDelta(next.manifest.files, old.manifest.files)
  assert.deepEqual(plan.changedPaths, ['scripts/start.sh', 'x/child', 'y', '中文 目录/卡片.txt'])
  assert.equal(plan.changes.removed, 3)
  const bundle = path.join(tempRoot, 'preview.tgz')
  const transfer = buildDeltaArchive(next.dir, bundle, plan.changedPaths)
  const listing = execFileSync('tar', ['-tzf', bundle], { encoding: 'utf8' })
  assert(!listing.includes('immutable.bin'))
  assert(!listing.trim().split(/\r?\n/).includes('./'), 'temporary root permissions must stay local')
  assert(transfer.bytes < shared['assets/immutable.bin'].length)
  const install = (oldHash = old.manifest.manifestHash, bundleHash = transfer.sha256) => assemble(root, bundle, bundleHash, oldHash, next)
  const installed = install()
  assert.equal(installed.status, 0, installed.stderr)
  const stage = path.join(root, 'new-release.next')
  assert.deepEqual(verifyReleaseManifest(stage), next.manifest)
  assert(!fs.existsSync(path.join(stage, 'old-file')))
  fs.writeFileSync(path.join(stage, 'assets/immutable.bin'), 'only the candidate changes')
  assert.deepEqual(verifyReleaseManifest(old.dir), old.manifest)

  assert.match(install('0'.repeat(64)).stderr, /清单与预览不符/)
  assert.match(install(old.manifest.manifestHash, '0'.repeat(64)).stderr, /增量包校验失败/)
  // 即使压缩包摘要正确，缺少应上传的文件也必须被完整版本校验拦截。
  const incomplete = buildDeltaArchive(next.dir, bundle, plan.changedPaths.slice(1))
  assert.match(install(old.manifest.manifestHash, incomplete.sha256).stderr, /发布物文件清单不一致/)
  assert.equal(fs.realpathSync(path.join(root, 'current')), fs.realpathSync(old.dir))

  // 只有删除的变更，以及仅发布身份变化的版本，都只发送新清单。
  for (const [id, contents] of [['delete-only', shared], ['no-changes', oldContents]]) {
    const version = writeVersion(tempRoot, id, contents)
    const delta = planReleaseDelta(version.manifest.files, old.manifest.files)
    assert.deepEqual(delta.changedPaths, [])
    const archive = buildDeltaArchive(version.dir, bundle, delta.changedPaths)
    const entries = execFileSync('tar', ['-tzf', bundle], { encoding: 'utf8' }).trim().split(/\r?\n/).filter(name => !name.endsWith('/'))
    assert.deepEqual(entries, ['./release-manifest.json'])
    const result = assemble(root, bundle, archive.sha256, old.manifest.manifestHash, version)
    assert.equal(result.status, 0, result.stderr)
    assert.deepEqual(verifyReleaseManifest(path.join(root, id + '.next')), version.manifest)
  }
}

module.exports = { runReleaseDeltaTests }
