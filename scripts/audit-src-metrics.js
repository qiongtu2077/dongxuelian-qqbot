#!/usr/bin/env node
const fs = require('fs')
const path = require('path')
const Module = require('module')
const { execFileSync } = require('child_process')
const ts = require('typescript')

const ROOT = path.resolve(__dirname, '..')
const SOURCE_EXTS = new Set(['.ts', '.tsx', '.js', '.jsx', '.vue'])
const BUILTIN_MODULES = new Set(
  Module.builtinModules.flatMap((name) => (name.startsWith('node:') ? [name, name.slice(5)] : [name, `node:${name}`])),
)

const TYPE_ESCAPE_PATTERNS = {
  asUnknownAs: /as\s+unknown\s+as/g,
  typedRecordUnknown: /:\s*Record<string,\s*unknown>/g,
  typedUnknownArray: /:\s*unknown\[\]/g,
  anyType: /:\s*any\b/g,
  asAny: /as\s+any\b/g,
  extendsRecordUnknown: /extends\s+Record<string,\s*unknown>/g,
  typeAliasRecordUnknown: /type\s+[A-Za-z_$][\w$]*\s*=\s*Record<string,\s*unknown>/g,
  asRecordUnknown: /as\s+Record<string,\s*unknown>/g,
  promiseRecordUnknown: /Promise<Record<string,\s*unknown>>/g,
  arrayUnknown: /\bArray<unknown>/g,
  readonlyArrayUnknown: /\bReadonlyArray<unknown>/g,
}

function normalizeRel(relPath) {
  return relPath.replace(/\\/g, '/')
}

