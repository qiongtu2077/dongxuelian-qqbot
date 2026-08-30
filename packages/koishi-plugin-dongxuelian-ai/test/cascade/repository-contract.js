/** Verifies root scripts, workspaces, syntax targets, and local package metadata. */
async function runRepositoryContract(context) {
  const {
    fs, path, dns, spawnSync,
    ROOT, PKG_ROOT, AI_ROOT, LIB, HELP, TEST_ROOT,
    STR, CMD, modules, c, u, p, api, conv, reader, handler, index,  constantsSrc,
    section, pass, fail, skip, check, checkEqual, checkIncludes, checkThrows,
    read, readJson, runSyntaxCheck, runShellSyntaxCheck, gitCheckIgnored, gitTrackedFiles,
    makeLoggerStore, makeSession, makeHandlerState, runHandler, getCounts,
  } = context
  section('1. repository and package health')
  const rootPkg = readJson(path.join(ROOT, 'package.json'))
  checkEqual('root package name', rootPkg.name, 'dongxuelian-qqbot')
  const cascadeEntrySrc = read(path.join(AI_ROOT, 'test', 'cascade-test.js'))
  const cascadeRunnerNames = ['repository-contract', 'coverage-contract', 'module-contract', 'core-contracts', 'message-command-contracts', 'persona-contracts', 'repository-guards', 'output-memory-contracts']
  check('cascade entry delegates independent domain runners', cascadeEntrySrc.split(/\r?\n/).length < 120 && cascadeRunnerNames.every(name => cascadeEntrySrc.includes(`./cascade/${name}`)))
  checkEqual('npm test:quick keeps cascade, public boundary, pipeline, DTO and shared utility entries', rootPkg.scripts && rootPkg.scripts['test:quick'], 'node packages/koishi-plugin-dongxuelian-ai/test/cascade-test.js && node packages/koishi-plugin-dongxuelian-ai/test/public-management-runtime-test.js && node packages/koishi-plugin-dongxuelian-ai/test/pipeline-stage-test.js && node packages/koishi-plugin-dongxuelian-ai/test/dto-boundary-test.js && npm run test:shared-utilities')
  checkEqual('npm test:scenario runs scenario entry', rootPkg.scripts && rootPkg.scripts['test:scenario'], 'node packages/koishi-plugin-dongxuelian-ai/test/scenario-test.js')
  checkEqual('npm test:plugins runs auxiliary plugin tests', rootPkg.scripts && rootPkg.scripts['test:plugins'], 'node packages/koishi-plugin-group-name-at/test/plugin-test.js && node packages/koishi-plugin-defense/test/plugin-test.js && node packages/koishi-plugin-local-video-sender/test/plugin-test.js && node packages/koishi-plugin-daily-report/test/plugin-test.js && node packages/koishi-plugin-dongxuelian-poke/test/plugin-test.js && node packages/koishi-plugin-group-leave-notice/test/plugin-test.js && node packages/koishi-plugin-dongxuelian-help/test/plugin-test.js && node packages/koishi-plugin-pet-bridge/test/plugin-test.js')
  checkEqual('npm test delegates to the unique full entry', rootPkg.scripts && rootPkg.scripts.test, 'npm run test:full')
  const fullTestScript = rootPkg.scripts && rootPkg.scripts['test:full'] || ''
  check('full test entry covers all behavior suites', ['test:quick', 'test:scenario', 'test:plugins', 'test:dashboard', 'test:agent-console'].every(name => fullTestScript.includes(`npm run ${name}`)))
  check('full test entry covers types, generated builds, sync and hygiene', fullTestScript.includes('npm run typecheck:all') && fullTestScript.includes('npm run verify:generated-artifacts') && fullTestScript.includes('npm run verify:ai-plugin-sync') && fullTestScript.includes('npm run verify:workspace-hygiene'))
  checkEqual('npm check uses syntax runner', rootPkg.scripts && rootPkg.scripts.check, 'node scripts/check-syntax.js')
  checkEqual('root package exposes resource cleanup dry-run helper', rootPkg.scripts && rootPkg.scripts['resource:cleanup:dry-run'], 'node scripts/resource-cleanup.js')
  checkEqual('root package exposes resource cleanup apply helper', rootPkg.scripts && rootPkg.scripts['resource:cleanup:apply'], 'node scripts/resource-cleanup.js --apply')
  checkEqual('root package exposes resource loop-stress helper', rootPkg.scripts && rootPkg.scripts['resource:loop-stress'], 'npm run test:resource-loop-stress --prefix packages/koishi-plugin-dongxuelian-ai')
  checkEqual('root package exposes AI plugin sync verifier', rootPkg.scripts && rootPkg.scripts['verify:ai-plugin-sync'], 'node scripts/verify-ai-plugin-sync.js')
  checkEqual('root package exposes generated artifact verifier', rootPkg.scripts && rootPkg.scripts['verify:generated-artifacts'], 'node scripts/verify-generated-artifacts.js')
  checkEqual('root package exposes workspace hygiene verifier', rootPkg.scripts && rootPkg.scripts['verify:workspace-hygiene'], 'node scripts/verify-workspace-hygiene.js')
  const syntaxRunner = require(path.join(ROOT, 'scripts', 'check-syntax.js'))
  const syntaxTargets = syntaxRunner.buildCheckTargets()
  const syntaxFileSet = new Set(syntaxTargets.fileChecks)
  const syntaxModuleSet = new Set(syntaxTargets.moduleInputChecks)
  check('syntax runner check dirs exist', Array.isArray(syntaxTargets.missingDirs) && syntaxTargets.missingDirs.length === 0, JSON.stringify(syntaxTargets.missingDirs || []))
  check('syntax runner covers AI index syntax', syntaxFileSet.has('packages/koishi-plugin-dongxuelian-ai/lib/index.js'))
  check('syntax runner covers chat prompt builder syntax', syntaxFileSet.has('packages/koishi-plugin-dongxuelian-ai/lib/chat/chat-prompt-builder.js'))
  check('syntax runner covers reply timing syntax', syntaxFileSet.has('packages/koishi-plugin-dongxuelian-ai/lib/reply/reply-timing.js'))
  check('syntax runner covers affect router syntax', syntaxFileSet.has('packages/koishi-plugin-dongxuelian-ai/lib/behavior/affect-router.js'))
  check('syntax runner covers sticker shadow syntax', syntaxFileSet.has('packages/koishi-plugin-dongxuelian-ai/lib/behavior/sticker-shadow.js'))
  check('syntax runner covers startup schedulers syntax', syntaxFileSet.has('packages/koishi-plugin-dongxuelian-ai/lib/lifecycle/startup-schedulers.js'))
  check('syntax runner covers persona runtime plan syntax', syntaxFileSet.has('packages/koishi-plugin-dongxuelian-ai/lib/persona/persona-runtime-plan.js'))
  check('syntax runner covers persona profile syntax', syntaxFileSet.has('packages/koishi-plugin-dongxuelian-ai/lib/persona/persona-profile.js'))
  check('syntax runner covers persona profile sources syntax', syntaxFileSet.has('packages/koishi-plugin-dongxuelian-ai/lib/persona/persona-profile-sources.js'))
  check('syntax runner covers web search tool syntax', syntaxFileSet.has('packages/koishi-plugin-dongxuelian-ai/lib/agent/tools/web-search.js'))
  check('syntax runner covers web fetch tool syntax', syntaxFileSet.has('packages/koishi-plugin-dongxuelian-ai/lib/agent/tools/web-fetch.js'))
  check('syntax runner covers dashboard standalone syntax', syntaxFileSet.has('packages/koishi-plugin-dashboard/standalone.js'))
  check('syntax runner covers dashboard route modules', syntaxFileSet.has('packages/koishi-plugin-dashboard/lib/routes/config.js'))
  check('syntax runner covers daily report analyzer syntax', syntaxFileSet.has('packages/koishi-plugin-daily-report/lib/ai-analyzer.js'))
  check('syntax runner covers local deployer runtime syntax', syntaxFileSet.has('local-deployer/lib/runtime.cjs'))
  check('syntax runner covers resource cleanup script syntax', syntaxFileSet.has('scripts/resource-cleanup.js'))
  check('syntax runner covers AI sync verifier syntax', syntaxFileSet.has('scripts/verify-ai-plugin-sync.js'))
  check('syntax runner no longer module-checks frontend TS source', syntaxModuleSet.size === 0)
  check('syntax runner avoids checked-in dist bundles', !syntaxTargets.fileChecks.some(file => file.includes('/dist/')))
  check('syntax runner keeps npm check command short for Windows', rootPkg.scripts.check.length < 120)
  const aiPackageManifest = readJson(path.join(AI_ROOT, 'package.json'))
  check('AI package resource test includes cleanup regression', aiPackageManifest.scripts && aiPackageManifest.scripts['test:resource'] && aiPackageManifest.scripts['test:resource'].includes('test:resource-cleanup'))
  checkEqual('AI package exposes cleanup regression entry', aiPackageManifest.scripts && aiPackageManifest.scripts['test:resource-cleanup'], 'node test/resource-cleanup-test.js')
  checkEqual('AI package exposes loop-stress regression entry', aiPackageManifest.scripts && aiPackageManifest.scripts['test:resource-loop-stress'], 'node test/resource-loop-stress-test.js')
  const syncVerifyResult = spawnSync(process.execPath, ['scripts/verify-ai-plugin-sync.js', '--json'], { cwd: ROOT, encoding: 'utf8' })
  check('AI sync verifier exits 0 in local workspace', syncVerifyResult.status === 0, `status=${syncVerifyResult.status} stdout=${syncVerifyResult.stdout} stderr=${syncVerifyResult.stderr}`)
  if (syncVerifyResult.status === 0) {
    try {
      const syncSummary = JSON.parse(String(syncVerifyResult.stdout || '{}'))
      check('AI sync verifier reports ok', syncSummary.ok === true, JSON.stringify(syncSummary))
      check('AI sync verifier detects linked or copied install mode', syncSummary.installMode === 'linked' || syncSummary.installMode === 'copied', JSON.stringify(syncSummary))
    } catch (error) {
      fail('AI sync verifier outputs JSON', error && error.message || String(error))
    }
  }
  checkEqual('npm start uses start.js', rootPkg.scripts && rootPkg.scripts.start, 'node start.js')
  check('workspace package glob exists', Array.isArray(rootPkg.workspaces) && rootPkg.workspaces.includes('packages/*'))
  const localDeployerPkg = readJson(path.join(ROOT, 'local-deployer', 'package.json'))
  const localDeployerBuild = localDeployerPkg.build || {}
  const localDeployerWin = localDeployerBuild.win || {}
  const localDeployerWinTarget = typeof localDeployerWin.target === 'string' ? [localDeployerWin.target] : (localDeployerWin.target || [])
  check('local deployer win target includes portable', Array.isArray(localDeployerWinTarget) && localDeployerWinTarget.includes('portable'))
  check('local deployer win target includes setup installer', Array.isArray(localDeployerWinTarget) && localDeployerWinTarget.includes('nsis'))
  check('local deployer package includes runtime helpers', Array.isArray(localDeployerBuild.files) && localDeployerBuild.files.includes('lib/**/*'))
  const localDeployerReleaseSrc = read(path.join(ROOT, 'local-deployer', 'scripts', 'build-release.cjs'))
  check('local deployer release keeps portable and setup artifacts separate', localDeployerReleaseSrc.includes('LianLianBOT-Deployer-Portable') && localDeployerReleaseSrc.includes('LianLianBOT-Deployer-Setup'))
  check('local deployer release packages portable zip and setup exe', localDeployerReleaseSrc.includes('portable zip created') && localDeployerReleaseSrc.includes('setup exe copied'))

  const packageDirs = fs.readdirSync(PKG_ROOT, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => path.join(PKG_ROOT, entry.name))
    .filter(dir => fs.existsSync(path.join(dir, 'package.json')))
    .sort()

  check('all expected local packages exist', packageDirs.length >= 7, `found ${packageDirs.length}`)
  for (const dir of packageDirs) {
    const pkg = readJson(path.join(dir, 'package.json'))
    const entry = path.join(dir, pkg.main || 'lib/index.js')
    check(`${pkg.name} main exists`, fs.existsSync(entry), entry)
    runSyntaxCheck(`${pkg.name} main syntax`, entry)
    try {
      const loaded = require(entry)
      check(`${pkg.name} plugin name exported`, typeof loaded.name === 'string' && loaded.name.length > 0)
    } catch (error) {
      fail(`${pkg.name} require`, error.message)
    }
  }

  for (const [depName, depValue] of Object.entries(rootPkg.dependencies || {})) {
    if (!String(depValue).startsWith('file:')) continue
    const depPath = path.join(ROOT, depValue.slice('file:'.length))
    check(`local dependency path exists: ${depName}`, fs.existsSync(depPath), depPath)
    const depPkgFile = path.join(depPath, 'package.json')
    check(`local dependency has package.json: ${depName}`, fs.existsSync(depPkgFile), depPkgFile)
    if (fs.existsSync(depPkgFile)) {
      const depPkg = readJson(depPkgFile)
      checkEqual(`local dependency name matches: ${depName}`, depPkg.name, depName)
    }
  }
  return { rootPkg }
}

module.exports = { runRepositoryContract }
