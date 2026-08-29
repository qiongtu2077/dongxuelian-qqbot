'use strict'

const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const {
  ConfigTransactionError,
  executeConfigTransaction,
  recoverPendingConfigTransactions,
} = require('../lib/config-transaction')

const SECRET = 'sk-transaction-secret-must-not-leak'
const TARGET_NAMES = ['providers', 'key', 'fallback']

// --- Test workspace helpers ---

// Creates one isolated data directory and three logical transaction targets.
function createFixture() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dashboard-config-tx-'))
  const files = {
    providers: path.join(dataDir, 'custom-providers.json'),
    key: path.join(dataDir, 'ai-custom-key.txt'),
    fallback: path.join(dataDir, 'fallback-chains.json'),
  }
  fs.writeFileSync(files.providers, '{"old":"providers"}', { mode: 0o640 })
  fs.writeFileSync(files.fallback, '{"old":"fallback"}', { mode: 0o600 })
  return { dataDir, files }
}

// Captures exact existence, bytes, and effective mode for every formal target.
function captureFiles(files) {
  return Object.fromEntries(TARGET_NAMES.map(name => {
    const filePath = files[name]
    const exists = fs.existsSync(filePath)
    return [name, {
      exists,
      bytes: exists ? fs.readFileSync(filePath) : null,
      mode: exists ? fs.statSync(filePath).mode & 0o777 : null,
    }]
  }))
}

// Reads the same file state a simulated runtime refresh would observe.
function readRuntime(files) {
  return Object.fromEntries(TARGET_NAMES.map(name => [name, fs.existsSync(files[name]) ? fs.readFileSync(files[name], 'utf8') : null]))
}

// Builds a complete three-target transaction using a caller-provided fault policy.
function transactionOptions(fixture, hooks, refresh, verify) {
  return {
    dataDir: fixture.dataDir,
    targets: [
      { name: 'providers', filePath: fixture.files.providers, content: Buffer.from('{"new":"providers"}') },
      { name: 'key', filePath: fixture.files.key, content: Buffer.from(SECRET), mode: 0o600 },
      { name: 'fallback', filePath: fixture.files.fallback, content: Buffer.from('{"new":"fallback"}') },
    ],
    hooks,
    refresh,
    verify,
  }
}

// Asserts that a failed transaction restored all formal and runtime-visible state.
function assertRestored(fixture, before, runtime) {
  const after = captureFiles(fixture.files)
  for (const name of TARGET_NAMES) {
    assert.strictEqual(after[name].exists, before[name].exists, `${name} existence changed`)
    assert.deepStrictEqual(after[name].bytes, before[name].bytes, `${name} bytes changed`)
    assert.strictEqual(after[name].mode, before[name].mode, `${name} mode changed`)
  }
  assert.deepStrictEqual(runtime, readRuntime(fixture.files), 'runtime refresh does not match restored files')
  assert.strictEqual(fs.existsSync(path.join(fixture.dataDir, '.dashboard-api-config-transaction.lock')), false, 'transaction lock leaked')
}

// Executes one expected failure and verifies its public error is both stable and secret-free.
function expectRestoringFailure(stage, targetName) {
  const fixture = createFixture()
  try {
    const before = captureFiles(fixture.files)
    let runtime = readRuntime(fixture.files)
    const hooks = {
      beforeStage(currentStage, currentTarget) {
        if (currentStage === stage && (targetName === undefined || currentTarget === targetName)) throw new Error(`injected ${stage} ${targetName || ''}`)
      },
    }
    assert.throws(
      () => executeConfigTransaction(transactionOptions(fixture, hooks, () => { runtime = readRuntime(fixture.files) }, () => {})),
      error => {
        assert(error instanceof ConfigTransactionError)
        assert.strictEqual(error.code, 'API_CONFIG_TRANSACTION_FAILED')
        assert(!JSON.stringify(error).includes(SECRET), 'secret leaked through transaction error')
        return true
      },
    )
    assertRestored(fixture, before, runtime)
  } finally {
    fs.rmSync(fixture.dataDir, { recursive: true, force: true })
  }
}

// --- Fault injection scenarios ---

// Covers every temporary-file preparation and formal-file replacement stage.
function testPerTargetFailures() {
  for (const name of TARGET_NAMES) expectRestoringFailure('prepared', name)
  for (const name of TARGET_NAMES) expectRestoringFailure('replacing', name)
}

