'use strict'

const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawnSync } = require('child_process')
const { buildDashboardRelease, verifyReleaseManifest, verifyBrowserAssets, RELEASE_PACKAGES } = require('../lib/release')

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..')

// --- Cross-platform Bash harness ---

// Quotes one value for a POSIX shell without allowing interpolation.
function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'"'"'`)}'`
}

// Converts an absolute Windows path to the default WSL mount path.
function toBashPath(filePath) {
  if (process.platform !== 'win32') return path.resolve(filePath)
  const resolved = path.resolve(filePath)
  const match = resolved.match(/^([A-Za-z]):\\(.*)$/)
  if (!match) throw new Error(`cannot map Windows path into WSL: ${resolved}`)
  return `/mnt/${match[1].toLowerCase()}/${match[2].replace(/\\/g, '/')}`
}

// Runs one isolated Bash command and returns its captured result.
function runBash(command, options = {}) {
  return spawnSync('bash', ['-lc', command], { encoding: 'utf8', timeout: 120000, ...options })
}

// Detects whether the host can execute the POSIX activation harness before using shell links.
function hasWorkingBash() {
  const result = runBash('printf dashboard-release-bash-ready')
  return result.status === 0 && result.stdout === 'dashboard-release-bash-ready'
}

// Writes one LF-only executable used by the isolated activation harness.
function writeExecutable(filePath, content) {
  fs.writeFileSync(filePath, content.replace(/\r\n/g, '\n'), 'utf8')
  fs.chmodSync(filePath, 0o755)
}

// Builds a fake node launcher that preserves the host Node executable on every platform.
function fakeNodeScript() {
  const cleanupGuard = `if [ "$(basename -- "\${1:-}")" = cleanup-dashboard-releases.js ]; then
  printf 'cleanup-releases\\n' >> "$TEST_APP_DIR/activation-command.log"
  if [ "\${FAIL_RELEASE_CLEANUP:-0}" = "1" ]; then exit 49; fi
fi`
  if (process.platform !== 'win32') return `#!/bin/bash
${cleanupGuard}
exec ${shellQuote(process.execPath)} "$@"
`
  return `#!/bin/bash
${cleanupGuard}
args=()
for arg in "$@"; do
  case "$arg" in
    /mnt/*) args+=("$(wslpath -w "$arg")") ;;
    *) args+=("$arg") ;;
  esac
done
# Windows Node 无法直接 realpath WSL 创建的 current 链接；仅桥接夹具的这个指针，
# 路径目标仍由 WSL 的真实 readlink 提供，回收与清单校验继续运行生产代码。
if [ "$(basename -- "\${1:-}")" = cleanup-dashboard-releases.js ]; then
  actual_current="$(wslpath -w "$(readlink -f "$TEST_APP_DIR/.lian-releases/current")")"
  exec ${shellQuote(toBashPath(process.execPath))} -e 'const fs=require("fs"),path=require("path"); const original=fs.realpathSync; const pointer=path.join(process.argv[3],".lian-releases","current"); fs.realpathSync=function(file,...args){return path.resolve(String(file))===pointer?process.argv[1]:original.call(fs,file,...args)}; require(process.argv[2]).main(process.argv.slice(3))' "$actual_current" "\${args[@]}"
fi
exec ${shellQuote(toBashPath(process.execPath))} "\${args[@]}"
`
}

