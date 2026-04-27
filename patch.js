const { Session, Bot } = require('@satorijs/core')

if (!Session.prototype.resolve) {
  Session.prototype.resolve = function(value) {
    if (typeof value === 'function') return value(this)
    return value
  }
}

if (!('stripped' in Session.prototype)) {
  Object.defineProperty(Session.prototype, 'stripped', {
    get: function() {
      const elements = this.event?.message?.elements || []
      const filtered = elements.filter(e => e.type !== 'at' && e.type !== 'sharp')
      const hasAt = elements.some(e => e.type === 'at')
      const appel = hasAt && elements.some(e => e.type === 'at' && e.attrs?.id === this.bot?.selfId)
      const content = filtered.map(e => {
        if (e.type === 'text') return e.attrs?.content || ''
        return ''
      }).join('').trim()
      return { elements: filtered, content, hasAt, appel, prefix: '' }
    }
  })
}

if (!Session.prototype.send) {
  Session.prototype.send = async function(content) {
    if (!this.bot || typeof this.bot.sendMessage !== 'function') {
      throw new Error('Bot not available for sending')
    }
    return this.bot.sendMessage(this.channelId, content, this.guildId)
  }
}
