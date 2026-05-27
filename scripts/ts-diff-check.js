const { execSync } = require('child_process')
const fs = require('fs')
const path = require('path')
const ts = require('typescript')

const PKG = 'packages/koishi-plugin-dongxuelian-ai'
const TAG = 'pre-ts-migration'
const EXPORT_ASSIGNMENT = /exports\.(\w+)\s*=/
const FORBIDDEN = [/__esModule/, /__awaiter/, /__spreadArray/, /\(0,\s*\w+\.\w+\)/]
const ALLOWED_ADDED_EXPORTS = {
  'core/utils.js': ['safeChannelKey', 'safeUserId', 'legacySafeUserId', 'truncateText', 'readJsonFileSync', 'writeJsonFileSync', 'normalizeText'],
  'agent/queue.js': ['withTimeout'],
}
const ALLOWED_REQUIRE_CHANGES = {
  'agent/auto-memory.js': { added: ['../core/utils'] },
  'agent/context.js': { added: ['../core/utils'] },
  'agent/dream.js': { added: ['../core/utils'] },
  'agent/memory.js': { added: ['../core/utils'] },
  'agent/plan/plan-store.js': { added: ['../../core/utils'] },
  'agent/push.js': { added: ['../core/utils'] },
  'agent/skills/store.js': { added: ['../../core/utils'] },
  'agent/tools/scheduled-task-tools.js': { added: ['../../core/utils'] },
  'agent/tools/web-search.js': { added: ['../queue'] },
  'behavior/expression/expression-abstractor.js': { added: ['../../agent/queue'] },
  'behavior/repeat.js': { removed: ['../message/message-reader'] },
  'chat/agent-chat-bridge.js': { removed: ['../message/message-reader'] },
  'chat/chat-jailbreak-flow.js': { removed: ['../message/message-reader'] },
  'commands/agent-command.js': { removed: ['../agent/skill-hub'] },
  'commands/memory-command.js': {
    removed: [
      '../agent/config', '../agent/config', '../agent/config',
      '../agent/memory', '../agent/memory', '../agent/memory',
    ],
  },
  'conversation.js': { removed: ['./message/message-reader'] },
  'core/utils.js': { added: ['fs', 'fs', 'path'], removed: ['../message/message-reader'] },
  'diagnostics/shared-record-text.js': { removed: ['../message/message-reader'] },
  'media/file/file-store.js': { added: ['../../core/utils'] },
  'media/image/image-store.js': { added: ['../../core/utils'] },
  'message/message-reader.js': { added: ['../core/utils'] },
  'persona/persona-lore-router.js': { added: ['../core/utils'] },
  'persona/persona.js': { added: ['../core/utils'], removed: ['fs', 'fs', 'fs', 'fs'] },
  'routing/group-scene-index.js': { removed: ['../message/message-reader'] },
  'routing/search-context.js': { added: ['../core/utils'], removed: ['../message/message-reader'] },
}

const domain = process.argv[2]
if (!domain) {
  console.error('Usage: node scripts/ts-diff-check.js <domain|--all>')
  process.exit(1)
}

function listCurrentJsFiles(dir, prefix = '') {
  const result = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? path.posix.join(prefix, entry.name) : entry.name
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      result.push(...listCurrentJsFiles(full, rel))
    } else if (entry.isFile() && entry.name.endsWith('.js')) {
      result.push(rel)
    }
  }
  return result.sort()
}

function listBaselineJsFiles() {
  const output = execSync(`git ls-tree -r --name-only ${TAG} ${PKG}/lib`, { encoding: 'utf8' })
  return output
    .split(/\r?\n/)
    .filter(Boolean)
    .filter((file) => file.endsWith('.js'))
    .map((file) => file.slice(`${PKG}/lib/`.length))
    .sort()
}

const libRoot = path.join(PKG, 'lib')
const libTarget = path.join(libRoot, domain)
const libFileTarget = path.join(libRoot, domain.endsWith('.js') ? domain : `${domain}.js`)
const files = domain === '--all'
  ? listCurrentJsFiles(libRoot)
  : fs.existsSync(libTarget) && fs.statSync(libTarget).isDirectory()
    ? fs.readdirSync(libTarget).filter((file) => file.endsWith('.js')).map((file) => path.posix.join(domain, file)).sort()
    : [path.relative(libRoot, libFileTarget).replace(/\\/g, '/')]

let failures = 0
let checked = 0

if (domain === '--all') {
  const currentSet = new Set(files)
  const baselineSet = new Set(listBaselineJsFiles())
  const added = files.filter((file) => !baselineSet.has(file))
  const removed = Array.from(baselineSet).filter((file) => !currentSet.has(file))
  if (added.length) {
    console.error(`FAIL [--all]: new compiled JS files without baseline: ${added.join(', ')}`)
    failures++
  }
  if (removed.length) {
    console.error(`FAIL [--all]: baseline JS files missing from compiled output: ${removed.join(', ')}`)
    failures++
  }
}

