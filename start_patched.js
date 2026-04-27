const { App } = require('koishi')
const path = require('path')

// Monkey-patch Session.prototype.resolve
const core = require('@satorijs/core')
if (!core.Session.prototype.resolve) {
  core.Session.prototype.resolve = function(value) {
    // Resolve computed config values
    if (typeof value === 'function') return value(this)
    return value
  }
  console.log('[PATCH] session.resolve added')
}

// Now start koishi normally via the config file
process.env.KOISHI_CONFIG_FILE = path.resolve(__dirname, 'koishi.yml')
require('koishi/lib/cli')
