const { execFileSync } = require('child_process')
const fs = require('fs')
const path = require('path')
const ts = require('typescript')

const ROOT = path.resolve(__dirname, '..')
const AI_PLUGIN = 'koishi-plugin-dongxuelian-ai'
const AI_PKG = `packages/${AI_PLUGIN}`
const AI_TAG = 'pre-ts-migration'
const PLUGINS_TAG = 'pre-plugins-ts-migration'

const OTHER_PLUGIN_NAMES = [
  'koishi-plugin-dongxuelian-poke',
  'koishi-plugin-group-leave-notice',
  'koishi-plugin-defense',
  'koishi-plugin-dongxuelian-help',
  'koishi-plugin-local-video-sender',
  'koishi-plugin-group-name-at',
  'koishi-plugin-pet-bridge',
  'koishi-plugin-daily-report',
  'koishi-plugin-dashboard',
]

const EXPORT_ASSIGNMENT = /exports\.(\w+)\s*=/
const FORBIDDEN = [/__esModule/, /__awaiter/, /__spreadArray/, /\(0,\s*\w+\.\w+\)/]
const ALLOWED_ADDED_EXPORTS = {
  'core/utils.js': ['safeChannelKey', 'safeUserId', 'legacySafeUserId', 'truncateText', 'readJsonFileSync', 'writeJsonFileSync', 'normalizeText', 'getFileFingerprint', 'normalizeHostname', 'isPrivateHostname', 'isPrivateIp', 'validatePublicHttpUrl', 'resolveAndValidateHostname', 'errorMessage', 'errorCode'],
  'agent/queue.js': ['withTimeout'],
  'agent/pending.js': ['summarizePendingArgs', 'upsertPendingToolSnapshot'],
  'behavior/emotion-renderer.js': ['renderEmotionImageDirect'],
  'conversation.js': ['clearPendingSensitiveAlert', 'consumePendingSensitiveAlert', 'writePendingSensitiveAlert'],
  'core/redactor.js': ['redactSensitiveData'],
  'lifecycle/startup-schedulers.js': ['scheduleDailyPrecomputePlanning'],
  'message/message-segment.js': ['extractVoiceRefFromContent', 'getVoiceSegmentData'],
  'reply/safe-send.js': ['canSendDuringSafeSendWindow'],
}
const ALLOWED_NEW_AI_JS_FILES = new Set([
  'agent/resource-execution.js',
  'agent/worker-submission.js',
  'bot-mode/command-classifier.js',
  'bot-mode/mode-policy.js',
  'bot-mode/mode-state.js',
  'bot-mode/status-reply.js',
  'daily-precompute/daily-coverage.js',
  'daily-precompute/daily-slot-planner.js',
  'daily-precompute/daily-slot-worker.js',
  'daily-precompute/daily-summary-merge.js',
  'daily-precompute/precompute-index.js',
  'daily-precompute/precompute-status.js',
  'media/backpressure/media-queue.js',
  'media/backpressure/media-requests.js',
  'media/voice/tts-resource.js',
  'media/voice/voice-store.js',
  'resource-common/files.js',
  'resource-gate/gate.js',
  'resource-scheduler/admission.js',
  'resource-scheduler/resource-snapshot.js',
  'resource-scheduler/task-budget.js',
  'resource-system/system-protection.js',
  'resource-workers/agent-payload.js',
  'resource-workers/agent-worker.js',
  'resource-workers/background-llm-submission.js',
  'resource-workers/background-llm-worker.js',
  'resource-workers/daily-worker.js',
  'resource-workers/emotion-worker.js',
  'resource-workers/media-worker.js',
  'resource-workers/memory-worker.js',
  'resource-workers/result-notifier.js',
  'resource-workers/task-client.js',
  'resource-workers/task-paths.js',
  'resource-workers/task-store.js',
  'resource-workers/task-types.js',
  'resource-workers/worker-main.js',
  'resource-workers/worker-supervisor.js',
])
const ALLOWED_ADDED_EXPORTS_BY_PLUGIN = {
  'koishi-plugin-daily-report': {
    'lib/data-collector.js': ['buildPrecomputedContext', 'countEmojiInContent', 'isMessageInReportDay'],
    'lib/html-renderer.js': ['assertEnoughMemoryForRender', 'assertRenderEnvironment'],
  },
}
const ALLOWED_NEW_JS_FILES_BY_PLUGIN = {
  'koishi-plugin-daily-report': new Set(['lib/report-pipeline.js']),
  'koishi-plugin-dashboard': new Set(['lib/routes/resource.js']),
}
const ALLOWED_REQUIRE_CHANGES_BY_PLUGIN = {
  'koishi-plugin-pet-bridge': {
    'lib/protocol.js': {
      added: [
        'koishi-plugin-dongxuelian-ai/lib/resource-gate/gate',
        'koishi-plugin-dongxuelian-ai/lib/resource-scheduler/admission',
      ],
    },
  },
  'koishi-plugin-daily-report': {
    'lib/html-renderer.js': {
      added: ['../../koishi-plugin-dongxuelian-ai/lib/resource-system/system-protection'],
    },
    'lib/index.js': {
      removed: ['./ai-analyzer', './data-collector', './html-renderer', 'koishi'],
    },
  },
  'koishi-plugin-dashboard': {
    'lib/router.js': {
      added: ['./routes/resource'],
    },
  },
}
const ALLOWED_REQUIRE_CHANGES = {
  'agent/auto-memory.js': { added: ['./config', '../core/utils', '../resource-workers/memory-worker'], removed: ['../core/api', '../core/constants', '../core/runtime-config', './dream', 'fs/promises', 'path'] },
  'agent/context.js': { added: ['../core/utils'] },
  'agent/cron.js': { added: ['../resource-workers/agent-payload', './worker-submission'], removed: ['./engine', './push', './queue'] },
  'agent/dream.js': { added: ['../core/utils', '../resource-workers/memory-worker'], removed: ['../core/api', '../core/constants', '../core/runtime-config', 'fs/promises', 'path'] },
  'agent/memory.js': { added: ['../core/utils'] },
  'agent/pending.js': { added: ['../core/constants', '../resource-common/files', 'path'] },
  'agent/plan/plan-store.js': { added: ['../../core/utils'] },
  'agent/plan/plan-runner.js': { added: ['../../resource-workers/agent-payload', '../worker-submission'], removed: ['../engine', '../queue'] },
  'agent/push.js': { added: ['../core/utils'] },
  'agent/skills/store.js': { added: ['../../core/utils'] },
  'agent/skills/pool-service.js': { added: ['../../core/utils'] },
  'agent/skills/workspace-service.js': { added: ['../../core/utils'] },
  'agent/tools/analyze-file.js': { added: ['../../media/backpressure/media-requests'], removed: ['../../media/file/file-analyzer'] },
  'agent/tools/analyze-image.js': { added: ['../../media/backpressure/media-queue', '../../resource-scheduler/admission'], removed: ['../../core/api', '../../core/api', '../../core/runtime-config', '../../media/image/image-analysis-sanitizer', '../../media/image/image-analyzer', '../../media/image/vision'] },
  'agent/tools/reminder-tools.js': { added: ['../config'] },
  'agent/tools/scheduled-task-tools.js': { added: ['../../core/utils', '../config'] },
  'agent/tools/browser-action.js': { added: ['../../core/utils', '../../resource-scheduler/admission', '../../resource-system/system-protection'], removed: ['dns/promises', 'net'] },
  'agent/tools/create-uploaded-file-variant.js': { added: ['../../media/backpressure/media-requests'], removed: ['../../media/file/file-analyzer'] },
  'agent/tools/web-search.js': { added: ['../queue'] },
  'behavior/expression/expression-abstractor.js': { added: ['../../agent/queue'] },
  'behavior/emotion-renderer.js': { added: ['../resource-common/files', '../resource-gate/gate', '../resource-scheduler/admission'] },
  'behavior/retaliation.js': { added: ['../core/utils'] },
  'behavior/repeat.js': { removed: ['../message/message-reader', '../persona/persona'] },
  'chat/agent-chat-bridge.js': { removed: ['../message/message-reader'] },
  'chat/chat-result-flow.js': { added: ['../agent/worker-submission', '../resource-workers/agent-payload'], removed: ['../lifecycle/bot-resolver'] },
  'chat/chat-send-flow.js': { added: ['../media/voice/tts-resource'] },
  'chat/chat-jailbreak-flow.js': { removed: ['../message/message-reader'] },
  'chat/chat-tools.js': { added: ['../agent/safety', '../agent/pending', '../media/backpressure/media-queue', '../resource-scheduler/admission'], removed: ['../media/image/image-analyzer'] },
  'commands/agent-command.js': { added: ['../agent/config', '../agent/worker-submission', '../resource-workers/agent-payload'], removed: ['../agent/skill-hub', '../agent/engine', '../agent/engine', '../agent/queue'] },
  'commands/emotion-command.js': { added: ['../resource-workers/task-client'], removed: ['../behavior/emotion-renderer', 'koishi'] },
  'commands/memory-command.js': {
    removed: [
      '../agent/config', '../agent/config', '../agent/config',
      '../agent/memory', '../agent/memory', '../agent/memory',
    ],
  },
  'commands/plan-command.js': { added: ['../agent/worker-submission', '../resource-workers/agent-payload'], removed: ['../agent/engine', '../agent/queue'] },
  'commands/voice-command.js': { added: ['../media/voice/tts', '../media/voice/tts-resource'] },
  'conversation.js': { added: ['./daily-precompute/precompute-index', './resource-workers/background-llm-submission', 'fs', 'fs', 'fs'], removed: ['./message/message-reader', './core/api', './core/runtime-config'] },
  'diagnostics/health-check.js': { added: ['../resource-gate/gate', '../resource-scheduler/admission'] },
  'handler.js': { added: ['./core/api'] },
  'index.js': { added: ['./bot-mode/command-classifier', './bot-mode/mode-policy', './bot-mode/mode-state', './bot-mode/status-reply'] },
  'agent/fetch-reader.js': { added: ['../core/utils'], removed: ['dns', 'net'] },
  'behavior/runtime-settings.js': { removed: ['fs/promises'] },
  'core/api.js': { removed: ['../agent/fetch-reader'] },
  'core/constants.js': { removed: ['../rulesets/jailbreak'] },
  'core/user-blacklist.js': { removed: ['../behavior/runtime-settings'] },
  'core/utils.js': { added: ['fs', 'fs', 'path', 'dns', 'net', 'fs/promises'], removed: ['../message/message-reader'] },
  'diagnostics/shared-record-text.js': { removed: ['../message/message-reader'] },
  'lifecycle/plugin-lifecycle.js': { added: ['../resource-workers/result-notifier', '../resource-workers/worker-supervisor'] },
  'lifecycle/startup-schedulers.js': { added: ['../daily-precompute/daily-slot-planner', '../daily-precompute/precompute-status', '../resource-workers/background-llm-submission'], removed: ['../behavior/expression/expression-abstractor'] },
  'media/file/file-store.js': { added: ['../../core/utils'] },
  'media/file/file-analyzer.js': { added: ['../../core/utils'], removed: ['../../agent/fetch-reader'] },
  'media/file/incoming-file.js': { added: ['../../core/utils'] },
  'media/image/image-store.js': { added: ['../../core/utils'] },
  'media/voice/voice.js': { removed: ['../../agent/fetch-reader'] },
  'mcp/local-server.js': { added: ['../resource-common/files', '../resource-gate/gate', '../resource-scheduler/admission'], removed: ['../agent/tools/analyze-file'] },
  'message/incoming-message-flow.js': { added: ['../media/backpressure/media-queue', '../media/voice/voice-store', '../resource-scheduler/admission'], removed: ['../core/runtime-config', '../media/file/incoming-file', '../media/image/image-analyzer', '../media/voice/voice'] },
  'message/message-reader.js': { added: ['../core/utils'] },
  'persona/persona-lore-router.js': { added: ['../core/utils'] },
  'persona/persona.js': { added: ['../core/utils'], removed: ['fs', 'fs', 'fs', 'fs'] },
  'reply/safe-send.js': { added: ['../media/voice/tts-resource'] },
  'routing/agent-auto-route-flow.js': { added: ['../agent/worker-submission', '../resource-workers/agent-payload'] },
  'routing/file-quick-read.js': { added: ['../media/backpressure/media-requests'], removed: ['../media/file/file-analyzer'] },
  'routing/group-scene-index.js': { removed: ['../message/message-reader'] },
  'routing/search-context.js': { added: ['../core/utils'], removed: ['../message/message-reader'] },
  'rulesets/jailbreak.js': { added: ['../core/constants'] },
}

