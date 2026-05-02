const { runScenarioTests } = require('./scenarios')

let totalPassed = 0
let totalFailed = 0
let totalSkipped = 0

function section(title) {
  console.log(`\n=== ${title} ===`)
}

function pass(label) {
  totalPassed++
  console.log(`  OK   ${label}`)
}

function fail(label, detail) {
  totalFailed++
  console.log(`  FAIL ${label}${detail ? ': ' + detail : ''}`)
}

function skip(label, detail) {
  totalSkipped++
  console.log(`  SKIP ${label}${detail ? ': ' + detail : ''}`)
}

function check(label, ok, detail) {
  if (ok) pass(label)
  else fail(label, detail)
}

function checkEqual(label, actual, expected) {
  check(label, actual === expected, `expected=${JSON.stringify(expected)} actual=${JSON.stringify(actual)}`)
}

function checkThrows(label, fn, pattern) {
  try {
    fn()
    fail(label, 'did not throw')
  } catch (error) {
    const msg = String(error && error.message || error)
    check(label, pattern ? pattern.test(msg) : true, msg)
  }
}

async function main() {
  await runScenarioTests({ section, pass, fail, skip, check, checkEqual, checkThrows })
  section('scenario summary')
  console.log(`  passed: ${totalPassed}`)
  console.log(`  failed: ${totalFailed}`)
  console.log(`  skipped: ${totalSkipped}`)
  if (totalSkipped > 0) {
    console.log('  note: setup.sh simulation skips when bash/sh is unavailable; run on Linux/Git Bash/WSL for shell-path coverage.')
  }
  process.exit(totalFailed > 0 ? 1 : 0)
}

main().catch(error => {
  console.error(error && error.stack || error)
  process.exit(1)
})
