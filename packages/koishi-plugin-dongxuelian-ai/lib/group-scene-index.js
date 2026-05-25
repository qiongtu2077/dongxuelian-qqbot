/**
 * MODULE: 群聊 scene 目录。
 * 职责: 将公开群聊消息整理成安全 scene card，提供当前现场提示和旧上下文检索。
 * 边界: 不调用 AI API、不发送消息、不保存文件正文/真实 URL/本地路径。
 * 状态: data/group-scenes/<safeChannelKey>.json。
 */
const fs = require('fs/promises')
const path = require('path')
const { DATA_DIR } = require('./constants')
const { normalizeText } = require('./message-reader')
const { sanitizeUserName, formatShanghaiTime24h } = require('./utils')

const GROUP_SCENE_DIR = path.join(DATA_DIR, 'group-scenes')
const GROUP_SCENE_VERSION = 1
const GROUP_SCENE_HOT_GAP_MS = 3 * 60 * 1000
const GROUP_SCENE_COLD_GAP_MS = 10 * 60 * 1000
const GROUP_SCENE_MAX_SCENES = 160
const GROUP_SCENE_MAX_SNIPPETS = 16
const GROUP_SCENE_MAX_FILE_BYTES = 768 * 1024
const ACTIVE_SCENE_MAX_ITEMS = 12
const ACTIVE_SCENE_HOT_MS = 3 * 60 * 1000
const ACTIVE_SCENE_THIN_MS = 10 * 60 * 1000
const SHORT_SCENE_FOLLOWUP_MAX_CHARS = 12
const CURRENT_TURN_WINDOW_MS = 90 * 1000
const CURRENT_TURN_MAX_ITEMS = 4

const sceneQueues = new Map()
const sceneCache = new Map()

function safeSceneChannelKey(value = '') {
  return String(value || '').replace(/[^a-zA-Z0-9._-]/g, '_') || 'unknown'
}

function getSceneFilePath(channelKey = '') {
  return path.join(GROUP_SCENE_DIR, safeSceneChannelKey(channelKey) + '.json')
}

function enqueueSceneTask(channelKey, task) {
  const key = safeSceneChannelKey(channelKey)
  const previous = sceneQueues.get(key) || Promise.resolve()
  const current = previous.catch(() => {}).then(task)
  const cleanup = current.finally(() => {
    if (sceneQueues.get(key) === cleanup) sceneQueues.delete(key)
  }).catch(() => {})
  sceneQueues.set(key, cleanup)
  return current
}

