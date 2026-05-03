const fs = require('fs/promises')
const path = require('path')
const { Session } = require('@satorijs/core')
const { handleCommand } = require('./handler')
const { analyzeIncomingMessage, normalizeText, summarizeForwardNodes } = require('./message-reader')
const { loadStickerCache, sendReply } = require('./reply')
const {
  chat,
  loadConfig, resetConfigCache,
  loadSkills, loadSkillsContentCache,
  callOpenAI,
  getSkillsCount,
  getThinkingEnabled, setThinkingEnabled,
} = require('./chat')
const {
  DATA_DIR, PLUGIN_VERSION,
  PERSONA_GROUPS_FILE, PERSONA_USERS_FILE, EVENT_DUMP_DIR,
  RANDOM_WHITELIST_FILE, RANDOM_RATE_FILE,
  MAINTENANCE_FILE, REPEAT_ENABLED_FILE,
  RANDOM_TRIGGER_RATE_BASE, RANDOM_TRIGGER_WARMUP, RANDOM_TRIGGER_RAMP,
  DEFAULT_GROUP_RANDOM_WHITELIST,
  MAX_REPEAT_CHECK_HISTORY,
  MAX_CHANNEL_SHARED_MESSAGES,
  EVENT_DUMP_ARM_EXPIRE_MS,
  ADMIN_USER_IDS,
  USER_BLACKLIST_FILE, VIDEO_BLACKLIST_FILE,
  SUMMARY_WHITELIST_FILE, TODAY_CACHE_PREFIX,
  THINKING_MODE_FILE,
  POLITICAL_HANDLER_DIR, POLITICAL_DETECT_FILE, SENSITIVE_CACHE_PREFIX,
  CONVERSATIONS_DIR,
  NUMERIC_GROUP_ID_RE,
  SENSITIVE_KEYWORDS_RE,
} = require('./constants')
const {
  atomicWriteJson,
  loadPersonaGroups,
  loadPersonaUsers,
  resolvePersona,
} = require('./persona')
const {
  callGetForwardMsg,
  extractImageFileFromElements,
} = require('./api')
const {
  channelSharedCache, lastForwardSummaryCache,
  pendingSensitiveAlert, channelTodayCache,
  getChannelKey,
  clearUserConversationHistory,
  saveSharedChannelTurn,
  findChannelMessageById, collectReplyChain,
  getQuotedMessageNote, getSharedContextNote,
  saveSensitiveCache, analyzeChannelSensitive,
} = require('./conversation')
const {
  isReservedCommand, getSenderUserId, hasAdminPermission,
  stripMentions, collapseRepeatedBotCalls,
  sanitizeUserName,
  extractAtIds,
  isDirectAtBot, getBotMentionCount, hasOtherMentions,
  formatPercent,
  readTextFile, writeTextFile, readJsonFile, writeJsonFile,
  shouldTriggerRandom,
  normalizeUrl, extractImageUrls,
  sanitizeFileToken, safeJsonStringify,
} = require('./utils')

// @satorijs/core@3.7.0 缺少 stripped / resolve / send，这里打补丁
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
if (typeof Session.prototype.resolve !== 'function') {
  Session.prototype.resolve = function(value) {
    if (typeof value === 'function') return value(this)
    return value
  }
}
if (typeof Session.prototype.send !== 'function') {
  Session.prototype.send = async function(content) {
    if (!this.bot || typeof this.bot.sendMessage !== 'function') {
      throw new Error('Bot not available for sending')
    }
    return this.bot.sendMessage(this.channelId, content, this.guildId)
  }
}

exports.name = 'dongxuelian-ai'

let runtimeSettingsLoaded = false
let randomWhitelistCache = new Set(DEFAULT_GROUP_RANDOM_WHITELIST)
let randomRateCache = new Map()
const channelQueues = new Map()
const channelQueueDepth = new Map()
const channelMissCount = new Map()
const armedEventDumpCache = new Map()
const channelMutedUntil = new Map()
const channelPendingRandom = new Map()
const channelMsgCount = new Map()
const lastSensitiveAlert = new Map()

