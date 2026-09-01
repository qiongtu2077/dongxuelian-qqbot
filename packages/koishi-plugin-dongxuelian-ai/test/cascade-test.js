/*
 * Cascade is the structural and pure-contract quick-test entry.
 * Scenario behavior remains owned by test/scenarios; the domain runners below
 * keep repository, module, command, persona, and output guards independently traceable.
 */
'use strict'

const fs = require('fs')
const path = require('path')
const dns = require('dns')
const { spawnSync } = require('child_process')
const { createTestDataDir } = require('./fake/file')
const { createCascadeHarness } = require('./helpers/cascade-harness')
const { createCascadeFixtures } = require('./cascade/fixtures')
const { runRepositoryContract } = require('./cascade/repository-contract')
const { runCoverageContract } = require('./cascade/coverage-contract')
const { runModuleContract } = require('./cascade/module-contract')
const { runCoreContracts } = require('./cascade/core-contracts')
const { runAiCapabilityContracts } = require('./cascade/ai-capability-contracts')
const { runMessageCommandContracts } = require('./cascade/message-command-contracts')
const { runPersonaContracts } = require('./cascade/persona-contracts')
const { runRepositoryGuards } = require('./cascade/repository-guards')
const { runOutputMemoryContracts } = require('./cascade/output-memory-contracts')

const cascadeTestData = createTestDataDir()
process.env.DONGXUELIAN_AI_DATA_DIR = cascadeTestData.dataDir
process.env.DONGXUELIAN_DEFAULT_ADMIN_IDS = '100000000,200000000'
process.on('exit', () => {
  try { cascadeTestData.cleanup() } catch {}
})

const ROOT = path.resolve(__dirname, '..', '..', '..')
const PKG_ROOT = path.join(ROOT, 'packages')
const AI_ROOT = path.join(PKG_ROOT, 'koishi-plugin-dongxuelian-ai')
const LIB = path.join(AI_ROOT, 'lib')
const HELP = path.join(PKG_ROOT, 'koishi-plugin-dongxuelian-help', 'lib')
const harness = createCascadeHarness(ROOT)
const fixtures = createCascadeFixtures(LIB)

/** Runs cascade domain contracts in their original observable order. */
async function main() {
  const context = {
    fs,
    path,
    dns,
    spawnSync,
    ROOT,
    PKG_ROOT,
    AI_ROOT,
    LIB,
    HELP,
    TEST_ROOT: __dirname,
    ...harness,
    ...fixtures,
  }

  Object.assign(context, await runRepositoryContract(context))
  await runCoverageContract(context)
  Object.assign(context, await runModuleContract(context))
  await runCoreContracts(context)
  await runAiCapabilityContracts(context)
  await runMessageCommandContracts(context)
  await runPersonaContracts(context)
  Object.assign(context, await runRepositoryGuards(context))
  await runOutputMemoryContracts(context)

  const counts = harness.getCounts()
  console.log(`  passed: ${counts.passed}`)
  console.log(`  failed: ${counts.failed}`)
  console.log(`  skipped: ${counts.skipped}`)
  if (counts.skipped > 0) {
    console.log('  note: skipped node syntax subprocess checks are sandbox limitations; run `npm run check` to verify them. setup.sh shell syntax may also skip on Windows without bash/sh.')
  }
  process.exit(counts.failed > 0 ? 1 : 0)
}

main().catch(error => {
  console.error(error && (error.stack || error.message) || error)
  process.exit(1)
})
