'use strict'

/** 发布包回收：只处理应用的 .lian-releases；默认预览，保留当前版与上一成功版。 */
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')

// --- 发布身份与保留集合 ---

/** 解析明确的应用目录和执行模式，不接受未知选项。 */
function parseArgs(argv) {
  if (!argv[0] || !path.isAbsolute(argv[0])) throw new Error('usage: cleanup-dashboard-releases.js <absolute-app-dir> [--apply] [--lock-token token]')
  const options = { appDir: fs.realpathSync(argv[0]), apply: false, lockToken: '' }
  for (let i = 1; i < argv.length; i += 1) {
    if (argv[i] === '--apply') options.apply = true
    else if (argv[i] === '--lock-token' && argv[i + 1]) options.lockToken = argv[++i]
    else throw new Error(`unknown cleanup argument: ${argv[i]}`)
  }
  return options
}

/** 收集发布流程的成功回执，按实际完成时间选择上一成功版本。 */
function readSuccessfulReleases(appDir) {
  const directory = path.join(process.env.DONGXUELIAN_AI_DATA_DIR || path.join(appDir, 'data'), 'deploy-tasks')
  return fs.readdirSync(directory).filter(name => name.endsWith('.remote.json')).map(name => {
    const receipt = JSON.parse(fs.readFileSync(path.join(directory, name), 'utf8'))
    return receipt
  }).filter(receipt => receipt.state === 'success' && receipt.stage === 'complete'
    && /^[a-z0-9-]+$/.test(receipt.releaseId) && Number.isFinite(receipt.updatedAt))
    .sort((left, right) => right.updatedAt - left.updatedAt)
}

/** 校验当前指针和成功回执，使用生产清单验证器核验两个保留包的完整内容。 */
function resolveRetainedReleases(appDir, root) {
  const current = fs.realpathSync(path.join(root, 'current'))
  if (path.dirname(current) !== root || !fs.lstatSync(current).isDirectory()) throw new Error('current points outside release root')
  const receipts = readSuccessfulReleases(appDir)
  const currentReceipt = receipts.find(item => item.releaseId === path.basename(current))
  if (!currentReceipt) throw new Error('current release has no successful deployment receipt')
  const previous = receipts.find(item => item.releaseId !== currentReceipt.releaseId && item.updatedAt <= currentReceipt.updatedAt
    && fs.existsSync(path.join(root, item.releaseId)))
  if (!previous) throw new Error('previous successful deployment receipt unavailable; cleanup skipped')
  const { verifyReleaseManifest } = require(path.join(appDir, 'node_modules', 'koishi-plugin-dashboard', 'lib', 'release.js'))
  for (const receipt of [currentReceipt, previous].filter(Boolean)) {
    const directory = path.join(root, receipt.releaseId)
    if (fs.lstatSync(directory).isSymbolicLink() || fs.realpathSync(directory) !== directory) throw new Error('retained release must be a direct directory')
    const manifest = verifyReleaseManifest(directory)
    if (manifest.releaseId !== receipt.releaseId || manifest.manifestHash !== receipt.manifestHash || manifest.contentHash !== receipt.contentHash) {
      throw new Error(`successful release manifest mismatch: ${receipt.releaseId}`)
    }
  }
  return { current, verifiedAt: currentReceipt.updatedAt, keep: [currentReceipt.releaseId, previous?.releaseId].filter(Boolean) }
}

// --- 发布锁与删除边界 ---

/** 复用发布者持有的锁；手动运行则原子获得同一把锁，绝不强拆已有锁。 */
function acquireLock(root, suppliedToken) {
  const directory = path.join(root, 'deploy.lock')
  if (suppliedToken) {
    if (fs.readFileSync(path.join(directory, 'token'), 'utf8').trim() !== suppliedToken) throw new Error('deployment lock token mismatch')
    return () => {}
  }
  const token = crypto.randomBytes(16).toString('hex')
  fs.mkdirSync(directory)
  try {
    fs.writeFileSync(path.join(directory, 'token'), token)
    fs.writeFileSync(path.join(directory, 'owner'), `pid=${process.pid} release=cleanup started=${new Date().toISOString()}\n`)
  } catch (error) {
    fs.rmSync(directory, { recursive: true })
    throw error
  }
  // 只释放本次获得的锁，保留后来接管者的锁。
  return () => {
    if (fs.readFileSync(path.join(directory, 'token'), 'utf8').trim() === token) fs.rmSync(directory, { recursive: true })
  }
}

/** 只列出有发布清单的旧目录，以及成功发布前已搁置至少一小时的上传残留。 */
function listCandidates(root, retained, now) {
  const candidates = []
  const skipped = []
  const staleBefore = Math.min(retained.verifiedAt, now - 60 * 60 * 1000)
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (retained.keep.includes(entry.name) || ['current', 'deploy.lock'].includes(entry.name)) continue
    const target = path.join(root, entry.name)
    if (entry.isSymbolicLink()) { skipped.push(entry.name); continue }
    const staleUpload = /^[a-z0-9-]+(?:\.next|\.tgz|\.tar\.gz|\.upload\.tar\.gz)$/.test(entry.name)
      && fs.statSync(target).mtimeMs < staleBefore
    if (staleUpload && (entry.isDirectory() || entry.isFile())) candidates.push(entry.name)
    else if (entry.isDirectory() && /^[a-z0-9-]+$/.test(entry.name) && fs.existsSync(path.join(target, 'release-manifest.json'))) {
      const manifest = JSON.parse(fs.readFileSync(path.join(target, 'release-manifest.json'), 'utf8'))
      if (manifest.releaseId !== entry.name) throw new Error(`old release identity mismatch: ${entry.name}`)
      candidates.push(entry.name)
    } else skipped.push(entry.name)
  }
  return { candidates, skipped }
}

/** 在每次删除前重验物理范围、锁和 current，禁止递归删除符号链接或运行版本。 */
function removeCandidate(root, name, retained, token) {
  const target = path.join(root, name)
  if (path.dirname(target) !== root || fs.realpathSync(target) !== target || fs.lstatSync(target).isSymbolicLink()) throw new Error('cleanup target escapes release root')
  if (retained.keep.includes(name) || fs.realpathSync(path.join(root, 'current')) !== retained.current) throw new Error('current release changed during cleanup')
  if (fs.readFileSync(path.join(root, 'deploy.lock', 'token'), 'utf8').trim() !== token) throw new Error('deployment lock changed during cleanup')
  fs.rmSync(target, { recursive: true })
}

// --- 命令入口 ---

/** 在锁内形成预览或执行回收；失败只影响维护任务，不修改应用版本和共享数据。 */
function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv)
  const root = path.join(options.appDir, '.lian-releases')
  if (fs.realpathSync(root) !== root) throw new Error('release root must not be a symlink')
  const unlock = acquireLock(root, options.lockToken)
  try {
    const token = fs.readFileSync(path.join(root, 'deploy.lock', 'token'), 'utf8').trim()
    const retained = resolveRetainedReleases(options.appDir, root)
    const { candidates, skipped } = listCandidates(root, retained, Date.now())
    if (options.apply) for (const name of candidates) removeCandidate(root, name, retained, token)
    const result = { mode: options.apply ? 'apply' : 'dry-run', keep: retained.keep, removed: options.apply ? candidates.length : 0, candidates, skipped }
    process.stdout.write(JSON.stringify(result) + '\n')
    return result
  } finally { unlock() }
}

if (require.main === module) {
  try { main() } catch (error) {
    process.stderr.write(`[release-cleanup] ${error.message}\n`)
    process.exitCode = 1
  }
}

module.exports = { main }