function sanitizeSceneText(text = '', maxChars = 180) {
  let value = normalizeText(text)
  if (!value) return ''
  value = value
    .replace(/https?:\/\/[^\s<>"'）)】\]]{1,300}/gi, '[链接]')
    .replace(/file:\/\/[^\r\n<>"'）)】\]]{0,500}?\.[A-Za-z0-9]{1,8}/gi, '[本地文件]')
    .replace(/file:\/\/[^\s<>"'）)】\]]{1,300}/gi, '[本地文件]')
    .replace(/[A-Za-z]:\\[^\r\n<>"'）)】\]]{0,300}?\.[A-Za-z0-9]{1,8}/g, '[本地路径]')
    .replace(/[A-Za-z]:\\[^\s<>"'）)】\]]{1,260}/g, '[本地路径]')
    .replace(/(?:token|key|secret|cookie|authorization)\s*[:=]\s*[^\s,;，；]{4,}/gi, '$1=[已隐藏]')
    .replace(/<img\b[^>]*>/gi, '[图片]')
    .replace(/\[CQ:[^\]]+\]/gi, '[消息]')
    .trim()
  if (value.length > maxChars) value = value.slice(0, maxChars).trim()
  return value
}

function extractSceneAnchors(content = '') {
  const text = sanitizeSceneText(content, 260)
  const anchors = []
  if (/\[图片/.test(text)) anchors.push({ type: 'image', label: '图片' })
  if (/\[语音/.test(text)) anchors.push({ type: 'voice', label: '语音' })
  if (/\[转发|合并转发/.test(text)) anchors.push({ type: 'forward', label: '合并转发' })
  const fileMatch = text.match(/\[文件[:：]?\s*([^\]]{0,120})\]/)
  if (fileMatch) {
    const label = sanitizeSceneText(fileMatch[1] || '文件', 80)
    anchors.push({ type: 'file', label: label ? `文件：${label}` : '文件' })
  }
  return anchors
}

function extractSceneKeywords(content = '') {
  const text = sanitizeSceneText(content, 220)
  const found = new Set()
  for (const m of text.matchAll(/[0-9]+(?:\.[0-9]+)?\s*(?:kb|mb|gb|KB|MB|GB|秒|分钟|小时|%|％)?/g)) {
    if (m[0]) found.add(m[0].replace(/\s+/g, ''))
  }
  for (const m of text.matchAll(/[A-Za-z0-9_.-]+\.(?:txt|md|json|pdf|docx?|xlsx?|pptx?|zip|rar|png|jpe?g|gif|mp3|wav|m4a)/gi)) {
    if (m[0]) found.add(m[0].slice(0, 40))
  }
  const chinese = text.match(/[\u4e00-\u9fa5]{2,8}/g) || []
  for (const word of chinese.slice(0, 8)) found.add(word)
  return Array.from(found).slice(0, 12)
}

function hasSceneMedia(item = {}) {
  return !!(item.hasMessageRecordCue || /\[(?:文件|图片|语音|转发)/.test(item.content || ''))
}

function looksLikeShortSceneFollowUp(text = '') {
  const value = normalizeText(text)
  return !!(value && value.length <= SHORT_SCENE_FOLLOWUP_MAX_CHARS)
}

function normalizeSceneEntry(channelKey, entry = {}) {
  const content = sanitizeSceneText(entry.content || '', 240)
  if (!channelKey || !content) return null
  const ts = Number(entry.ts || Date.now()) || Date.now()
  const messageId = String(entry.messageId || `${ts}`)
  const speakerName = sanitizeUserName(String(entry.speakerName || (entry.role === 'assistant' ? '东雪莲' : '群友'))).slice(0, 40) || '群友'
  const hasMessageRecordCue = !!entry.hasMessageRecordCue
  const anchors = extractSceneAnchors(content)
  if (hasMessageRecordCue && !anchors.some(anchor => anchor.type === 'forward')) {
    anchors.push({ type: 'forward', label: '合并转发' })
  }
  return {
    channelKey: safeSceneChannelKey(channelKey),
    userId: String(entry.userId || ''),
    role: entry.role === 'assistant' ? 'assistant' : 'user',
    speakerName,
    personaName: entry.role === 'assistant' ? sanitizeUserName(String(entry.personaName || '')).slice(0, 40) : '',
    content,
    messageId,
    replyToId: String(entry.replyToId || ''),
    mentionUserIds: Array.isArray(entry.mentionUserIds) ? entry.mentionUserIds.map(String).filter(Boolean).slice(0, 8) : [],
    hasMessageRecordCue,
    ts,
    anchors,
    keywords: extractSceneKeywords(content),
  }
}

function normalizeSceneData(data) {
  const scenes = Array.isArray(data?.scenes) ? data.scenes : []
  return {
    version: GROUP_SCENE_VERSION,
    updatedAt: Number(data?.updatedAt || 0),
    scenes: scenes
      .filter(scene => scene && typeof scene === 'object')
      .map(scene => ({
        id: String(scene.id || ''),
        channelKey: safeSceneChannelKey(scene.channelKey || ''),
        startTs: Number(scene.startTs || 0),
        endTs: Number(scene.endTs || 0),
        messageIds: Array.isArray(scene.messageIds) ? scene.messageIds.map(String).filter(Boolean).slice(-GROUP_SCENE_MAX_SNIPPETS) : [],
        speakers: Array.isArray(scene.speakers) ? scene.speakers.map(name => sanitizeUserName(String(name || '')).slice(0, 40)).filter(Boolean).slice(0, 12) : [],
        speakerCount: Number(scene.speakerCount || 0),
        anchors: Array.isArray(scene.anchors) ? scene.anchors.map(anchor => ({
          type: String(anchor?.type || 'message').slice(0, 20),
          label: sanitizeSceneText(anchor?.label || '', 100),
          messageId: String(anchor?.messageId || ''),
        })).filter(anchor => anchor.label).slice(0, 12) : [],
        keywords: Array.isArray(scene.keywords) ? scene.keywords.map(item => sanitizeSceneText(item, 40)).filter(Boolean).slice(0, 20) : [],
        samples: Array.isArray(scene.samples) ? scene.samples.map(item => sanitizeSceneText(item, 120)).filter(Boolean).slice(0, 8) : [],
        snippets: Array.isArray(scene.snippets) ? scene.snippets.map(snippet => ({
          messageId: String(snippet?.messageId || ''),
          ts: Number(snippet?.ts || 0),
          speakerName: sanitizeUserName(String(snippet?.speakerName || '群友')).slice(0, 40) || '群友',
          role: snippet?.role === 'assistant' ? 'assistant' : 'user',
          personaName: snippet?.role === 'assistant' ? sanitizeUserName(String(snippet?.personaName || '')).slice(0, 40) : '',
          content: sanitizeSceneText(snippet?.content || '', 220),
          hasMessageRecordCue: !!snippet?.hasMessageRecordCue,
        })).filter(snippet => snippet.content).slice(-GROUP_SCENE_MAX_SNIPPETS) : [],
        state: String(scene.state || 'warm'),
        source: 'deterministic',
      }))
      .filter(scene => scene.id && scene.startTs && scene.endTs && scene.snippets.length),
  }
}

async function loadGroupScenes(channelKey) {
  const key = safeSceneChannelKey(channelKey)
  try {
    await fs.mkdir(GROUP_SCENE_DIR, { recursive: true })
    const file = getSceneFilePath(key)
    const stat = await fs.stat(file)
    if (!stat.isFile() || stat.size > GROUP_SCENE_MAX_FILE_BYTES) return { version: GROUP_SCENE_VERSION, updatedAt: 0, scenes: [] }
    const parsed = JSON.parse(await fs.readFile(file, 'utf8'))
    const data = normalizeSceneData(parsed)
    sceneCache.set(key, data)
    return data
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      sceneCache.delete(key)
      return { version: GROUP_SCENE_VERSION, updatedAt: 0, scenes: [] }
    }
    return sceneCache.get(key) || { version: GROUP_SCENE_VERSION, updatedAt: 0, scenes: [] }
  }
}

async function writeGroupScenes(channelKey, data) {
  await fs.mkdir(GROUP_SCENE_DIR, { recursive: true })
  const normalized = normalizeSceneData({ ...data, updatedAt: Date.now() })
  const file = getSceneFilePath(channelKey)
  const tmp = file + '.tmp'
  await fs.writeFile(tmp, JSON.stringify(normalized), 'utf8')
  await fs.rename(tmp, file)
  sceneCache.set(safeSceneChannelKey(channelKey), normalized)
  return true
}

function createSceneId(entry) {
  const d = new Date(entry.ts)
  const pad = n => String(n).padStart(2, '0')
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  const suffix = String(entry.messageId || entry.ts).replace(/[^a-zA-Z0-9]/g, '').slice(-6) || String(entry.ts).slice(-6)
  return `scene_${stamp}_${suffix}`
}

function sceneContainsMessage(scene, messageId = '') {
  const id = String(messageId || '')
  return !!(id && Array.isArray(scene?.messageIds) && scene.messageIds.includes(id))
}

function shouldMergeScene(lastScene, entry) {
  if (!lastScene) return false
  const gap = Number(entry.ts || 0) - Number(lastScene.endTs || 0)
  if (entry.replyToId && sceneContainsMessage(lastScene, entry.replyToId)) return true
  if (gap >= 0 && gap <= GROUP_SCENE_HOT_GAP_MS) return true
  if (gap >= 0 && gap <= GROUP_SCENE_COLD_GAP_MS && entry.anchors.length && (lastScene.anchors || []).length) return true
  return false
}

function appendEntryToScene(scene, entry) {
  scene.endTs = Math.max(Number(scene.endTs || 0), entry.ts)
  if (entry.messageId && !scene.messageIds.includes(entry.messageId)) scene.messageIds.push(entry.messageId)
  if (!entry.hasMessageRecordCue && !scene.speakers.includes(entry.speakerName)) scene.speakers.push(entry.speakerName)
  scene.speakerCount = scene.speakers.length
  for (const anchor of entry.anchors) {
    const label = sanitizeSceneText(anchor.label || '', 100)
    if (!label) continue
    if (!scene.anchors.some(item => item.type === anchor.type && item.label === label)) {
      scene.anchors.push({ type: anchor.type, label, messageId: entry.messageId })
    }
  }
  for (const keyword of entry.keywords) {
    if (keyword && !scene.keywords.includes(keyword)) scene.keywords.push(keyword)
  }
  if (entry.content && !scene.samples.includes(entry.content)) scene.samples.push(entry.content)
  scene.snippets.push({
    messageId: entry.messageId,
    ts: entry.ts,
    speakerName: entry.speakerName,
    role: entry.role,
    personaName: entry.personaName || '',
    content: entry.content,
    hasMessageRecordCue: !!entry.hasMessageRecordCue,
  })
  scene.messageIds = scene.messageIds.slice(-GROUP_SCENE_MAX_SNIPPETS)
  scene.anchors = scene.anchors.slice(-12)
  scene.keywords = scene.keywords.slice(-20)
  scene.samples = scene.samples.slice(-8)
  scene.snippets = scene.snippets.slice(-GROUP_SCENE_MAX_SNIPPETS)
  scene.state = Date.now() - scene.endTs <= ACTIVE_SCENE_THIN_MS ? 'warm' : 'cold'
  return scene
}

async function appendGroupSceneEntry(channelKey, rawEntry = {}) {
  const entry = normalizeSceneEntry(channelKey, rawEntry)
  if (!entry) return false
  return enqueueSceneTask(channelKey, async () => {
    const data = await loadGroupScenes(channelKey)
    const scenes = data.scenes || []
    const last = scenes[scenes.length - 1]
    if (shouldMergeScene(last, entry)) {
      appendEntryToScene(last, entry)
    } else {
      scenes.push(appendEntryToScene({
        id: createSceneId(entry),
        channelKey: safeSceneChannelKey(channelKey),
        startTs: entry.ts,
        endTs: entry.ts,
        messageIds: [],
        speakers: [],
        speakerCount: 0,
        anchors: [],
        keywords: [],
        samples: [],
        snippets: [],
        state: 'warm',
        source: 'deterministic',
      }, entry))
    }
    while (scenes.length > GROUP_SCENE_MAX_SCENES) scenes.shift()
    data.scenes = scenes
    return writeGroupScenes(channelKey, data)
  })
}

function formatSceneLine(item = {}) {
  const name = sanitizeUserName(String(item.speakerName || (item.role === 'assistant' ? '东雪莲' : '群友'))).slice(0, 40) || '群友'
  const personaName = item.role === 'assistant' ? sanitizeUserName(String(item.personaName || '')).slice(0, 40) : ''
  const role = item.role === 'assistant' ? (personaName ? `bot人格:${personaName}` : 'bot') : '群友'
  const materialTag = item.hasMessageRecordCue ? '/合并转发材料' : ''
  const content = sanitizeSceneText(item.content || '', 220)
  return content ? `${name}(${role}${materialTag})：${content}` : ''
}

function classifySceneItemsForActive(items = [], options = {}) {
  const list = Array.isArray(items) ? items : []
  if (!list.length) return { currentTurn: [], hotContext: [], oldBackground: [] }
  const now = Number(options.now || Date.now())
  const currentMessageId = String(options.currentMessageId || '')
  const currentReplyToId = String(options.currentReplyToId || '')
  const currentUserId = String(options.currentUserId || '')

  const idIndex = new Map()
  for (const item of list) {
    const id = String(item?.messageId || '')
    if (id) idIndex.set(id, item)
  }

  const currentTurnIds = new Set()
  if (currentMessageId) currentTurnIds.add(currentMessageId)
  let cursor = currentReplyToId
  let hops = 0
  while (cursor && idIndex.has(cursor) && hops < 3) {
    currentTurnIds.add(cursor)
    cursor = String(idIndex.get(cursor)?.replyToId || '')
    hops += 1
  }

  const currentTurn = []
  const hotContext = []
  const oldBackground = []

  for (const item of list) {
    if (!item || !item.content) continue
    const ts = Number(item.ts || 0)
    const ageMs = ts ? now - ts : Infinity
    const id = String(item.messageId || '')
    const sameUser = currentUserId && String(item.userId || '') === currentUserId
    const isAssistant = item.role === 'assistant'

    const inCurrentTurn = (
      (id && currentTurnIds.has(id)) ||
      (ageMs <= CURRENT_TURN_WINDOW_MS && (sameUser || isAssistant))
    )
    if (inCurrentTurn) {
      currentTurn.push(item)
      continue
    }
    if (ageMs <= ACTIVE_SCENE_HOT_MS) {
      hotContext.push(item)
      continue
    }
    if (ageMs <= ACTIVE_SCENE_THIN_MS) {
      oldBackground.push(item)
      continue
    }
  }

  return {
    currentTurn: currentTurn.slice(-CURRENT_TURN_MAX_ITEMS),
    hotContext: hotContext.slice(-ACTIVE_SCENE_MAX_ITEMS),
    oldBackground: oldBackground.slice(-ACTIVE_SCENE_MAX_ITEMS),
  }
}

function buildActiveGroupSceneNote(channelKey, items = [], currentUserId = '', options = {}) {
  if (!channelKey || !Array.isArray(items) || !items.length) return ''
  const now = Date.now()
  const currentText = normalizeText(options.currentText || '')
  const recent = items.filter(item => item && item.content).slice(-MAX_SCENE_MAX_INPUT_ITEMS())
  if (!recent.length) return ''
  const active = []
  for (let i = recent.length - 1; i >= 0; i -= 1) {
    const item = recent[i]
    const ts = Number(item.ts || 0)
    if (!active.length) {
      active.unshift(item)
      continue
    }
    const nextTs = Number(active[0]?.ts || 0)
    const gap = nextTs && ts ? nextTs - ts : 0
    const withinHot = ts && now - ts <= ACTIVE_SCENE_HOT_MS
    const withinThin = ts && now - ts <= ACTIVE_SCENE_THIN_MS
    const replyLinked = active.some(entry => String(entry.replyToId || '') && String(entry.replyToId || '') === String(item.messageId || ''))
    const mediaLinked = hasSceneMedia(item) || active.some(entry => hasSceneMedia(entry))
    if (active.length < ACTIVE_SCENE_MAX_ITEMS && (withinHot || (withinThin && gap <= GROUP_SCENE_COLD_GAP_MS) || replyLinked || (withinThin && mediaLinked))) {
      active.unshift(item)
      continue
    }
    break
  }
  const hasRecentMedia = active.some(item => hasSceneMedia(item))
  const explicitInteraction = !!(options.directAt || options.nameMentioned || options.isDirect)
  const shortMediaFollowUp = hasRecentMedia && looksLikeShortSceneFollowUp(currentText)
  const fallbackNeeded = (!explicitInteraction && active.length < 3 && (currentText.length <= 12 || options.randomTriggered)) || shortMediaFollowUp
  const finalItems = fallbackNeeded
    ? recent.slice(-Math.min(ACTIVE_SCENE_MAX_ITEMS, 8))
    : active.slice(-ACTIVE_SCENE_MAX_ITEMS)
  if (!finalItems.length) return ''

  const layered = classifySceneItemsForActive(finalItems, {
    now,
    currentMessageId: options.currentMessageId,
    currentReplyToId: options.currentReplyToId,
    currentUserId,
  })
  const inSet = (set, item) => set.includes(item)
  const hotOnly = layered.hotContext.filter(item => !inSet(layered.currentTurn, item))
  const oldOnly = layered.oldBackground.filter(item => !inSet(layered.currentTurn, item) && !inSet(layered.hotContext, item))

  const hasMedia = finalItems.some(item => hasSceneMedia(item))
  const hasForwardMaterial = finalItems.some(item => item.hasMessageRecordCue)
  const hasAssistant = finalItems.some(item => item.role === 'assistant')
  const currentPersonaName = String(options.personaName || '').trim()
  const hasOtherPersonaAssistant = !!currentPersonaName && finalItems.some(item => item.role === 'assistant' && item.personaName && String(item.personaName) !== currentPersonaName)
  const hasCurrentMediaCue = /(?:这张|这图|图里|图片|上面|刚才|刚刚|那个|这个|表情|文件|语音|转发)/.test(currentText)
  const currentTurnHasMedia = layered.currentTurn.some(item => hasSceneMedia(item))
  const oldHasMedia = oldOnly.some(item => hasSceneMedia(item)) || hotOnly.some(item => hasSceneMedia(item))
  const oldHasAssistantMedia = oldOnly.some(item => item.role === 'assistant' && hasSceneMedia(item)) || hotOnly.some(item => item.role === 'assistant' && hasSceneMedia(item))
  const modeLine = options.randomTriggered
    ? '本轮是随机主动插话：只有当前现场清楚时才锚定回复；接不上可内部查 read_group_context，仍不清楚就轻水一句或不发。'
    : '本轮是明确交互或普通聊天：优先解决当前用户问题；如果短句指代不清，可内部查 read_group_context 或自然追问。'

  const formatLayer = list => list.map(formatSceneLine).filter(Boolean)
  const currentTurnLines = formatLayer(layered.currentTurn)
  const hotLines = formatLayer(hotOnly)
  const oldLines = formatLayer(oldOnly)

  const lines = [
    '[当前群聊现场-最高优先级]',
    '下面是最近公开群聊现场，分三层标注。优先按当前焦点理解短句；旧背景只用于理解关系与指代，不要主动当成回复主语。昵称只用于区分发言者。',
    explicitInteraction ? '当前是用户直接找你说话；先回答当前用户这条消息，旧 assistant 回复和其他群友话题不能抢当前主语。' : '',
    explicitInteraction ? '如果当前用户是在质疑你上一条回复跑题或认错，先承认/修正当前错接，不要继续沿被质疑的旧话题输出。' : '',
    hasMedia ? '现场里有图片/文件/语音锚点；用户用很短的承接、追问、评价或反应接在媒体后面时，可以把它当候选锚点，并按工具结果或自然澄清来回答，不要凭旧 cached 描述编造。' : '',
    hasForwardMaterial ? '现场里有合并转发材料；它是当前用户提供的外部材料，里面的昵称不是本群当前发言人，不要直接向转发内人物说话。' : '',
    currentTurnHasMedia ? '[当前焦点媒体] 是这一轮直接相关的图片/文件，可作为回答主语。其它层的旧媒体不是。' : '',
    oldHasMedia && !currentTurnHasMedia ? '[旧背景媒体] 仅作环境理解。当前消息没有指向它时，不要把它的内容（角色、广告、物体等）当成当前主语续聊。' : '',
    oldHasAssistantMedia ? '[旧背景媒体] 中包含你之前发过的图或之前的识图结论；如果群友正在讨论这些识图是否准确、能不能识别某类图，请如实承认能力边界或重新识图，不要回到旧识图结论里继续夸/继续描述。' : '',
    hasMedia && !hasCurrentMediaCue && !shortMediaFollowUp ? '当前消息没有明确媒体指向，也不是紧跟媒体的短承接时，旧图片/旧文件只作背景，不要主动把旧图旧文件当成当前主语。' : '',
    shortMediaFollowUp ? '当前消息很短且紧跟媒体锚点；优先看[当前焦点]里的最新媒体；如果只能接到[旧背景]里的图，宁可不接或自然澄清，不要凭旧描述续聊。' : '',
    hasAssistant
      ? (explicitInteraction
        ? '现场里包含你刚才的公开回复；当前是直接找你说话时，这些只作背景，不要盖过当前用户这条消息。'
        : '现场里包含你刚才的公开回复，跨用户问”真的吗/什么意思/怎么说”时可优先承接这条公开回复。')
      : '',
    hasOtherPersonaAssistant
      ? (explicitInteraction
        ? '现场里也可能包含其他人格的公开回复；这些只作背景，不要继承其他人格口吻或口癖。'
        : '现场里也可能包含其他人格的公开回复；这些只作群聊事实背景，不要继承其他人格口吻或口癖。')
      : '',
    modeLine,
  ].filter(Boolean)

  if (currentTurnLines.length) {
    lines.push('--- 当前焦点 current_turn ---')
    lines.push(...currentTurnLines)
  }
  if (hotLines.length) {
    lines.push('--- 近期热议 hot_context ---')
    lines.push(...hotLines)
  }
  if (oldLines.length) {
    lines.push('--- 旧背景 old_background（仅供理解关系，不要主动续聊） ---')
    lines.push(...oldLines)
  }
  if (!currentTurnLines.length && !hotLines.length && !oldLines.length) {
    lines.push(...formatLayer(finalItems))
  }

  return lines.join('\n')
}

function MAX_SCENE_MAX_INPUT_ITEMS() {
  return Math.max(ACTIVE_SCENE_MAX_ITEMS, 16)
}

function tokenizeQuery(text = '') {
  const value = sanitizeSceneText(text, 120)
  const tokens = new Set()
  if (value) tokens.add(value)
  for (const m of value.matchAll(/[0-9]+(?:\.[0-9]+)?\s*(?:kb|mb|gb|KB|MB|GB|秒|分钟|小时|%|％)?/g)) tokens.add(m[0].replace(/\s+/g, ''))
  for (const m of value.matchAll(/[A-Za-z0-9_.-]{2,40}/g)) tokens.add(m[0])
  for (const m of value.matchAll(/[\u4e00-\u9fa5]{2,8}/g)) tokens.add(m[0])
  return Array.from(tokens).filter(Boolean).slice(0, 12)
}

function scoreScene(scene, tokens = [], options = {}) {
  if (!scene) return 0
  if (options.sceneId && String(scene.id) === String(options.sceneId)) return 10000
  const haystack = [
    scene.id,
    ...(scene.keywords || []),
    ...(scene.samples || []),
    ...(scene.anchors || []).map(anchor => anchor.label),
    ...(scene.snippets || []).map(snippet => snippet.content),
  ].join('\n')
  let score = 0
  for (const token of tokens) {
    if (!token) continue
    if (haystack.includes(token)) score += token.length >= 4 ? 8 : 4
  }
  if (options.anchorType && options.anchorType !== 'any') {
    if ((scene.anchors || []).some(anchor => anchor.type === options.anchorType)) score += 6
  }
  const ageMs = Date.now() - Number(scene.endTs || 0)
  if (ageMs < 10 * 60 * 1000) score += 5
  else if (ageMs < 30 * 60 * 1000) score += 3
  else if (ageMs < 60 * 60 * 1000) score += 1
  return score
}

function formatRetrievedScene(scene) {
  const start = formatShanghaiTime24h(scene.startTs)
  const end = formatShanghaiTime24h(scene.endTs)
  const anchors = (scene.anchors || []).map(anchor => anchor.label).filter(Boolean).slice(0, 4)
  const header = `${scene.id}，约 ${start}-${end}${anchors.length ? `，锚点：${anchors.join(' / ')}` : ''}`
  const body = (scene.snippets || []).slice(-GROUP_SCENE_MAX_SNIPPETS).map(formatSceneLine).filter(Boolean).join('\n')
  return `${header}\n${body}`
}

async function readGroupContext(channelKey, args = {}) {
  if (!channelKey) return '无法获取当前群聊频道。'
  const sceneId = String(args.sceneId || '').trim()
  const query = String(args.query || args.reason || '').trim()
  const maxAgeMinutes = Math.min(Math.max(parseInt(args.maxAgeMinutes, 10) || 60, 1), 24 * 60)
  const maxScenes = Math.min(Math.max(parseInt(args.maxScenes, 10) || 2, 1), 3)
  const anchorType = String(args.anchorType || 'any')
  const data = await loadGroupScenes(channelKey)
  const cutoff = Date.now() - maxAgeMinutes * 60 * 1000
  const tokens = tokenizeQuery([query, args.timeHint || '', args.reason || ''].filter(Boolean).join(' '))
  const candidates = (data.scenes || [])
    .filter(scene => scene && scene.endTs >= cutoff)
    .map(scene => ({ scene, score: scoreScene(scene, tokens, { sceneId, anchorType }) }))
    .filter(item => sceneId ? String(item.scene.id) === sceneId : item.score > 0)
    .sort((a, b) => b.score - a.score || b.scene.endTs - a.scene.endTs)
    .slice(0, maxScenes)
    .map(item => item.scene)
  if (!candidates.length) return '没有找到明确相关的群聊历史片段。'
  return [
    '[群聊历史片段，仅供理解当前指代，不代表当前话题]',
    '这些是旧公开聊天片段。只有当前用户明确在追问“刚才/之前/那个/这张图/那个文件”时才可引用；不要主动把无关旧话题翻出来。',
    candidates.map(formatRetrievedScene).join('\n\n'),
  ].join('\n')
}

module.exports = {
  GROUP_SCENE_VERSION,
  GROUP_SCENE_DIR,
  safeSceneChannelKey,
  getSceneFilePath,
  sanitizeSceneText,
  extractSceneAnchors,
  extractSceneKeywords,
  appendGroupSceneEntry,
  loadGroupScenes,
  readGroupContext,
  buildActiveGroupSceneNote,
  classifySceneItemsForActive,
}