function usage() {
  console.error([
    'Usage:',
    '  node scripts/ts-diff-check.js <domain|--all>',
    '  node scripts/ts-diff-check.js --plugin <plugin-name|packages/plugin> [domain|--all]',
    '  node scripts/ts-diff-check.js --plugins',
  ].join('\n'))
}

function normalizeRel(file) {
  return file.replace(/\\/g, '/')
}

function packageRootForPlugin(pluginNameOrPath) {
  const normalized = normalizeRel(pluginNameOrPath)
  if (normalized.startsWith('packages/')) return normalized.replace(/\/$/, '')
  return `packages/${normalized.replace(/\/$/, '')}`
}

function pluginNameFromPackageRoot(packageRoot) {
  return normalizeRel(packageRoot).split('/').pop()
}

function packageExists(packageRoot) {
  return fs.existsSync(path.join(ROOT, packageRoot, 'package.json'))
}

function isDashboardPackage(packageRoot) {
  return pluginNameFromPackageRoot(packageRoot) === 'koishi-plugin-dashboard'
}

function isAiPackage(packageRoot) {
  return pluginNameFromPackageRoot(packageRoot) === AI_PLUGIN
}

function isMigratedPackage(packageRoot) {
  if (isAiPackage(packageRoot)) return true
  return fs.existsSync(path.join(ROOT, packageRoot, 'tsconfig.json'))
    || fs.existsSync(path.join(ROOT, packageRoot, 'src'))
}

