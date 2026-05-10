/* ==========================================================================
 * 东雪莲 AI 插件 — 核心入口
 *
 * 拆分/修改前先阅读：
 *   - AI协作规则.md（架构红线、修改规范、测试规范）
 *   - 教训总结.md（代码拆分 5 步法、部署教训）
 *   - 测试文件维护指南.md（新增模块的 check/test 同步清单）
 *
 * 红线：
 *   1. 拆模块时先加后删，每步 node -c + npm run test:quick 验证
 *   2. 行为变更优先加 scenario，不要加源码字符串扫描
 *   3. 新模块只从 constants/utils/api/conversation/persona 导入，
 *      不反向 import index.js
 *   4. 非必要不要在此文件加职责，优先考虑独立模块
 *
 * ARCHITECTURE CONSTRAINT:
 * - 本文件是路由入口，职责：中间件编排 + apply() 注册 + 状态初始化。
 * - 禁止在此文件新增 Map/Set/全局缓存。新状态归属到对应子模块。
 * - 禁止在此文件直接调用 AI API 或低层 IO。统一走 api.js / utils.js。
 * - 新增函数超过 50 行 → 独立模块。
 * ========================================================================== */
const fs = require('fs/promises')
const path = require('path')
const satoriCore = require('@satorijs/core')
const KoishiSession = satoriCore.Session
const KoishiBot = satoriCore.Bot
const { handleCommand } = require('./handler')
const { analyzeIncomingMessage, normalizeText } = require('./message-reader')
const { loadStickerCache, sendReply } = require('./reply')
const { resolveForwardSummary } = require('./forward')
const { prepareVisionRequest, isVisionSession } = require('./vision')

// ===== @satorijs/core@3.7.0 兼容补丁：Session 缺失方法 =====
function __patchBuildStripped(session) {
  if (session._stripped && typeof session._stripped === 'object') return session._stripped
  const source = Array.isArray(session.elements) ? session.elements : Array.isArray(session.event?.message?.elements) ? session.event.message.elements : []
  const elements = source.slice()
  let hasAt = false
  let appel = false
  let atSelf = false
  const selfId = String(session.selfId || session.bot?.selfId || session.event?.selfId || '')
  const quoteUserId = String(session.quote?.user?.id || '')
  while (elements[0]?.type === 'at') {
    const id = String(elements.shift()?.attrs?.id || '')
    if (selfId && id === selfId) { atSelf = true; appel = true }
    if (!quoteUserId || id !== quoteUserId) hasAt = true
    while (elements[0]?.type === 'text' && !String(elements[0].attrs?.content || '').trim()) { elements.shift() }
  }
  let content = elements.map(function(element) {
    if (!element) return ''
    if (element.type === 'text') return String(element.attrs?.content || '')
    if (element.type === 'at') {
      const id = element.attrs?.id || ''
      return id ? '<at id="' + id + '"/>' : ''
    }
    return ''
  }).join('').trim()
  if (!hasAt) {
    const nicknames = session?.app?.koishi?.config?.nickname || session?.app?.config?.nickname || []
    const list = Array.isArray(nicknames) ? nicknames : [nicknames]
    let val = content
    if (val.startsWith('@')) val = val.slice(1)
    for (let index = 0; index < list.length; index++) {
      const name = String(list[index] || '')
      if (!name || !val.startsWith(name)) continue
      const rest = val.slice(name.length)
      const match = /^([,\uFF0C\u3001\s]+|$)/.exec(rest)
      if (!match) continue
      appel = true; content = rest.slice(match[0].length).trim(); break
    }
  }
  session._stripped = { hasAt: hasAt, content: content, appel: appel, atSelf: atSelf, prefix: null }
  return session._stripped
}

function __patchInstallAccessors(target) {
  if (!target || target.__dongxuelianStrippedPatch) return
  Object.defineProperty(target, 'stripped', { configurable: true, enumerable: false,
    get: function() { return __patchBuildStripped(this) },
    set: function(v) { if (v && typeof v === 'object') this._stripped = v; else if (v === undefined) this._stripped = undefined }
  })
  Object.defineProperty(target, 'parsed', { configurable: true, enumerable: false,
    get: function() { return this.stripped }, set: function(v) { this.stripped = v }
  })
  Object.defineProperty(target, '__dongxuelianStrippedPatch', { value: true, configurable: true, enumerable: false })
}

// 安装到 Session 原型
__patchInstallAccessors(KoishiSession && KoishiSession.prototype)

// 包装 Bot.prototype.session()
const __origSession = KoishiBot.prototype.session
if (!__origSession.__dongxuelianPatched) {
  KoishiBot.prototype.session = function(event) {
    const session = __origSession.call(this, event)
    if (!session || typeof session !== 'object') return session
    try { if (session.stripped !== undefined) return session } catch (error) {}
    __patchInstallAccessors(session)
    return session
  }
  KoishiBot.prototype.session.__dongxuelianPatched = true
}

// Resolve
if (!KoishiSession.prototype.resolve) {
  KoishiSession.prototype.resolve = function(value) {
    if (typeof value === 'function') return value(this)
    return value
  }
}

// Send（需 h.normalize 解析 CQ 码）
if (!KoishiSession.prototype.send) {
  KoishiSession.prototype.send = async function(content) {
    if (!this.bot || typeof this.bot.sendMessage !== 'function') throw new Error('Bot not available for sending')
    return this.bot.sendMessage(this.channelId, require('koishi').h.normalize(content), this.guildId)
  }
}

