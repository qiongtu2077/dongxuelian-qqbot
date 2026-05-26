const fs = require('fs')
const path = require('path')

const testFile = path.join(__dirname, '..', 'test', 'cascade-test.js')
const lines = fs.readFileSync(testFile, 'utf8').split('\n')

const kept = []
let skipUntilCloseBracket = false
let removedCount = 0

for (let i = 0; i < lines.length; i++) {
  const line = lines[i]

  // If we're in skip mode (inside a *Shim: [...] block), skip until we find the closing ],
  if (skipUntilCloseBracket) {
    removedCount++
    if (/^\s*\],?\s*$/.test(line)) {
      skipUntilCloseBracket = false
    }
    continue
  }

  // Detect start of a *Shim: [ block in expectedExports
  if (/^\s+\w+Shim:\s*\[/.test(line)) {
    removedCount++
    // Check if it's a single-line entry like `fooShim: ['bar'],`
    if (/\],?\s*$/.test(line)) {
      // Single line, already consumed
    } else {
      skipUntilCloseBracket = true
    }
    continue
  }

  kept.push(line)
}

console.log(`Removed ${removedCount} more lines (expectedExports shim entries)`)
console.log(`File: ${lines.length} → ${kept.length} lines`)

fs.writeFileSync(testFile, kept.join('\n'), 'utf8')
console.log('Written successfully')