function listJsFilesUnder(dir, prefix = '') {
  const result = []
  if (!fs.existsSync(dir)) return result
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? path.posix.join(prefix, entry.name) : entry.name
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      result.push(...listJsFilesUnder(full, rel))
    } else if (entry.isFile() && entry.name.endsWith('.js')) {
      result.push(rel)
    }
  }
  return result.sort()
}

function listCurrentJsFiles(packageRoot) {
  const pkgAbs = path.join(ROOT, packageRoot)
  const files = []
  if (isDashboardPackage(packageRoot)) {
    for (const rootFile of ['index.js', 'standalone.js']) {
      if (fs.existsSync(path.join(pkgAbs, rootFile))) files.push(rootFile)
    }
  }
  const libAbs = path.join(pkgAbs, 'lib')
  for (const file of listJsFilesUnder(libAbs)) files.push(path.posix.join('lib', file))
  return files.sort()
}

function gitOutput(args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' })
}

function gitShow(tag, file) {
  return gitOutput(['show', `${tag}:${file}`])
}

function gitListTree(tag, packageRoot) {
  try {
    return gitOutput(['ls-tree', '-r', '--name-only', tag, packageRoot])
  } catch {
    return ''
  }
}

function listBaselineJsFiles(tag, packageRoot) {
  return gitListTree(tag, packageRoot)
    .split(/\r?\n/)
    .filter(Boolean)
    .filter((file) => file.endsWith('.js'))
    .filter((file) => {
      const rel = normalizeRel(file).slice(`${packageRoot}/`.length)
      return rel.startsWith('lib/') || (isDashboardPackage(packageRoot) && ['index.js', 'standalone.js'].includes(rel))
    })
    .map((file) => normalizeRel(file).slice(`${packageRoot}/`.length))
    .sort()
}