// Covers cache refresh failure and exact readback mismatch after all replacements.
function testRuntimeFailures() {
  const refreshFixture = createFixture()
  try {
    const before = captureFiles(refreshFixture.files)
    let refreshCalls = 0
    let runtime = readRuntime(refreshFixture.files)
    assert.throws(
      () => executeConfigTransaction(transactionOptions(refreshFixture, undefined, () => {
        refreshCalls += 1
        runtime = readRuntime(refreshFixture.files)
        if (refreshCalls === 1) throw new Error('injected cache refresh failure')
      }, () => {})),
      error => error instanceof ConfigTransactionError && error.stage === 'refreshing',
    )
    assertRestored(refreshFixture, before, runtime)
  } finally {
    fs.rmSync(refreshFixture.dataDir, { recursive: true, force: true })
  }

  const verifyFixture = createFixture()
  try {
    const before = captureFiles(verifyFixture.files)
    let runtime = readRuntime(verifyFixture.files)
    assert.throws(
      () => executeConfigTransaction(transactionOptions(verifyFixture, undefined, () => { runtime = readRuntime(verifyFixture.files) }, () => { throw new Error('injected readback mismatch') })),
      error => error instanceof ConfigTransactionError && error.stage === 'verifying',
    )
    assertRestored(verifyFixture, before, runtime)
  } finally {
    fs.rmSync(verifyFixture.dataDir, { recursive: true, force: true })
  }
}

// Verifies startup recovery restores an uncommitted journal left between replacements.
function testInterruptedRecovery() {
  const fixture = createFixture()
  try {
    const transactionDir = path.join(fixture.dataDir, '.dashboard-api-config-transactions', 'interrupted')
    const backupPath = path.join(transactionDir, '0-providers.backup')
    const nextPath = fixture.files.providers + '.interrupted.next'
    fs.mkdirSync(transactionDir, { recursive: true })
    fs.copyFileSync(fixture.files.providers, backupPath)
    const original = fs.readFileSync(fixture.files.providers)
    const mode = fs.statSync(fixture.files.providers).mode & 0o777
    fs.writeFileSync(fixture.files.providers, '{"partial":"new"}')
    fs.writeFileSync(nextPath, '{"pending":"next"}')
    fs.writeFileSync(path.join(transactionDir, 'journal.json'), JSON.stringify({
      id: 'interrupted',
      state: 'replacing',
      createdAt: Date.now(),
      targets: [{ name: 'providers', filePath: fixture.files.providers, nextPath, backupPath, existed: true, mode }],
    }))

    recoverPendingConfigTransactions(fixture.dataDir)

    assert.deepStrictEqual(fs.readFileSync(fixture.files.providers), original)
    assert.strictEqual(fs.existsSync(nextPath), false)
    assert.strictEqual(fs.existsSync(transactionDir), false)
  } finally {
    fs.rmSync(fixture.dataDir, { recursive: true, force: true })
  }
}

// Verifies rollback failure is explicit, metadata-only, and never leaks the Key value.
function testRollbackFailure() {
  const fixture = createFixture()
  try {
    let caught = null
    try {
      executeConfigTransaction(transactionOptions(fixture, {
        beforeStage(stage) { if (stage === 'rolling_back') throw new Error('injected rollback failure') },
      }, () => {}, () => { throw new Error('trigger rollback') }))
    } catch (error) {
      caught = error
    }
    assert(caught instanceof ConfigTransactionError)
    assert.strictEqual(caught.code, 'API_CONFIG_ROLLBACK_FAILED')
    assert.deepStrictEqual(caught.files.sort(), ['ai-custom-key.txt', 'custom-providers.json', 'fallback-chains.json'])
    assert(!JSON.stringify(caught).includes(SECRET), 'secret leaked through rollback failure')
  } finally {
    fs.rmSync(fixture.dataDir, { recursive: true, force: true })
  }
}

// Verifies a cleanup fault becomes a warning while committed data and lock release remain correct.
function testCleanupWarning() {
  const fixture = createFixture()
  try {
    const result = executeConfigTransaction(transactionOptions(fixture, {
      beforeStage(stage) { if (stage === 'cleanup') throw new Error('injected cleanup warning') },
    }, () => {}, () => {}))
    assert.strictEqual(result.cleanupWarning, true)
    assert.strictEqual(fs.readFileSync(fixture.files.key, 'utf8'), SECRET)
    assert.strictEqual(fs.existsSync(path.join(fixture.dataDir, '.dashboard-api-config-transaction.lock')), false)
  } finally {
    fs.rmSync(fixture.dataDir, { recursive: true, force: true })
  }
}

// Verifies a live owner rejects the second transaction and a proven dead owner is reclaimed.
function testCrossProcessLock() {
  const fixture = createFixture()
  const lockPath = path.join(fixture.dataDir, '.dashboard-api-config-transaction.lock')
  try {
    fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid }))
    assert.throws(
      () => executeConfigTransaction(transactionOptions(fixture, undefined, () => {}, () => {})),
      error => error instanceof ConfigTransactionError && error.code === 'API_CONFIG_BUSY',
    )
    fs.unlinkSync(lockPath)
    fs.writeFileSync(lockPath, JSON.stringify({ pid: 2147483647 }))
    const result = executeConfigTransaction(transactionOptions(fixture, undefined, () => {}, () => {}))
    assert(result.id)
  } finally {
    fs.rmSync(fixture.dataDir, { recursive: true, force: true })
  }
}

// Runs all API configuration transaction regression scenarios.
function main() {
  testPerTargetFailures()
  expectRestoringFailure('committed')
  testRuntimeFailures()
  testInterruptedRecovery()
  testRollbackFailure()
  testCleanupWarning()
  testCrossProcessLock()
  console.log('config transaction tests passed')
}

main()
