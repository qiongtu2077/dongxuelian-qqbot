const { makeCtx, makeSession, runMiddleware, installFakeTimers, flushAsync } = require('../fake/koishi')
const { createTestDataDir, reloadPlugin, withDataEnv } = require('../fake/file')
const { h } = require('koishi')

function applyPlugin(plugin, harness) {
  plugin.apply(harness.ctx)
  return harness
}

function createScenario(options = {}) {
  const data = createTestDataDir(options.data || {})
  const restoreEnv = withDataEnv(data.dataDir)
  const clock = options.fakeTimers === false ? null : installFakeTimers(options.now || 1700000000000)
  const originalElementWarn = h.warn
  if (options.silenceElementWarnings !== false) h.warn = () => {}
  const plugin = reloadPlugin()
  const harness = makeCtx(options.ctx || {})
  applyPlugin(plugin, harness)
  return {
    data,
    clock,
    plugin,
    harness,
    makeSession,
    run: (session, runOptions) => runMiddleware(harness, session, runOptions),
    async ready() {
      await harness.ctx.emit('ready')
      await flushAsync(4)
    },
    async teardown() {
      await flushAsync(20)
      if (clock) clock.uninstall()
      h.warn = originalElementWarn
      restoreEnv()
      data.cleanup()
      await flushAsync(2)
    },
  }
}

async function withScenario(options, fn) {
  const scenario = createScenario(options)
  try {
    return await fn(scenario)
  } finally {
    await scenario.teardown()
  }
}

module.exports = {
  createScenario,
  withScenario,
}
