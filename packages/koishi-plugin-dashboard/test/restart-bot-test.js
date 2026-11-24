'use strict'

const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawnSync } = require('child_process')

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..')
const RESTART_SCRIPT = path.join(REPO_ROOT, 'scripts', 'restart-bot.sh')
const SERVICE_INSTALL_SCRIPT = path.join(REPO_ROOT, 'scripts', 'install-koishi-service.sh')

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
function runBash(command) {
  return spawnSync('bash', ['-lc', command], { encoding: 'utf8', timeout: 120000 })
}

// Detects whether the host can execute the POSIX command-stub test.
function hasWorkingBash() {
  const result = runBash('printf restart-bot-bash-ready')
  return result.status === 0 && result.stdout === 'restart-bot-bash-ready'
}

// Writes one LF-only executable used by the isolated command-stub test.
function writeExecutable(filePath, content) {
  fs.writeFileSync(filePath, content.replace(/\r\n/g, '\n'), 'utf8')
  fs.chmodSync(filePath, 0o755)
}

// Creates command stubs that model systemd service ownership and the post-restart health signals.
function createFakeCommands(root) {
  const binDir = path.join(root, 'fake-bin')
  fs.mkdirSync(binDir, { recursive: true })
  writeExecutable(path.join(binDir, 'node'), '#!/bin/bash\nexit 0\n')
  writeExecutable(path.join(binDir, 'systemctl'), `#!/bin/bash
printf '%s\\n' "$*" >> "$COMMAND_LOG"
if [ "\${1:-}" = restart ]; then : > "$SYSTEMD_RESTARTED"; fi
exit 0
`)
  writeExecutable(path.join(binDir, 'ss'), `#!/bin/bash
if [ -f "$SYSTEMD_RESTARTED" ]; then printf 'LISTEN 0 128 127.0.0.1:5140 0.0.0.0:*\\n'; fi
`)
  writeExecutable(path.join(binDir, 'ps'), '#!/bin/bash\nprintf "root 1 0 0 koishi/lib/worker\\n"\n')
  writeExecutable(path.join(binDir, 'tail'), '#!/bin/bash\nif [ "$#" = 1 ]; then exec /usr/bin/tail "$@"; fi\nif [ "${MOCK_LOG_SOURCE:-file}" = journal ]; then exit 0; fi\nif [ "${MOCK_ADAPTER_OFFLINE:-0}" = "1" ]; then printf "adapter connect ECONNREFUSED\\n"; else printf "adapter connect to server\\n"; fi\n')
  writeExecutable(path.join(binDir, 'journalctl'), '#!/bin/bash\nprintf "journalctl:%s\\n" "$*" >> "$COMMAND_LOG"\nif [ "${MOCK_LOG_SOURCE:-file}" = journal ] && [ "${MOCK_ADAPTER_OFFLINE:-0}" != 1 ]; then printf "adapter connect to server\\n"; fi\n')
  writeExecutable(path.join(binDir, 'sleep'), '#!/bin/bash\nexit 0\n')
  return binDir
}

// Verifies static ownership boundaries before running the command-stub scenario.
function testRestartScriptContract() {
  const source = fs.readFileSync(RESTART_SCRIPT, 'utf8')
  assert.match(source, /systemctl restart lian-koishi/)
  assert.doesNotMatch(source, /\bnohup\b/)
  assert.doesNotMatch(source, /\bKOISHI_PID\b/)
  assert.doesNotMatch(source, /start_koishi/)
  assert.doesNotMatch(source, /lian-dashboard/)
}

// Verifies that the generated long-running service owns the required Koishi runtime settings.
function testKoishiServiceContract() {
  const source = fs.readFileSync(SERVICE_INSTALL_SCRIPT, 'utf8')
  assert.match(source, /command -v node/)
  assert.match(source, /Type=simple/)
  assert.match(source, /WorkingDirectory=\$APP_DIR/)
  assert.match(source, /ExecStart=\$NODE_BIN \$APP_DIR\/node_modules\/koishi\/bin\.js start/)
  assert.match(source, /Environment=KOISHI_DIR=\$APP_DIR/)
  assert.match(source, /Environment=DONGXUELIAN_AI_DATA_DIR=\$DATA_DIR/)
  assert.match(source, /Environment=NODE_PATH=\$APP_DIR\/node_modules/)
  assert.match(source, /Environment=NODE_OPTIONS=--max-semi-space-size=4/)
  assert.match(source, /Restart=on-failure/)
  assert.match(source, /systemctl daemon-reload/)
  assert.match(source, /systemctl enable "\$SERVICE_NAME"/)
}

