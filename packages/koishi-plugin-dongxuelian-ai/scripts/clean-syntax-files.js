const fs = require('fs')
const path = require('path')

const LIB = path.join(__dirname, '..', 'lib')
const testFile = path.join(__dirname, '..', 'test', 'cascade-test.js')
const src = fs.readFileSync(testFile, 'utf8')

// Find syntaxFiles array - it's built with path.join calls
// Pattern: const syntaxFiles = [...].map(...) or similar
// Actually let's look for the pattern

const lines = src.split('\n')
let syntaxStart = -1
let syntaxEnd = -1

for (let i = 0; i < lines.length; i++) {
  if (lines[i].includes('const syntaxFiles = [')) {
    syntaxStart = i
  }
  if (syntaxStart >= 0 && syntaxEnd < 0 && lines[i].trim().startsWith(']')) {
    syntaxEnd = i
    break
  }
}

if (syntaxStart < 0) {
  // Maybe it's a single-line array or uses a different pattern
  // Search for syntaxFiles assignment
  for (let i = 0; i < lines.length; i++) {
    if (/syntaxFiles\s*=/.test(lines[i]) && !lines[i].includes('syntaxFileSet')) {
      console.log(`Found syntaxFiles at line ${i + 1}: ${lines[i].substring(0, 100)}...`)
    }
  }
  console.log('Could not find multi-line syntaxFiles array')
} else {
  console.log(`syntaxFiles spans lines ${syntaxStart + 1} to ${syntaxEnd + 1}`)

  // Extract entries - they're path.join(LIB, 'xxx.js') or path.join(LIB, 'subdir', 'xxx.js')
  const block = lines.slice(syntaxStart, syntaxEnd + 1).join('\n')
  const entries = [...block.matchAll(/path\.join\(LIB,\s*([^)]+)\)/g)]

  console.log(`Found ${entries.length} entries`)

  let removed = 0
  const newLines = []
  for (let i = syntaxStart; i <= syntaxEnd; i++) {
    const line = lines[i]
    // Check if this line has a path.join that references a non-existent file
    const m = line.match(/path\.join\(LIB,\s*([^)]+)\)/)
    if (m) {
      // Parse the path segments
      const segments = m[1].split(',').map(s => s.trim().replace(/^'|'$/g, ''))
      const filePath = path.join(LIB, ...segments)
      if (!fs.existsSync(filePath)) {
        console.log(`  REMOVING: ${segments.join('/')}`)
        removed++
        continue
      }
    }
    newLines.push(line)
  }

  console.log(`\nRemoved ${removed} entries from syntaxFiles`)

  // Rebuild file
  const result = [...lines.slice(0, syntaxStart), ...newLines, ...lines.slice(syntaxEnd + 1)]
  fs.writeFileSync(testFile, result.join('\n'), 'utf8')
  console.log('Written successfully')
}
