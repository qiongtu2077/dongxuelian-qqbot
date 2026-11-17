'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const crypto = require('node:crypto')
const { main } = require('./cleanup-dashboard-releases')

// --- 有真实清单和成功回执的文件夹具 ---

/** 为最小发布载荷生成符合生产验证器的真实清单与成功回执。 */
function writeRelease(appDir, id, updatedAt, state = 'success') {
  const root = path.join(appDir, '.lian-releases', id)
  const files = []
  for (const base of ['packages', 'node_modules']) {
    for (const directory of ['agent-console/dist', 'koishi-plugin-dashboard/frontend/dist']) {
      const relative = `${base}/${directory}/index.html`
      const content = '<html>fixture</html>'
      fs.mkdirSync(path.dirname(path.join(root, relative)), { recursive: true })
      fs.writeFileSync(path.join(root, relative), content)
      files.push({ path: relative, size: Buffer.byteLength(content), sha256: crypto.createHash('sha256').update(content).digest('hex') })
    }
  }
  files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
  const manifest = { schemaVersion: 1, releaseId: id, version: 'test', commit: 'a'.repeat(40), builtAt: new Date(updatedAt).toISOString(), files,
    contentHash: crypto.createHash('sha256').update(JSON.stringify(files)).digest('hex') }
  manifest.manifestHash = crypto.createHash('sha256').update(JSON.stringify(manifest)).digest('hex')
  fs.writeFileSync(path.join(root, 'release-manifest.json'), JSON.stringify(manifest))
  fs.writeFileSync(path.join(appDir, 'data', 'deploy-tasks', `${id}.remote.json`), JSON.stringify({ state, stage: 'complete', releaseId: id,
    updatedAt, manifestHash: manifest.manifestHash, contentHash: manifest.contentHash }))
  return root
}

/** 创建三个已验证版本和一个更新但失败的版本，避免按目录时间误选回滚包。 */
function fixture(parent, name) {
  const appDir = path.join(parent, name)
  const root = path.join(appDir, '.lian-releases')
  const moduleDir = path.join(appDir, 'node_modules', 'koishi-plugin-dashboard', 'lib')
  fs.mkdirSync(path.join(appDir, 'data', 'deploy-tasks'), { recursive: true })
  fs.mkdirSync(moduleDir, { recursive: true })
  fs.copyFileSync(path.join(__dirname, '../packages/koishi-plugin-dashboard/lib/release.js'), path.join(moduleDir, 'release.js'))
  const now = Date.now()
  writeRelease(appDir, 'old', now - 10000)
  writeRelease(appDir, 'previous', now - 8000)
  const current = writeRelease(appDir, 'current-release', now - 6000)
  writeRelease(appDir, 'failed-newer', now - 2000, 'failed')
  fs.symlinkSync(current, path.join(root, 'current'), process.platform === 'win32' ? 'junction' : 'dir')
  return { appDir, root }
}

// --- 回收行为和删除边界 ---

/** 覆盖预览、保留策略、过期上传、外链、校验失败、锁和重复执行。 */
function run() {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'lian-release-cleanup-'))
  try {
    const { appDir, root } = fixture(parent, 'normal')
    const outside = path.join(parent, 'outside')
    fs.mkdirSync(outside)
    fs.writeFileSync(path.join(outside, 'keep'), 'keep')
    fs.symlinkSync(outside, path.join(root, 'linked-old'), process.platform === 'win32' ? 'junction' : 'dir')
    for (const name of ['abandoned.next', 'old.tgz', 'old.upload.tar.gz']) {
      const target = path.join(root, name)
      if (name.endsWith('.next')) fs.mkdirSync(target)
      else fs.writeFileSync(target, 'old upload')
      fs.utimesSync(target, new Date(0), new Date(0))
    }
    fs.mkdirSync(path.join(root, 'active.next'))
    const preview = main([appDir])
    assert.deepEqual(preview.keep, ['current-release', 'previous'])
    assert.equal(preview.removed, 0)
    assert(fs.existsSync(path.join(root, 'old')))
    assert(preview.skipped.includes('active.next') && preview.skipped.includes('linked-old'))
    const applied = main([appDir, '--apply'])
    assert.equal(applied.removed, 5)
    assert(fs.existsSync(path.join(root, 'previous')) && fs.existsSync(path.join(root, 'current-release')))
    assert(fs.existsSync(path.join(outside, 'keep')))
    assert(!fs.existsSync(path.join(root, 'failed-newer')))
    assert.equal(main([appDir, '--apply']).removed, 0)
    console.log('PASS retains current and verified previous; removes old packages and stale uploads; repeat is empty')

    const damaged = fixture(parent, 'damaged')
    fs.appendFileSync(path.join(damaged.root, 'previous', 'packages/agent-console/dist/index.html'), 'tampered')
    assert.throws(() => main([damaged.appDir, '--apply']), /发布物文件清单不一致/)
    assert(fs.existsSync(path.join(damaged.root, 'old')))
    assert(!fs.existsSync(path.join(damaged.root, 'deploy.lock')))
    console.log('PASS damaged rollback package blocks all deletion and releases own lock')

    const locked = fixture(parent, 'locked')
    fs.mkdirSync(path.join(locked.root, 'deploy.lock'))
    fs.writeFileSync(path.join(locked.root, 'deploy.lock', 'token'), 'activation-owner')
    assert.throws(() => main([locked.appDir, '--apply']), /EEXIST/)
    assert.throws(() => main([locked.appDir, '--apply', '--lock-token', 'wrong-owner']), /lock token mismatch/)
    assert.equal(main([locked.appDir, '--apply', '--lock-token', 'activation-owner']).removed, 2)
    assert(fs.existsSync(path.join(locked.root, 'deploy.lock')))
    console.log('PASS activation lock excludes manual cleanup and is preserved when borrowed')

    const invalid = fixture(parent, 'no-current-receipt')
    fs.unlinkSync(path.join(invalid.appDir, 'data/deploy-tasks/current-release.remote.json'))
    assert.throws(() => main([invalid.appDir, '--apply']), /no successful deployment receipt/)
    assert(fs.existsSync(path.join(invalid.root, 'old')))
    console.log('PASS unverified current blocks deletion')

    const noPrevious = fixture(parent, 'no-previous-receipt')
    fs.unlinkSync(path.join(noPrevious.appDir, 'data/deploy-tasks/previous.remote.json'))
    fs.unlinkSync(path.join(noPrevious.appDir, 'data/deploy-tasks/old.remote.json'))
    assert.throws(() => main([noPrevious.appDir, '--apply']), /previous successful deployment receipt unavailable/)
    assert(fs.existsSync(path.join(noPrevious.root, 'old')))
    console.log('PASS missing verified rollback identity blocks deletion')
  } finally {
    // 夹具根目录由 mkdtemp 创建并固定在系统临时目录，删除前再次验证物理边界。
    assert.equal(path.dirname(fs.realpathSync(parent)), fs.realpathSync(os.tmpdir()))
    fs.rmSync(parent, { recursive: true, force: true })
  }
}

run()
