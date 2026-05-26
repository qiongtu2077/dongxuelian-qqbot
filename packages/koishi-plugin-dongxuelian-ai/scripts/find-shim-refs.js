const path = require('path')
const fs = require('fs')
const LIB = path.join(__dirname, '..', 'lib')

const shims = new Set()
for (const f of fs.readdirSync(LIB)) {
  if (!f.endsWith('.js')) continue
  const full = path.join(LIB, f)
  if (!fs.statSync(full).isFile()) continue
  const content = fs.readFileSync(full, 'utf8').trim()
  if (/^module\.exports\s*=\s*require\('\.\//.test(content)) shims.add(f.replace('.js', ''))
}

console.log(`${shims.size} shims found`)

function scan(dir) {
  let found = 0
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) { if (entry.name !== 'node_modules') found += scan(full); continue }
    if (!entry.name.endsWith('.js')) continue
    const relFile = path.relative(LIB, full).split(path.sep).join('/')
    if (!relFile.includes('/') && shims.has(entry.name.replace('.js', ''))) continue
    const src = fs.readFileSync(full, 'utf8')
    for (const m of src.matchAll(/require\('(\.[^']+)'\)/g)) {
      const resolved = path.relative(LIB, path.resolve(dir, m[1])).split(path.sep).join('/')
      if (shims.has(resolved)) {
        console.log(`${relFile}: require('${m[1]}') -> shim "${resolved}"`)
        found++
      }
    }
  }
  return found
}

const total = scan(LIB)
console.log(`\nTotal: ${total} references to shims found`)