// 连续复读系统
const REPEAT_TRIGGER_COOLDOWN_MS = 30000
const REPEAT_MATCH_WINDOW_MS = 120000
const channelRepeatState = new Map()  // channelKey → { key, reply, kind, userId, ts }
const channelRepeatCooldown = new Map()  // channelKey → timestamp
let repeatEnabledCache = {}  // { channelKey: boolean }
let userBlacklistCache = null
const lastEmotionCache = new Map()
let politicalDetectCache = null  // 内存缓存敏感检测白名单

// 获取敏感检测白名单列表（带 30s 内存缓存，避免每次读文件）
async function getPoliticalDetectList() {
  if (politicalDetectCache !== null) return politicalDetectCache
  const raw = await readTextFile(POLITICAL_DETECT_FILE).catch(() => '[]')
  try {
    const parsed = JSON.parse(raw || '[]')
    politicalDetectCache = new Set(Array.isArray(parsed) ? parsed.map(String) : [])
  } catch (error) {
    console.warn(`[dongxuelian-ai] political detect list parse failed: ${error.message}`)
    politicalDetectCache = new Set()
  }
  setTimeout(() => { politicalDetectCache = null }, 30000)
  return politicalDetectCache
}

function resetPoliticalDetectCache() {
  politicalDetectCache = null
}

function clearSensitiveRuntimeState(channelKey) {
  const key = String(channelKey)
  channelMsgCount.delete(key)
  lastSensitiveAlert.delete(key)
  pendingSensitiveAlert.delete(key)
}

function loadRepeatConfig() {
  try {
    repeatEnabledCache = JSON.parse(require('fs').readFileSync(REPEAT_ENABLED_FILE, 'utf8'))
  } catch {
    repeatEnabledCache = {}
  }
}

function clearRepeatState(channelKey) {
  const key = String(channelKey)
  channelRepeatState.delete(key)
  channelRepeatCooldown.delete(key)
}

function setRepeatEnabled(channelKey, enabled) {
  const key = String(channelKey)
  repeatEnabledCache[key] = enabled
  clearRepeatState(key)
  atomicWriteJson(REPEAT_ENABLED_FILE, repeatEnabledCache)
}

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
  const miss = channelMissCount.get(channelKey) || 0
  if (miss < RANDOM_TRIGGER_WARMUP) return baseRate
  return baseRate + (miss - RANDOM_TRIGGER_WARMUP) * RANDOM_TRIGGER_RAMP
}

function getSegmentData(segment) {
  return segment?.data || segment?.attrs || {}
}

function getSessionMessageSegments(session) {
  const message = session?.event?.message
  if (Array.isArray(message)) return message
  if (Array.isArray(message?.elements)) return message.elements
  if (Array.isArray(session?.event?.message?.content)) return session.event.message.content
  return []
}

function extractStructuredFaceIds(session) {
  const segments = getSessionMessageSegments(session)
  if (!segments.length) return null

  const ids = []
  for (const segment of segments) {
    const type = String(segment?.type || '').toLowerCase()
    const data = getSegmentData(segment)

    if (type === 'text') {
      const text = data.text ?? data.content ?? ''
      if (!normalizeText(String(text))) continue
      return null
    }

    // @ 段不参与复读内容。主流程已排除直呼 bot / @其他人的触发场景。
    if (type === 'at') continue

    if (type === 'face') {
      const id = String(data.id ?? data.qq ?? data.face_id ?? data.faceId ?? '').trim()
      if (!/^\d+$/.test(id)) return null
      ids.push(id)
      continue
    }

    return null
  }

  return ids.length ? ids : null
}

function extractContentFaceIds(content = '') {
  const value = String(content || '')
  if (!value.trim()) return null

  const ids = []
  const tokenRe = /(\[CQ:face,[^\]]*?\bid=(\d+)[^\]]*\])|(<face\b[^>]*?\bid="(\d+)"[^>]*\/?>)/gi
  const remainder = value.replace(tokenRe, (_, cqToken, cqId, htmlToken, htmlId) => {
    ids.push(cqId || htmlId)
    return ''
  })

  return ids.length && !remainder.trim() ? ids : null
}