// Builds an mv shim with failure injection and the Windows mounted-directory workaround.
function fakeMoveScript() {
  const failureInjection = `if [ "\${FAIL_SWITCH:-0}" = "1" ] && printf '%s\\n' "$@" | grep -q 'current.next'; then exit 43; fi`
  if (process.platform !== 'win32') return `#!/bin/bash
${failureInjection}
exec /bin/mv "$@"
`
  const windowsRoot = process.env.SystemRoot || 'C:\\Windows'
  const powershell = toBashPath(path.join(windowsRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'))
  return `#!/bin/bash
if [ "$#" = "2" ] && [ -d "$1" ] && [ ! -e "$2" ]; then
  source_path="$(wslpath -w "$1")"
  target_path="$(wslpath -w "$2")"
  ${shellQuote(powershell)} -NoProfile -Command "Move-Item -LiteralPath '$source_path' -Destination '$target_path'" >/dev/null
  exit $?
fi
${failureInjection}
exec /bin/mv "$@"
`
}

// Creates fake service and network commands without touching host services.
function createFakeCommands(root) {
  const binDir = path.join(root, 'fake-bin')
  fs.mkdirSync(binDir, { recursive: true })
  writeExecutable(path.join(binDir, 'node'), fakeNodeScript())
  writeExecutable(path.join(binDir, 'systemctl'), `#!/bin/bash
printf 'systemctl:%s\\n' "$*" >> "$TEST_APP_DIR/activation-command.log"
case "\${1:-}" in
  restart)
    current="$(readlink -f "$TEST_APP_DIR/.lian-releases/current" 2>/dev/null || true)"
    if [ -n "\${FAIL_RELEASE_ID:-}" ] && [ "$(basename "$current")" = "$FAIL_RELEASE_ID" ]; then exit 42; fi
    exit 0 ;;
  *) exit 0 ;;
esac
`)
  writeExecutable(path.join(binDir, 'curl'), `#!/bin/bash
manifest="$TEST_APP_DIR/.lian-releases/current/release-manifest.json"
current="$(readlink -f "$TEST_APP_DIR/.lian-releases/current" 2>/dev/null || true)"
release_id="$(basename "$current")"
onebot_listening=true
if [ "\${MOCK_ONEBOT_OFFLINE:-0}" = "1" ]; then onebot_listening=false; fi
printf 'curl:%s\\n' "$release_id" >> "$TEST_APP_DIR/activation-command.log"
if [ "\${FAIL_ALL_HEALTH:-0}" = "1" ]; then exit 22; fi
if [ -n "\${FAIL_HEALTH_RELEASE_ID:-}" ] && [ "$(basename "$current")" = "$FAIL_HEALTH_RELEASE_ID" ]; then exit 22; fi
if [ -n "\${FAIL_STABILITY_HEALTH_RELEASE_ID:-}" ] && [ "$release_id" = "$FAIL_STABILITY_HEALTH_RELEASE_ID" ]; then
  count_file="$TEST_APP_DIR/.health-check-$release_id"
  count="$(cat "$count_file" 2>/dev/null || printf 0)"
  count=$((count + 1))
  printf '%s' "$count" > "$count_file"
  if [ "$count" -ge 2 ]; then exit 22; fi
fi
if [ -f "$manifest" ]; then
  hash="$(node -e "process.stdout.write(JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')).manifestHash)" "$manifest")"
  printf '{"ok":true,"dashboard":{"healthy":true},"release":{"manifestHash":"%s"},"bot":{"listening":true},"worker":{"processes":1},"onebot":{"listening":%s}}\\n' "$hash" "$onebot_listening"
else
  printf '{"ok":true,"dashboard":{"healthy":true},"release":null,"bot":{"listening":true},"worker":{"processes":1},"onebot":{"listening":true}}\\n'
fi
`)
  writeExecutable(path.join(binDir, 'ss'), '#!/bin/bash\nprintf "LISTEN 0 128 127.0.0.1:5140 0.0.0.0:*\\n"\n')
  writeExecutable(path.join(binDir, 'sleep'), '#!/bin/bash\nprintf "sleep:%s\\n" "${1:-}" >> "$TEST_APP_DIR/activation-command.log"\nexit 0\n')
  writeExecutable(path.join(binDir, 'bash'), `#!/bin/bash
case "\${1:-}" in
  *install-dashboard-service.sh)
    printf 'install-dashboard-service\\n' >> "$TEST_APP_DIR/activation-command.log"
    exit 0 ;;
  *install-koishi-service.sh)
    printf 'install-koishi-service\\n' >> "$TEST_APP_DIR/activation-command.log"
    exit 0 ;;
  *install-logrotate.sh)
    if [ "\${FAIL_LOGROTATE:-0}" = "1" ]; then exit 45; fi
    : > "$TEST_APP_DIR/logrotate-installed"
    exit 0 ;;
  *install-qq-cache-cleaner.sh)
    if [ "\${FAIL_QQ_CACHE_CLEANER:-0}" = "1" ]; then exit 48; fi
    printf 'install-qq-cache-cleaner\\n' >> "$TEST_APP_DIR/activation-command.log"
    exit 0 ;;
  *install-release-retention.sh)
    printf 'install-release-retention\\n' >> "$TEST_APP_DIR/activation-command.log"
    exit 0 ;;
  *restart-bot.sh)
    if [ "\${KOISHI_APP_DIR:-}" != "$TEST_APP_DIR" ]; then exit 46; fi
    if [ "\${DONGXUELIAN_AI_DATA_DIR:-}" != "$TEST_APP_DIR/data" ]; then exit 47; fi
    current="$(readlink -f "$TEST_APP_DIR/.lian-releases/current" 2>/dev/null || true)"
    printf 'restart-bot:%s\\n' "$(basename "$current")" >> "$TEST_APP_DIR/activation-command.log"
    if [ -n "\${FAIL_BOT_RELEASE_ID:-}" ] && [ "$(basename "$current")" = "$FAIL_BOT_RELEASE_ID" ]; then exit 44; fi
    exit 0 ;;
  *) exec /bin/bash "$@" ;;
esac
`)
  writeExecutable(path.join(binDir, 'mv'), fakeMoveScript())
  return binDir
}

// --- Release construction assertions ---

// Waits for a distinct millisecond so two release IDs cannot collide.
function waitForNextMillisecond() {
  const started = Date.now()
  while (Date.now() === started) { /* release IDs intentionally include the millisecond */ }
}

// 在独立 Node 进程中模拟不同系统语言，验证中文路径不能让同一发布物误报损坏。
function testCrossLocaleManifest(releaseDir) {
  const script = `
const locale = process.argv[1]
const builtinCompare = String.prototype.localeCompare
// 仅在测试子进程中模拟系统默认语言，不影响测试宿主或生产全局状态。
String.prototype.localeCompare = function compareInSelectedLocale(other) { return builtinCompare.call(this, other, locale) }
require(process.argv[2]).main([process.argv[3]])
`
  for (const locale of ['zh-CN', 'en-US']) {
    const result = spawnSync(process.execPath, ['-e', script, locale, path.join(REPO_ROOT, 'scripts', 'verify-release-manifest.js'), releaseDir], { encoding: 'utf8', timeout: 120000 })
    assert.strictEqual(result.status, 0, `manifest rejected under ${locale}: ${result.stderr || result.stdout}`)
    assert.strictEqual(JSON.parse(result.stdout).ok, true)
  }
}

// Verifies exact manifest coverage, browser resources, package coverage, and sensitive exclusions.
function testReleaseManifest(tempRoot) {
  const outputRoot = path.join(tempRoot, 'builds')
  const first = buildDashboardRelease(REPO_ROOT, outputRoot)
  const manifest = verifyReleaseManifest(first.releaseDir)
  testCrossLocaleManifest(first.releaseDir)
  const listed = new Set(manifest.files.map(item => item.path))

  assert(listed.has('packages/koishi-plugin-dashboard/lib/release.js'))
  assert(listed.has('packages/koishi-plugin-dashboard/frontend/dist/index.html'))
  // Dashboard 可从源码包或运行时副本启动，两处都必须携带同版本的 Agent 页面与资源。
  for (const base of ['packages', 'node_modules']) {
    const consoleRoot = `${base}/agent-console`
    assert(listed.has(`${consoleRoot}/package.json`), `${consoleRoot} metadata missing`)
    assert(listed.has(`${consoleRoot}/dist/index.html`), `${consoleRoot} browser entry missing`)
    const html = fs.readFileSync(path.join(first.releaseDir, consoleRoot, 'dist', 'index.html'), 'utf8')
    const assets = [...html.matchAll(/(?:src|href)=["'](\/agent\/assets\/[^"']+)["']/g)]
    assert(assets.length > 0, `${consoleRoot} has no browser assets`)
    for (const [, reference] of assets) assert(listed.has(`${consoleRoot}/dist/${reference.slice('/agent/'.length)}`), `${consoleRoot} asset missing: ${reference}`)
  }
  const agentAsset = manifest.files.find(item => item.path.startsWith('packages/agent-console/dist/assets/'))
  assert(agentAsset, 'Agent browser assets missing from release')
  assert.throws(() => verifyBrowserAssets(first.releaseDir, { ...manifest, files: manifest.files.filter(item => item.path !== agentAsset.path) }), /浏览器入口引用未进入发布清单/)
  assert(listed.has('scripts/activate-dashboard-release.sh'))
  assert(listed.has('scripts/install-koishi-service.sh'))
  assert(listed.has('scripts/qq-cache-cleaner.sh'))
  assert(listed.has('scripts/install-qq-cache-cleaner.sh'))
  assert(listed.has('scripts/cleanup-dashboard-releases.js'))
  assert(listed.has('scripts/install-release-retention.sh'))
  const forcedPersona = 'koishi-plugin-dongxuelian-ai/data/ai-skills/modes/SKILL.persona-forced-abusive.md'
  const personaSource = fs.readFileSync(path.join(REPO_ROOT, 'packages', forcedPersona), 'utf8')
  // 发布目录与运行时副本必须包含完整的新人格，首次启动才能向共享目录补齐种子。
  for (const base of ['packages', 'node_modules']) {
    const relative = `${base}/${forcedPersona}`
    assert(listed.has(relative), `forced abusive persona missing from release: ${relative}`)
    assert.strictEqual(fs.readFileSync(path.join(first.releaseDir, relative), 'utf8'), personaSource)
  }
  for (const packageName of RELEASE_PACKAGES) {
    assert(listed.has(`packages/${packageName}/package.json`), `${packageName} package metadata missing`)
    assert(listed.has(`node_modules/${packageName}/package.json`), `${packageName} runtime copy missing`)
  }
  for (const item of manifest.files) {
    assert(!item.path.startsWith('data/'), `data file entered release: ${item.path}`)
    assert(!/bilibili-cookies|key\.txt|deploy-config\.json/i.test(item.path), `sensitive file entered release: ${item.path}`)
  }

  const tampered = path.join(tempRoot, 'tampered')
  fs.cpSync(first.releaseDir, tampered, { recursive: true })
  fs.appendFileSync(path.join(tampered, 'packages', 'koishi-plugin-dashboard', 'standalone.js'), '\n// tampered\n')
  assert.throws(() => verifyReleaseManifest(tampered), /发布物文件清单不一致/)
  fs.rmSync(tampered, { recursive: true, force: true })

  const extra = path.join(tempRoot, 'extra-file')
  fs.cpSync(first.releaseDir, extra, { recursive: true })
  fs.writeFileSync(path.join(extra, 'unexpected.txt'), 'unexpected')
  assert.throws(() => verifyReleaseManifest(extra), /发布物文件清单不一致/)

  const linked = path.join(tempRoot, 'linked-file')
  fs.cpSync(first.releaseDir, linked, { recursive: true })
  fs.symlinkSync(path.join(linked, 'packages'), path.join(linked, 'unexpected-link'), process.platform === 'win32' ? 'junction' : 'dir')
  assert.throws(() => verifyReleaseManifest(linked), /不允许的链接或特殊文件/)

  waitForNextMillisecond()
  const second = buildDashboardRelease(REPO_ROOT, outputRoot)
  return { oldRelease: first, newRelease: second }
}

// --- Isolated activation and rollback ---

// Creates an app directory with old/new immutable releases and a harmless restart script.
function prepareVersionedApp(tempRoot, name, releases, includeCurrent = true) {
  const appDir = path.join(tempRoot, name)
  const releaseRoot = path.join(appDir, '.lian-releases')
  const oldDir = path.join(releaseRoot, releases.oldRelease.manifest.releaseId)
  const nextDir = path.join(releaseRoot, releases.newRelease.manifest.releaseId + '.next')
  fs.mkdirSync(path.join(appDir, 'data', 'deploy-tasks'), { recursive: true })
  fs.cpSync(releases.oldRelease.releaseDir, oldDir, { recursive: true })
  fs.cpSync(releases.newRelease.releaseDir, nextDir, { recursive: true })
  const oldManifest = releases.oldRelease.manifest
  fs.writeFileSync(path.join(appDir, 'data/deploy-tasks/previous.remote.json'), JSON.stringify({
    state: 'success', stage: 'complete', releaseId: oldManifest.releaseId, updatedAt: 1,
    manifestHash: oldManifest.manifestHash, contentHash: oldManifest.contentHash,
  }))
  // 模拟生产应用的 Dashboard 运行时入口，回收器仍使用真实清单验证实现。
  const moduleDir = path.join(appDir, 'node_modules/koishi-plugin-dashboard/lib')
  fs.mkdirSync(moduleDir, { recursive: true })
  fs.copyFileSync(path.join(REPO_ROOT, 'packages/koishi-plugin-dashboard/lib/release.js'), path.join(moduleDir, 'release.js'))
  writeExecutable(path.join(appDir, 'restart.sh'), `#!/usr/bin/env bash
current="$(readlink -f "$TEST_APP_DIR/.lian-releases/current" 2>/dev/null || true)"
if [ -n "\${FAIL_BOT_RELEASE_ID:-}" ] && [ "$(basename "$current")" = "$FAIL_BOT_RELEASE_ID" ]; then exit 44; fi
exit 0
`)
  if (includeCurrent) {
    const command = `ln -s ${shellQuote(toBashPath(oldDir))} ${shellQuote(toBashPath(path.join(releaseRoot, 'current')))}`
    const linked = runBash(command)
    if (linked.status !== 0) throw new Error(`failed to create current link: ${linked.stderr}`)
  } else {
    for (const base of ['packages', 'node_modules']) {
      for (const packageName of RELEASE_PACKAGES) {
        const source = path.join(oldDir, base, packageName)
        const target = path.join(appDir, base, packageName)
        fs.mkdirSync(path.dirname(target), { recursive: true })
        fs.cpSync(source, target, { recursive: true })
      }
    }
  }
  return { appDir, oldDir, nextDir, baselineHash: includeCurrent ? releases.oldRelease.manifest.manifestHash : 'none', resultFile: path.join(appDir, 'data', 'deploy-tasks', 'activation.remote.json') }
}

// Runs the real activation script against fake systemctl/curl/ss commands.
function runActivation(app, releaseId, fakeBin, failures = {}) {
  const activation = path.join(app.nextDir, 'scripts', 'activate-dashboard-release.sh')
  const envPrefix = [
    `export PATH=${shellQuote(toBashPath(fakeBin))}:/usr/bin:/bin`,
    `export TEST_APP_DIR=${shellQuote(toBashPath(app.appDir))}`,
    `export FAIL_RELEASE_ID=${shellQuote(failures.dashboardReleaseId || '')}`,
    `export FAIL_BOT_RELEASE_ID=${shellQuote(failures.botReleaseId || '')}`,
    `export FAIL_HEALTH_RELEASE_ID=${shellQuote(failures.healthReleaseId || '')}`,
    `export FAIL_STABILITY_HEALTH_RELEASE_ID=${shellQuote(failures.stabilityHealthReleaseId || '')}`,
    `export FAIL_ALL_HEALTH=${shellQuote(failures.allHealth ? '1' : '0')}`,
    `export FAIL_LOGROTATE=${shellQuote(failures.logrotate ? '1' : '0')}`,
    `export FAIL_QQ_CACHE_CLEANER=${shellQuote(failures.qqCacheCleaner ? '1' : '0')}`,
    `export FAIL_RELEASE_CLEANUP=${shellQuote(failures.releaseCleanup ? '1' : '0')}`,
    `export FAIL_SWITCH=${shellQuote(failures.switch ? '1' : '0')}`,
    `export MOCK_ONEBOT_OFFLINE=${shellQuote(failures.onebotOffline ? '1' : '0')}`,
    `export LIAN_DEPLOY_ALLOW_ONEBOT_OFFLINE=${shellQuote(failures.allowOnebotOffline ? '1' : '0')}`,
  ].join('; ')
  const baselineHash = failures.baselineHash || app.baselineHash
  const command = `${envPrefix}; exec ${shellQuote(toBashPath(activation))} ${shellQuote(toBashPath(app.appDir))} ${shellQuote(releaseId)} ${shellQuote(toBashPath(app.resultFile))} ${shellQuote(baselineHash)}`
  return runBash(command)
}

// Resolves the active release pointer through the same Linux path semantics as production.
function activeReleaseId(appDir) {
  const result = runBash(`basename "$(readlink -f ${shellQuote(toBashPath(path.join(appDir, '.lian-releases', 'current')))})"`)
  if (result.status !== 0) throw new Error(`failed to resolve current release: ${result.stderr}`)
  return result.stdout.trim()
}

// Reads the isolated activation command sequence emitted by the fake runtime commands.
function readActivationCommandLog(appDir) {
  return fs.readFileSync(path.join(appDir, 'activation-command.log'), 'utf8').trim().split(/\r?\n/).filter(Boolean)
}

// Asserts that activation prepares both services before switching and performs the two health phases in order.
function assertActivationOrder(log, releaseId, expectCleanup = true) {
  const cacheCleanerInstall = log.indexOf('install-qq-cache-cleaner')
  const dashboardInstall = log.indexOf('install-dashboard-service')
  const koishiInstall = log.indexOf('install-koishi-service')
  const restartBot = log.indexOf(`restart-bot:${releaseId}`)
  const directKoishiRestart = log.indexOf('systemctl:restart lian-koishi')
  const restartDashboard = log.indexOf('systemctl:restart lian-dashboard')
  const firstHealth = log.indexOf(`curl:${releaseId}`)
  const stabilityWait = log.indexOf('sleep:10')
  const secondHealth = log.indexOf(`curl:${releaseId}`, firstHealth + 1)
  const cleanup = log.indexOf('cleanup-releases')
  assert(cacheCleanerInstall >= 0 && cacheCleanerInstall < dashboardInstall, `QQ cache cleaner was not installed before services: ${log.join(', ')}`)
  assert(dashboardInstall >= 0 && koishiInstall > dashboardInstall, `service installation order is invalid: ${log.join(', ')}`)
  assert(restartBot > koishiInstall && restartDashboard > restartBot, `service restart order is invalid: ${log.join(', ')}`)
  assert.strictEqual(directKoishiRestart, -1, `normal activation bypassed restart-bot.sh: ${log.join(', ')}`)
  assert(firstHealth > restartDashboard && stabilityWait > firstHealth && secondHealth > stabilityWait, `stability verification order is invalid: ${log.join(', ')}`)
  if (expectCleanup) assert(cleanup > secondHealth, `release cleanup preceded final health verification: ${log.join(', ')}`)
  else assert.strictEqual(cleanup, -1, 'failed stability verification must not clean old releases')
}

// Verifies successful switching, failure rollback, and first migration from physical paths.
function testActivationScenarios(tempRoot, releases) {
  const fakeBin = createFakeCommands(tempRoot)
  const newId = releases.newRelease.manifest.releaseId
  const oldId = releases.oldRelease.manifest.releaseId

  const successApp = prepareVersionedApp(tempRoot, 'activation-success', releases)
  // The release script is invoked by Bash, so Linux must not require an executable bit.
  if (process.platform !== 'win32') {
    const restartScript = path.join(successApp.nextDir, 'scripts', 'restart-bot.sh')
    fs.chmodSync(restartScript, 0o644)
    assert.strictEqual(fs.statSync(restartScript).mode & 0o111, 0, 'restart script test fixture unexpectedly remains executable')
  }
  const success = runActivation(successApp, newId, fakeBin)
  assert.strictEqual(success.status, 0, success.stderr || success.stdout)
  assert.match(success.stdout, /"mode":"apply"/, success.stderr)
  assert.doesNotMatch(success.stderr, /cleanup failed/)
  assert.strictEqual(activeReleaseId(successApp.appDir), newId)
  assert.strictEqual(fs.existsSync(path.join(successApp.appDir, 'logrotate-installed')), true)
  const successResult = JSON.parse(fs.readFileSync(successApp.resultFile, 'utf8'))
  assert.strictEqual(successResult.state, 'success')
  assert.strictEqual(successResult.manifestHash, releases.newRelease.manifest.manifestHash)
  assert.strictEqual(fs.existsSync(path.join(successApp.appDir, '.lian-releases', 'deploy.lock')), false)
  assertActivationOrder(readActivationCommandLog(successApp.appDir), newId)

  // 默认发布仍要求连接；显式离线发布允许未登录，但不放宽应用健康失败后的回滚。
  const offlineApp = prepareVersionedApp(tempRoot, 'activation-offline-allowed', releases)
  const offline = runActivation(offlineApp, newId, fakeBin, { onebotOffline: true, allowOnebotOffline: true })
  assert.strictEqual(offline.status, 0, offline.stderr || offline.stdout)
  assert.strictEqual(activeReleaseId(offlineApp.appDir), newId)
  assert.strictEqual(JSON.parse(fs.readFileSync(offlineApp.resultFile, 'utf8')).state, 'success')
  assertActivationOrder(readActivationCommandLog(offlineApp.appDir), newId)
  const strictOfflineApp = prepareVersionedApp(tempRoot, 'activation-offline-rejected', releases)
  const strictOffline = runActivation(strictOfflineApp, newId, fakeBin, { onebotOffline: true })
  assert.notStrictEqual(strictOffline.status, 0, 'normal activation accepted offline OneBot')
  assert.strictEqual(activeReleaseId(strictOfflineApp.appDir), oldId)
  const unhealthyOfflineApp = prepareVersionedApp(tempRoot, 'activation-offline-unhealthy', releases)
  const unhealthyOffline = runActivation(unhealthyOfflineApp, newId, fakeBin, { onebotOffline: true, allowOnebotOffline: true, healthReleaseId: newId })
  assert.notStrictEqual(unhealthyOffline.status, 0, 'offline allowance bypassed application health failure')
  assert.strictEqual(activeReleaseId(unhealthyOfflineApp.appDir), oldId)
  assert.strictEqual(JSON.parse(fs.readFileSync(unhealthyOfflineApp.resultFile, 'utf8')).rolledBack, true)

  const lockedApp = prepareVersionedApp(tempRoot, 'activation-locked', releases)
  const lockDir = path.join(lockedApp.appDir, '.lian-releases', 'deploy.lock')
  fs.mkdirSync(lockDir)
  fs.writeFileSync(path.join(lockDir, 'owner'), 'pid=999 release=other')
  const locked = runActivation(lockedApp, newId, fakeBin)
  assert.notStrictEqual(locked.status, 0, 'concurrent activation unexpectedly acquired an existing lock')
  assert.strictEqual(activeReleaseId(lockedApp.appDir), oldId)
  const lockedResult = JSON.parse(fs.readFileSync(lockedApp.resultFile, 'utf8'))
  assert.strictEqual(lockedResult.stage, 'lock')
  assert.strictEqual(lockedResult.rollbackState, 'not_needed')
  assert.strictEqual(fs.existsSync(lockDir), true, 'activation must not delete a lock it does not own')

  const staleBaselineApp = prepareVersionedApp(tempRoot, 'activation-stale-baseline', releases)
  const staleBaseline = runActivation(staleBaselineApp, newId, fakeBin, { baselineHash: '0'.repeat(64) })
  assert.notStrictEqual(staleBaseline.status, 0, 'stale remote baseline unexpectedly switched versions')
  assert.strictEqual(activeReleaseId(staleBaselineApp.appDir), oldId)
  const staleBaselineResult = JSON.parse(fs.readFileSync(staleBaselineApp.resultFile, 'utf8'))
  assert.strictEqual(staleBaselineResult.stage, 'verify_baseline')
  assert.strictEqual(staleBaselineResult.rollbackState, 'not_needed')
  assert.strictEqual(fs.existsSync(path.join(staleBaselineApp.appDir, '.lian-releases', 'deploy.lock')), false)

  const rollbackApp = prepareVersionedApp(tempRoot, 'activation-rollback', releases)
  const failed = runActivation(rollbackApp, newId, fakeBin, { dashboardReleaseId: newId })
  assert.notStrictEqual(failed.status, 0, 'injected service restart failure unexpectedly succeeded')
  assert.strictEqual(activeReleaseId(rollbackApp.appDir), oldId)
  const failureResult = JSON.parse(fs.readFileSync(rollbackApp.resultFile, 'utf8'))
  assert.strictEqual(failureResult.state, 'failed')
  assert.strictEqual(failureResult.stage, 'restart_dashboard')
  assert.strictEqual(failureResult.rolledBack, true)
  assert.strictEqual(failureResult.rollbackState, 'success')
  assert.match(failureResult.error, /exit 42/)
  assert.strictEqual(fs.existsSync(path.join(rollbackApp.appDir, '.lian-releases', 'deploy.lock')), false)

  const switchApp = prepareVersionedApp(tempRoot, 'activation-switch-failure', releases)
  const switchFailed = runActivation(switchApp, newId, fakeBin, { switch: true })
  assert.notStrictEqual(switchFailed.status, 0)
  assert.strictEqual(activeReleaseId(switchApp.appDir), oldId)
  const switchResult = JSON.parse(fs.readFileSync(switchApp.resultFile, 'utf8'))
  assert.strictEqual(switchResult.stage, 'switch_version')

  const botApp = prepareVersionedApp(tempRoot, 'activation-bot-failure', releases)
  const botFailed = runActivation(botApp, newId, fakeBin, { botReleaseId: newId })
  assert.notStrictEqual(botFailed.status, 0)
  assert.strictEqual(activeReleaseId(botApp.appDir), oldId)
  const botResult = JSON.parse(fs.readFileSync(botApp.resultFile, 'utf8'))
  assert.strictEqual(botResult.stage, 'restart_bot')
  assert.strictEqual(botResult.rolledBack, true)

  const healthApp = prepareVersionedApp(tempRoot, 'activation-health-failure', releases)
  const healthFailed = runActivation(healthApp, newId, fakeBin, { healthReleaseId: newId })
  assert.notStrictEqual(healthFailed.status, 0)
  assert.strictEqual(activeReleaseId(healthApp.appDir), oldId)
  const healthResult = JSON.parse(fs.readFileSync(healthApp.resultFile, 'utf8'))
  assert.strictEqual(healthResult.stage, 'health_check')
  assert.strictEqual(healthResult.rolledBack, true)
  assert(!readActivationCommandLog(healthApp.appDir).includes('cleanup-releases'), 'failed release must not prune rollback packages')

  const stabilityApp = prepareVersionedApp(tempRoot, 'activation-stability-failure', releases)
  const stabilityFailed = runActivation(stabilityApp, newId, fakeBin, { stabilityHealthReleaseId: newId })
  assert.notStrictEqual(stabilityFailed.status, 0, 'secondary health failure unexpectedly succeeded')
  assert.strictEqual(activeReleaseId(stabilityApp.appDir), oldId)
  const stabilityResult = JSON.parse(fs.readFileSync(stabilityApp.resultFile, 'utf8'))
  assert.strictEqual(stabilityResult.state, 'failed')
  assert.strictEqual(stabilityResult.stage, 'stability_check')
  assert.strictEqual(stabilityResult.rolledBack, true)
  const stabilityLog = readActivationCommandLog(stabilityApp.appDir)
  assertActivationOrder(stabilityLog, newId, false)
  assert(stabilityLog.includes(`restart-bot:${oldId}`), 'rollback did not restart the old Koishi release')

  const rollbackHealthApp = prepareVersionedApp(tempRoot, 'activation-rollback-health-failure', releases)
  const rollbackHealthFailed = runActivation(rollbackHealthApp, newId, fakeBin, { allHealth: true })
  assert.notStrictEqual(rollbackHealthFailed.status, 0)
  assert.strictEqual(activeReleaseId(rollbackHealthApp.appDir), oldId)
  const rollbackHealthResult = JSON.parse(fs.readFileSync(rollbackHealthApp.resultFile, 'utf8'))
  assert.strictEqual(rollbackHealthResult.rolledBack, false)
  assert.strictEqual(rollbackHealthResult.rollbackState, 'failed')
  assert.strictEqual(fs.existsSync(path.join(rollbackHealthApp.appDir, '.lian-releases', 'deploy.lock')), false)

  const logrotateApp = prepareVersionedApp(tempRoot, 'activation-logrotate-failure', releases)
  const logrotateFailed = runActivation(logrotateApp, newId, fakeBin, { logrotate: true })
  assert.notStrictEqual(logrotateFailed.status, 0)
  assert.strictEqual(activeReleaseId(logrotateApp.appDir), oldId)
  const logrotateResult = JSON.parse(fs.readFileSync(logrotateApp.resultFile, 'utf8'))
  assert.strictEqual(logrotateResult.stage, 'prepare_logrotate')
  assert.strictEqual(logrotateResult.rolledBack, false)

  const cacheCleanerApp = prepareVersionedApp(tempRoot, 'activation-cache-cleaner-failure', releases)
  const cacheCleanerFailed = runActivation(cacheCleanerApp, newId, fakeBin, { qqCacheCleaner: true })
  assert.notStrictEqual(cacheCleanerFailed.status, 0)
  assert.strictEqual(activeReleaseId(cacheCleanerApp.appDir), oldId)
  const cacheCleanerResult = JSON.parse(fs.readFileSync(cacheCleanerApp.resultFile, 'utf8'))
  assert.strictEqual(cacheCleanerResult.stage, 'prepare_qq_cache_cleaner')
  assert.strictEqual(cacheCleanerResult.rolledBack, false)

  const cleanupApp = prepareVersionedApp(tempRoot, 'activation-release-cleanup-failure', releases)
  const cleanupFailed = runActivation(cleanupApp, newId, fakeBin, { releaseCleanup: true })
  assert.strictEqual(cleanupFailed.status, 0, cleanupFailed.stderr || cleanupFailed.stdout)
  assert.strictEqual(activeReleaseId(cleanupApp.appDir), newId)
  assert.strictEqual(JSON.parse(fs.readFileSync(cleanupApp.resultFile, 'utf8')).state, 'success')
  assert(fs.existsSync(cleanupApp.oldDir), 'cleanup failure must preserve the rollback package')
  assert.match(cleanupFailed.stderr, /cleanup failed; verified release remains active/)

  const migrationApp = prepareVersionedApp(tempRoot, 'activation-migration', releases, false)
  const migrated = runActivation(migrationApp, newId, fakeBin)
  assert.strictEqual(migrated.status, 0, migrated.stderr || migrated.stdout)
  assert.strictEqual(activeReleaseId(migrationApp.appDir), newId)
  const dashboardPath = toBashPath(path.join(migrationApp.appDir, 'packages', 'koishi-plugin-dashboard'))
  const symlinkCheck = runBash(`test -L ${shellQuote(dashboardPath)}`)
  assert.strictEqual(symlinkCheck.status, 0, 'first migration did not replace managed package with a symlink')
}

// Runs complete release manifest and isolated activation regression coverage.
function main() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dashboard-release-'))
  try {
    const releases = testReleaseManifest(tempRoot)
    if (hasWorkingBash()) {
      testActivationScenarios(tempRoot, releases)
      console.log('release manifest and activation tests passed')
    } else {
      console.log('release manifest tests passed; activation scenarios skipped because bash is unavailable')
    }
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true })
  }
}

main()
