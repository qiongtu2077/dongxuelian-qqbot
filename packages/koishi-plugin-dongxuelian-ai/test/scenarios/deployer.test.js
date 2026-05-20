async function run(t) {
  t.section('scenario: dashboard deployer security')

  const fs = require('fs')
  const path = require('path')
  const os = require('os')

  const standalonePath = path.resolve(__dirname, '../../../koishi-plugin-dashboard/standalone.js')
  const dashboardDir = path.dirname(standalonePath)
  const pathsModulePath = path.resolve(dashboardDir, 'lib', 'paths.js')
  const runtimePath = path.resolve(__dirname, '../../../../local-deployer/lib/runtime.cjs')
  const runtime = require(runtimePath)
  const originalKoishiDir = process.env.KOISHI_DIR
  const originalGlobalLocal = process.env.GLOBAL_LOCAL_MODE

  function freshRequireStandalone() {
    delete require.cache[require.resolve(standalonePath)]
    delete require.cache[require.resolve(pathsModulePath)]
    return require(standalonePath)
  }

  try {
    const exeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'deployer-portable-exe-'))
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'deployer-user-data-'))
    const documentsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'deployer-documents-'))
    const appResourceRoot = path.join(exeDir, 'resources', 'app')
    const portablePaths = runtime.resolveAppPaths({
      isPackaged: true,
      distribution: 'portable',
      resourceRoot: appResourceRoot,
      executableDir: exeDir,
      userDataPath: userDataDir,
    })
    const installedPaths = runtime.resolveAppPaths({
      isPackaged: true,
      distribution: 'installed',
      resourceRoot: appResourceRoot,
      executableDir: exeDir,
      documentsPath: documentsDir,
      userDataPath: userDataDir,
    })
    try {
      t.checkEqual('deployer packaged portable workspace defaults beside exe', portablePaths.workspaceRoot, path.join(exeDir, 'LianLianBOT'))
      t.checkEqual('deployer packaged installer workspace defaults under documents', installedPaths.workspaceRoot, path.join(documentsDir, 'LianLianBOT'))
      t.checkEqual('deployer packaged runtime state uses electron userData', portablePaths.runtimeStateRoot, path.resolve(userDataDir))
      t.check('deployer startup path helper does not create workspace', !fs.existsSync(portablePaths.workspaceRoot))
      t.checkEqual('deployer invalid DASHBOARD_PORT falls back to 5150', runtime.parseDashboardPort('not-a-port'), '5150')
      t.check('deployer path guard accepts nested workspace', runtime.isInsidePathCaseAware(portablePaths.workspaceRoot, path.join(portablePaths.workspaceRoot, 'runtime')))

      const nonDashboardPidFile = path.join(userDataDir, 'runtime', 'non-dashboard.pid')
      runtime.writeDashboardPidFile(nonDashboardPidFile, runtime.createDashboardPidRecord({
        pid: 4321,
        resourceRoot: portablePaths.resourceRoot,
        workspaceRoot: portablePaths.workspaceRoot,
        standalonePath: portablePaths.standalonePath,
      }))
      const nonDashboardKills = []
      const nonDashboardCleanup = runtime.cleanupStaleDashboardPid({
        pidFilePath: nonDashboardPidFile,
        appPaths: portablePaths,
        processExists: () => true,
        getProcessCommandLine: () => `"${process.execPath}" "${path.join(exeDir, 'not-dashboard.js')}"`,
        killProcessTree: pid => nonDashboardKills.push(pid),
      })
      t.check('deployer stale pid pointing non Dashboard does not kill', !nonDashboardCleanup.killed && nonDashboardKills.length === 0)
      t.check('deployer stale pid pointing non Dashboard removes pid file', !fs.existsSync(nonDashboardPidFile))

      const dashboardPidFile = path.join(userDataDir, 'runtime', 'dashboard.pid')
      runtime.writeDashboardPidFile(dashboardPidFile, runtime.createDashboardPidRecord({
        pid: 8765,
        resourceRoot: portablePaths.resourceRoot,
        workspaceRoot: portablePaths.workspaceRoot,
        standalonePath: portablePaths.standalonePath,
      }))
      const dashboardKills = []
      const dashboardCleanup = runtime.cleanupStaleDashboardPid({
        pidFilePath: dashboardPidFile,
        appPaths: portablePaths,
        processExists: () => true,
        getProcessCommandLine: () => `"${process.execPath}" "${portablePaths.standalonePath}"`,
        killProcessTree: pid => dashboardKills.push(pid),
      })
      t.check('deployer stale pid pointing Dashboard command kills', dashboardCleanup.killed && dashboardKills[0] === 8765)
      t.check('deployer stale pid pointing Dashboard removes pid file', !fs.existsSync(dashboardPidFile))
    } finally {
      try { fs.rmSync(exeDir, { recursive: true, force: true }) } catch {}
      try { fs.rmSync(userDataDir, { recursive: true, force: true }) } catch {}
      try { fs.rmSync(documentsDir, { recursive: true, force: true }) } catch {}
    }

    delete process.env.KOISHI_DIR
    delete process.env.GLOBAL_LOCAL_MODE
    const dash = freshRequireStandalone()

    t.check('deployer isLoopback accepts 127.0.0.1', dash.isLoopbackAddress('127.0.0.1'))
    t.check('deployer isLoopback accepts ::1', dash.isLoopbackAddress('::1'))
    t.check('deployer isLoopback accepts ::ffff:127.0.0.1', dash.isLoopbackAddress('::ffff:127.0.0.1'))

    t.check('deployer isLoopback rejects 192.168.1.100', !dash.isLoopbackAddress('192.168.1.100'))
    t.check('deployer isLoopback rejects 10.0.0.1', !dash.isLoopbackAddress('10.0.0.1'))
    t.check('deployer isLoopback rejects 8.8.8.8', !dash.isLoopbackAddress('8.8.8.8'))

    t.checkEqual('deployer getRemoteAddress uses socket.remoteAddress', dash.getRemoteAddress({ socket: { remoteAddress: '  10.9.8.7  ' } }), '10.9.8.7')
    t.checkEqual('deployer getRemoteAddress falls back to connection.remoteAddress', dash.getRemoteAddress({ connection: { remoteAddress: '1.2.3.4' } }), '1.2.3.4')
    t.checkEqual('deployer getRemoteAddress prefers socket over connection', dash.getRemoteAddress({ socket: { remoteAddress: '::1' }, connection: { remoteAddress: '9.9.9.9' } }), '::1')
    t.checkEqual('deployer getRemoteAddress empty when missing', dash.getRemoteAddress({}), '')

    t.check(
      'deployer isLocalAuthBypass rejects loopback without GLOBAL_LOCAL_MODE',
      !dash.isLocalAuthBypass({ socket: { remoteAddress: '127.0.0.1' } }),
    )

    process.env.GLOBAL_LOCAL_MODE = '1'
    t.check(
      'deployer isLocalAuthBypass rejects non-loopback with GLOBAL_LOCAL_MODE',
      !dash.isLocalAuthBypass({ socket: { remoteAddress: '192.168.1.100' } }),
    )

    t.check(
      'deployer isLocalAuthBypass allows loopback with GLOBAL_LOCAL_MODE',
      dash.isLocalAuthBypass({ socket: { remoteAddress: '127.0.0.1' } }),
    )

    const expectedDefaultPid = path.join(path.resolve(path.join(dashboardDir, '..', '..')), 'koishi.pid')
    t.checkEqual('deployer KOISHI_PID_FILE defaults under resolved KOISHI_DIR', dash.KOISHI_PID_FILE, expectedDefaultPid)

    const tmpKoishiDir = fs.mkdtempSync(path.join(os.tmpdir(), 'deployer-koishi-dir-'))
    delete require.cache[require.resolve(standalonePath)]
    delete require.cache[require.resolve(pathsModulePath)]
    process.env.KOISHI_DIR = tmpKoishiDir
    try {
      const dashCustom = require(standalonePath)
      t.checkEqual('deployer KOISHI_PID_FILE follows KOISHI_DIR env', dashCustom.KOISHI_PID_FILE, path.join(path.resolve(tmpKoishiDir), 'koishi.pid'))
    } finally {
      try { fs.rmSync(tmpKoishiDir, { recursive: true, force: true }) } catch {}
    }
  } finally {
    if (originalKoishiDir === undefined) delete process.env.KOISHI_DIR
    else process.env.KOISHI_DIR = originalKoishiDir

    if (originalGlobalLocal === undefined) delete process.env.GLOBAL_LOCAL_MODE
    else process.env.GLOBAL_LOCAL_MODE = originalGlobalLocal

    delete require.cache[require.resolve(standalonePath)]
    delete require.cache[require.resolve(pathsModulePath)]
  }
}

module.exports = { run }