// Runs the real restart script against command stubs and verifies that systemd performs the start.
function testRestartCommandStub(tempRoot, { offline = false, allowOffline = false, logSource = 'file' } = {}) {
  const appDir = path.join(tempRoot, 'app')
  const dataDir = path.join(appDir, 'data')
  const scriptDir = path.join(appDir, 'scripts')
  const commandLog = path.join(appDir, 'systemctl.log')
  const restartedMarker = path.join(appDir, 'lian-koishi-restarted')
  const fakeBin = createFakeCommands(tempRoot)
  fs.mkdirSync(path.join(dataDir, 'resource-workers', 'supervisor'), { recursive: true })
  fs.mkdirSync(scriptDir, { recursive: true })
  fs.writeFileSync(path.join(appDir, 'package.json'), '{"name":"restart-bot-test"}\n')
  fs.writeFileSync(path.join(dataDir, 'resource-workers', 'supervisor', 'state.json'), '{"generation":"test","pid":1}\n')
  fs.copyFileSync(RESTART_SCRIPT, path.join(scriptDir, 'restart-bot.sh'))
  fs.chmodSync(path.join(scriptDir, 'restart-bot.sh'), 0o755)

  const command = [
    `export PATH=${shellQuote(toBashPath(fakeBin))}:/usr/bin:/bin`,
    `export KOISHI_APP_DIR=${shellQuote(toBashPath(appDir))}`,
    `export DONGXUELIAN_AI_DATA_DIR=${shellQuote(toBashPath(dataDir))}`,
    `export COMMAND_LOG=${shellQuote(toBashPath(commandLog))}`,
    `export SYSTEMD_RESTARTED=${shellQuote(toBashPath(restartedMarker))}`,
    `export MOCK_ADAPTER_OFFLINE=${offline ? '1' : '0'}`,
    `export MOCK_LOG_SOURCE=${shellQuote(logSource)}`,
    `export LIAN_DEPLOY_ALLOW_ONEBOT_OFFLINE=${allowOffline ? '1' : '0'}`,
    `exec ${shellQuote(toBashPath(path.join(scriptDir, 'restart-bot.sh')))}`,
  ].join('; ')
  const result = runBash(command)
  if (offline && !allowOffline) assert.notStrictEqual(result.status, 0, 'normal restart accepted an offline adapter')
  else assert.strictEqual(result.status, 0, result.stderr || result.stdout)
  if (offline && allowOffline) {
    assert.match(result.stdout, /adapter waiting for QQ login/)
    assert.doesNotMatch(result.stdout, /adapter connected/)
  }
  const invocations = fs.readFileSync(commandLog, 'utf8').trim().split(/\r?\n/)
  assert(invocations.includes('stop lian-koishi'), `missing systemd stop: ${invocations.join(', ')}`)
  assert(invocations.includes('restart lian-koishi'), `missing systemd restart: ${invocations.join(', ')}`)
  assert(invocations.includes('is-active --quiet lian-koishi'), `missing systemd health check: ${invocations.join(', ')}`)
  assert(invocations.some(item => item.startsWith('journalctl:-u lian-koishi --since @')), 'startup logs must be bounded by the restart timestamp')
  assert(!invocations.some(item => item.includes('lian-dashboard')), `restart script touched Dashboard: ${invocations.join(', ')}`)
}

// Runs static and POSIX command-stub coverage for the systemd-owned restart flow.
function main() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'restart-bot-'))
  try {
    testRestartScriptContract()
    testKoishiServiceContract()
    if (hasWorkingBash()) {
      testRestartCommandStub(path.join(tempRoot, 'connected'))
      testRestartCommandStub(path.join(tempRoot, 'journal-only'), { logSource: 'journal' })
      testRestartCommandStub(path.join(tempRoot, 'offline-rejected'), { offline: true })
      testRestartCommandStub(path.join(tempRoot, 'offline-allowed'), { offline: true, allowOffline: true })
    }
    console.log(hasWorkingBash() ? 'restart-bot systemd tests passed' : 'restart-bot static tests passed; command-stub scenario skipped because bash is unavailable')
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true })
  }
}

main()
