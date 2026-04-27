const { Session } = require('@satorijs/core')

// Monkey-patch missing methods in @satorijs/core@3.7.0
if (!Session.prototype.resolve) {
  Session.prototype.resolve = function(value) {
    if (typeof value === 'function') return value(this)
    return value
  }
}

if (!('stripped' in Session.prototype)) {
  Object.defineProperty(Session.prototype, 'stripped', {
    get: function() {
      return this.event?.message?.elements?.filter(e => 
        e.type !== 'at' && e.type !== 'sharp'
      ) || []
    }
  })
}

console.log('[PATCH] Session patches applied')

// Now run koishi start
require('koishi/lib/cli/start')
