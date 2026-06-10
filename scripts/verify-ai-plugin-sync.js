#!/usr/bin/env node
'use strict'

const crypto = require('crypto')
const fs = require('fs')
const path = require('path')

const REPO_ROOT = path.resolve(__dirname, '..')
const PACKAGE_NAME = 'koishi-plugin-dongxuelian-ai'
const PACKAGE_DIR = path.join(REPO_ROOT, 'packages', PACKAGE_NAME)
const KEY_FILES = [
  'package.json',
  'lib/resource-workers/task-store.js',
  'lib/resource-workers/result-notifier.js',
  'lib/resource-workers/media-worker.js',
  'lib/resource-scheduler/admission.js',
  'lib/resource-scheduler/resource-snapshot.js',
]

function parseArgs(argv) {
  const options = {}
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--app-dir') options.appDir = String(argv[++i] || '')
    else if (arg === '--json') options.json = true
  }
  return options
}

function hashFile(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

function normalize(file) {
  return path.resolve(file).replace(/\\/g, '/').toLowerCase()
}

function isWithin(file, root) {
  const fileNorm = normalize(file)
  const rootNorm = normalize(root).replace(/\/$/, '')
  return fileNorm === rootNorm || fileNorm.startsWith(`${rootNorm}/`)
}

function realpathSafe(file) {
  try {
    return fs.realpathSync(file)
  } catch {
    return path.resolve(file)
  }
}

function resolveFromApp(appDir, request) {
  return require.resolve(request, { paths: [appDir] })
}

function main() {
  const options = parseArgs(process.argv.slice(2))
  const appDir = path.resolve(
    options.appDir
      || process.env.KOISHI_APP_DIR
      || process.env.KOISHI_DIR
      || REPO_ROOT
  )
  const installedRoot = path.join(appDir, 'node_modules', PACKAGE_NAME)

  const result = {
    appDir,
    packageName: PACKAGE_NAME,
    packageDir: PACKAGE_DIR,
    installedRoot,
    installMode: 'copied',
    checks: [],
    ok: true,
  }

  if (!fs.existsSync(PACKAGE_DIR)) {
    throw new Error(`source package not found: ${PACKAGE_DIR}`)
  }
  if (!fs.existsSync(installedRoot)) {
    throw new Error(`installed package not found: ${installedRoot}`)
  }

  const packageReal = realpathSafe(PACKAGE_DIR)
  const installedReal = realpathSafe(installedRoot)
  const linkedInstall = normalize(packageReal) === normalize(installedReal)
  result.installMode = linkedInstall ? 'linked' : 'copied'

  for (const relativeFile of KEY_FILES) {
    const sourceFile = path.join(PACKAGE_DIR, relativeFile)
    if (!fs.existsSync(sourceFile)) throw new Error(`source file missing: ${sourceFile}`)

    const request = relativeFile === 'package.json'
      ? `${PACKAGE_NAME}/package.json`
      : `${PACKAGE_NAME}/${relativeFile.replace(/\\/g, '/')}`
    const resolvedFile = resolveFromApp(appDir, request)
    const resolvedReal = realpathSafe(resolvedFile)
    const expectedRoot = linkedInstall ? packageReal : installedRoot
    const sourceHash = hashFile(sourceFile)
    const resolvedHash = hashFile(resolvedReal)
    const rootOk = isWithin(resolvedReal, expectedRoot)
    const hashOk = sourceHash === resolvedHash

    result.checks.push({
      file: relativeFile,
      resolvedFile,
      resolvedReal,
      expectedRoot,
      rootOk,
      hashOk,
      sourceHash,
      resolvedHash,
    })
  }

  result.ok = result.checks.every(item => item.rootOk && item.hashOk)

  if (options.json) {
    console.log(JSON.stringify(result, null, 2))
  } else {
    console.log(`[verify-ai-plugin-sync] appDir=${appDir}`)
    console.log(`[verify-ai-plugin-sync] installMode=${result.installMode}`)
    for (const item of result.checks) {
      const status = item.rootOk && item.hashOk ? 'OK' : 'FAIL'
      console.log(`[verify-ai-plugin-sync] ${status} ${item.file}`)
      if (!item.rootOk) console.log(`  resolvedReal=${item.resolvedReal}`)
      if (!item.rootOk) console.log(`  expectedRoot=${item.expectedRoot}`)
      if (!item.hashOk) console.log(`  hashMismatch source=${item.sourceHash} resolved=${item.resolvedHash}`)
    }
  }

  process.exitCode = result.ok ? 0 : 1
}

main()
