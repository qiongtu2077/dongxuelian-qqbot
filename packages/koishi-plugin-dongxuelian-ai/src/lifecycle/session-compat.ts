/* ==========================================================================
 * MODULE: session-compat
 * 职责：安装 @satorijs/core@3.7.0 缺失的 Session stripped / parsed / resolve / send 兼容层。
 * 边界：不处理消息业务、不读写 conversation、不调用 AI API；只补齐 Koishi/Satori session 形状。
 * 状态：仅通过 prototype 标记避免重复安装补丁，不持有业务 Map/Cache。
 * ========================================================================== */
const { h } = require('koishi')

interface ElementLike {
  type?: string
  attrs?: {
    content?: string
    id?: string | number
    qq?: string | number
    userId?: string | number
    user_id?: string | number
  }
  toString?: () => string
}

interface SessionLike {
  app?: { koishi?: { config?: { nickname?: string | string[] } }; config?: { nickname?: string | string[] } }
  elements?: ElementLike[]
  event?: { message?: { elements?: ElementLike[] }; selfId?: string }
  selfId?: string
  bot?: { selfId?: string; sendMessage?: (channelId: string | undefined, content: unknown, guildId?: string) => unknown }
  quote?: { user?: { id?: string } }
  channelId?: string
  guildId?: string
  _stripped?: StrippedSession
  stripped?: StrippedSession
  parsed?: StrippedSession
  __dongxuelianStrippedPatch?: boolean
}

interface StrippedSession {
  hasAt: boolean
  content: string
  appel: boolean
  atSelf: boolean
  prefix: null
}

interface PatchTarget {
  __dongxuelianStrippedPatch?: boolean
}

interface PatchedSessionFactory {
  (event: unknown): SessionLike
  __dongxuelianPatched?: boolean
}

interface KoishiSessionCtor {
  prototype: SessionLike & { resolve?: (value: unknown) => unknown; send?: (content: unknown) => Promise<unknown> }
}

interface KoishiBotCtor {
  prototype: { session?: PatchedSessionFactory }
}

interface SessionCompatibilityOptions {
  KoishiSession?: KoishiSessionCtor
  KoishiBot?: KoishiBotCtor
}

function ignoreSessionAccessorProbeError(error: unknown): void {
  void error
}

function patchElementText(element: ElementLike | string | undefined | null): string {
  if (!element) return ''
  if (typeof element === 'string') return element
  if (element.type === 'text') return String(element.attrs?.content || '')
  if (element.type === 'at') {
    const id = element.attrs?.id || element.attrs?.qq || element.attrs?.userId || element.attrs?.user_id || ''
    return id ? `<at id="${id}"/>` : ''
  }
  if (typeof element.toString === 'function' && element.toString !== Object.prototype.toString) {
    const text = String(element)
    return text === '[object Object]' ? '' : text
  }
  return ''
}

function patchElementsToText(elements: Array<ElementLike | string> | undefined | null): string {
  return Array.isArray(elements) ? elements.map(element => patchElementText(element)).join('') : ''
}

function patchElementId(element: ElementLike | undefined): string {
  return String(element?.attrs?.id || element?.attrs?.qq || element?.attrs?.userId || element?.attrs?.user_id || '')
}

function isBlankTextElement(element: ElementLike | undefined): boolean {
  return element?.type === 'text' && !String(element.attrs?.content || '').trim()
}

function patchStripNickname(session: SessionLike, content: string): string | null {
  const nicknames = session?.app?.koishi?.config?.nickname || session?.app?.config?.nickname || []
  const list = Array.isArray(nicknames) ? nicknames : [nicknames]
  let value = String(content || '')
  if (value.startsWith('@')) value = value.slice(1)
  for (const rawName of list) {
    const name = String(rawName || '')
    if (!name || !value.startsWith(name)) continue
    const rest = value.slice(name.length)
    const match = /^([,\uFF0C\u3001\s]+|$)/.exec(rest)
    if (!match) continue
    return rest.slice(match[0].length).trim()
  }
  return null
}

function patchBuildStripped(session: SessionLike): StrippedSession {
  if (session._stripped && typeof session._stripped === 'object') return session._stripped
  const source = Array.isArray(session.elements) ? session.elements : Array.isArray(session.event?.message?.elements) ? session.event.message.elements : []
  const elements = source.slice()
  let hasAt = false
  let appel = false
  let atSelf = false
  const selfId = String(session.selfId || session.bot?.selfId || session.event?.selfId || '')
  const quoteUserId = String(session.quote?.user?.id || '')
  while (elements[0]?.type === 'at') {
    const id = patchElementId(elements.shift())
    if (selfId && id === selfId) {
      atSelf = true
      appel = true
    }
    if (!quoteUserId || id !== quoteUserId) hasAt = true
    while (isBlankTextElement(elements[0])) elements.shift()
  }
  let content = patchElementsToText(elements).trim()
  if (!hasAt) {
    const stripped = patchStripNickname(session, content)
    if (stripped !== null) {
      appel = true
      content = stripped
    }
  }
  session._stripped = { hasAt, content, appel, atSelf, prefix: null }
  return session._stripped
}

function patchInstallAccessors(target: SessionLike | null | undefined): void {
  if (!target || Object.prototype.hasOwnProperty.call(target, '__dongxuelianStrippedPatch')) return
  Object.defineProperty(target, 'stripped', {
    configurable: true,
    enumerable: false,
    get() { return patchBuildStripped(this) },
    set(value) { if (value && typeof value === 'object') this._stripped = value; else if (value === undefined) this._stripped = undefined },
  })
  Object.defineProperty(target, 'parsed', {
    configurable: true,
    enumerable: false,
    get() { return this.stripped },
    set(value) { this.stripped = value },
  })
  Object.defineProperty(target, '__dongxuelianStrippedPatch', { configurable: true, enumerable: false, value: true })
}

function patchEnsureSession<T>(session: T): T {
  if (!session || typeof session !== 'object') return session
  const runtimeSession = session as SessionLike
  try { if (runtimeSession.stripped !== undefined) return session } catch (error) { ignoreSessionAccessorProbeError(error) }
  patchInstallAccessors(runtimeSession)
  return session
}

function installSessionCompatibility({ KoishiSession, KoishiBot }: SessionCompatibilityOptions = {}): void {
  patchInstallAccessors(KoishiSession && KoishiSession.prototype)

  const originalSessionFactory = KoishiBot && KoishiBot.prototype && KoishiBot.prototype.session
  if (originalSessionFactory && !originalSessionFactory.__dongxuelianPatched) {
    KoishiBot.prototype.session = function(event) {
      const session = originalSessionFactory.call(this, event)
      return patchEnsureSession(session)
    }
    KoishiBot.prototype.session.__dongxuelianPatched = true
  }

  if (KoishiSession && KoishiSession.prototype && !KoishiSession.prototype.resolve) {
    KoishiSession.prototype.resolve = function(value) {
      if (typeof value === 'function') return value(this)
      return value
    }
  }

  if (KoishiSession && KoishiSession.prototype && !KoishiSession.prototype.send) {
    KoishiSession.prototype.send = async function(content) {
      if (!this.bot || typeof this.bot.sendMessage !== 'function') {
        throw new Error('Bot not available for sending')
      }
      return this.bot.sendMessage(this.channelId, h.normalize(content), this.guildId)
    }
  }
}

export = {
  patchElementText,
  patchElementsToText,
  patchElementId,
  patchStripNickname,
  patchBuildStripped,
  patchInstallAccessors,
  patchEnsureSession,
  installSessionCompatibility,
}