function isTrackedSourceFile(relPath) {
  if (!relPath.startsWith('packages/')) return false
  if (!relPath.includes('/src/')) return false
  if (/^packages\/[^/]+\/(?:lib|dist|test|__tests__)\//.test(relPath)) return false
  const ext = path.extname(relPath).toLowerCase()
  if (!SOURCE_EXTS.has(ext)) return false
  if (/\.d\.ts$/i.test(relPath)) return false
  return true
}

function listSourceFiles() {
  const output = execFileSync('git', ['ls-files', '--', 'packages'], { cwd: ROOT, encoding: 'utf8' })
  return output
    .split(/\r?\n/)
    .map(normalizeRel)
    .filter(Boolean)
    .filter(isTrackedSourceFile)
    .sort()
}

function getSourceRoot(relPath) {
  const parts = normalizeRel(relPath).split('/')
  if (parts.length >= 4 && parts[0] === 'packages') {
    if (parts[2] === 'frontend' && parts[3] === 'src') return parts.slice(0, 4).join('/')
    const srcIndex = parts.indexOf('src')
    if (srcIndex >= 0) return parts.slice(0, srcIndex + 1).join('/')
  }
  return ''
}

function pluginOnly(relPath) {
  const parts = normalizeRel(relPath).split('/')
  return parts[0] === 'packages' && /^koishi-plugin-/.test(parts[1] || '')
}

function getScopeClass(relPath) {
  if (/^packages\/koishi-plugin-[^/]+\/frontend\/src\//.test(relPath)) return 'plugin_frontend_src'
  if (/^packages\/koishi-plugin-[^/]+\/src\//.test(relPath)) return 'plugin_root_src'
  if (/^packages\/[^/]+\/frontend\/src\//.test(relPath)) return 'non_plugin_frontend_src'
  return 'non_plugin_src'
}

function readFile(relPath) {
  return fs.readFileSync(path.join(ROOT, relPath), 'utf8')
}

function extractVueScript(raw) {
  if (!/<script\b/i.test(raw)) return { text: '', lineMap: [] }
  const pieces = []
  const lineMap = []
  const re = /<script\b[^>]*>([\s\S]*?)<\/script>/gi
  let match = null
  while ((match = re.exec(raw))) {
    const block = match[1] || ''
    const contentStart = match.index + match[0].indexOf(block)
    const startLine = raw.slice(0, contentStart).split(/\r?\n/).length
    if (pieces.length) {
      pieces.push('\n')
      lineMap.push(0)
    }
    pieces.push(block)
    const blockLines = block.split(/\r?\n/)
    for (let i = 0; i < blockLines.length; i++) lineMap.push(startLine + i)
  }
  return { text: pieces.join(''), lineMap }
}

function createSource(relPath) {
  const raw = readFile(relPath)
  const ext = path.extname(relPath).toLowerCase()
  let text = raw
  let kind = ts.ScriptKind.TS
  let lineMap = null
  if (ext === '.vue') {
    const extracted = extractVueScript(raw)
    text = extracted.text
    lineMap = extracted.lineMap
    kind = ts.ScriptKind.TS
  } else if (ext === '.tsx') {
    kind = ts.ScriptKind.TSX
  } else if (ext === '.jsx') {
    kind = ts.ScriptKind.JSX
  } else if (ext === '.js') {
    kind = ts.ScriptKind.JS
  }
  return {
    relPath,
    raw,
    text,
    lineMap,
    source: ts.createSourceFile(relPath, text, ts.ScriptTarget.Latest, true, kind),
  }
}

function lineAndColumnOf(meta, node) {
  const loc = meta.source.getLineAndCharacterOfPosition(node.getStart(meta.source))
  const rawLine = meta.lineMap && meta.lineMap[loc.line] ? meta.lineMap[loc.line] : loc.line + 1
  return { line: rawLine, column: loc.character + 1 }
}

function lineOf(meta, node) {
  return lineAndColumnOf(meta, node).line
}

function textOf(meta, node) {
  return node.getText(meta.source).replace(/\s+/g, ' ').slice(0, 200)
}

function resolveRelativeImport(relPath, specifier) {
  if (!specifier.startsWith('.')) return ''
  const base = path.resolve(ROOT, path.dirname(relPath), specifier)
  const candidates = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.js`,
    `${base}.jsx`,
    `${base}.vue`,
    path.join(base, 'index.ts'),
    path.join(base, 'index.tsx'),
    path.join(base, 'index.js'),
    path.join(base, 'index.jsx'),
    path.join(base, 'index.vue'),
  ]
  for (const candidate of candidates) {
    if (!fs.existsSync(candidate)) continue
    const rel = normalizeRel(path.relative(ROOT, candidate))
    if (!isTrackedSourceFile(rel)) continue
    return rel
  }
  return ''
}

function lookupStringBinding(bindings, name, pos) {
  const items = bindings.get(name)
  if (!items || !items.length) return null
  for (let i = items.length - 1; i >= 0; i--) {
    if (items[i].pos <= pos) return items[i].value
  }
  return null
}

function resolveStaticString(node, bindings, pos = node.pos) {
  if (ts.isStringLiteralLike(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text
  if (ts.isParenthesizedExpression(node)) return resolveStaticString(node.expression, bindings, pos)
  if (ts.isIdentifier(node)) return lookupStringBinding(bindings, node.text, pos)
  if (ts.isTemplateExpression(node)) {
    let text = node.head.text
    for (const span of node.templateSpans) {
      const expr = resolveStaticString(span.expression, bindings, pos)
      if (typeof expr !== 'string') return null
      text += expr + span.literal.text
    }
    return text
  }
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = resolveStaticString(node.left, bindings, pos)
    const right = resolveStaticString(node.right, bindings, pos)
    if (typeof left === 'string' && typeof right === 'string') return left + right
  }
  return null
}

function collectStaticStringBindings(meta) {
  const bindings = new Map()
  const visit = (node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const value = resolveStaticString(node.initializer, bindings, node.pos)
      if (typeof value === 'string') {
        if (!bindings.has(node.name.text)) bindings.set(node.name.text, [])
        bindings.get(node.name.text).push({ pos: node.pos, value })
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(meta.source)
  return bindings
}

function classifyStaticSpecifier(specifier, inTryBlock) {
  if (BUILTIN_MODULES.has(specifier)) return { category: 'builtin-lazy', specifier }
  if (specifier.includes('koishi-plugin-dongxuelian-ai/lib/')) return { category: 'cross-package-deep-path', specifier }
  if (specifier.startsWith('.')) return { category: 'relative-lazy', specifier }
  if (inTryBlock) return { category: 'optional-dependency', specifier }
  return { category: 'package-runtime', specifier }
}

function isPathJoinAiLibCall(node) {
  return (
    ts.isCallExpression(node)
    && ts.isPropertyAccessExpression(node.expression)
    && ts.isIdentifier(node.expression.expression)
    && node.expression.expression.text === 'path'
    && node.expression.name.text === 'join'
    && node.arguments.length >= 2
    && ts.isIdentifier(node.arguments[0])
    && node.arguments[0].text === 'AI_LIB'
  )
}

function isGetAiResourceLibPathCall(node) {
  return (
    ts.isCallExpression(node)
    && ts.isIdentifier(node.expression)
    && node.expression.text === 'getAiResourceLibPath'
    && node.arguments.length >= 1
  )
}

function getRequireCategory(arg, bindings, inTryBlock) {
  const resolved = resolveStaticString(arg, bindings, arg.pos)
  if (typeof resolved === 'string') {
    return {
      ...classifyStaticSpecifier(resolved, inTryBlock),
      argumentKind: ts.SyntaxKind[arg.kind],
      detail: 'resolved-static-string',
    }
  }
  if (isPathJoinAiLibCall(arg)) {
    return {
      category: 'dynamic-expression',
      specifier: '',
      argumentKind: 'CallExpression',
      detail: 'path.join(AI_LIB, ...)',
    }
  }
  if (isGetAiResourceLibPathCall(arg)) {
    return {
      category: 'dynamic-expression',
      specifier: '',
      argumentKind: 'CallExpression',
      detail: 'getAiResourceLibPath(...)',
    }
  }
  return {
    category: 'dynamic-expression',
    specifier: '',
    argumentKind: ts.SyntaxKind[arg.kind],
    detail: 'unresolved-expression',
  }
}

function getFunctionLikeName(node) {
  if (node.name && ts.isIdentifier(node.name)) return node.name.text
  if (
    (ts.isArrowFunction(node) || ts.isFunctionExpression(node))
    && node.parent
    && ts.isVariableDeclaration(node.parent)
    && ts.isIdentifier(node.parent.name)
  ) {
    return node.parent.name.text
  }
  return null
}

function isHelperLikeName(name) {
  return /^[a-z_$]/.test(name)
}

function hasExportModifier(node) {
  return !!(node.modifiers && node.modifiers.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword || modifier.kind === ts.SyntaxKind.DefaultKeyword))
}

function isExportedDeclaration(node) {
  if (hasExportModifier(node)) return true
  if (
    ts.isVariableDeclaration(node)
    && node.parent
    && node.parent.parent
    && ts.isVariableStatement(node.parent.parent)
  ) {
    return hasExportModifier(node.parent.parent)
  }
  return false
}

function detectCycles(filesMap) {
  const state = new Map()
  const stack = []
  const cycles = []

  const visit = (file) => {
    const mark = state.get(file) || 0
    if (mark === 1) {
      const start = stack.indexOf(file)
      cycles.push(stack.slice(start).concat(file))
      return
    }
    if (mark === 2) return
    state.set(file, 1)
    stack.push(file)
    for (const dep of filesMap.get(file) || []) visit(dep)
    stack.pop()
    state.set(file, 2)
  }

  for (const file of filesMap.keys()) visit(file)
  return {
    fileCount: filesMap.size,
    cycleCount: cycles.length,
    sampleCycles: cycles.slice(0, 5),
  }
}

function analyzeDynamicRequire(files) {
  const occurrences = []
  const byCategory = {}
  const byArgumentKind = {}
  const graph = new Map()

  for (const relPath of files) {
    const meta = createSource(relPath)
    const bindings = collectStaticStringBindings(meta)
    const root = getSourceRoot(relPath)
    if (!graph.has(root)) graph.set(root, new Map())
    graph.get(root).set(relPath, new Set())

    const visit = (node, state) => {
      if (ts.isFunctionLike(node)) {
        const functionName = getFunctionLikeName(node) || state.functionName
        ts.forEachChild(node, (child) => {
          if (node.body && child === node.body) {
            visit(child, { ...state, inFunctionBody: true, functionName })
          } else {
            visit(child, { ...state, functionName })
          }
        })
        return
      }

      if (ts.isTryStatement(node)) {
        visit(node.tryBlock, { ...state, inTryBlock: true })
        if (node.catchClause) visit(node.catchClause, state)
        if (node.finallyBlock) visit(node.finallyBlock, state)
        return
      }

      if (
        state.inFunctionBody
        && ts.isCallExpression(node)
        && ts.isIdentifier(node.expression)
        && node.expression.text === 'require'
        && node.arguments.length === 1
      ) {
        const arg = node.arguments[0]
        const classification = getRequireCategory(arg, bindings, state.inTryBlock)
        const loc = lineAndColumnOf(meta, node)
        const item = {
          file: relPath,
          line: loc.line,
          column: loc.column,
          functionName: state.functionName || null,
          category: classification.category,
          specifier: classification.specifier,
          argumentKind: classification.argumentKind,
          detail: classification.detail,
          argumentText: textOf(meta, arg),
        }
        occurrences.push(item)
        byCategory[item.category] = (byCategory[item.category] || 0) + 1
        byArgumentKind[item.argumentKind] = (byArgumentKind[item.argumentKind] || 0) + 1
      }

      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'require' && node.arguments.length === 1) {
        const arg = node.arguments[0]
        if (ts.isStringLiteralLike(arg)) {
          const resolved = resolveRelativeImport(relPath, arg.text)
          const currentRoot = getSourceRoot(relPath)
          if (resolved && currentRoot && getSourceRoot(resolved) === currentRoot) {
            graph.get(currentRoot).get(relPath).add(resolved)
          }
        }
      }

      if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
        const specifier = node.moduleSpecifier
        if (specifier && ts.isStringLiteralLike(specifier)) {
          const resolved = resolveRelativeImport(relPath, specifier.text)
          const currentRoot = getSourceRoot(relPath)
          if (resolved && currentRoot && getSourceRoot(resolved) === currentRoot) {
            graph.get(currentRoot).get(relPath).add(resolved)
          }
        }
      }

      ts.forEachChild(node, (child) => visit(child, state))
    }

    visit(meta.source, { inFunctionBody: false, inTryBlock: false, functionName: null })
  }

  const cycles = {}
  for (const [root, filesMap] of graph.entries()) {
    cycles[root] = detectCycles(filesMap)
  }

  return {
    scope: 'packages/**/src/**/*.{ts,js,tsx,jsx,vue}',
    totalFunctionRequires: occurrences.length,
    byCategory,
    byArgumentKind,
    occurrences,
    staticCycles: cycles,
  }
}

function buildHelperOccurrence(relPath, meta, nameNode, declKind, strictEligible, bucket) {
  const name = nameNode.getText(meta.source)
  if (!isHelperLikeName(name)) return null
  const loc = lineAndColumnOf(meta, nameNode)
  return {
    id: `${relPath}:${loc.line}:${loc.column}:${name}`,
    name,
    declKind,
    file: relPath,
    line: loc.line,
    column: loc.column,
    scopeClass: getScopeClass(relPath),
    pluginOnly: pluginOnly(relPath),
    bucket,
    viewTags: strictEligible ? ['wide', 'strict'] : ['wide'],
  }
}

function analyzeDuplicateHelpers(files) {
  const occurrences = []

  for (const relPath of files) {
    const meta = createSource(relPath)
    const visit = (node, state) => {
      if (ts.isFunctionDeclaration(node) && node.name && node.body) {
        const item = isExportedDeclaration(node)
          ? null
          : buildHelperOccurrence(relPath, meta, node.name, 'function_declaration', state.moduleLevel, 'unreviewed_same_name')
        if (item) occurrences.push(item)
      }
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
        if (ts.isArrowFunction(node.initializer)) {
          const item = isExportedDeclaration(node)
            ? null
            : buildHelperOccurrence(relPath, meta, node.name, 'arrow_function_variable', state.moduleLevel, 'unreviewed_same_name')
          if (item) occurrences.push(item)
        } else if (ts.isFunctionExpression(node.initializer)) {
          const item = isExportedDeclaration(node)
            ? null
            : buildHelperOccurrence(relPath, meta, node.name, 'function_expression_variable', state.moduleLevel, 'unreviewed_same_name')
          if (item) occurrences.push(item)
        }
      }

      if (ts.isFunctionLike(node)) {
        ts.forEachChild(node, (child) => {
          if (node.body && child === node.body) visit(child, { moduleLevel: false })
          else visit(child, state)
        })
        return
      }

      ts.forEachChild(node, (child) => visit(child, state))
    }

    visit(meta.source, { moduleLevel: true })
  }

  const wideSameNamePool = summarizeOccurrenceGroups(occurrences, 'wide')
  const strictHelperBaseline = summarizeOccurrenceGroups(occurrences, 'strict')

  return {
    scope: 'packages/**/src/**/*.{ts,tsx,vue}',
    summary: {
      wide_all_groups: wideSameNamePool.allGroupCount,
      wide_plugin_groups: wideSameNamePool.pluginOnlyGroupCount,
      strict_all_groups: strictHelperBaseline.allGroupCount,
      strict_plugin_groups: strictHelperBaseline.pluginOnlyGroupCount,
    },
    occurrences,
    wideSameNamePool,
    strictHelperBaseline,
    wide: wideSameNamePool,
    strict: strictHelperBaseline,
  }
}

function summarizeOccurrenceGroups(occurrences, viewTag) {
  const grouped = new Map()
  for (const item of occurrences) {
    if (!item.viewTags.includes(viewTag)) continue
    if (!grouped.has(item.name)) grouped.set(item.name, [])
    grouped.get(item.name).push(item)
  }
  const groups = Array.from(grouped.entries())
    .filter(([, items]) => items.length > 1)
    .map(([name, items]) => ({
      name,
      occurrences: items.length,
      pluginOnly: items.every((item) => item.pluginOnly),
      files: Array.from(new Set(items.map((item) => item.file))).sort(),
      bucket: items.every((item) => item.bucket === items[0].bucket) ? items[0].bucket : 'mixed',
      memberIds: items.map((item) => item.id),
      items: items
        .slice()
        .sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.column - b.column),
    }))
    .sort((a, b) => b.occurrences - a.occurrences || a.name.localeCompare(b.name))

  return {
    allGroupCount: groups.length,
    pluginOnlyGroupCount: groups.filter((group) => group.pluginOnly).length,
    groups,
  }
}

function analyzeTypeEscape(files) {
  const summary = {}
  const evidence = {}
  for (const [label, pattern] of Object.entries(TYPE_ESCAPE_PATTERNS)) {
    const matches = []
    for (const relPath of files) {
      const { raw } = createSource(relPath)
      const lines = raw.split(/\r?\n/)
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]
        pattern.lastIndex = 0
        let count = 0
        while (pattern.exec(line)) count++
        if (count) matches.push({ file: relPath, line: i + 1, count, text: line.trim().slice(0, 200) })
      }
    }
    summary[label] = {
      lineCount: matches.reduce((sum, item) => sum + item.count, 0),
      fileCount: new Set(matches.map((item) => item.file)).size,
    }
    evidence[label] = matches.slice(0, 40)
  }
  return { scope: 'packages/*/src + packages/*/frontend/src', summary, evidence }
}

function classifyCatchBlock(meta, node) {
  const blockText = meta.text.slice(node.block.getStart(meta.source), node.block.end)
  const inner = blockText.replace(/^\{/, '').replace(/\}$/, '').trim()
  return inner ? 'comment-only' : 'empty'
}

function analyzeConsoleMisc(files) {
  const consoleHits = []
  const todoHits = []
  const emptyCatchHits = []
  const commentOnlyCatchHits = []
  const byLevel = {}

  for (const relPath of files) {
    const meta = createSource(relPath)
    const lines = meta.raw.split(/\r?\n/)
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      const consoleMatch = line.match(/\bconsole\.(log|info|warn|error|debug|trace)\s*\(/)
      if (consoleMatch) {
        const level = consoleMatch[1]
        byLevel[level] = (byLevel[level] || 0) + 1
        consoleHits.push({ file: relPath, line: i + 1, level, text: line.trim().slice(0, 200) })
      }
      if (/\b(?:TODO|FIXME)\b/.test(line)) {
        todoHits.push({ file: relPath, line: i + 1, text: line.trim().slice(0, 200) })
      }
    }

    const visit = (node) => {
      if (ts.isCatchClause(node) && node.block && node.block.statements.length === 0) {
        const classification = classifyCatchBlock(meta, node)
        const hit = {
          file: relPath,
          line: lineOf(meta, node),
          text: textOf(meta, node),
        }
        if (classification === 'comment-only') commentOnlyCatchHits.push(hit)
        else emptyCatchHits.push(hit)
      }
      ts.forEachChild(node, visit)
    }
    visit(meta.source)
  }

  return {
    scope: 'packages/**/src/**',
    console: {
      count: consoleHits.length,
      fileCount: new Set(consoleHits.map((item) => item.file)).size,
      byLevel,
      hits: consoleHits.slice(0, 80),
    },
    todoFixme: {
      count: todoHits.length,
      fileCount: new Set(todoHits.map((item) => item.file)).size,
      hits: todoHits.slice(0, 80),
    },
    emptyCatch: {
      count: emptyCatchHits.length,
      fileCount: new Set(emptyCatchHits.map((item) => item.file)).size,
      hits: emptyCatchHits.slice(0, 80),
    },
    commentOnlyCatch: {
      count: commentOnlyCatchHits.length,
      fileCount: new Set(commentOnlyCatchHits.map((item) => item.file)).size,
      hits: commentOnlyCatchHits.slice(0, 80),
    },
  }
}

function analyzeLongFiles(files) {
  const scopedFiles = files.filter((relPath) => /\.(?:ts|js|vue)$/i.test(relPath))
  const hits = []
  for (const relPath of scopedFiles) {
    const { raw } = createSource(relPath)
    const lineCount = raw.split(/\r?\n/).length
    if (lineCount > 500) hits.push({ file: relPath, lineCount, pluginOnly: pluginOnly(relPath) })
  }
  hits.sort((a, b) => b.lineCount - a.lineCount || a.file.localeCompare(b.file))
  return {
    scope: 'packages/**/src + packages/**/frontend/src (.ts/.js/.vue)',
    threshold: 500,
    count: hits.length,
    pluginOnlyCount: hits.filter((item) => item.pluginOnly).length,
    hits,
  }
}

function main() {
  const mode = process.argv[2]
  const files = listSourceFiles()
  const result = {
    mode,
    generatedAt: new Date().toISOString(),
    fileCount: files.length,
  }

  if (mode === 'dynamic-require') Object.assign(result, analyzeDynamicRequire(files))
  else if (mode === 'duplicate-helper') Object.assign(result, analyzeDuplicateHelpers(files))
  else if (mode === 'type-escape') Object.assign(result, analyzeTypeEscape(files))
  else if (mode === 'console-misc') Object.assign(result, analyzeConsoleMisc(files))
  else if (mode === 'long-files') Object.assign(result, analyzeLongFiles(files))
  else {
    console.error('usage: node scripts/audit-src-metrics.js <dynamic-require|duplicate-helper|type-escape|console-misc|long-files>')
    process.exit(2)
  }

  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
}

if (require.main === module) main()
