'use strict'

const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawnSync } = require('child_process')
const { buildDashboardRelease, verifyReleaseManifest, RELEASE_PACKAGES } = require('../lib/release')

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

// Writes one LF-only executable used by the isolated activation harness.
function writeExecutable(filePath, content) {
  fs.writeFileSync(filePath, content.replace(/\r\n/g, '\n'), 'utf8')
  fs.chmodSync(filePath, 0o755)
}

// Builds a fake node launcher that preserves the host Node executable on every platform.
function fakeNodeScript() {
  if (process.platform !== 'win32') return `#!/bin/bash
exec ${shellQuote(process.execPath)} "$@"
`
  return `#!/bin/bash
args=()
for arg in "$@"; do
  case "$arg" in
    /mnt/*) args+=("$(wslpath -w "$arg")") ;;
    *) args+=("$arg") ;;
  esac
done
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
if [ "\${FAIL_ALL_HEALTH:-0}" = "1" ]; then exit 22; fi
if [ -n "\${FAIL_HEALTH_RELEASE_ID:-}" ] && [ "$(basename "$current")" = "$FAIL_HEALTH_RELEASE_ID" ]; then exit 22; fi
if [ -f "$manifest" ]; then
  hash="$(node -e "process.stdout.write(JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')).manifestHash)" "$manifest")"
  printf '{"ok":true,"dashboard":{"healthy":true},"release":{"manifestHash":"%s"},"bot":{"listening":true},"worker":{"processes":1},"onebot":{"listening":true}}\\n' "$hash"
else
  printf '{"ok":true,"dashboard":{"healthy":true},"release":null,"bot":{"listening":true},"worker":{"processes":1},"onebot":{"listening":true}}\\n'
fi
`)
  writeExecutable(path.join(binDir, 'ss'), '#!/bin/bash\nprintf "LISTEN 0 128 127.0.0.1:5140 0.0.0.0:*\\n"\n')
  writeExecutable(path.join(binDir, 'sleep'), '#!/bin/bash\nexit 0\n')
  writeExecutable(path.join(binDir, 'bash'), `#!/bin/bash
case "\${1:-}" in
  *install-dashboard-service.sh) exit 0 ;;
  *install-logrotate.sh)
    if [ "\${FAIL_LOGROTATE:-0}" = "1" ]; then exit 45; fi
    : > "$TEST_APP_DIR/logrotate-installed"
    exit 0 ;;
  *restart-bot.sh)
    current="$(readlink -f "$TEST_APP_DIR/.lian-releases/current" 2>/dev/null || true)"
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

// Verifies exact manifest coverage, browser resources, package coverage, and sensitive exclusions.
function testReleaseManifest(tempRoot) {
  const outputRoot = path.join(tempRoot, 'builds')
  const first = buildDashboardRelease(REPO_ROOT, outputRoot)
  const manifest = verifyReleaseManifest(first.releaseDir)
  const listed = new Set(manifest.files.map(item => item.path))

  assert(listed.has('packages/koishi-plugin-dashboard/lib/release.js'))
  assert(listed.has('packages/koishi-plugin-dashboard/frontend/dist/index.html'))
  assert(listed.has('scripts/activate-dashboard-release.sh'))
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
    `export FAIL_ALL_HEALTH=${shellQuote(failures.allHealth ? '1' : '0')}`,
    `export FAIL_LOGROTATE=${shellQuote(failures.logrotate ? '1' : '0')}`,
    `export FAIL_SWITCH=${shellQuote(failures.switch ? '1' : '0')}`,
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

// Verifies successful switching, failure rollback, and first migration from physical paths.
function testActivationScenarios(tempRoot, releases) {
  const fakeBin = createFakeCommands(tempRoot)
  const newId = releases.newRelease.manifest.releaseId
  const oldId = releases.oldRelease.manifest.releaseId

  const successApp = prepareVersionedApp(tempRoot, 'activation-success', releases)
  const success = runActivation(successApp, newId, fakeBin)
  assert.strictEqual(success.status, 0, success.stderr || success.stdout)
  assert.strictEqual(activeReleaseId(successApp.appDir), newId)
  assert.strictEqual(fs.existsSync(path.join(successApp.appDir, 'logrotate-installed')), true)
  const successResult = JSON.parse(fs.readFileSync(successApp.resultFile, 'utf8'))
  assert.strictEqual(successResult.state, 'success')
  assert.strictEqual(successResult.manifestHash, releases.newRelease.manifest.manifestHash)
  assert.strictEqual(fs.existsSync(path.join(successApp.appDir, '.lian-releases', 'deploy.lock')), false)

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
    testActivationScenarios(tempRoot, releases)
    console.log('release manifest and activation tests passed')
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true })
  }
}

main()