const {
  resetPoliticalDetectCache,
  clearSensitiveRuntimeState,
  notifySensitiveHandlers,
  handleSensitiveMessage,
} = require('./sensitive')
const {
  loadRepeatConfig,
  setRepeatEnabled,
  getRepeatEnabledCache,
  buildRepeatCandidate,
  checkGroupRepeat,
} = require('./repeat')
const {
  chat,
  loadSkills, loadSkillsContentCache,
  callOpenAI,
  getSkillsCount,
} = require('./chat')
const {
  loadConfig, resetConfigCache,
  getThinkingEnabled, setThinkingEnabled,
  isAdminUserId, getAdminUserIds,
} = require('./runtime-config')
const {
  DATA_DIR, PLUGIN_VERSION,
  PERSONA_GROUPS_FILE, PERSONA_USERS_FILE, EVENT_DUMP_DIR,
  RANDOM_WHITELIST_FILE, RANDOM_RATE_FILE,
  MAINTENANCE_FILE,
  RANDOM_TRIGGER_RATE_BASE, RANDOM_TRIGGER_WARMUP, RANDOM_TRIGGER_RAMP,
  DEFAULT_GROUP_RANDOM_WHITELIST,
  MAX_CHANNEL_SHARED_MESSAGES,
  EVENT_DUMP_ARM_EXPIRE_MS,
  USER_BLACKLIST_FILE, VIDEO_BLACKLIST_FILE,
  SUMMARY_WHITELIST_FILE, TODAY_CACHE_PREFIX,
  THINKING_MODE_FILE,
  POLITICAL_HANDLER_DIR, POLITICAL_DETECT_FILE, SENSITIVE_CACHE_PREFIX,
  CONVERSATIONS_DIR,
  NUMERIC_GROUP_ID_RE,
} = require('./constants')
const {
  loadPersonaGroups,
  loadPersonaUsers,
  resolvePersona,
  loadPersonalSkill,
} = require('./persona')
const {
  channelSharedCache,
  channelTodayCache,
  getChannelKey,
  saveSharedChannelTurn,
  findChannelMessageById, collectReplyChain,
  getQuotedMessageNote, getSharedContextNote,
  analyzeChannelSensitive,
} = require('./conversation')
const {
  isReservedCommand, getSenderUserId, hasAdminPermission,
  stripMentions, collapseRepeatedBotCalls,
  sanitizeUserName,
  extractAtIds,
  isDirectAtBot, getBotMentionCount, hasOtherMentions,
  formatPercent,
  readTextFile, writeTextFile, readJsonFile, writeJsonFile,
  shouldTriggerRandom, calculateWillFactor,
  normalizeUrl,
  sanitizeFileToken, safeJsonStringify,
  todayCst,
} = require('./utils')

// @satorijs/core@3.7.0 缺少 stripped / parsed / resolve / send，这里随插件加载安装兼容补丁。
function patchElementText(element) {
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

function patchElementsToText(elements) {
  return Array.isArray(elements) ? elements.map(element => patchElementText(element)).join('') : ''
}

function patchElementId(element) {
  return String(element?.attrs?.id || element?.attrs?.qq || element?.attrs?.userId || element?.attrs?.user_id || '')
}

function patchStripNickname(session, content) {
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

function patchBuildStripped(session) {
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
    while (elements[0]?.type === 'text' && !String(elements[0].attrs?.content || '').trim()) elements.shift()
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

function patchInstallAccessors(target) {
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

function patchEnsureSession(session) {
  if (!session || typeof session !== 'object') return session
  try { if (session.stripped !== undefined) return session } catch {}
  patchInstallAccessors(session)
  return session
}

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
    return this.bot.sendMessage(this.channelId, content, this.guildId)
  }
}

exports.name = 'dongxuelian-ai'

let runtimeSettingsLoaded = false
let runtimeSettingsFingerprint = ''
let randomWhitelistCache = new Set(DEFAULT_GROUP_RANDOM_WHITELIST)
let randomRateCache = new Map()
const channelQueues = new Map()
const channelQueueDepth = new Map()
const channelMissCount = new Map()
const armedEventDumpCache = new Map()
const channelMutedUntil = new Map()
const lastRandomReplyTs = new Map()
const channelPendingRandom = new Map()

const sendFailState = {
  streak: 0,
  lastFailAt: 0,
  lastNotifyAt: 0,
  restrictedUntil: 0,
  maxStreak: 2,
  cooldownMs: 5 * 60 * 1000,
  restrictDurationMs: 60 * 60 * 1000,
  notifyIntervalMs: 30 * 1000,
}

let userBlacklistCache = null
let userBlacklistFingerprint = ''
const lastEmotionCache = new Map()

// 人格系统：per-group persona 配置
// 格式: { "channelKey": { persona: "name" | null } }

// 原子写入 JSON（先写临时文件再 rename，防并发损坏）

// 人格系统：per-user persona 配置
// 格式: { "userId": "personaName" }

// 计算最终 persona：用户级 > 群级 > 默认

function enqueueForChannel(channelKey, fn, maxDepth) {
  const existing = channelQueues.get(channelKey) || Promise.resolve()
  const next = existing
    .then(() => {
      const depth = channelQueueDepth.get(channelKey) || 0
      if (depth >= maxDepth) return
      channelQueueDepth.set(channelKey, depth + 1)
      const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error('queue timeout (60s)')), 60000))
      return Promise.race([fn(), timeoutPromise])
    })
    .catch(() => {})
    .then(() => {
      const d = channelQueueDepth.get(channelKey) || 1
      if (d <= 1) channelQueueDepth.delete(channelKey)
      else channelQueueDepth.set(channelKey, d - 1)
      if (channelQueues.get(channelKey) === next) channelQueues.delete(channelKey)
    })
  channelQueues.set(channelKey, next)
}

function getRandomTriggerRate(channelKey) {
  const baseRate = getRandomTriggerBaseRate(channelKey)
  if (!baseRate || baseRate <= 0) return 0
  const miss = channelMissCount.get(channelKey) || 0
  if (miss < RANDOM_TRIGGER_WARMUP) return baseRate
  return baseRate + (miss - RANDOM_TRIGGER_WARMUP) * RANDOM_TRIGGER_RAMP
}

// 输入净化：移除常见 prompt injection 结构标签，防止角色标签注入（PCFI 思路）

// 昵称净化：剔除游戏前缀、书名号、各类括号等特殊字符，限制长度防止昵称内容污染回复

function getRandomTriggerBaseRate(channelKey) {
  return randomRateCache.get(String(channelKey || '')) || RANDOM_TRIGGER_RATE_BASE
}

// 白名单为空时视为全群禁用主动回复，只有显式加入的群才允许触发。
function getRandomWhitelistStatus(channelKey) {
  return randomWhitelistCache.has(String(channelKey || ''))
}