function buildFaceRepeatCandidate(faceIds) {
  const ids = faceIds.map(id => String(id))
  return {
    key: ids.map(id => `face:${id}`).join('|'),
    reply: ids.map(id => `<face id="${id}"/>`).join(''),
    kind: 'face',
    supported: true,
  }
}

function buildUnsupportedRepeatCandidate(reason) {
  return {
    key: '',
    reply: '',
    kind: 'unsupported',
    supported: false,
    reason,
  }
}

function buildRepeatCandidate(session, plain, analyzed = {}) {
  const structuredFaceIds = extractStructuredFaceIds(session)
  if (structuredFaceIds) return buildFaceRepeatCandidate(structuredFaceIds)

  const contentFaceIds = extractContentFaceIds(session?.content || '')
  if (contentFaceIds) return buildFaceRepeatCandidate(contentFaceIds)

  if (analyzed.hasFile) return buildUnsupportedRepeatCandidate('file')
  if (analyzed.hasEmbed || analyzed.hasMessageRecordCue) return buildUnsupportedRepeatCandidate('embed')
  if (analyzed.hasVisual) return buildUnsupportedRepeatCandidate('visual')

  const text = normalizeText(String(plain || '')).trim()
  if (!text) return buildUnsupportedRepeatCandidate('empty')

  return {
    key: `text:${text}`,
    reply: text,
    kind: 'text',
    supported: true,
  }
}

function checkGroupRepeat(session, candidate, channelKey, currentUserId, now = Date.now()) {
  // 跳过：私聊
  if (session.isDirect) return null
  // 跳过：未开启
  if (!repeatEnabledCache[channelKey]) return null
  // 跳过：内容为空或不支持复读；同时截断连续复读链，避免跨媒体误触发
  if (!candidate || !candidate.supported || !candidate.key || !candidate.reply) {
    channelRepeatState.delete(channelKey)
    return null
  }
  // 比较上一条消息
  const last = channelRepeatState.get(channelKey)
  // 更新状态（先更新再判断，避免自己和自己比）
  channelRepeatState.set(channelKey, {
    key: candidate.key,
    reply: candidate.reply,
    kind: candidate.kind,
    userId: currentUserId,
    ts: now,
  })

  // 冷却中不触发，但上面的状态仍然刷新，避免冷却结束后拿旧消息误触发
  const lastTs = channelRepeatCooldown.get(channelKey) || 0
  if (lastTs && now - lastTs < REPEAT_TRIGGER_COOLDOWN_MS) return null

  if (
    last &&
    last.userId !== currentUserId &&
    last.key === candidate.key &&
    now - last.ts <= REPEAT_MATCH_WINDOW_MS
  ) {
    channelRepeatCooldown.set(channelKey, now)
    return candidate
  }
  return null
}

// 输入净化：移除常见 prompt injection 结构标签，防止角色标签注入（PCFI 思路）

// 昵称净化：剔除游戏前缀、书名号、各类括号等特殊字符，限制长度防止昵称内容污染回复

function getRandomTriggerBaseRate(channelKey) {
  return randomRateCache.get(String(channelKey || '')) || RANDOM_TRIGGER_RATE_BASE
}

