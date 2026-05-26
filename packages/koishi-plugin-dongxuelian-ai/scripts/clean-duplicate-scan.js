const fs = require('fs')
const path = require('path')

const LIB = path.join(__dirname, '..', 'lib')
const testFile = path.join(__dirname, '..', 'test', 'cascade-test.js')
const src = fs.readFileSync(testFile, 'utf8')

// Extract the duplicateScanFiles array
const match = src.match(/const duplicateScanFiles = \[([^\]]+)\]/)
if (!match) { console.error('Could not find duplicateScanFiles'); process.exit(1) }

const entries = match[1].split(',').map(s => s.trim().replace(/^'|'$/g, ''))
console.log(`Found ${entries.length} entries in duplicateScanFiles`)

// Filter to only files that exist
const existing = entries.filter(f => {
  const full = path.join(LIB, f)
  if (fs.existsSync(full)) return true
  console.log(`  REMOVING (not found): ${f}`)
  return false
})

console.log(`\nKept ${existing.length} entries, removed ${entries.length - existing.length}`)

// Rebuild the array string
const newArray = `const duplicateScanFiles = [${existing.map(f => `'${f}'`).join(', ')}]`

// Replace in source
const newSrc = src.replace(/const duplicateScanFiles = \[[^\]]+\]/, newArray)
fs.writeFileSync(testFile, newSrc, 'utf8')
console.log('Written successfully')