// --- 原始事件抓取 --- //

// 清理过期的一次性抓取状态，避免命令挂太久。
function getArmedEventDump(channelKey = '') {
  const key = String(channelKey || '')
  const state = armedEventDumpCache.get(key)
  if (!state) return null
  if (Date.now() - state.armedAt > EVENT_DUMP_ARM_EXPIRE_MS) {
    armedEventDumpCache.delete(key)
    return null
  }
  return state
}

// 开启当前频道的下一条事件抓取。
function armEventDump(session) {
  const channelKey = getChannelKey(session)
  const state = {
    armedAt: Date.now(),
    armedBy: getSenderUserId(session),
  }
  armedEventDumpCache.set(channelKey, state)
  return state
}

// 取消当前频道的下一条事件抓取。
function clearArmedEventDump(channelKey = '') {
  armedEventDumpCache.delete(String(channelKey || ''))
}

// 生成安全文件名，避免把群号和消息号直接拼出非法路径。

// 安全序列化复杂对象，避免循环引用或 bigint 把抓取过程搞挂。

// 把当前会话的原始 event 和解析结果落盘，供后续精修消息记录解析。
async function dumpSessionEvent(session, analyzed, plain, memoryText) {
  const now = new Date()
  const dateStamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`
  const timeStamp = `${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}${String(now.getSeconds()).padStart(2, '0')}`
  const channelToken = sanitizeFileToken(getChannelKey(session))
  const messageToken = sanitizeFileToken(session.messageId || 'no-message-id')
  const fileName = `ai-event-${dateStamp}-${timeStamp}-${channelToken}-${messageToken}.json`
  const filePath = path.join(EVENT_DUMP_DIR, fileName)

  const payload = {
    capturedAt: now.toISOString(),
    analyzed,
    session: {
      platform: session.platform,
      type: session.type,
      subtype: session.subtype,
      selfId: session.selfId,
      userId: session.userId,
      channelId: session.channelId,
      guildId: session.guildId,
      messageId: session.messageId,
      content: session.content,
      plain,
      memoryText,
      author: session.author,
      quote: session.quote,
      event: session.event,
    },
  }

  await fs.mkdir(EVENT_DUMP_DIR, { recursive: true })
  await fs.writeFile(filePath, safeJsonStringify(payload), 'utf8')
  return filePath
}

// --- 联网搜索 --- //

// 解析接口域名，统一给联网能力判断使用。

// 判断是否为 DashScope / 百炼的 OpenAI 兼容接口。

// 判断是否为 OpenAI 官方接口。

// 根据模型 ID 查找显示名称
// 从消息内容中提取图片 URL

// 根据模型 ID/Name 查找显示名称

// 汇总当前接口的联网搜索能力，避免命令提示和请求逻辑各写一套判断。

// 生成联网状态文本，给命令输出和状态页复用。

async function getFileFingerprint(filePath) {
  try {
    const stat = await fs.stat(filePath)
    return `${stat.mtimeMs}:${stat.size}`
  } catch {
    return 'missing'
  }
}

async function getRuntimeSettingsFingerprint() {
  const [whitelistStamp, rateStamp] = await Promise.all([
    getFileFingerprint(RANDOM_WHITELIST_FILE),
    getFileFingerprint(RANDOM_RATE_FILE),
  ])
  return `${whitelistStamp}|${rateStamp}`
}

async function loadRuntimeSettings(force = false) {
  const fingerprint = await getRuntimeSettingsFingerprint()
  if (!force && runtimeSettingsLoaded && fingerprint === runtimeSettingsFingerprint) return

  const [whitelist, rateMap] = await Promise.all([
    readJsonFile(RANDOM_WHITELIST_FILE, [...DEFAULT_GROUP_RANDOM_WHITELIST]),
    readJsonFile(RANDOM_RATE_FILE, {}),
  ])

  randomWhitelistCache = new Set(
    Array.isArray(whitelist)
      ? whitelist.map(item => String(item || '').trim()).filter(item => NUMERIC_GROUP_ID_RE.test(item))
      : [...DEFAULT_GROUP_RANDOM_WHITELIST]
  )

  const nextRateMap = new Map()
  if (rateMap && typeof rateMap === 'object') {
    for (const [channelId, rawRate] of Object.entries(rateMap)) {
      const normalizedId = String(channelId || '').trim()
      const numericRate = Number(rawRate)
      if (!NUMERIC_GROUP_ID_RE.test(normalizedId)) continue
      if (!Number.isFinite(numericRate) || numericRate <= 0 || numericRate > 1) continue
      nextRateMap.set(normalizedId, numericRate)
    }
  }
  randomRateCache = nextRateMap
  runtimeSettingsLoaded = true
  runtimeSettingsFingerprint = fingerprint
}

async function loadUserBlacklist(force = false) {
  const fingerprint = await getFileFingerprint(USER_BLACKLIST_FILE)
  if (!force && userBlacklistCache !== null && fingerprint === userBlacklistFingerprint) return userBlacklistCache

  const raw = await readJsonFile(USER_BLACKLIST_FILE, [])
  userBlacklistCache = new Set(Array.isArray(raw) ? raw.map(String) : [])
  userBlacklistFingerprint = fingerprint
  return userBlacklistCache
}

async function notifyAdminsSendFailure(ctx, bot) {
  const admins = getAdminUserIds(true)
  const msg = '⚠️ 连续发送失败，已进入消息受限状态'
  await Promise.allSettled(
    [...admins].map(async (id) => {
      try {
        if (typeof bot?.sendPrivateMessage === 'function') {
          await bot.sendPrivateMessage(id, msg)
        } else if (bot?.internal?.sendPrivateMsg) {
          await bot.internal.sendPrivateMsg(id, msg)
        }
      } catch (error) {
        ctx.logger('dongxuelian-ai').warn('notify admin send failure: ' + error.message)
      }
    })
  )
}

async function safeSendReply(ctx, session, reply, isRandom = false) {
  const now = Date.now()
  if (sendFailState.streak > 0 && now - sendFailState.lastFailAt > sendFailState.cooldownMs) {
    sendFailState.streak = 0
  }
  if (now < sendFailState.restrictedUntil) {
    if (!hasAdminPermission(session)) {
      if (!isDirectAtBot(session)) {
        ctx.logger('dongxuelian-ai').warn('safeSendReply: restricted, skipping reply')
        return
      }
      try {
        return await session.send('我被盯上了，有内鬼终止交易')
      } catch (error) {
        ctx.logger('dongxuelian-ai').error(`safeSendReply: restricted notice failed: ${error.message}`)
        return
      }
    }
  }
  try {
    const sentCount = await sendReply(ctx, session, reply, isRandom)
    if (sentCount > 0) {
      sendFailState.streak = 0
      sendFailState.lastFailAt = 0
    }
  } catch (error) {
    const errMsg = String(error?.message || '')
    // 只对 retcode 1200（QQ 风控）走冻结逻辑，其他错误直接抛
    if (!/retcode:\s*1200/.test(errMsg)) {
      ctx.logger('dongxuelian-ai').warn(`safeSendReply: non-1200 error skipped: ${errMsg.slice(0, 120)}`)
      throw error
    }
    sendFailState.streak++
    sendFailState.lastFailAt = now
    ctx.logger('dongxuelian-ai').error(`safeSendReply: send failed (streak=${sendFailState.streak}): ${error.message}`)
    if (sendFailState.streak <= 2) {
      sendFailState.lastNotifyAt = now
      notifyAdminsSendFailure(ctx, session.bot).catch(() => {})
    } else if (now - sendFailState.lastNotifyAt > sendFailState.notifyIntervalMs) {
      sendFailState.lastNotifyAt = now
      notifyAdminsSendFailure(ctx, session.bot).catch(() => {})
    }
    if (sendFailState.streak >= sendFailState.maxStreak) {
      sendFailState.restrictedUntil = now + sendFailState.restrictDurationMs
      ctx.logger('dongxuelian-ai').warn(`safeSendReply: restricted for 1 hour due to ${sendFailState.streak} consecutive send failures`)
      // 30 分钟后再次通知管理员（避开风控窗口）
      setTimeout(function() {
        const admins = getAdminUserIds(true)
        const unlockMsg = '🔓 30 分钟已过，风控可能已解除。BOT 冻结期还剩约 30 分钟，届时自动恢复。急需使用可重启 BOT。'
        Promise.allSettled([...admins].map(function(id) {
          try {
            if (typeof session?.bot?.sendPrivateMessage === 'function') {
              return session.bot.sendPrivateMessage(id, unlockMsg)
            }
          } catch {}
        }))
      }, 30 * 60 * 1000)
    }
    throw error
  }
}

exports.buildRepeatCandidate = buildRepeatCandidate
exports.checkGroupRepeat = checkGroupRepeat

exports.apply = (ctx) => {
  ctx.on('ready', async () => {
    await loadRuntimeSettings(true)
    await loadConfig(true)
    await loadSkills()
    await loadSkillsContentCache()
    setThinkingEnabled((await readTextFile(THINKING_MODE_FILE).catch(() => '')).trim() === 'on')
    loadStickerCache()
    loadPersonaGroups()
    loadRepeatConfig()
    loadPersonaUsers()
    // 恢复今日情绪磁盘缓存
    try {
      const files = require('fs').readdirSync(DATA_DIR).filter(f => f.startsWith('today-cache-') && f.endsWith('.json'))
      const today = todayCst()
      for (const f of files) {
        try {
          const raw = require('fs').readFileSync(path.join(DATA_DIR, f), 'utf8')
          const data = JSON.parse(raw)
          if (data && data.date === today && Array.isArray(data.messages) && data.messages.length > 0) {
            const key = f.replace('today-cache-', '').replace('.json', '')
            channelTodayCache.set(key, { date: today, messages: data.messages })
          }
        } catch {}
      }
    } catch {}
    ctx.logger('dongxuelian-ai').info(`dongxuelian-ai ${PLUGIN_VERSION} loaded`)
  })

  // 定时扫描敏感话题（每 30 分钟）
  setInterval(async () => {
    try {
      const enabled = await readJsonFile(POLITICAL_DETECT_FILE, [])
      if (Array.isArray(enabled)) {
        for (const ch of enabled) {
          analyzeChannelSensitive(ch).catch(() => {})
        }
      }
    } catch {}
  }, 1800000)

  ctx.middleware(async (session, next) => {
    const content = session.content || ''
    const selfId = String(session.selfId || session.bot?.selfId || '')
    if (selfId && String(session.userId || session.author?.id || '') === selfId) return next()

    await loadRuntimeSettings()
    try {
      await fs.access(MAINTENANCE_FILE)
      if (!session.isDirect && !isDirectAtBot(session)) return next()
      const mt = (await fs.readFile(MAINTENANCE_FILE, 'utf8')).trim() || '优化中'
      await session.send(mt).catch(() => {})
      return
    } catch {}

    const analyzed = analyzeIncomingMessage(session, { sanitizeUserName })
    const plain = collapseRepeatedBotCalls(stripMentions(analyzed.plain || content))
    const memoryText = normalizeText(stripMentions(analyzed.memory || plain))
    const directAt = isDirectAtBot(session)

    const forwardSummaryText = await resolveForwardSummary(session, content, ctx)

    const armedEventDump = getArmedEventDump(getChannelKey(session))
    if (armedEventDump) {
      try {
        const dumpPath = await dumpSessionEvent(session, analyzed, plain, memoryText)
        clearArmedEventDump(getChannelKey(session))
        ctx.logger('dongxuelian-ai').info(`captured raw session event: ${dumpPath}`)
        await session.send(`已抓到原始事件：${dumpPath}`)
      } catch (error) {
        clearArmedEventDump(getChannelKey(session))
        ctx.logger('dongxuelian-ai').warn(error)
        await session.send('原始事件抓取失败。')
      }
    }

    if (!plain && !directAt) return next()

    ctx.logger('dongxuelian-ai').info(`entry-debug: userId=${session.userId} isDirect=${!!session.isDirect} guildId=${session.guildId} type=${session.type} subtype=${session.subtype} contentLen=${(session.content||'').length}`)
ctx.logger('dongxuelian-ai').info(`middleware-debug: plain=${JSON.stringify(plain).slice(0, 100)} directAt=${directAt} isDirect=${!!session.isDirect}`)

    if (isReservedCommand(plain)) return next()

    const isPrivate = !!session.isDirect
    const inGuild = !isPrivate
    const channelKey  = getChannelKey(session)
    const currentUserId = session.userId || session.author?.id || session.username
    const userName = sanitizeUserName(
      session.author?.nick ||
      session.author?.name ||
      session.username ||
      '群友'
    )
    const adminCommandMatched =
      /^(?:东雪莲)?测试(?:开|关)$/.test(plain) ||
      /^群聊AI白名单(?:添加|删除|查看|列表)/.test(plain) ||
      /^东雪莲群聊AI概率(?:设置|重置)$/.test(plain) ||
      /^东雪莲联网(?:开|关)$/.test(plain) ||
      /^东雪莲思考(?:开|关)$/.test(plain) ||
      /^解除上限群白名单/.test(plain) ||
      /^敏感话题处理者/.test(plain) ||
      plain === 'AI重载'

    await handleSensitiveMessage(session, ctx, {
      inGuild,
      channelKey,
      analyzed,
      plain,
      userName,
      currentUserId,
      lastEmotionCache,
    })

    if (adminCommandMatched && !hasAdminPermission(session)) {
      return '只有指定管理员能操作这个命令。'
    }

    const whitelistAddMatch = plain.match(/^群聊AI白名单添加\s*(\d+)$/)
    if (whitelistAddMatch) {
      randomWhitelistCache.add(whitelistAddMatch[1])
      await writeJsonFile(RANDOM_WHITELIST_FILE, [...randomWhitelistCache])
      return `已加入群聊AI白名单：${whitelistAddMatch[1]}`
    }

    const whitelistDeleteMatch = plain.match(/^群聊AI白名单删除\s*(\d+)$/)
    if (whitelistDeleteMatch) {
      randomWhitelistCache.delete(whitelistDeleteMatch[1])
      await writeJsonFile(RANDOM_WHITELIST_FILE, [...randomWhitelistCache])
      return `已移出群聊AI白名单：${whitelistDeleteMatch[1]}`
    }

    if (/^群聊AI白名单(?:查看|列表)$/.test(plain)) {
      const whitelist = [...randomWhitelistCache]
      return whitelist.length ? `群聊AI白名单：\n${whitelist.join('\n')}` : '当前白名单为空，等同于所有群都禁止主动回复。'
    }

    // 用户黑名单管理
    const ensureUserBlacklistCache = async () => {
      await loadUserBlacklist()
    }
    const userBlAdd = plain.match(/^用户黑名单添加\s*(\d+)$/)
    if (userBlAdd) {
      const uid = userBlAdd[1]
      if (isAdminUserId(uid)) return '不能对管理员添加黑名单。'
      await ensureUserBlacklistCache()
      userBlacklistCache.add(uid)
      await writeJsonFile(USER_BLACKLIST_FILE, [...userBlacklistCache])
      userBlacklistFingerprint = await getFileFingerprint(USER_BLACKLIST_FILE)
      return `已添加用户黑名单：${uid}`
    }
    const userBlDel = plain.match(/^用户黑名单删除\s*(\d+)$/)
    if (userBlDel) {
      await ensureUserBlacklistCache()
      userBlacklistCache.delete(userBlDel[1])
      await writeJsonFile(USER_BLACKLIST_FILE, [...userBlacklistCache])
      userBlacklistFingerprint = await getFileFingerprint(USER_BLACKLIST_FILE)
      return `已移出用户黑名单：${userBlDel[1]}`
    }
    if (plain === '用户黑名单查看') {
      await ensureUserBlacklistCache()
      const list = [...userBlacklistCache]
      return list.length ? `用户黑名单：\n${list.join('\n')}` : '用户黑名单为空。'
    }

    // 视频黑名单管理
    const vidBlAddG = plain.match(/^视频黑名单添加群\s*(\d+)$/)
    if (vidBlAddG) {
      if (!inGuild) return '这个命令只能在群里使用。'
      const isGA = session.event?.sender?.role === 'owner' || session.event?.sender?.role === 'admin'
      if (!isGA && !hasAdminPermission(session)) return '只有群主、管理员或bot管理员才能操作。'
      const bl = await readJsonFile(VIDEO_BLACKLIST_FILE, { groups: [], users: [] })
      if (!Array.isArray(bl.groups)) bl.groups = []
      if (!bl.groups.includes(vidBlAddG[1])) bl.groups.push(vidBlAddG[1])
      await writeJsonFile(VIDEO_BLACKLIST_FILE, bl)
      return `视频解析已加入群黑名单：${vidBlAddG[1]}`
    }
    const vidBlDelG = plain.match(/^视频黑名单删除群\s*(\d+)$/)
    if (vidBlDelG) {
      if (!inGuild) return '这个命令只能在群里使用。'
      const isGA = session.event?.sender?.role === 'owner' || session.event?.sender?.role === 'admin'
      if (!isGA && !hasAdminPermission(session)) return '只有群主、管理员或bot管理员才能操作。'
      const bl = await readJsonFile(VIDEO_BLACKLIST_FILE, { groups: [], users: [] })
      if (Array.isArray(bl.groups)) bl.groups = bl.groups.filter(g => g !== vidBlDelG[1])
      await writeJsonFile(VIDEO_BLACKLIST_FILE, bl)
      return `视频解析已移出群黑名单：${vidBlDelG[1]}`
    }
    if (plain === '视频黑名单查看') {
      const bl = await readJsonFile(VIDEO_BLACKLIST_FILE, { groups: [], users: [] })
      if (Array.isArray(bl.groups) && bl.groups.length) return `视频黑名单群：\n${bl.groups.join('\n')}`
      return '视频群黑名单为空。'
    }

    // 敏感话题处理者管理
    const safeChannelKeyStr = String(channelKey).replace(/[^a-zA-Z0-9._-]/g, '_')
    const handlerFile = path.join(POLITICAL_HANDLER_DIR, safeChannelKeyStr + '.json')
    const isGroupAdmin = session.event?.sender?.role === 'owner' || session.event?.sender?.role === 'admin'

    const handlerAdd = plain.match(/^敏感话题处理者添加\s*(\d+)$/)
    if (handlerAdd) {
      if (!inGuild) return '这个命令只能在群里使用。'
      if (!isGroupAdmin && !hasAdminPermission(session)) return '只有群主、管理员或bot管理员才能设置处理者。'
      let list = await readJsonFile(handlerFile, [])
      if (!Array.isArray(list)) { await writeJsonFile(handlerFile, [handlerAdd[1]]); return `已添加敏感话题处理者：${handlerAdd[1]}` }
      if (!list.includes(handlerAdd[1])) { list.push(handlerAdd[1]); await writeJsonFile(handlerFile, list) }
      return `已添加敏感话题处理者：${handlerAdd[1]}`
    }
    const handlerDel = plain.match(/^敏感话题处理者删除\s*(\d+)$/)
    if (handlerDel) {
      if (!inGuild) return '这个命令只能在群里使用。'
      if (!isGroupAdmin && !hasAdminPermission(session)) return '只有群主、管理员或bot管理员才能设置处理者。'
      let list = await readJsonFile(handlerFile, [])
      if (Array.isArray(list)) { list = list.filter(id => id !== handlerDel[1]); await writeJsonFile(handlerFile, list) }
      return `已移除敏感话题处理者：${handlerDel[1]}`
    }
    if (plain === '敏感话题处理者查看') {
      if (!inGuild) return '这个命令只能在群里使用。'
      const list = await readJsonFile(handlerFile, [])
      if (Array.isArray(list) && list.length) return `本群敏感话题处理者：\n${list.join('\n')}`
      return '本群未配置敏感话题处理者。'
    }

    // 敏感话题检测开关
    if (plain === '敏感话题检测开') {
      if (!inGuild) return '这个命令只能在群里使用。'
      const isGA = session.event?.sender?.role === 'owner' || session.event?.sender?.role === 'admin'
      if (!isGA && !hasAdminPermission(session)) return '只有群主、管理员或bot管理员才能操作。'
      let list = await readJsonFile(POLITICAL_DETECT_FILE, [])
      if (!Array.isArray(list)) list = []
      if (!list.includes(channelKey)) { list.push(channelKey); await writeJsonFile(POLITICAL_DETECT_FILE, list) }
      resetPoliticalDetectCache()
      clearSensitiveRuntimeState(channelKey)
      // 自动加入白名单，确保敏感缓存有数据
      let sw = await readJsonFile(SUMMARY_WHITELIST_FILE, [])
      if (!Array.isArray(sw)) sw = []
      if (!sw.includes(channelKey)) { sw.push(channelKey); await writeJsonFile(SUMMARY_WHITELIST_FILE, sw) }
      return '敏感话题检测已开启。'
    }
    if (plain === '敏感话题检测关') {
      if (!inGuild) return '这个命令只能在群里使用。'
      const isGA = session.event?.sender?.role === 'owner' || session.event?.sender?.role === 'admin'
      if (!isGA && !hasAdminPermission(session)) return '只有群主、管理员或bot管理员才能操作。'
      let list = await readJsonFile(POLITICAL_DETECT_FILE, [])
      if (Array.isArray(list)) { list = list.filter(k => k !== channelKey); await writeJsonFile(POLITICAL_DETECT_FILE, list) }
      resetPoliticalDetectCache()
      clearSensitiveRuntimeState(channelKey)
      return '敏感话题检测已关闭。'
    }
    if (plain === '敏感话题检测查看') {
      const list = await readJsonFile(POLITICAL_DETECT_FILE, [])
      return `敏感话题检测：${Array.isArray(list) && list.includes(channelKey) ? '开' : '关'}`
    }

    // 解除上限群白名单管理
    const swAdd = plain.match(/^解除上限群白名单添加\s*(\d+)$/)
    if (swAdd) {
      const sw = await readJsonFile(SUMMARY_WHITELIST_FILE, [])
      if (!Array.isArray(sw)) { await writeJsonFile(SUMMARY_WHITELIST_FILE, [swAdd[1]]); return `已添加解除上限群白名单：${swAdd[1]}` }
      if (!sw.includes(swAdd[1])) { sw.push(swAdd[1]); await writeJsonFile(SUMMARY_WHITELIST_FILE, sw) }
      return `已添加解除上限群白名单：${swAdd[1]}`
    }
    const swDel = plain.match(/^解除上限群白名单删除\s*(\d+)$/)
    if (swDel) {
      let sw = await readJsonFile(SUMMARY_WHITELIST_FILE, [])
      if (Array.isArray(sw)) { sw = sw.filter(g => g !== swDel[1]); await writeJsonFile(SUMMARY_WHITELIST_FILE, sw) }
      return `已移出解除上限群白名单：${swDel[1]}`
    }
    if (plain === '解除上限群白名单查看') {
      const sw = await readJsonFile(SUMMARY_WHITELIST_FILE, [])
      if (Array.isArray(sw) && sw.length) return `解除上限群白名单：\n${sw.join('\n')}`
      return '解除上限群白名单为空。'
    }

    if (plain === 'AI抓事件') {
      armEventDump(session)
      return `已开始抓取当前会话的下一条原始事件。\n请把目标消息再发一遍，触发后会写入：${EVENT_DUMP_DIR}`
    }

    if (plain === 'AI抓事件查看') {
      const armed = getArmedEventDump(channelKey)
      if (!armed) return '当前没有待抓取的原始事件。'
      return `原始事件抓取：已开启\n抓取人：${armed.armedBy || '(未知)'}\n剩余有效期：约${Math.max(1, Math.ceil((EVENT_DUMP_ARM_EXPIRE_MS - (Date.now() - armed.armedAt)) / 60000))}分钟`
    }

    if (plain === 'AI抓事件取消') {
      clearArmedEventDump(channelKey)
      return '已取消当前会话的原始事件抓取。'
    }

    const rateSetMatch = plain.match(/^东雪莲群聊AI概率设置\s*((?:100(?:\.0+)?)|(?:\d{1,2}(?:\.\d+)?))%$/)
    if (rateSetMatch) {
      if (!inGuild) return '这个命令只能在群里用。'
      if (!isGroupAdmin && !hasAdminPermission(session)) return '只有群主、群管理员或bot管理员才能设置概率。'
      const rate = Number(rateSetMatch[1]) / 100
      if (!Number.isFinite(rate) || rate <= 0 || rate > 1) return '概率范围只能是 0% 到 100% 之间。'
      randomRateCache.set(channelKey, rate)
      await writeJsonFile(RANDOM_RATE_FILE, Object.fromEntries(randomRateCache))
      return `本群主动回复基础概率已设置为 ${formatPercent(rate)}。50条未触发后仍按每条 +${formatPercent(RANDOM_TRIGGER_RAMP)} 递增。本群东雪莲AI聊天状态：${getRandomWhitelistStatus(channelKey) ? '开' : '关'}`
    }

    if (/^东雪莲群聊AI概率重置$/.test(plain)) {
      if (!inGuild) return '这个命令只能在群里用。'
      randomRateCache.delete(channelKey)
      await writeJsonFile(RANDOM_RATE_FILE, Object.fromEntries(randomRateCache))
      return `本群主动回复基础概率已重置为默认值 ${formatPercent(RANDOM_TRIGGER_RATE_BASE)}。`
    }

    const commandResult = await handleCommand(session, ctx, {
      plain, inGuild, channelKey, currentUserId, adminCommandMatched,
      loadConfig, loadRuntimeSettings, loadSkills, loadSkillsContentCache,
      callOpenAI, setRepeatEnabled, getRandomTriggerBaseRate, getRandomWhitelistStatus,
      getThinkingEnabled,
      setThinkingEnabled,
      resetConfigCache,
      getSkillsCount,
      channelMissCount, repeatEnabledCache: getRepeatEnabledCache(), channelTodayCache, lastEmotionCache,
    })
    if (commandResult.matched) {
      if (Object.prototype.hasOwnProperty.call(commandResult, 'response')) return commandResult.response
      return
    }
    // 以 / 开头且非命令的消息交给后续插件处理（如 dongxuelian-help 的 /help 搜索）
    if (plain.startsWith('/')) return next()

    const botMentionCount = getBotMentionCount(session)
    const otherMentions = hasOtherMentions(session)
    const mentionUserIds = extractAtIds(session.content || '')
      .map(userId => String(userId))
      .filter(userId => userId && userId !== String(session.selfId || session.bot?.selfId || ''))
    const currentPersonaName = resolvePersona(channelKey, currentUserId).name
    const personaWillContent = currentPersonaName ? loadPersonalSkill(currentPersonaName) : null
    const nameMentioned = !currentPersonaName && /莲莲|东雪莲/.test(plain)
    const inRandomWhitelist = getRandomWhitelistStatus(channelKey)
    let isRandomCandidate = inGuild && !directAt && !otherMentions && !nameMentioned && inRandomWhitelist && !analyzed.shouldSkipForRandomReply
    // 30秒冷却：触发后不再次主动发言
    if (lastRandomReplyTs.has(channelKey) && Date.now() - (lastRandomReplyTs.get(channelKey) || 0) < 15000) {
      isRandomCandidate = false
    }
    const willFactor = calculateWillFactor(channelKey, currentPersonaName, channelSharedCache, personaWillContent)
    const finalTriggerRate = Math.min(getRandomTriggerBaseRate(channelKey) * willFactor, 1.0)

    // "闭嘴" 静默十分钟主动回复
    if (inGuild && !directAt && !nameMentioned && /^(?:闭嘴|别吵|别说了|不要说话)/.test(plain)) {
      const remaining = (channelMutedUntil.get(channelKey) || 0) - Date.now()
      if (remaining < 600000) {
        channelMutedUntil.set(channelKey, Date.now() + 600000)
        ctx.logger('dongxuelian-ai').info(`muted ${channelKey} for 10min due to 闭嘴`)
      }
    }
    // 静默期中抑制随机触发
    if (channelMutedUntil.get(channelKey) > Date.now()) {
      if (isRandomCandidate) channelMissCount.set(channelKey, (channelMissCount.get(channelKey) || 0) + 1)
      isRandomCandidate = false
    }

    // 连续复读检测（在随机回复之前，2人相同→bot跟第3条）
    if (inGuild && !directAt && !otherMentions) {
      const repeatCandidate = buildRepeatCandidate(session, plain, analyzed)
      const repeatResult = checkGroupRepeat(session, repeatCandidate, channelKey, currentUserId)
      if (repeatResult) {
        ctx.logger('dongxuelian-ai').info(`repeat triggered in ${channelKey}: kind=${repeatResult.kind} key="${repeatResult.key.slice(0, 80)}"`)
        await session.send(repeatResult.reply)
        return next()
      }
    }

    // 连续发言延迟触发
    if (isRandomCandidate && inGuild && !directAt && !nameMentioned) {
      const recentMsgs = channelSharedCache.get(channelKey)
        ?.filter(e => e.userId === currentUserId && e.role === 'user')
        ?.slice(-2)
      if (recentMsgs?.length >= 2 && (Date.now() - (recentMsgs[recentMsgs.length - 1]?.ts || 0)) < 10000) {
        isRandomCandidate = false
        clearTimeout(channelPendingRandom.get(channelKey)?.timer)
        const timer = setTimeout(() => {
          const p = channelPendingRandom.get(channelKey)
          channelPendingRandom.delete(channelKey)
          if (p && shouldTriggerRandom(getRandomTriggerRate(channelKey))) {
            channelMissCount.set(channelKey, 0)
            enqueueForChannel(channelKey, () => chat(session, p.combinedText, ctx, { randomTriggered: true, sharedContextNote, quotedMessageNote, forwardSummaryText }), 4)
          } else {
            channelMissCount.set(channelKey, (channelMissCount.get(channelKey) || 0) + 1)
          }
        }, 15000)
        channelPendingRandom.set(channelKey, { timer, combinedText: plain })
      }
    }
    const randomTriggered = isRandomCandidate && shouldTriggerRandom(Math.min(getRandomTriggerRate(channelKey) * willFactor, 1.0))

    if (inGuild && !directAt && !nameMentioned) {
      ctx.logger('dongxuelian-ai').info(`random-reply debug: key=${channelKey} whitelist=${inRandomWhitelist} candidate=${isRandomCandidate} triggered=${randomTriggered} rate=${getRandomTriggerRate(channelKey)} skip=${analyzed.shouldSkipForRandomReply} hasUsableText=${analyzed.hasUsableText} hasLink=${analyzed.hasLink} hasVisual=${analyzed.hasVisual} hasFile=${analyzed.hasFile} hasEmbed=${analyzed.hasEmbed} directAt=${directAt} otherMentions=${otherMentions} nameMentioned=${nameMentioned} whitelistSize=${randomWhitelistCache.size}`)
    }

    if (inGuild && !directAt && !nameMentioned && inRandomWhitelist) {
      if (isRandomCandidate && randomTriggered) {
        channelMissCount.set(channelKey, 0)
        lastRandomReplyTs.set(channelKey, Date.now())
      } else {
        channelMissCount.set(channelKey, (channelMissCount.get(channelKey) || 0) + 1)
      }
    }

    const userText = normalizeText(plain)
    const sharedContextNote = getSharedContextNote(session, currentUserId, {
      replyToId: analyzed.replyToId,
      mentionUserIds,
      randomTriggered,
    })
    const quotedMessageNote = getQuotedMessageNote(session, { replyToId: analyzed.replyToId })
    const sharedRecordText = memoryText || (analyzed.hasMessageRecordCue ? normalizeText(analyzed.plain || '') : '')

    if (inGuild && sharedRecordText) {
      saveSharedChannelTurn(session, userName, sharedRecordText, 'user', {
        messageId: session.messageId,
        replyToId: analyzed.replyToId,
        mentionUserIds,
        hasMessageRecordCue: analyzed.hasMessageRecordCue,
      })
    }

// 用户黑名单：群聊中不回复，但仍记录消息供上下文使用
    if (inGuild && !hasAdminPermission(session)) {
      const userBlacklist = await loadUserBlacklist()
      if (userBlacklist.has(String(currentUserId))) return next()
    }

    if (!isPrivate && !directAt && !nameMentioned) {
      if (analyzed.hasVisual || analyzed.hasFile || analyzed.hasEmbed) {
        if (!inRandomWhitelist) return next()
        // 跳过 emoji/sticker/gif 表情包
        if (/Qzone|Emoji|Sticker|gif/i.test(content)) return next()
        // 图片也按概率回复，不无条件回复
        if (!randomTriggered && !shouldTriggerRandom(getRandomTriggerRate(channelKey))) return next()
        if (!prepareVisionRequest(session, analyzed, { content, allowCurrentMessage: true, includeQuote: false }) && !analyzed.hasUsableText) {
          return next()
        }
      } else if (!randomTriggered) {
        return next()
      }
    }

    // 引用/回复中的图片：当前消息不含图，但被引用的消息可能含图片
    prepareVisionRequest(session, analyzed, { content, allowCurrentMessage: false, includeQuote: true })

    if ((directAt || nameMentioned || isPrivate) && (analyzed.hasVisual || analyzed.hasFile || analyzed.hasEmbed)) {
      // 有图片 → 尝试识图
      if (!prepareVisionRequest(session, analyzed, { content, allowCurrentMessage: true, includeQuote: false }) && !analyzed.hasUsableText) {
        await session.send('我不识图，也不读文件链接。发文字。')
        return
      }
    } else if ((directAt || nameMentioned) && !analyzed.hasUsableText) {
      if (analyzed.hasLink) return next()
      return
    }
    if (session._skipVision) { delete session._skipVision; return next() }
    if (!userText && !isVisionSession(session)) return next()

    if (botMentionCount > 1) {
      ctx.logger('dongxuelian-ai').info(`collapsed repeated @bot mentions: ${botMentionCount}`)
    }

    const maxDepth = inGuild ? 4 : 2
    enqueueForChannel(channelKey, () =>
      chat(session, userText, ctx, { randomTriggered, sharedContextNote, quotedMessageNote, forwardSummaryText, mentionUserIds })
        .then(reply => {
          // AI 回复中检测到政治拒绝 → 通知处理者
          if (inGuild && /别问了，这个我不聊/.test(reply)) {
            notifySensitiveHandlers(session, channelKey, { throttle: true }).catch(() => {})
          }
          return safeSendReply(ctx, session, reply, randomTriggered)
        })
        .catch(err => {
          const m = err && err.message ? String(err.message) : ''
          const code = err && err.code ? String(err.code) : ''
          ctx.logger('dongxuelian-ai').warn(`chat failed: name=${err && err.name} code=${code} message=${m}`)
          let msg = '东雪莲暂时无法连接。'
          if (/fallback/i.test(m)) msg = '我寄了'
          else if (/Empty model/i.test(m)) msg = '我摆了，懒得回'
          else if (/data_inspection|DataInspection|inappropriate content|content_filter|content policy|moderation|safety|审核|风控|ResponsibleAIPolicy|ResponsibleAI|blocked|censored/i.test(m)) {
            msg = /data_inspection|DataInspection|inappropriate content|图/i.test(m) ? '这个图不合适，不说了吧' : '这话我接不了，换一句吧。'
          } else if (/timeout|ETIMEDOUT|aborted|AbortError|deadline/i.test(m) || /TIMED_OUT|ETIMEDOUT/i.test(code)) {
            msg = '请求超时了，一会再来。'
          } else if (/ECONNRESET|ECONNREFUSED|ENOTFOUND|ENETUNREACH|socket hang|TLS|SSL|fetch failed/i.test(m) || /^ECONN/.test(code)) {
            msg = '网络抖了一下，一会再来。'
          } else if (/429|rate limit|too many requests|quota/i.test(m)) {
            msg = '请求太勤了，稍后再试。'
          }
          return safeSendReply(ctx, session, msg, randomTriggered)
        })
    , maxDepth)
  })
}
