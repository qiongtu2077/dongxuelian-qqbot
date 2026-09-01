'use strict'

const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')

/** Creates the shared assertion, file, syntax, and Git helpers for cascade suites. */
function createCascadeHarness(root) {
  let passed = 0
  let failed = 0
  let skipped = 0

  /** Prints a named cascade section. */
  function section(title) {
    console.log(`\n=== ${title} ===`)
  }

  /** Records one passing assertion. */
  function pass(label) {
    passed += 1
    console.log(`  OK   ${label}`)
  }

  /** Records one failing assertion with optional detail. */
  function fail(label, detail) {
    failed += 1
    console.log(`  FAIL ${label}${detail ? ': ' + detail : ''}`)
  }

  /** Records one skipped assertion with its environment reason. */
  function skip(label, detail) {
    skipped += 1
    console.log(`  SKIP ${label}${detail ? ': ' + detail : ''}`)
  }

  /** Records a boolean assertion. */
  function check(label, ok, detail) {
    if (ok) pass(label)
    else fail(label, detail)
  }

  /** Records a strict equality assertion. */
  function checkEqual(label, actual, expected) {
    check(label, actual === expected, `expected=${JSON.stringify(expected)} actual=${JSON.stringify(actual)}`)
  }

  /** Records a string containment assertion. */
  function checkIncludes(label, value, needle) {
    check(label, String(value).includes(needle), `missing ${JSON.stringify(needle)} in ${JSON.stringify(String(value).slice(0, 160))}`)
  }

  /** Records whether a callback throws the expected error. */
  function checkThrows(label, fn, pattern) {
    try {
      fn()
      fail(label, 'did not throw')
    } catch (error) {
      const message = String(error && error.message || error)
      check(label, pattern ? pattern.test(message) : true, message)
    }
  }

  /** Reads a UTF-8 text fixture. */
  function read(file) {
    return fs.readFileSync(file, 'utf8')
  }

  /** Reads a JSON fixture while tolerating a UTF-8 BOM. */
  function readJson(file) {
    return JSON.parse(read(file).replace(/^\uFEFF/, ''))
  }

  /** Runs Node syntax validation for one JavaScript file. */
  function syntaxCheck(file) {
    const result = spawnSync(process.execPath, ['-c', file], { cwd: root, stdio: 'pipe' })
    if (result.error && result.error.code === 'EPERM') return { skipped: true, reason: 'child process blocked by sandbox' }
    if (result.error) throw result.error
    if (result.status !== 0) {
      const message = String(result.stderr || result.stdout || '').trim()
      throw new Error(message || `node -c exited with ${result.status}`)
    }
    return { skipped: false }
  }

  /** Records a Node syntax validation result. */
  function runSyntaxCheck(label, file) {
    try {
      const result = syntaxCheck(file)
      if (result && result.skipped) skip(label, result.reason)
      else pass(label)
    } catch (error) {
      fail(label, error.message)
    }
  }

  /** Returns whether PATH resolves bash to Windows' WSL launcher rather than a POSIX shell binary. */
  function isWindowsSystemBash() {
    if (process.platform !== 'win32') return false
    const resolution = spawnSync('where.exe', ['bash'], { cwd: root, stdio: 'pipe' })
    if (resolution.status !== 0) return false
    const firstPath = String(resolution.stdout || '').split(/\r?\n/).find(Boolean)
    const systemBash = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'bash.exe')
    return !!firstPath && path.resolve(firstPath).toLowerCase() === path.resolve(systemBash).toLowerCase()
  }

  /** Runs shell syntax validation using the first available shell. */
  function shellSyntaxCheck(file) {
    const blocked = []
    const shellPath = path.relative(root, file).replace(/\\/g, '/') || file
    for (const shell of ['bash', 'sh']) {
      const result = spawnSync(shell, ['-n', shellPath], { cwd: root, stdio: 'pipe' })
      if (result.error && (result.error.code === 'ENOENT' || result.error.code === 'UNKNOWN')) continue
      if (result.error && result.error.code === 'EPERM') { blocked.push(shell); continue }
      if (result.error) throw result.error
      if (result.status !== 0) {
        // Windows Bash can emit its WSL service error as UTF-16LE; this means no shell is available, not invalid script syntax.
        const message = [result.stderr, result.stdout].filter(Boolean).map(rawOutput => Buffer.isBuffer(rawOutput)
          ? `${rawOutput.toString('utf8')}\n${rawOutput.toString('utf16le')}`
          : String(rawOutput)).join('\n').trim()
        // A real Bash syntax failure reports a diagnostic; Windows' unavailable WSL shim returns an empty non-zero result.
        if (message.includes('HCS_E_CONNECTION_TIMEOUT') || (shell === 'bash' && isWindowsSystemBash())) continue
        throw new Error(message || `${shell} -n exited with ${result.status}`)
      }
      return { skipped: false, shell }
    }
    if (blocked.length) return { skipped: true, reason: `${blocked.join('/')} blocked by sandbox` }
    return { skipped: true, reason: 'setup shell syntax check requires bash/sh' }
  }

  /** Records a shell syntax validation result. */
  function runShellSyntaxCheck(label, file) {
    try {
      const result = shellSyntaxCheck(file)
      if (result && result.skipped) skip(label, result.reason)
      else pass(`${label} (${result.shell} -n)`)
    } catch (error) {
      fail(label, error.message)
    }
  }

  /** Checks whether Git ignores a repository-relative path. */
  function gitCheckIgnored(relativePath) {
    const result = spawnSync('git', ['check-ignore', '-q', relativePath], { cwd: root, stdio: 'pipe' })
    if (result.error) return null
    return result.status === 0
  }

  /** Lists tracked repository files using normalized relative paths. */
  function gitTrackedFiles() {
    const result = spawnSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' })
    if (result.error || result.status !== 0) return []
    return String(result.stdout || '').split(/\r?\n/).filter(Boolean)
  }

  /** Returns the current assertion totals without exposing mutable counters. */
  function getCounts() {
    return { passed, failed, skipped }
  }

  return {
    section, pass, fail, skip, check, checkEqual, checkIncludes, checkThrows,
    read, readJson, runSyntaxCheck, runShellSyntaxCheck, gitCheckIgnored, gitTrackedFiles,
    getCounts,
  }
}

module.exports = { createCascadeHarness }
