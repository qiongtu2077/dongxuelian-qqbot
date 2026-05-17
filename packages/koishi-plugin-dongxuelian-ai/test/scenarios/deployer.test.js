async function run(t) {
  t.section('scenario: dashboard deployer security')

  const fs = require('fs')
  const path = require('path')
  const os = require('os')

  const standalonePath = path.resolve(__dirname, '../../../koishi-plugin-dashboard/standalone.js')
  const dashboardDir = path.dirname(standalonePath)
  const originalKoishiDir = process.env.KOISHI_DIR
  const originalGlobalLocal = process.env.GLOBAL_LOCAL_MODE

  function freshRequireStandalone() {
    delete require.cache[require.resolve(standalonePath)]
    return require(standalonePath)
  }

  try {
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
  }
}

module.exports = { run }
