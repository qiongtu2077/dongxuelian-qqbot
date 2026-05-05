/* ==========================================================================
 * @satorijs/core@3.7.0 兼容性补丁
 *
 * 适配范围：本项目的 package.json overrides 锁定 @satorijs/core@3.7.0。
 *           Koishi 4.x 需要 core@^4.6.0，但 adapter-onebot 依赖 core@^3.0.0。
 *           overrides 强制用 3.7.0 解决版本冲突，但 3.7.0 的 Session 原型
 *           缺少 stripped、resolve、send、text 四个方法，导致插件启动报错。
 *           现四个方法均已补丁。
 *
 * 未来升级到 Koishi 5 / @satorijs/core@^4.x 后，此文件可删除。
 * ========================================================================== */
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

// @satorijs/core@3.7.0 缺失 text() 方法
// adapter-onebot 发送消息失败时的错误处理会调用 text()
if (!Session.prototype.text) {
  Session.prototype.text = function(...args) {
    if (typeof this.element?.toString === 'function') return this.element.toString(...args)
    return String(args[0] || '')
  }
}