function listDomainFiles(packageRoot, domain, legacyAiDomain) {
  if (!domain || domain === '--all') return listCurrentJsFiles(packageRoot)

  const baseRel = legacyAiDomain ? 'lib' : ''
  const pkgAbs = path.join(ROOT, packageRoot)
  const asRel = normalizeRel(domain).replace(/^\.?\//, '')
  const relFromPackage = baseRel ? path.posix.join(baseRel, asRel) : asRel
  const dirTarget = path.join(pkgAbs, relFromPackage)
  if (fs.existsSync(dirTarget) && fs.statSync(dirTarget).isDirectory()) {
    return fs.readdirSync(dirTarget)
      .filter((file) => file.endsWith('.js'))
      .map((file) => path.posix.join(relFromPackage, file))
      .sort()
  }

  if (asRel.endsWith('.js')) return [relFromPackage]
  return [path.posix.join(baseRel, `${asRel}.js`)]
}

function parseArgs(argv) {
  if (!argv.length) return null
  if (argv[0] === '--plugins') {
    if (argv.length !== 1) return null
    return {
      mode: 'plugins',
      checks: OTHER_PLUGIN_NAMES.map((name) => ({
        packageRoot: packageRootForPlugin(name),
        tag: PLUGINS_TAG,
        domain: '--all',
        legacyAiDomain: false,
      })),
    }
  }
  if (argv[0] === '--plugin') {
    const plugin = argv[1]
    if (!plugin) return null
    return {
      mode: 'single',
      checks: [{
        packageRoot: packageRootForPlugin(plugin),
        tag: isAiPackage(packageRootForPlugin(plugin)) ? AI_TAG : PLUGINS_TAG,
        domain: argv[2] || '--all',
        legacyAiDomain: false,
      }],
    }
  }
  if (argv[0].startsWith('--')) return null
  return {
    mode: 'legacy-ai',
    checks: [{
      packageRoot: AI_PKG,
      tag: AI_TAG,
      domain: argv[0],
      legacyAiDomain: true,
    }],
  }
}

function getAiAllowanceKey(packageRoot, file) {
  if (!isAiPackage(packageRoot)) return file
  return file.startsWith('lib/') ? file.slice('lib/'.length) : file
}

function getAllowedAddedExports(packageRoot, file, allowanceKey) {
  if (isAiPackage(packageRoot)) return ALLOWED_ADDED_EXPORTS[allowanceKey] || []
  const pluginAllowances = ALLOWED_ADDED_EXPORTS_BY_PLUGIN[pluginNameFromPackageRoot(packageRoot)] || {}
  return pluginAllowances[file] || []
}

function isAllowedNewCompiledFile(packageRoot, file) {
  if (isAiPackage(packageRoot)) {
    const allowanceKey = getAiAllowanceKey(packageRoot, file)
    return ALLOWED_NEW_AI_JS_FILES.has(allowanceKey)
  }
  const pluginAllowances = ALLOWED_NEW_JS_FILES_BY_PLUGIN[pluginNameFromPackageRoot(packageRoot)]
  return !!pluginAllowances && pluginAllowances.has(file)
}

function getAllowedRequireChanges(packageRoot, file, allowanceKey) {
  if (isAiPackage(packageRoot)) return ALLOWED_REQUIRE_CHANGES[allowanceKey] || {}
  const pluginAllowances = ALLOWED_REQUIRE_CHANGES_BY_PLUGIN[pluginNameFromPackageRoot(packageRoot)] || {}
  return pluginAllowances[file] || {}
}

function getRequirePaths(src, file) {
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

function diffRequirePaths(originalPaths, compiledPaths) {
  const compiledRemaining = compiledPaths.slice()
  const removed = []
  for (const originalPath of originalPaths) {
    const index = compiledRemaining.indexOf(originalPath)
    if (index >= 0) compiledRemaining.splice(index, 1)
    else removed.push(originalPath)
  }
  return { added: compiledRemaining, removed }
}

function consumeAllowed(items, allowed = []) {
  const remaining = items.slice()
  for (const allowedItem of allowed) {
    const index = remaining.indexOf(allowedItem)
    if (index >= 0) remaining.splice(index, 1)
  }
  return remaining
}

function getExportKeys(src, file) {
  const source = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
  const keys = new Set()

  const collectObjectKeys = (objectLiteral) => {
    for (const prop of objectLiteral.properties) {
      if (ts.isShorthandPropertyAssignment(prop) || ts.isPropertyAssignment(prop) || ts.isMethodDeclaration(prop)) {
        const name = prop.name
        if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) keys.add(name.text)
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

function checkPackage(check) {
  const { packageRoot, tag, domain, legacyAiDomain } = check
  const pluginName = pluginNameFromPackageRoot(packageRoot)
  if (!packageExists(packageRoot)) {
    console.error(`FAIL [${pluginName}]: package not found at ${packageRoot}`)
    return { failures: 1, checked: 0 }
  }

  const files = listDomainFiles(packageRoot, domain, legacyAiDomain)
  let failures = 0
  let checked = 0

  if (domain === '--all') {
    const currentSet = new Set(files)
    const baselineSet = new Set(listBaselineJsFiles(tag, packageRoot))
    const added = files.filter((file) => !baselineSet.has(file))
    const removed = Array.from(baselineSet).filter((file) => !currentSet.has(file))
    const unexpectedAdded = added.filter((file) => !isAllowedNewCompiledFile(packageRoot, file))
    if (unexpectedAdded.length) {
      console.error(`FAIL [${pluginName} --all]: new compiled JS files without baseline: ${unexpectedAdded.join(', ')}`)
      failures++
    }
    if (removed.length) {
      console.error(`FAIL [${pluginName} --all]: baseline JS files missing from compiled output: ${removed.join(', ')}`)
      failures++
    }
  }

  const strictCompiledExportShape = isMigratedPackage(packageRoot)
  for (const file of files) {
    const relPath = `${packageRoot}/${file}`
    let original
    const allowedNewCompiledFile = isAllowedNewCompiledFile(packageRoot, file)
    if (allowedNewCompiledFile) {
      original = ''
    } else {
      try {
        original = gitShow(tag, relPath)
      } catch {
        console.error(`FAIL [${pluginName} ${file}]: missing baseline artifact in ${tag}`)
        failures++
        continue
      }
    }

    const abs = path.join(ROOT, relPath)
    if (!fs.existsSync(abs)) {
      console.error(`FAIL [${pluginName} ${file}]: compiled output file missing`)
      failures++
      continue
    }

    const compiled = fs.readFileSync(abs, 'utf8')
    checked++

    if (strictCompiledExportShape && EXPORT_ASSIGNMENT.test(compiled)) {
      console.error(`FAIL [${pluginName} ${file}]: compiled output uses exports.* assignment`)
      failures++
    }

    for (const re of FORBIDDEN) {
      if (re.test(compiled) && (!original || !re.test(original))) {
        console.error(`FAIL [${pluginName} ${file}]: forbidden pattern added ${re}`)
        failures++
      }
    }

    const doubleQuoteRequires = compiled.match(/require\("[^"]+"\)/g) || []
    const originalDoubleQuotes = original.match(/require\("[^"]+"\)/g) || []
    if (doubleQuoteRequires.length > originalDoubleQuotes.length) {
      console.error(`FAIL [${pluginName} ${file}]: new double-quoted require`)
      failures++
    }

    if (original) {
      const originalRequirePaths = getRequirePaths(original, file)
      const compiledRequirePaths = getRequirePaths(compiled, file)
      const requireDiff = diffRequirePaths(originalRequirePaths, compiledRequirePaths)
      const allowanceKey = getAiAllowanceKey(packageRoot, file)
      const allowedRequireChanges = getAllowedRequireChanges(packageRoot, file, allowanceKey)
      const unexpectedAddedRequires = consumeAllowed(requireDiff.added, allowedRequireChanges.added)
      const unexpectedRemovedRequires = consumeAllowed(requireDiff.removed, allowedRequireChanges.removed)
      if (unexpectedAddedRequires.length || unexpectedRemovedRequires.length) {
        console.error(`FAIL [${pluginName} ${file}]: require paths changed added=[${unexpectedAddedRequires}] removed=[${unexpectedRemovedRequires}]`)
        failures++
      }

      const origKeys = getExportKeys(original, file)
      const compKeys = getExportKeys(compiled, file)
      const allowedAdded = new Set(getAllowedAddedExports(packageRoot, file, allowanceKey))
      const filteredCompKeys = compKeys.filter((key) => origKeys.includes(key) || !allowedAdded.has(key))
      const unexpectedAdded = compKeys.filter((key) => !origKeys.includes(key) && !allowedAdded.has(key))
      const missingKeys = origKeys.filter((key) => !compKeys.includes(key))
      if (missingKeys.length || unexpectedAdded.length || origKeys.join(',') !== filteredCompKeys.join(',')) {
        console.error(`FAIL [${pluginName} ${file}]: exports keys changed [${origKeys}] -> [${compKeys}]`)
        failures++
      }
    }
  }

  if (!failures) console.log(`${pluginName} ${domain || '--all'}: ${checked} files passed artifact checks`)
  return { failures, checked }
}

const parsed = parseArgs(process.argv.slice(2))
if (!parsed) {
  usage()
  process.exit(1)
}

let failures = 0
let checked = 0
for (const check of parsed.checks) {
  const result = checkPackage(check)
  failures += result.failures
  checked += result.checked
}

if (failures) {
  console.error(`\n${failures} diff checks failed`)
  process.exit(1)
}

console.log(`artifact checks passed: ${checked} files`)