// 白名单为空时视为全群禁用主动回复，只有显式加入的群才允许触发。
function getRandomWhitelistStatus(channelKey) {
  if (randomWhitelistCache.size === 0) return false
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

async function loadRuntimeSettings(force = false) {
  if (!force && runtimeSettingsLoaded) return

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
      const today = new Date().toISOString().slice(0, 10)
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
    try { await fs.access(MAINTENANCE_FILE); const mt = (await fs.readFile(MAINTENANCE_FILE, 'utf8')).trim() || '优化中'; await session.send(mt).catch(() => {}); return } catch (e) { /* no maintenance mode */ }

    const analyzed = analyzeIncomingMessage(session, { sanitizeUserName })
    const plain = collapseRepeatedBotCalls(stripMentions(analyzed.plain || content))
    const memoryText = normalizeText(stripMentions(analyzed.memory || plain))
    const directAt = isDirectAtBot(session)

    // 合并转发：提取 ID 并拉取内容
    let forwardSummaryText = ''
    var fwdM = content.match(/(?:\[CQ:forward,id=([^,\]]+)\])|<forward\s+id="([^"]+)"\/>/)
    var fwdId = fwdM ? (fwdM[1] || fwdM[2]) : null
    if (fwdId) {
      var fwdData = await callGetForwardMsg(fwdId)
      ctx.logger('dongxuelian-ai').info('fwd fetch result: ' + (fwdData ? 'ok' : 'null') + ' len=' + (Array.isArray(fwdData) ? fwdData.length : (fwdData && fwdData.messages ? fwdData.messages.length : '?')))
      if (fwdData && Array.isArray(fwdData)) {
        var cn = (await Promise.all(fwdData.map(async function(n) {
          if (n.type === 'node' && n.data) return n
          var s = n.sender || {}
          var nk = (s.card || s.nickname || '').replace(/[\s\u200b-\u200f\u2028-\u202f\ufeff\u3164\uffa0\u115f\u1160-\u11ff]+/g, '').trim() || '群友'
          var mt = n.raw_message || ''
          // 处理原始 CQ 码中的嵌套转发
          if (!mt) mt = ''
          var cqFwdMatch = mt.match(/\[CQ:forward,id=(\d+)/)
          if (cqFwdMatch) {
            var cqInnerData = await callGetForwardMsg(cqFwdMatch[1])
            ctx.logger('dongxuelian-ai').info('cq inner: id=' + cqFwdMatch[1] + ' result=' + (cqInnerData ? 'ok' : 'null'))
            if (cqInnerData) {
              var cqInnerArr = Array.isArray(cqInnerData) ? cqInnerData : (cqInnerData.messages || null)
              if (cqInnerArr) {
                var cqInnerCn = (await Promise.all(cqInnerArr.map(async function(cn) {
                  if (cn.type === 'node' && cn.data) return cn
                  var cs = cn.sender || {}
                  var cnk = (cs.card || cs.nickname || '').replace(/[\s\u200b-\u200f\u2028-\u202f\ufeff\u3164\uffa0\u115f\u1160-\u11ff]+/g, '').trim() || '群友'
                  var cmt = cn.raw_message || ''
                  if (cn.message && Array.isArray(cn.message)) {
                    cmt = cn.message.map(function(cm){if(cm.type==='text')return cm.data&&cm.data.text||'';if(cm.type==='face')return'【表情】';if(cm.type==='at')return'@'+(cm.data&&(cm.data.name||cm.data.qq||''));if(cm.type==='image')return'【图片】';return'【消息】'}).filter(Boolean).join('')
                  }
                  if (!cmt) return null
                  return {type:'node',data:{nickname:cnk,content:[{type:'text',data:{text:cmt}}]}}
                }))).filter(Boolean)
                mt = require('./message-reader').summarizeForwardNodes(cqInnerCn, 0, function(x){return x})
              }
            }
            if (!mt || mt.indexOf('[CQ:forward')>=0) mt = '[嵌套转发：内容暂不可见]'
          } else if (n.message && Array.isArray(n.message)) {
            var fwdIdx = -1
            for (var fi = 0; fi < n.message.length; fi++) {
              if (n.message[fi].type === 'forward' || n.message[fi].type === 'node') { fwdIdx = fi; break }
            }
            if (fwdIdx >= 0) {
              var nestedId = n.message[fwdIdx].data && (n.message[fwdIdx].data.id || n.message[fwdIdx].data['forward-id'] || n.message[fwdIdx].data.res_id)
              if (nestedId) {
                var nestedData = await callGetForwardMsg(nestedId)
                if (nestedData) {
                  var nestedArr = Array.isArray(nestedData) ? nestedData : (nestedData.messages || null)
                  if (nestedArr) {
                    var nestedCn = (await Promise.all(nestedArr.map(async function(nn) {
                      if (nn.type === 'node' && nn.data) return nn
                      var ss = nn.sender || {}
                      var nnk = (ss.card || ss.nickname || '').replace(/[\s\u200b-\u200f\u2028-\u202f\ufeff\u3164\uffa0\u115f\u1160-\u11ff]+/g, '').trim() || '群友'
                      var nmt = nn.raw_message || ''
                      if (nn.message && Array.isArray(nn.message)) {
                        nmt = nn.message.map(function(mm){if(mm.type==='text')return mm.data&&mm.data.text||'';if(mm.type==='face')return'【表情】';if(mm.type==='at')return'@'+(mm.data&&(mm.data.name||mm.data.qq||''));if(mm.type==='image')return'【图片】';return'【消息】'}).filter(Boolean).join('')
                      }
                      if (!nmt) return null
                      return {type:'node',data:{nickname:nnk,content:[{type:'text',data:{text:nmt}}]}}
                    }))).filter(Boolean)
                    mt = summarizeForwardNodes(nestedCn, 0, function(x){return x})
                  }
                }
              }
              if (!mt || mt.indexOf('[CQ:forward')>=0) mt = '[嵌套转发：内容暂不可见]'
            } else {
              mt = n.message.map(function(m){if(m.type==='text')return m.data&&m.data.text||'';if(m.type==='face')return'【表情】';if(m.type==='at')return'@'+(m.data&&(m.data.name||m.data.qq||''));if(m.type==='image')return'【图片】';return'【消息】'}).filter(Boolean).join('')
            }
          }
          if (!mt) return null
          return {type:'node',data:{nickname:nk,content:[{type:'text',data:{text:mt}}]}}
        }))).filter(Boolean)
        forwardSummaryText = summarizeForwardNodes(cn, 0, function(x){return x})
    ctx.logger("dongxuelian-ai").info("fwd summary len: " + (forwardSummaryText ? forwardSummaryText.length : 0) + " text: " + (forwardSummaryText || "(empty)").slice(0, 100).replace(/\n/g, "\\n"))
        if (forwardSummaryText) lastForwardSummaryCache.set(getChannelKey(session), forwardSummaryText)
      }
    }

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

    // 敏感话题检测 → @处理者（使用内存缓存避免重复读文件）
    const detectList = await getPoliticalDetectList()
    const isDetectOn = detectList.has(channelKey)
    if (inGuild && isDetectOn && !analyzed.hasVisual && SENSITIVE_KEYWORDS_RE.test(plain)) {
      const safeKey = String(channelKey).replace(/[^a-zA-Z0-9._-]/g, '_')
      const handlerFile = path.join(POLITICAL_HANDLER_DIR, safeKey + '.json')
      const handlers = await readJsonFile(handlerFile, [])
      if (Array.isArray(handlers) && handlers.length > 0 && Date.now() - (lastSensitiveAlert.get(channelKey) || 0) > 30000) {
        const atAll = handlers.map(id => `<at id="${id}"/>`).join(' ')
        session.send(`管理员快来，群里有傻福在剑阵。${atAll}`).catch(() => {})
        lastSensitiveAlert.set(channelKey, Date.now())
      }
      ctx.logger('dongxuelian-ai').info(`sensitive topic in ${channelKey}: ${plain.slice(0, 50)}`)
      // 清除该群的共享上下文和该用户的对话记忆
      channelSharedCache.delete(channelKey)
      clearUserConversationHistory(session)
      channelMsgCount.delete(channelKey)
      lastEmotionCache.delete(channelKey)
    }

    // 所有用户消息写入敏感话题缓存（供 AI 分析用）
    if (inGuild && isDetectOn && !analyzed.hasVisual && plain) {
      saveSensitiveCache(channelKey, plain, userName, currentUserId)
    }

    // 敏感话题检测计数（每 50 条触发一次 AI 分析）
    if (isDetectOn && inGuild && !analyzed.hasVisual) {
      const count = (channelMsgCount.get(channelKey) || 0) + 1
      channelMsgCount.set(channelKey, count)
      if (count % 50 === 0) analyzeChannelSensitive(channelKey).catch(() => {})
    }
    // 检查待通知标记（AI 分析判定敏感时触发）
    if (isDetectOn && pendingSensitiveAlert.get(channelKey)) {
      pendingSensitiveAlert.delete(channelKey)
      // 清除该群的共享上下文（AI 分析判定整个群氛围敏感）
      channelSharedCache.delete(channelKey)
      channelMsgCount.delete(channelKey)
      lastEmotionCache.delete(channelKey)
      try {
        const safeKey = String(channelKey).replace(/[^a-zA-Z0-9._-]/g, '_')
        const handlerFile = path.join(POLITICAL_HANDLER_DIR, safeKey + '.json')
        const handlers = await readJsonFile(handlerFile, [])
        if (Array.isArray(handlers) && handlers.length > 0) {
          const atAll = handlers.map(id => `<at id="${id}"/>`).join(' ')
          session.send(`管理员快来，群里有傻福在剑阵。${atAll}`).catch(() => {})
        }
      } catch {}
    }

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
      if (userBlacklistCache === null) {
        const raw = await readJsonFile(USER_BLACKLIST_FILE, [])
        userBlacklistCache = new Set(Array.isArray(raw) ? raw.map(String) : [])
      }
    }
    const userBlAdd = plain.match(/^用户黑名单添加\s*(\d+)$/)
    if (userBlAdd) {
      const uid = userBlAdd[1]
      if (ADMIN_USER_IDS.has(uid)) return '不能对管理员添加黑名单。'
      await ensureUserBlacklistCache()
      userBlacklistCache.add(uid)
      await writeJsonFile(USER_BLACKLIST_FILE, [...userBlacklistCache])
      return `已添加用户黑名单：${uid}`
    }
    const userBlDel = plain.match(/^用户黑名单删除\s*(\d+)$/)
    if (userBlDel) {
      await ensureUserBlacklistCache()
      userBlacklistCache.delete(userBlDel[1])
      await writeJsonFile(USER_BLACKLIST_FILE, [...userBlacklistCache])
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
      channelMissCount, repeatEnabledCache, channelTodayCache, lastEmotionCache,
    })
    if (commandResult.matched) {
      if (Object.prototype.hasOwnProperty.call(commandResult, 'response')) return commandResult.response
      return
    }

    const botMentionCount = getBotMentionCount(session)
    const otherMentions = hasOtherMentions(session)
    const mentionUserIds = extractAtIds(session.content || '')
      .map(userId => String(userId))
      .filter(userId => userId && userId !== String(session.selfId || session.bot?.selfId || ''))
    const nameMentioned = !resolvePersona(channelKey, currentUserId).name && /莲莲|东雪莲/.test(plain)
    const inRandomWhitelist = getRandomWhitelistStatus(channelKey)
    let isRandomCandidate = inGuild && !directAt && !otherMentions && !nameMentioned && inRandomWhitelist && !analyzed.shouldSkipForRandomReply

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
    const randomTriggered = isRandomCandidate && shouldTriggerRandom(getRandomTriggerRate(channelKey))

    if (inGuild && !directAt && !nameMentioned) {
      ctx.logger('dongxuelian-ai').info(`random-reply debug: key=${channelKey} whitelist=${inRandomWhitelist} candidate=${isRandomCandidate} triggered=${randomTriggered} rate=${getRandomTriggerRate(channelKey)} skip=${analyzed.shouldSkipForRandomReply} hasUsableText=${analyzed.hasUsableText} hasLink=${analyzed.hasLink} hasVisual=${analyzed.hasVisual} hasFile=${analyzed.hasFile} hasEmbed=${analyzed.hasEmbed} directAt=${directAt} otherMentions=${otherMentions} nameMentioned=${nameMentioned} whitelistSize=${randomWhitelistCache.size}`)
    }

    if (inGuild && !directAt && !nameMentioned && inRandomWhitelist) {
      if (isRandomCandidate && randomTriggered) {
        channelMissCount.set(channelKey, 0)
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
      if (userBlacklistCache === null) {
        const raw = await readJsonFile(USER_BLACKLIST_FILE, [])
        if (userBlacklistCache === null) {
          userBlacklistCache = new Set(Array.isArray(raw) ? raw.map(String) : [])
        }
      }
      if (userBlacklistCache.has(String(currentUserId))) return next()
    }

    if (!isPrivate && !directAt && !nameMentioned) {
      if (analyzed.hasVisual || analyzed.hasFile || analyzed.hasEmbed) {
        if (!inRandomWhitelist) return next()
        // 图片也按概率回复，不无条件回复
        if (!randomTriggered && !shouldTriggerRandom(getRandomTriggerRate(channelKey))) return next()
        const vUrls = extractImageUrls(session.content || '')
        const vFile = extractImageFileFromElements(session)
        if (vUrls.length > 0 || vFile) {
          session._visionUrls = vUrls
          session._visionFile = vFile
          session._isVisionRequest = true
        } else if (!analyzed.hasUsableText) {
          return next()
        }
      } else if (!randomTriggered) {
        return next()
      }
    }

    // 引用/回复中的图片：当前消息不含图，但被引用的消息可能含图片
    if (!analyzed.hasVisual && !analyzed.hasFile && !analyzed.hasEmbed && session.quote) {
      let qc = ''
      let quotedFile = null
      try {
        if (typeof session.quote.content === 'string') qc = session.quote.content
        else if (Array.isArray(session.quote.message)) {
          qc = session.quote.message.map(s => s.data?.url || s.data?.file || '').filter(Boolean).join(' ')
          // 直接从 quote.message 段提取 file
          const imgSeg = session.quote.message.find(s => s.type === 'image')
          if (imgSeg && imgSeg.data?.file) quotedFile = imgSeg.data.file
        }
      } catch {}
      if (qc) {
        const quotedUrls = extractImageUrls(qc)
        if (quotedUrls.length > 0 || quotedFile) {
          session._visionUrls = quotedUrls
          session._visionFile = quotedFile
          session._isVisionRequest = true
        }
      }
    }

    if ((directAt || nameMentioned || isPrivate) && (analyzed.hasVisual || analyzed.hasFile || analyzed.hasEmbed)) {
      // 有图片 → 尝试识图
      const imgUrls = extractImageUrls(session.content || '')
      const imgFile = extractImageFileFromElements(session)
      if (imgUrls.length > 0 || imgFile) {
        session._visionUrls = imgUrls
        session._visionFile = imgFile
        session._isVisionRequest = true
      } else if (!analyzed.hasUsableText) {
        await session.send('我不识图，也不读文件链接。发文字。')
        return
      }
    } else if ((directAt || nameMentioned) && !analyzed.hasUsableText) {
      if (analyzed.hasLink) return next()
      return
    }
    if (session._skipVision) { delete session._skipVision; return next() }
    if (!userText && !session._isVisionRequest) return next()

    if (botMentionCount > 1) {
      ctx.logger('dongxuelian-ai').info(`collapsed repeated @bot mentions: ${botMentionCount}`)
    }

    const maxDepth = inGuild ? 4 : 2
    enqueueForChannel(channelKey, () =>
      chat(session, userText, ctx, { randomTriggered, sharedContextNote, quotedMessageNote, forwardSummaryText, mentionUserIds })
        .then(reply => {
          // AI 回复中检测到政治拒绝 → 通知处理者
          if (inGuild && /别问了，这个我不聊/.test(reply)) {
            const safeKey = String(channelKey).replace(/[^a-zA-Z0-9._-]/g, '_')
            const handlerFile = path.join(POLITICAL_HANDLER_DIR, safeKey + '.json')
            try {
              const raw = require('fs').readFileSync(handlerFile, 'utf8')
              const list = JSON.parse(raw)
              if (Array.isArray(list) && list.length > 0 && Date.now() - (lastSensitiveAlert.get(channelKey) || 0) > 30000) {
                const atAll = list.map(id => `<at id="${id}"/>`).join(' ')
                session.send(`管理员快来，群里有傻福在剑阵。${atAll}`).catch(() => {})
                lastSensitiveAlert.set(channelKey, Date.now())
              }
            } catch {}
          }
          return sendReply(ctx, session, reply, randomTriggered)
        })
        .catch(err => {
          ctx.logger('dongxuelian-ai').warn(err)
          const msg = err && err.message && err.message.includes('fallback') ? '我寄了' :
                err && err.message && err.message.includes('Empty model') ? '我摆了，懒得回' :
                err && err.message && /data_inspection|DataInspection|inappropriate content/i.test(err.message) ? '这个图不合适，不说了吧' :
                '东雪莲暂时无法连接。'
          return session.send(msg)
        })
    , maxDepth)
  })
}
