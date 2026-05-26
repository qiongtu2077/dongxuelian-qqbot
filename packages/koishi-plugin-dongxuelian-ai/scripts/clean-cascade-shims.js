const fs = require('fs')
const path = require('path')

const testFile = path.join(__dirname, '..', 'test', 'cascade-test.js')
const lines = fs.readFileSync(testFile, 'utf8').split('\n')

const removedLines = []
const kept = []

for (let i = 0; i < lines.length; i++) {
  const line = lines[i]
  const lineNum = i + 1
  let remove = false

  // Remove modPaths entries with "Shim:" in key
  if (/^\s+\w+Shim:\s*path\.join\(LIB,/.test(line)) {
    remove = true
  }

  // Remove *ShimSrc declarations
  if (/^\s+const\s+\w+ShimSrc\s*=\s*read\(/.test(line)) {
    remove = true
  }

  // Remove shim forward guard checks
  if (/^\s+check\('[^']*shim forwards to/.test(line)) {
    remove = true
  }

  // Remove the constantsShimSrc in section 12 (line ~3749)
  if (/^\s+const\s+constantsShimSrc\s*=/.test(line)) {
    remove = true
  }

  if (remove) {
    removedLines.push(`${lineNum}: ${line.trim()}`)
  } else {
    kept.push(line)
  }
}

console.log(`Removed ${removedLines.length} lines`)
console.log(`File: ${lines.length} → ${kept.length} lines`)

// Show first 20 removals
console.log('\nFirst 20 removed:')
removedLines.slice(0, 20).forEach(l => console.log('  ' + l))
if (removedLines.length > 20) console.log(`  ... and ${removedLines.length - 20} more`)

// Also remove the duplicateScanFiles entries for shim files (root-level .js that no longer exist)
// The duplicateScanFiles array has pairs like 'constants.js', 'core/constants.js' - remove the root ones

// Write back
fs.writeFileSync(testFile, kept.join('\n'), 'utf8')
console.log('\nFile written successfully')
