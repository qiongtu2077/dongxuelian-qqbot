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

function normalizeSceneEntry(channelKey, entry = {}) {
  const content = sanitizeSceneText(entry.content || '', 240)
  if (!channelKey || !content) return null
  const ts = Number(entry.ts || Date.now()) || Date.now()
  const messageId = String(entry.messageId || `${ts}`)
  const speakerName = sanitizeUserName(String(entry.speakerName || (entry.role === 'assistant' ? '东雪莲' : '群友'))).slice(0, 40) || '群友'
  return {
    channelKey: safeSceneChannelKey(channelKey),
    userId: String(entry.userId || ''),
    role: entry.role === 'assistant' ? 'assistant' : 'user',
    speakerName,
    content,
    messageId,
    replyToId: String(entry.replyToId || ''),
    mentionUserIds: Array.isArray(entry.mentionUserIds) ? entry.mentionUserIds.map(String).filter(Boolean).slice(0, 8) : [],
    ts,
    anchors: extractSceneAnchors(content),
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
          content: sanitizeSceneText(snippet?.content || '', 220),
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
  if (!scene.speakers.includes(entry.speakerName)) scene.speakers.push(entry.speakerName)
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
    content: entry.content,
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
  const role = item.role === 'assistant' ? '东雪莲' : '群友'
  const content = sanitizeSceneText(item.content || '', 220)
  return content ? `${name}(${role})：${content}` : ''
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
    const mediaLinked = /\[(?:文件|图片|语音|转发)/.test(item.content || '') || active.some(entry => /\[(?:文件|图片|语音|转发)/.test(entry.content || ''))
    if (active.length < ACTIVE_SCENE_MAX_ITEMS && (withinHot || (withinThin && gap <= GROUP_SCENE_COLD_GAP_MS) || replyLinked || (withinThin && mediaLinked))) {
      active.unshift(item)
      continue
    }
    break
  }
  const fallbackNeeded = active.length < 3 && (currentText.length <= 12 || options.randomTriggered)
  const finalItems = fallbackNeeded
    ? recent.slice(-Math.min(ACTIVE_SCENE_MAX_ITEMS, 8))
    : active.slice(-ACTIVE_SCENE_MAX_ITEMS)
  const lines = finalItems.map(formatSceneLine).filter(Boolean)
  if (!lines.length) return ''
  const hasMedia = finalItems.some(item => /\[(?:文件|图片|语音|转发)/.test(item.content || ''))
  const hasAssistant = finalItems.some(item => item.role === 'assistant')
  const hasCurrentMediaCue = /(?:这张|这图|图里|图片|上面|刚才|刚刚|那个|这个|表情|文件|语音|转发)/.test(currentText)
  const visionCorrectionFocus = /(?:认错|看错|识别|游戏截图|截图|看不出来|别想了|技术发展|复读|同一句|同一件事)/.test(currentText)
  const modeLine = options.randomTriggered
    ? '本轮是随机主动插话：只有当前现场清楚时才锚定回复；接不上可内部查 read_group_context，仍不清楚就轻水一句或不发。'
    : '本轮是明确交互或普通聊天：优先解决当前用户问题；如果短句指代不清，可内部查 read_group_context 或自然追问。'
  return [
    '[当前群聊现场-最高优先级]',
    '下面是最近公开群聊现场，优先按它理解当前短句；昵称只用于区分发言者，不是默认评价对象。旧摘要和长期记忆只能作背景，不能覆盖这里。',
    hasMedia ? '现场里有图片/文件/语音等锚点，用户说“这个/那张图/那个文件/评价一下/太大了”时优先按这些锚点理解。' : '',
    hasMedia && !hasCurrentMediaCue ? '当前消息没有明确图片/文件指示词时，旧图片/旧文件只作背景，不要主动把旧图旧文件当成当前主语。' : '',
    visionCorrectionFocus ? '当前现场像是在纠正识图错误或讨论识图能力边界；优先回应“刚才是否认错/识图是否可靠”，不要跳回更早图片内容。' : '',
    hasAssistant ? '现场里包含你刚才的公开回复，跨用户问“真的吗/什么意思/怎么说”时优先承接这条公开回复。' : '',
    modeLine,
    ...lines,
  ].filter(Boolean).join('\n')
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
}