for (const file of files) {
  const relPath = `${PKG}/lib/${file}`
  let original
  try {
    original = execSync(`git show ${TAG}:${relPath}`, { encoding: 'utf8' })
  } catch {
    console.error(`FAIL [${file}]: missing baseline artifact in ${TAG}`)
    failures++
    continue
  }

  const compiled = fs.readFileSync(relPath, 'utf8')
  checked++

  if (EXPORT_ASSIGNMENT.test(compiled)) {
    console.error(`FAIL [${file}]: compiled output uses exports.* assignment`)
    failures++
  }

  for (const re of FORBIDDEN) {
    if (re.test(compiled) && !re.test(original)) {
      console.error(`FAIL [${file}]: forbidden pattern added ${re}`)
      failures++
    }
  }

  const doubleQuoteRequires = compiled.match(/require\("[^"]+"\)/g) || []
  const originalDoubleQuotes = original.match(/require\("[^"]+"\)/g) || []
  if (doubleQuoteRequires.length > originalDoubleQuotes.length) {
    console.error(`FAIL [${file}]: new double-quoted require`)
    failures++
  }

  const getRequirePaths = (src) => {
    const paths = []
    const source = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
    const visit = (node) => {
      if (
        ts.isCallExpression(node)
        && ts.isIdentifier(node.expression)
        && node.expression.text === 'require'
        && node.arguments.length === 1
        && ts.isStringLiteralLike(node.arguments[0])
      ) {
        paths.push(node.arguments[0].text)
      }
      ts.forEachChild(node, visit)
    }
    visit(source)
    return paths.sort()
  }

  const diffRequirePaths = (originalPaths, compiledPaths) => {
    const compiledRemaining = compiledPaths.slice()
    const removed = []
    for (const originalPath of originalPaths) {
      const index = compiledRemaining.indexOf(originalPath)
      if (index >= 0) compiledRemaining.splice(index, 1)
      else removed.push(originalPath)
    }
    return { added: compiledRemaining, removed }
  }

  const consumeAllowed = (items, allowed = []) => {
    const remaining = items.slice()
    for (const allowedItem of allowed) {
      const index = remaining.indexOf(allowedItem)
      if (index >= 0) remaining.splice(index, 1)
    }
    return remaining
  }

  const originalRequirePaths = getRequirePaths(original)
  const compiledRequirePaths = getRequirePaths(compiled)
  const requireDiff = diffRequirePaths(originalRequirePaths, compiledRequirePaths)
  const allowedRequireChanges = ALLOWED_REQUIRE_CHANGES[file] || {}
  const unexpectedAddedRequires = consumeAllowed(requireDiff.added, allowedRequireChanges.added)
  const unexpectedRemovedRequires = consumeAllowed(requireDiff.removed, allowedRequireChanges.removed)
  if (unexpectedAddedRequires.length || unexpectedRemovedRequires.length) {
    console.error(`FAIL [${file}]: require paths changed added=[${unexpectedAddedRequires}] removed=[${unexpectedRemovedRequires}]`)
    failures++
  }

  const getExportKeys = (src) => {
    const source = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
    const keys = new Set()

    const collectObjectKeys = (objectLiteral) => {
      for (const prop of objectLiteral.properties) {
        if (ts.isShorthandPropertyAssignment(prop) || ts.isPropertyAssignment(prop) || ts.isMethodDeclaration(prop)) {
          const name = prop.name
          if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
            keys.add(name.text)
          }
        }
      }
    }

    const visit = (node) => {
      if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.FirstAssignment) {
        const left = node.left
        if (
          ts.isPropertyAccessExpression(left)
          && ts.isIdentifier(left.expression)
          && left.expression.text === 'exports'
        ) {
          keys.add(left.name.text)
        }

        if (
          ts.isPropertyAccessExpression(left)
          && ts.isIdentifier(left.name)
          && left.name.text === 'exports'
          && ts.isIdentifier(left.expression)
          && left.expression.text === 'module'
          && ts.isObjectLiteralExpression(node.right)
        ) {
          collectObjectKeys(node.right)
        }

        if (
          ts.isPropertyAccessExpression(left)
          && ts.isPropertyAccessExpression(left.expression)
          && ts.isIdentifier(left.expression.expression)
          && left.expression.expression.text === 'module'
          && ts.isIdentifier(left.expression.name)
          && left.expression.name.text === 'exports'
        ) {
          keys.add(left.name.text)
        }
      }

      ts.forEachChild(node, visit)
    }

    visit(source)
    return Array.from(keys).sort()
  }

  const origKeys = getExportKeys(original)
  const compKeys = getExportKeys(compiled)
  const allowedAdded = new Set(ALLOWED_ADDED_EXPORTS[file] || [])
  const filteredCompKeys = compKeys.filter((key) => origKeys.includes(key) || !allowedAdded.has(key))
  const unexpectedAdded = compKeys.filter((key) => !origKeys.includes(key) && !allowedAdded.has(key))
  const missingKeys = origKeys.filter((key) => !compKeys.includes(key))
  if (missingKeys.length || unexpectedAdded.length || origKeys.join(',') !== filteredCompKeys.join(',')) {
    console.error(`FAIL [${file}]: exports keys changed [${origKeys}] -> [${compKeys}]`)
    failures++
  }
}

if (failures) {
  console.error(`\n${failures} diff checks failed`)
  process.exit(1)
}

console.log(`${domain}: ${checked} files passed artifact checks`)
