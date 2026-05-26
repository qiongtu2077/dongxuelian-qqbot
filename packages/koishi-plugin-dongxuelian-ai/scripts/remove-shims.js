const fs = require('fs')
const path = require('path')

const LIB = path.join(__dirname, '..', 'lib')

// Step 1: Build shim map (shimName → real relative path from lib/)
const shimMap = {}
const shimFiles = []
for (const f of fs.readdirSync(LIB)) {
  if (!f.endsWith('.js')) continue
  const full = path.join(LIB, f)
  if (!fs.statSync(full).isFile()) continue
  const content = fs.readFileSync(full, 'utf8').trim()
  const m = content.match(/^module\.exports\s*=\s*require\('\.\/(.+?)'\)\s*$/)
  if (m) {
    const name = f.replace('.js', '')
    shimMap[name] = m[1] // e.g. 'core/constants'
    shimFiles.push(full)
  }
}

console.log(`Found ${Object.keys(shimMap).length} shims:`)
for (const [name, target] of Object.entries(shimMap)) {
  console.log(`  ${name} → ${target}`)
}

// Step 2: Collect all .js files in lib/ tree (excluding shims themselves)
function collectJs(dir) {
  const results = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') continue
      results.push(...collectJs(full))
    } else if (entry.name.endsWith('.js') && !shimFiles.includes(full)) {
      results.push(full)
    }
  }
  return results
}

const allFiles = collectJs(LIB)
console.log(`\nScanning ${allFiles.length} source files...`)

// Step 3: For each file, find require('.../<shimName>') and replace
let totalReplacements = 0
const changes = []

for (const file of allFiles) {
  let src = fs.readFileSync(file, 'utf8')
  let modified = false
  const fileDir = path.dirname(file)

  // Match require('./xxx') or require('../xxx') etc where xxx could be a shim
  const newSrc = src.replace(/require\('(\.[^']+)'\)/g, (match, reqPath) => {
    // Resolve what this require points to
    const resolved = path.resolve(fileDir, reqPath)
    const resolvedRel = path.relative(LIB, resolved).replace(/\\/g, '/')

    // Check if it's a shim
    if (shimMap[resolvedRel]) {
      // Build new path: from fileDir to LIB/shimMap[resolvedRel]
      const realTarget = path.join(LIB, shimMap[resolvedRel])
      let newRel = path.relative(fileDir, realTarget).replace(/\\/g, '/')
      if (!newRel.startsWith('.')) newRel = './' + newRel
      totalReplacements++
      modified = true
      changes.push(`  ${path.relative(LIB, file)}: require('${reqPath}') → require('${newRel}')`)
      return `require('${newRel}')`
    }
    return match
  })

  if (modified) {
    fs.writeFileSync(file, newSrc, 'utf8')
  }
}

console.log(`\n${totalReplacements} require paths updated across ${changes.length ? new Set(changes.map(c => c.split(':')[0].trim())).size : 0} files`)
if (changes.length <= 100) {
  console.log('\nAll changes:')
  changes.forEach(c => console.log(c))
} else {
  console.log(`\nFirst 50 changes:`)
  changes.slice(0, 50).forEach(c => console.log(c))
  console.log(`  ... and ${changes.length - 50} more`)
}

// Step 4: Delete shim files (dry run first - comment out to execute)
const DRY_RUN = process.argv.includes('--dry-run')
if (DRY_RUN) {
  console.log(`\nDRY RUN: would delete ${shimFiles.length} shim files`)
} else {
  console.log(`\nDeleting ${shimFiles.length} shim files...`)
  for (const f of shimFiles) {
    fs.unlinkSync(f)
    console.log(`  deleted ${path.relative(LIB, f)}`)
  }
}

console.log('\nDone!')
