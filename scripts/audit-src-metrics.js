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

const PATH_CONFIG_GROUPS = [
  {
    key: 'crossPackagePath',
    label: '跨包内部路径',
    patterns: [
      /koishi-plugin-dongxuelian-ai\/lib/g,
      /getAiResourceLibPath\s*\(/g,
      /const\s+base\s*=\s*['"]\.\.\/\.\.\/koishi-plugin-dongxuelian-ai\/lib['"]/g,
      /path\.join\s*\(\s*AI_LIB\b/g,
    ],
  },
  {
    key: 'envKeyEntry',
    label: '环境变量与密钥入口',
    patterns: [
      /\b(?:KOISHI_DIR|KOISHI_APP_DIR|DONGXUELIAN_AI_DATA_DIR|DASHBOARD_HOST|DASHBOARD_PORT|NAPCAT_TOKEN|X-Admin-Token|ADMIN_PWD_FILE|ACCESS_PWD_FILE|RESET_TOKEN_FILE|KEY_FILE|TOKEN_FILE)\b/g,
      /process\.env\.[A-Z0-9_]+/g,
    ],
  },
  {
    key: 'pathUrlChain',
    label: '路径与 URL 与旧部署链路',
    patterns: [
      /\b(?:127\.0\.0\.1|0\.0\.0\.0|localhost)\b/g,
      /\bhttps?:\/\/[^\s'"`]+/g,
      /\bws:\/\/[^\s'"`]+/g,
      /\bwss:\/\/[^\s'"`]+/g,
      /\bssh\s+/g,
      /\bscp\s+/g,
      /\bgit pull\b/g,
      /\bgit clone\b/g,
      /node_modules\/koishi\/bin\.js start/g,
    ],
  },
  {
    key: 'sensitiveFallback',
    label: '真敏感值兜底',
    patterns: [
      /-----BEGIN [A-Z ]*PRIVATE KEY-----/g,
      /\bsk-[A-Za-z0-9_-]{8,}/g,
      /\bghp_[A-Za-z0-9]{8,}/g,
      /\bcookie\s*:/gi,
      /\btoken\s*:/gi,
      /\b(?:\d{1,3}\.){3}\d{1,3}\b/g,
    ],
  },
]

function makeTypeEscapeClassification(label, relPath, lineText) {
  const normalized = normalizeRel(relPath)
  const text = lineText || ''
  const lower = text.toLowerCase()
  const make = (bucket, action, debt, reason) => ({ bucket, action, debt, reason })

  if (
    /\.\.\.args\s*:\s*unknown\[\]/.test(text)
    || /\b(?:info|warn|error|debug|log)\s*\(\s*\.\.\.args\b/.test(text)
    || /\blogger\s*[:=]/i.test(text)
  ) {
    return make('logger_varargs', 'observe', 'log-boundary', 'logger passthrough varargs boundary; mechanical narrowing has low debt-reduction value')
  }

  if (
    /(?:\/core\/api\.ts|\/reply\/|\/message\/)/.test(normalized)
    || /\b(?:sendGroupMsg|sendPrivateMsg|callOneBot|OneBot|segment|message\??:\s*unknown\[\])\b/.test(text)
    || /\b(?:elements|content)\??:\s*unknown\[\]/.test(text)
  ) {
    return make('koishi_onebot_boundary', 'observe', 'adapter-boundary', 'Koishi/OneBot payload boundary; do not pretend external segment payload is an internal DTO')
  }

  if (
    /\/agent\/tools\//.test(normalized)
    || /\/chat(?:\/|\.ts$)/.test(normalized)
    || /\/routing\/agent-auto-route-flow\.ts$/.test(normalized)
    || /\/(?:handler|index)\.ts$/.test(normalized)
    || /\/agent\/(?:engine|router|context|fetch-reader|http-search|queue|state|cron)\.ts$/.test(normalized)
    || /\b(?:tool_calls|tools|args|parameters|extraBody|requestChatCompletions|callOpenAI|searchContext|configureAgentQueue)\b/.test(text)
  ) {
    if (/\b(?:args|parameters|meta|input|payload)\b/.test(text) && !/\b(?:requestChatCompletions|extraBody|tool_calls)\b/.test(text)) {
      return make('model_tool_boundary', 'fix-candidate', 'type-escape/fake-green', 'parsed tool/chat/routing data should not remain a broad container in the business middle layer')
    }
    return make('model_tool_boundary', 'observe', 'external-json-boundary', 'external model/tool JSON boundary; keep broad until parser/DTO boundary is explicit')
  }

  if (
    /\/resource-(?:workers|scheduler|system)\//.test(normalized)
    || /\/resource-(?:common|gate)\//.test(normalized)
    || /\/daily-precompute\//.test(normalized)
    || /\/media\/backpressure\//.test(normalized)
    || /\b(?:ResourceTask|TaskLike|payload|result|admission|snapshot|budget|worker|Jsonl|GateEvent|appendJsonlEvent|readRecentJsonlEvents|writeGateEvent)\b/.test(text)
  ) {
    return make('task_worker_resource_dto', 'fix-candidate', 'type-escape/fake-green', 'task/resource DTO crosses modules; broad containers can hide signature drift')
  }

  if (/packages\/koishi-plugin-dashboard\/src\/lib\//.test(normalized)) {
    if (/\b(?:status|result|response|config|settings|resource|deploy)\b/i.test(text)) {
      return make('dashboard_backend_bridge', 'fix-candidate', 'type-escape/fake-green', 'dashboard management DTO has a stable local shape or should expose an explicit bridge type')
    }
    return make('dashboard_backend_bridge', 'observe', 'runtime-diagnostic-boundary', 'dashboard diagnostic/runtime blob may stay broad until the source contract is explicit')
  }

  if (/\/media\/(?:file|image|voice)\//.test(normalized)) {
    if (/\b(?:entry|record|metadata|asset|state|store)\b/i.test(text)) {
      return make('media_store_api', 'fix-candidate', 'type-escape/fake-green', 'media store entry/state has stable fields and should not be kept as a broad container')
    }
    return make('media_store_api', 'observe', 'external-media-boundary', 'third-party media/TTS/vision payload boundary')
  }

  if (/\/(?:persona|behavior)\//.test(normalized) || /\b(?:expression|profile|persona|randomReply|sticker)\b/i.test(text)) {
    if (/\b(?:normalize|normalized|profile|entry|state|result)\b/i.test(text)) {
      return make('persona_behavior_persistence', 'fix-candidate', 'type-escape/fake-green', 'normalized persona/behavior object should have an internal shape')
    }
    return make('persona_behavior_persistence', 'observe', 'json-persistence-boundary', 'JSON persistence boundary can stay broad before normalization')
  }

  if (/\/frontend\/src\//.test(normalized) || /packages\/agent-console\/src\//.test(normalized)) {
    if (/\b(?:api|response|result|payload|dto|data)\b/i.test(text)) {
      return make('frontend_dto_ui', 'fix-candidate', 'type-escape/fake-green', 'front-end API data should share or define a response DTO when the backend shape is local')
    }
    return make('frontend_dto_ui', 'observe', 'ui-local-boundary', 'UI local recursion/cursor data can remain broad until a shared DTO exists')
  }

  if (/packages\/koishi-plugin-daily-report\//.test(normalized)) {
    return make('daily_report_bridge', 'observe', 'runtime-bridge', 'daily-report runtime bridge combines external records and plugin data')
  }

  if (/\/mcp\/local-server\.ts$/.test(normalized) || /\b(?:JsonRpc|jsonrpc|writeJsonRpc|properties\??:)\b/i.test(text)) {
    return make('json_rpc_mcp_boundary', 'observe', 'protocol-boundary', 'JSON-RPC/MCP protocol object boundary')
  }

  if (/\/agent\//.test(normalized)) {
    return make('agent_state_runtime_bridge', 'observe', 'runtime-bridge', 'agent runtime state bridge needs a narrower owner before changing')
  }

  if (/packages\/koishi-plugin-(?:pet-bridge|local-video-sender|group-name-at|dongxuelian-help|dongxuelian-poke|defense|group-leave-notice)\//.test(normalized)) {
    return make('small_plugin_runtime_boundary', 'observe', 'plugin-boundary', 'small plugin runtime boundary; classify before merging into shared DTOs')
  }

  if (/\/public\/pet-bridge-runtime\.ts$/.test(normalized)) {
    return make('small_plugin_runtime_boundary', 'observe', 'plugin-boundary', 'pet bridge runtime public facade boundary')
  }

  if (/\/core\//.test(normalized)) {
    return make('core_common_adapter', 'observe', 'common-adapter-boundary', 'core common adapter/redactor/object traversal should not be mechanically narrowed')
  }

  if (label === 'asUnknownAs' || label === 'asAny' || label === 'anyType') {
    return make('unclassified_escape', 'manual-review', 'type-escape', 'explicit type escape needs point review')
  }

  return make('unclassified', 'manual-review', 'type-escape', 'no deterministic bucket matched')
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

function listTrackedFiles(scopes = ['packages'], options = {}) {
  const args = ['-c', 'core.quotePath=false', 'ls-files', '-z']
  if (options.includeUntracked) args.push('-c', '-o', '--exclude-standard')
  args.push('--', ...scopes)
  const output = execFileSync('git', args, { cwd: ROOT, encoding: 'buffer' }).toString('utf8')
  return output
    .split('\0')
    .map(normalizeRel)
    .filter(Boolean)
    .sort()
}

function listSourceFiles(options = {}) {
  return listTrackedFiles(['packages'], options)
    .filter(isTrackedSourceFile)
}

function isPathConfigFile(relPath) {
  if (!relPath) return false
  if (/\.md$/i.test(relPath)) return false
  if (relPath === 'scripts/audit-src-metrics.js') return false
  if (/^packages\/[^/]+\/(?:lib|dist|test|__tests__)\//.test(relPath)) return false
  if (/^packages\/[^/]+\/src\//.test(relPath)) return true
  if (/^packages\/[^/]+\/package\.json$/.test(relPath)) return true
  if (/^(?:start\.js|setup\.sh|deploy\.bat|package\.json)$/.test(relPath)) return true
  if (/^scripts\/.+\.(?:sh|bat|js)$/i.test(relPath)) return true
  if (/^local-deployer\/(?!README)(?!.*\/dist\/)(?!.*\/node_modules\/).+\.(?:cjs|js|json|bat|cmd|ps1|html)$/i.test(relPath)) return true
  return false
}

function listPathConfigFiles(options = {}) {
  return listTrackedFiles(['packages', 'scripts', 'local-deployer', 'start.js', 'setup.sh', 'deploy.bat', 'package.json'], options)
    .filter(isPathConfigFile)
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

function makeDynamicRequireClassification(item) {
  const make = (bucket, action, debt, reason) => ({ bucket, action, debt, reason })
  if (item.category === 'cross-package-deep-path') {
    return make(
      'cross_package_private_deep_require',
      'fix-candidate',
      'coupling/private-api',
      'runtime require reaches into a sibling package lib path; a stable public API boundary would reduce coupling',
    )
  }
  if (item.category === 'dynamic-expression' && item.detail === 'path.join(AI_LIB, ...)') {
    return make(
      'dashboard_ai_lib_runtime_bridge',
      'fix-candidate',
      'coupling/service-locator',
      'Dashboard resolves AI package internals through AI_LIB at runtime; public API extraction is the debt-reducing direction',
    )
  }
  if (item.category === 'dynamic-expression' && item.detail === 'getAiResourceLibPath(...)') {
    return make(
      'external_ai_resource_runtime_bridge',
      'fix-candidate',
      'coupling/service-locator',
      'external plugin loads AI resource internals through a runtime path helper; a stable bridge would reduce cross-package coupling',
    )
  }
  if (item.category === 'dynamic-expression') {
    return make(
      'unresolved_dynamic_require',
      'manual-review',
      'dynamic-require',
      'dynamic require expression needs candidate-source and permission-boundary review',
    )
  }
  if (item.category === 'relative-lazy') {
    return make(
      'local_relative_lazy_require',
      'manual-review',
      'local-lazy-boundary',
      'local lazy require may be valid cold-path or cycle control, but this script cannot prove it point-by-point',
    )
  }
  if (item.category === 'builtin-lazy') {
    return make(
      'node_builtin_lazy_require',
      'do-not-change',
      'lazy-builtin',
      'Node builtin lazy require is low-risk and does not by itself increase package coupling',
    )
  }
  if (item.category === 'package-runtime') {
    return make(
      'heavy_or_runtime_package_lazy_require',
      'observe',
      'runtime-dependency-boundary',
      'package runtime require is usually a cold-path or optional capability boundary; changing it needs behavior evidence',
    )
  }
  if (item.category === 'optional-dependency') {
    return make(
      'optional_dependency_probe',
      'observe',
      'optional-runtime-dependency',
      'try-block require is used as an optional capability probe',
    )
  }
  return make(
    'unclassified_dynamic_require',
    'manual-review',
    'dynamic-require',
    'no deterministic dynamic require bucket matched',
  )
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
  const classificationSummary = {}
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
        Object.assign(item, makeDynamicRequireClassification(item))
        occurrences.push(item)
        byCategory[item.category] = (byCategory[item.category] || 0) + 1
        byArgumentKind[item.argumentKind] = (byArgumentKind[item.argumentKind] || 0) + 1
        const classificationKey = `${item.bucket}|${item.action}`
        classificationSummary[classificationKey] = (classificationSummary[classificationKey] || 0) + 1
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
    classificationSummary,
    occurrences,
    staticCycles: cycles,
  }
}

function buildHelperOccurrence(relPath, meta, nameNode, declKind, strictEligible, bucket) {
  const name = nameNode.getText(meta.source)
  if (!isHelperLikeName(name)) return null
  const loc = lineAndColumnOf(meta, nameNode)
  const classification = makeDuplicateHelperClassification(name, relPath, strictEligible)
  return {
    id: `${relPath}:${loc.line}:${loc.column}:${name}`,
    name,
    declKind,
    file: relPath,
    line: loc.line,
    column: loc.column,
    scopeClass: getScopeClass(relPath),
    pluginOnly: pluginOnly(relPath),
    bucket: classification.bucket || bucket,
    action: classification.action,
    debt: classification.debt,
    reason: classification.reason,
    viewTags: strictEligible ? ['wide', 'strict'] : ['wide'],
  }
}

function makeDuplicateHelperClassification(name, relPath, strictEligible) {
  const normalized = normalizeRel(relPath)
  const make = (bucket, action, debt, reason) => ({ bucket, action, debt, reason })
  const trueDuplicateNames = new Set([
    'getResponseHeader',
    'readResponseBytesLimited',
    'getSafeKey',
    'getFilePath',
    'getLegacyUnsafeFilePath',
    'getLegacyUnsafeKey',
    'getArgNumber',
    'parsePositiveInt',
    'getErrorMessage',
    'getLegacyErrorMessage',
    'parseJsonObject',
    'isRecord',
    'getFileFingerprint',
    'readJsonFile',
    'writeJsonFile',
    'writeTextFile',
    'readJsonFileSync',
    'writeJsonFileSync',
  ])
  const canonicalNames = new Set([
    'apply',
    'stripMentions',
    'formatPercent',
    'extractAtIds',
    'getSenderUserId',
    'normalizeText',
    'sleep',
    'withTimeout',
    'safeUserId',
    'safeChannelKey',
  ])
  const differentMeaningNames = new Set([
    'normalizeCustomProvider',
    'formatTime',
    'getUserId',
    'normalizeVoiceAsset',
    'resolveRunAt',
    'runAnalysis',
    'handleGetNapcatStatus',
    'normalizeContextPolicy',
    'normalizeLoreScope',
    'normalizeProviderModel',
    'getDreamStatus',
  ])
  const sideEffectNames = new Set([
    'callOneBot',
    'findBrowser',
    'getBrowserProcessPid',
    'readLinuxMemAvailableMb',
    'stopKoishiProcesses',
    'requireStrictAdmin',
    'getNapcatStartEntry',
    'isAgentPathInside',
    'isGroupAdmin',
    'isRunningTaskLike',
  ])
  const localPrivateNames = new Set([
    'listFromData',
    'readNumber',
    'readString',
    'formatBytes',
    'headers',
    'getAdminToken',
    'submit',
    'toggle',
    'finish',
    'pick',
    'cancel',
    'load',
    'loadStatus',
    'onKeydown',
    'addFallbackStep',
    'fallbackModelOptions',
    'normalizeModelKey',
  ])

  if (canonicalNames.has(name)) {
    return make('canonical_or_standard_entry', 'observe', 'duplicate', 'existing canonical helper or framework-standard entry; only other implementations may converge to it')
  }
  if (trueDuplicateNames.has(name)) {
    return make('true_duplicate_candidate', 'fix-candidate', 'duplicate', 'same-name helper family is a likely same-algorithm or thin-wrapper duplicate; needs per-group signature check before editing')
  }
  if (differentMeaningNames.has(name)) {
    return make('same_name_different_semantics', 'do-not-merge', 'duplicate', 'same name is used for different domain semantics')
  }
  if (sideEffectNames.has(name)) {
    return make('env_permission_side_effect_bound', 'observe', 'duplicate/side-effect-boundary', 'helper is bound to permissions, process, browser, OneBot, or runtime side effects')
  }
  if (localPrivateNames.has(name) || !strictEligible || /\/frontend\/src\/components\//.test(normalized) || /packages\/agent-console\/src\//.test(normalized)) {
    return make('local_private_helper', 'observe', 'duplicate/local-ui-helper', 'local component/route/action helper; same name alone is not a reusable contract')
  }
  return make('manual_review_same_name', 'manual-review', 'duplicate', 'same-name group needs semantic review')
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
    scope: 'packages/**/src/**/*.{ts,tsx,js,jsx,vue}',
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
    .map(([name, items]) => {
      const sortedItems = items
        .slice()
        .sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.column - b.column)
      const actions = new Set(items.map((item) => item.action))
      const buckets = new Set(items.map((item) => item.bucket))
      const classification = actions.size === 1 && buckets.size === 1
        ? {
          bucket: items[0].bucket,
          action: items[0].action,
          debt: items[0].debt,
          reason: items[0].reason,
        }
        : {
          bucket: 'mixed_same_name',
          action: 'manual-review',
          debt: 'duplicate',
          reason: 'same-name group contains mixed deterministic classifications',
        }
      return {
        name,
        occurrences: items.length,
        pluginOnly: items.every((item) => item.pluginOnly),
        files: Array.from(new Set(items.map((item) => item.file))).sort(),
        bucket: classification.bucket,
        action: classification.action,
        debt: classification.debt,
        reason: classification.reason,
        memberIds: items.map((item) => item.id),
        items: sortedItems,
      }
    })
    .sort((a, b) => b.occurrences - a.occurrences || a.name.localeCompare(b.name))

  const classificationSummary = {}
  for (const group of groups) {
    const key = `${group.bucket}|${group.action}`
    classificationSummary[key] = (classificationSummary[key] || 0) + 1
  }

  return {
    allGroupCount: groups.length,
    pluginOnlyGroupCount: groups.filter((group) => group.pluginOnly).length,
    classificationSummary,
    groups,
  }
}

function summarizeClassifications(items) {
  const summary = {}
  for (const item of items) {
    const key = `${item.bucket || 'unclassified'}|${item.action || 'manual-review'}`
    summary[key] = (summary[key] || 0) + 1
  }
  return summary
}

function summarizeClassificationCounts(items) {
  const summary = {}
  for (const item of items) {
    const key = `${item.bucket || 'unclassified'}|${item.action || 'manual-review'}`
    summary[key] = (summary[key] || 0) + (item.count || 1)
  }
  return summary
}

function analyzeTypeEscape(files, options = {}) {
  const summary = {}
  const evidence = {}
  const classificationSummary = {}
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
        if (count) {
          const text = line.trim().slice(0, 200)
          const classification = makeTypeEscapeClassification(label, relPath, text)
          const key = `${classification.bucket}|${classification.action}`
          if (!classificationSummary[label]) classificationSummary[label] = {}
          classificationSummary[label][key] = (classificationSummary[label][key] || 0) + count
          matches.push({
            file: relPath,
            line: i + 1,
            count,
            text,
            ...classification,
          })
        }
      }
    }
    summary[label] = {
      lineCount: matches.reduce((sum, item) => sum + item.count, 0),
      fileCount: new Set(matches.map((item) => item.file)).size,
    }
    evidence[label] = limitHits(matches, options, 40)
  }
  return { scope: 'packages/*/src + packages/*/frontend/src', summary, classificationSummary, evidence }
}

function classifyCatchBlock(meta, node) {
  const blockText = meta.text.slice(node.block.getStart(meta.source), node.block.end)
  const inner = blockText.replace(/^\{/, '').replace(/\}$/, '').trim()
  return inner ? 'comment-only' : 'empty'
}

function makeCommentOnlyCatchClassification(relPath, lineText) {
  const normalized = normalizeRel(relPath)
  const text = lineText || ''
  const lower = text.toLowerCase()
  const make = (bucket, action, debt, reason) => ({ bucket, action, debt, reason })

  if (
    /\b(request|stream|response|websocket|ws)\b/.test(lower)
    && /\b(already|closed|handled)\b/.test(lower)
  ) {
    return make('runtime_close_race', 'do-not-change', 'cleanup-race', 'close/destroy may race with an already-closed runtime resource')
  }

  if (
    /process may have already exited/.test(lower)
    || /process may already be stopped/.test(lower)
    || /external signal cleanup can race/.test(lower)
  ) {
    return make('runtime_close_race', 'do-not-change', 'cleanup-race', 'process or abort cleanup is inherently race-prone')
  }

  if (
    /\bcleanup\b/.test(lower)
    || /\bbest-effort\b.*\b(cleanup|removal|delete|deletion)\b/.test(lower)
    || /\b(staging|temp|temporary|cache limit|overwrite|stale|prune|rmdir|unlink|remove|lease cleanup|release failure|deletion)\b/.test(lower)
    || /清理失败|临时文件|旧文件/.test(text)
  ) {
    return make('best_effort_cleanup', 'do-not-change', 'cleanup-race', 'best-effort cleanup failure should not mask the primary operation')
  }

  if (
    /task log/.test(lower)
    || /pid file/.test(lower)
    || /progress log/.test(lower)
    || /status update/.test(lower)
    || /cache reset/.test(lower)
    || /in-memory mode/.test(lower)
    || /persistence fails/.test(lower)
    || /push log compaction/.test(lower)
    || /token usage flush/.test(lower)
    || /log rotation/.test(lower)
    || /event writing/.test(lower)
  ) {
    return make('secondary_state_write_failure', 'fix-candidate', 'fake-green', 'secondary state/log write failure can hide failed persistence or diagnostics')
  }

  if (
    /packages\/koishi-plugin-dashboard\/frontend\/src\/components\/agentpanel\.vue$/.test(normalized)
    || /pending approvals|session history|session detail/.test(lower)
  ) {
    return make('dashboard_user_visible_degradation', 'fix-candidate', 'fake-green/user-visible-degradation', 'Dashboard UI load failure is hidden from the operator')
  }

  if (
    /cached (?:file|image) hint/.test(lower)
    || /asr/.test(lower)
    || /onebot get_(?:file|image|record)/.test(lower)
    || /direct url download failure/.test(lower)
    || /download failure falls back/.test(lower)
    || /silk fallback/.test(lower)
    || /makes asr unavailable/.test(lower)
    || /analysis failure marker/.test(lower)
  ) {
    return make('media_user_visible_fallback', 'fix-candidate', 'user-visible-degradation', 'media/file/voice fallback can hide the real failed source')
  }

  if (
    /malformed/.test(lower)
    || /parse failed/.test(lower)
    || /json/.test(lower)
    || /regex/.test(lower)
    || /decoded/.test(lower)
    || /headers object/.test(lower)
    || /result url/.test(lower)
  ) {
    return make('parser_fallback', 'observe', 'parser-boundary', 'malformed external data has an explicit deterministic fallback path')
  }

  if (
    /logger may be unavailable/.test(lower)
    || /debug log failure/.test(lower)
    || /diagnostic logging/.test(lower)
    || /logging only/.test(lower)
    || /logging failure/.test(lower)
    || /diagnostic callback/.test(lower)
  ) {
    return make('diagnostic_logging_boundary', 'observe', 'diagnostic-boundary', 'diagnostic logging failure should not affect the primary result')
  }

  if (
    /probe/.test(lower)
    || /optional/.test(lower)
    || /missing/.test(lower)
    || /absent/.test(lower)
    || /unreadable/.test(lower)
    || /candidate/.test(lower)
    || /config/.test(lower)
    || /secret/.test(lower)
    || /token/.test(lower)
    || /maintenance/.test(lower)
    || /static file/.test(lower)
    || /browser/.test(lower)
    || /persona directory/.test(lower)
    || /prompt directory/.test(lower)
    || /skill pool/.test(lower)
  ) {
    return make('optional_probe_or_config_fallback', 'observe', 'runtime-probe-boundary', 'optional probe/config fallback has a stated degraded path')
  }

  if (/try the next|falls through|fall through|keeps trying next|skip one|continue with the rest/.test(lower)) {
    return make('bounded_fallback_continue', 'observe', 'fallback-boundary', 'comment states a bounded fallback or continue path')
  }

  if (/跳过|仍显示其他来源|继续/.test(text)) {
    return make('bounded_fallback_continue', 'observe', 'fallback-boundary', 'comment states a bounded fallback or continue path')
  }

  if (/writejsonfile will surface/.test(lower)) {
    return make('failure_surfaces_elsewhere', 'observe', 'secondary-error-surface', 'comment states the real failure is surfaced by the following write operation')
  }

  return make('unclassified_comment_only_catch', 'manual-review', 'silent-catch', 'comment-only catch needs point review before being treated as safe or actionable')
}

function limitHits(hits, options = {}, defaultLimit = 80) {
  return options.allHits ? hits : hits.slice(0, defaultLimit)
}

function analyzeConsoleMisc(files, options = {}) {
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
        const loc = lineOf(meta, node)
        const hit = {
          file: relPath,
          line: loc,
          text: textOf(meta, node),
        }
        if (classification === 'comment-only') {
          Object.assign(hit, makeCommentOnlyCatchClassification(relPath, hit.text))
          commentOnlyCatchHits.push(hit)
        } else {
          Object.assign(hit, {
            bucket: 'empty_catch',
            action: 'fix-candidate',
            debt: 'silent-catch',
            reason: 'empty catch has no explicit fallback, logging, or non-critical reason',
          })
          emptyCatchHits.push(hit)
        }
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
      hits: limitHits(consoleHits, options),
    },
    todoFixme: {
      count: todoHits.length,
      fileCount: new Set(todoHits.map((item) => item.file)).size,
      hits: limitHits(todoHits, options),
    },
    emptyCatch: {
      count: emptyCatchHits.length,
      fileCount: new Set(emptyCatchHits.map((item) => item.file)).size,
      classificationSummary: summarizeClassifications(emptyCatchHits),
      hits: limitHits(emptyCatchHits, options),
    },
    commentOnlyCatch: {
      count: commentOnlyCatchHits.length,
      fileCount: new Set(commentOnlyCatchHits.map((item) => item.file)).size,
      classificationSummary: summarizeClassifications(commentOnlyCatchHits),
      hits: limitHits(commentOnlyCatchHits, options),
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

function redactSensitiveSnippet(text) {
  return text
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, 'sk-<REDACTED>')
    .replace(/\bghp_[A-Za-z0-9]{8,}\b/g, 'ghp_<REDACTED>')
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----/g, '-----BEGIN <REDACTED> PRIVATE KEY-----')
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, '<IP>')
}

function isMockOrSmokePath(relPath) {
  const normalized = normalizeRel(relPath)
  return (
    /(?:^|\/)scripts\/(?:dashboard-click-smoke|agent-console-admin-smoke)\.js$/.test(normalized)
    || /^packages\/agent-console\/src\/api\/client\.ts$/.test(normalized)
  )
}

function isAuditToolPath(relPath) {
  return /^scripts\/(?:ts-diff-check|check-syntax|skill-hub)\.js$/.test(normalizeRel(relPath))
}

function hasLoopbackAddress(text) {
  return /\b(?:127\.0\.0\.1|0\.0\.0\.0|localhost)\b/i.test(text)
}

function hasNonLoopbackIp(text) {
  const matches = text.match(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g) || []
  return matches.some((value) => value !== '127.0.0.1' && value !== '0.0.0.0')
}

function makePathConfigClassification(groupKey, relPath, lineText) {
  const normalized = normalizeRel(relPath)
  const text = lineText || ''
  const lower = text.toLowerCase()
  const make = (bucket, action, debt, reason) => ({ bucket, action, debt, reason })

  if (isMockOrSmokePath(normalized)) {
    return make('mock_or_smoke_fixture', 'do-not-change', 'test-fixture', 'mock/smoke fixture value is not a production configuration source')
  }

  if (groupKey === 'crossPackagePath') {
    if (isAuditToolPath(normalized)) {
      return make('audit_tool_reference', 'do-not-change', 'audit-tooling', 'audit/check script references package paths as scan input, not runtime coupling')
    }
    if (/^\s*type\s+\w+\s*=\s*typeof import\(/.test(text)) {
      return make('cross_package_private_type_reference', 'observe', 'type-coupling', 'type-only reference to sibling compiled layout should be tracked separately from runtime loading')
    }
    if (/function\s+getAiResourceLibPath\s*\(/.test(text)) {
      return make('runtime_path_helper_definition', 'observe', 'service-locator-helper', 'helper definition documents a runtime bridge; actual require call sites carry the fix candidate')
    }
    if (/koishi-plugin-dongxuelian-ai\/lib\/public\//.test(text)) {
      return make('public_facade_reference', 'observe', 'public-facade-boundary', 'lib/public facade is a lower-risk compatibility boundary, not a private deep import')
    }
    if (/^packages\/koishi-plugin-dongxuelian-ai\/src\/agent\/workspace-context\.ts$/.test(normalized)) {
      return make('workspace_context_reference', 'observe', 'workspace-index-boundary', 'workspace context logic refers to package paths while building safe scan context')
    }
    if (/path\.join\s*\(\s*AI_LIB\b/.test(text)) {
      return make('dashboard_ai_lib_runtime_bridge', 'fix-candidate', 'coupling/service-locator', 'Dashboard resolves sibling AI internals through AI_LIB; a public API bridge would reduce coupling')
    }
    if (/require\s*\(\s*getAiResourceLibPath\s*\(/.test(text)) {
      return make('external_ai_resource_runtime_bridge', 'fix-candidate', 'coupling/service-locator', 'external plugin resolves AI resource internals through a runtime path helper')
    }
    if (/koishi-plugin-dongxuelian-ai\/lib/.test(text) || /\.\.\/\.\.\/koishi-plugin-dongxuelian-ai\/lib/.test(text)) {
      return make('cross_package_private_lib_reference', 'fix-candidate', 'coupling/private-api', 'sibling package lib path reference couples to non-public compiled layout')
    }
    return make('cross_package_path_unclassified', 'manual-review', 'cross-package-path', 'cross-package path hit needs point review')
  }

  if (groupKey === 'envKeyEntry') {
    if (/\b(?:token|key|password|pwd|secret|admin|napcat)\b/i.test(text) || /\/(?:auth|bot|napcat|paths|standalone)\.ts$/.test(normalized)) {
      return make('sensitive_runtime_config_surface', 'observe', 'sensitive-config-handling', 'environment-backed sensitive field is a runtime handling surface that needs auth/redaction review')
    }
    if (/process\.env\.[A-Z0-9_]+/.test(text) || /\b(?:KOISHI_DIR|DONGXUELIAN_AI_DATA_DIR|DASHBOARD_HOST|DASHBOARD_PORT)\b/.test(text)) {
      return make('env_override_entry', 'observe', 'config-boundary', 'environment override reduces hardcoding but still documents a runtime entry point')
    }
    return make('env_key_reference', 'observe', 'config-boundary', 'environment/config key reference is not a secret by itself')
  }

  if (groupKey === 'pathUrlChain') {
    if (hasLoopbackAddress(text)) {
      return make('loopback_or_local_bind', 'do-not-change', 'local-network-boundary', 'loopback/local bind is the intended local proxy/listener boundary')
    }
    if (/node_modules\/koishi\/bin\.js start/.test(text)) {
      return make('local_koishi_binary_entry', 'observe', 'runtime-entry', 'local Koishi binary is the expected runtime entry but still belongs in entry-drift inventory')
    }
    if (/\b(?:ssh|scp)\s+/.test(lower) || /\bgit (?:pull|clone)\b/.test(lower)) {
      return make('legacy_deploy_network_chain', 'fix-candidate', 'entry-drift/supply-chain', 'direct ssh/scp/git deployment path conflicts with the packaged deploy chain and increases drift risk')
    }
    if (/\bhttps?:\/\/[^\s'"`]+/i.test(text) || /\bwss?:\/\/[^\s'"`]+/i.test(text)) {
      return make('external_public_url_or_base_url', 'observe', 'external-url-boundary', 'external URL/baseURL needs ownership review but is not automatically a hardcoded secret')
    }
    return make('path_url_chain_unclassified', 'manual-review', 'path-url-chain', 'path/URL chain hit needs point review')
  }

  if (groupKey === 'sensitiveFallback') {
    if (hasLoopbackAddress(text)) {
      return make('loopback_ip_literal', 'do-not-change', 'local-network-boundary', 'loopback/local bind literal is not a deploy secret')
    }
    if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(text) || /\bghp_[A-Za-z0-9]{8,}/.test(text)) {
      return make('static_secret_literal', 'fix-candidate', 'sensitive-exposure', 'static private key or token literal must not be committed')
    }
    if (/\bsk-[A-Za-z0-9_-]{8,}/.test(text)) {
      return make('setup_or_example_api_key_literal', 'fix-candidate', 'sensitive-exposure', 'sk-* shaped literal should be replaced by placeholder or runtime input')
    }
    if (hasNonLoopbackIp(text)) {
      return make('hardcoded_non_loopback_ip', 'fix-candidate', 'sensitive-exposure/path-hardcode', 'non-loopback IP literal in committable files can reveal deployment shape or hardcode an endpoint')
    }
    if (/\b(?:token|cookie)\s*:/i.test(text)) {
      return make('sensitive_field_handling_surface', 'observe', 'sensitive-config-handling', 'token/cookie field handling needs auth/redaction review but is not proof of a leaked value')
    }
    return make('sensitive_fallback_unclassified', 'manual-review', 'sensitive-fallback', 'sensitive fallback hit needs point review')
  }

  return make('path_config_unclassified', 'manual-review', 'path-config', 'path-config hit needs point review')
}

function analyzePathConfig(files, options = {}) {
  const groups = {}
  for (const group of PATH_CONFIG_GROUPS) {
    const hits = []
    for (const relPath of files) {
      const raw = readFile(relPath)
      const lines = raw.split(/\r?\n/)
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]
        for (const pattern of group.patterns) {
          pattern.lastIndex = 0
          let count = 0
          while (pattern.exec(line)) count++
          if (count) {
            const classification = makePathConfigClassification(group.key, relPath, line)
            hits.push({
              file: relPath,
              line: i + 1,
              count,
              text: redactSensitiveSnippet(line.trim().slice(0, 240)),
              ...classification,
            })
          }
        }
      }
    }
    groups[group.key] = {
      label: group.label,
      rawHitCount: hits.reduce((sum, item) => sum + item.count, 0),
      fileCount: new Set(hits.map((item) => item.file)).size,
      classificationSummary: summarizeClassificationCounts(hits),
      classificationRows: summarizeClassifications(hits),
      hits: limitHits(hits, options, 120),
    }
  }
  return {
    scope: 'packages/**/src + packages/**/package.json + root startup/deploy scripts + local-deployer runtime files',
    groups,
  }
}

function classifyTrackedArtifact(relPath) {
  const normalized = normalizeRel(relPath)
  const make = (bucket, action, debt, reason) => ({ bucket, action, debt, reason })

  if (/^packages\/koishi-plugin-dashboard\/src\/lib\//.test(normalized)) {
    return make('handwritten_src_lib_false_positive', 'do-not-change', 'scan-scope', 'src/lib is handwritten source, not a tracked build artifact')
  }
  if (/(^|\/)lib\//.test(normalized)) {
    return make('tracked_compiled_lib', 'manual-review', 'build-artifact-drift', 'tracked compiled lib follows current package publishing convention but can drift from source')
  }
  if (/(^|\/)dist\//.test(normalized)) {
    return make('tracked_frontend_dist', 'manual-review', 'build-artifact-drift', 'tracked dist asset may be runtime material but can churn or drift from source')
  }
  if (/^packages\/koishi-plugin-dongxuelian-ai\/data\/agent-tool-results\//.test(normalized)) {
    return make('tracked_test_output_data', 'fix-candidate', 'runtime-data-pollution/fake-green', 'agent tool result text files look like test/runtime output committed under data')
  }
  if (/^packages\/koishi-plugin-dongxuelian-ai\/data\/image-history\//.test(normalized)) {
    return make('tracked_test_output_data', 'fix-candidate', 'runtime-data-pollution/fake-green', 'image-history test output is committed under data')
  }
  if (/^packages\/koishi-plugin-dongxuelian-ai\/data\/ai-skills\//.test(normalized)) {
    return make('tracked_seed_skill_data', 'observe', 'seed-runtime-boundary', 'ai-skills appear to be seed/product assets but live under data and need clear seed/runtime boundary')
  }
  if (
    normalized === 'data/nickname-collections.example.json'
    || normalized === 'packages/koishi-plugin-dongxuelian-ai/data/ai-tool-config.json'
    || normalized === 'packages/koishi-plugin-dongxuelian-ai/data/summary-whitelist.json'
  ) {
    return make('tracked_example_or_default_data', 'manual-review', 'runtime-data-boundary', 'example/default data needs confirmation as fixture, seed, or runtime config')
  }
  if (/^local-deployer\/(?:build|release)\//.test(normalized)) {
    return make('tracked_local_deployer_release_asset', 'manual-review', 'release-artifact-boundary', 'local-deployer release/build asset depends on packaging strategy')
  }
  if (/\.(?:tgz|zip|7z|rar|tar|gz)$/i.test(normalized)) {
    return make('tracked_archive_artifact', 'fix-candidate', 'archive-artifact-pollution', 'archive artifacts are forbidden in this repo policy')
  }
  if (/(^|\/)(?:build|release)\//.test(normalized)) {
    return make('tracked_build_release_artifact', 'manual-review', 'release-artifact-boundary', 'build/release tracked file needs packaging-policy review')
  }
  return make('tracked_artifact_unclassified', 'manual-review', 'artifact-inventory', 'tracked artifact-like path needs point review')
}

function classifyUntrackedArtifact(relPath) {
  const normalized = normalizeRel(relPath)
  const make = (bucket, action, debt, reason) => ({ bucket, action, debt, reason })
  if (/\.(?:tgz|zip|7z|rar|tar|gz)$/i.test(normalized)) {
    return make('untracked_archive_artifact', 'fix-candidate', 'archive-artifact-pollution', 'archive artifacts must not enter the repository')
  }
  if (/(^|\/)data\//.test(normalized)) {
    return make('untracked_runtime_data', 'fix-candidate', 'runtime-data-pollution', 'untracked data file is a commit-risk runtime artifact until ignored or classified')
  }
  if (/(^|\/)lib\//.test(normalized)) {
    return make('untracked_compiled_lib', 'manual-review', 'build-artifact-drift', 'untracked compiled output must be handled consistently with tracked source changes')
  }
  if (/(^|\/)src\//.test(normalized)) {
    return make('untracked_source_file', 'manual-review', 'worktree-scope', 'untracked source is part of current workspace scope but not current tracked baseline')
  }
  if (/(^|\/)test\//.test(normalized)) {
    return make('untracked_test_file', 'manual-review', 'test-scope', 'untracked test file may be legitimate coverage or temporary output')
  }
  if (!normalized.includes('/')) {
    return make('untracked_root_loose_file', 'manual-review', 'review-noise/sensitive-exposure', 'root-level untracked file needs content review before commit or deletion')
  }
  return make('untracked_other_file', 'manual-review', 'worktree-scope', 'untracked file needs point review')
}

function analyzeArtifactInventory(options = {}) {
  const trackedFiles = listTrackedFiles(['.'], {})
  const untrackedFiles = options.includeUntracked ? listTrackedFiles(['.'], { includeUntracked: true })
    .filter((relPath) => !trackedFiles.includes(relPath)) : listTrackedFiles([], {})
  const trackedBroad = trackedFiles.filter((relPath) => /(^|\/)(?:lib|dist|data)\/|(^|\/)(?:build|release)\/|\.(?:tgz|zip|7z|rar|tar|gz)$/i.test(relPath))
  const trackedHits = trackedBroad.map((file) => ({ file, ...classifyTrackedArtifact(file) }))
  const realTrackedHits = trackedHits.filter((item) => item.bucket !== 'handwritten_src_lib_false_positive')
  const untrackedHits = (options.includeUntracked ? untrackedFiles : [])
    .map((file) => ({ file, ...classifyUntrackedArtifact(file) }))
  const archiveHits = trackedFiles.concat(untrackedFiles)
    .filter((file) => /\.(?:tgz|zip|7z|rar|tar|gz)$/i.test(file))
    .map((file) => ({ file }))

  return {
    scope: 'tracked lib/dist/data/build/release/archive paths + optional untracked committable files',
    trackedBroadCount: trackedHits.length,
    trackedAuditCount: realTrackedHits.length,
    untrackedCount: untrackedHits.length,
    archiveCount: archiveHits.length,
    trackedClassificationSummary: summarizeClassifications(realTrackedHits),
    falsePositiveSummary: summarizeClassifications(trackedHits.filter((item) => item.bucket === 'handwritten_src_lib_false_positive')),
    untrackedClassificationSummary: summarizeClassifications(untrackedHits),
    trackedHits: limitHits(realTrackedHits, options, 200),
    falsePositiveHits: limitHits(trackedHits.filter((item) => item.bucket === 'handwritten_src_lib_false_positive'), options, 40),
    untrackedHits: limitHits(untrackedHits, options, 80),
    archiveHits,
  }
}

function main() {
  const mode = process.argv[2]
  const options = {
    allHits: process.argv.includes('--all-hits'),
    includeUntracked: process.argv.includes('--include-untracked'),
  }
  const files = listSourceFiles(options)
  const result = {
    mode,
    generatedAt: new Date().toISOString(),
    fileCount: files.length,
  }

  if (mode === 'dynamic-require') Object.assign(result, analyzeDynamicRequire(files))
  else if (mode === 'duplicate-helper') Object.assign(result, analyzeDuplicateHelpers(files))
  else if (mode === 'type-escape') Object.assign(result, analyzeTypeEscape(files, options))
  else if (mode === 'console-misc') Object.assign(result, analyzeConsoleMisc(files, options))
  else if (mode === 'long-files') Object.assign(result, analyzeLongFiles(files))
  else if (mode === 'path-config') {
    const pathFiles = listPathConfigFiles(options)
    result.fileCount = pathFiles.length
    Object.assign(result, analyzePathConfig(pathFiles, options))
  }
  else if (mode === 'artifact-inventory') Object.assign(result, analyzeArtifactInventory(options))
  else {
    console.error('usage: node scripts/audit-src-metrics.js <dynamic-require|duplicate-helper|type-escape|console-misc|long-files|path-config|artifact-inventory>')
    process.exit(2)
  }

  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
}

if (require.main === module) main()
