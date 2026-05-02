const QQ_FACE_NAME_MAP = {
  '0': '惊讶',
  '1': '撇嘴',
  '2': '色',
  '3': '发呆',
  '4': '得意',
  '5': '流泪',
  '6': '害羞',
  '9': '大哭',
  '10': '尴尬',
  '11': '发怒',
  '12': '调皮',
  '13': '呲牙',
  '14': '微笑',
  '16': '酷',
  '18': '抓狂',
  '20': '偷笑',
  '21': '可爱',
  '27': '流汗',
  '28': '憨笑',
  '30': '奋斗',
  '32': '疑问',
  '34': '晕',
  '39': '再见',
  '49': '拥抱',
  '59': '便便',
  '66': '爱心',
  '74': '太阳',
  '75': '月亮',
  '76': '赞',
  '77': '踩',
  '78': '握手',
  '79': '胜利',
  '85': '飞吻',
  '96': '冷汗',
  '97': '擦汗',
  '98': '抠鼻',
  '99': '鼓掌',
  '100': '糗大了',
  '101': '坏笑',
  '102': '左哼哼',
  '103': '右哼哼',
  '104': '哈欠',
  '106': '委屈',
  '109': '亲亲',
  '111': '可怜',
  '174': 'doge',
  '182': '笑哭',
}

const MESSAGE_RECORD_CUE_RE = /聊天记录|转发消息|查看\d+条转发消息/
const URL_RE = /https?:\/\/\S+/gi
const MAX_FORWARD_NODES = 50
const MAX_FORWARD_DEPTH = 4
const URL_TEST_RE = /https?:\/\/\S+/i

// 统一压缩消息里的多余空白，避免后续匹配被格式噪音影响。
function normalizeText(text = '') {
  return String(text).replace(/\s+/g, ' ').trim()
}

// 去掉 URL，供上下文记忆层使用，避免把长链接当成正常话题文本。
function stripUrls(text = '') {
  return String(text).replace(URL_RE, ' ')
}

// 统一 QQ 表情名字，尽量把数字 ID 转成人能看懂的文本。
function normalizeQQFaceName(name = '', id = '') {
  const raw = normalizeText(String(name || '').replace(/^\/+/, ''))
  if (raw && !/^\d+$/.test(raw)) return raw
  return QQ_FACE_NAME_MAP[String(id || '')] || (id ? `QQ表情#${id}` : 'QQ表情')
}

// 提取被回复的消息 ID，供线程上下文拼接使用。
function extractReplyMessageId(content = '') {
  const source = String(content)
  const quoteMatch = source.match(/<quote\b[^>]*?id="([^"]+)"[^>]*\/?>/i)
  if (quoteMatch) return String(quoteMatch[1])

  const cqMatch = source.match(/\[CQ:reply,[^\]]*?(?:id|message_id)=([^,\]]+)/i)
  if (cqMatch) return String(cqMatch[1])

  return ''
}

// 生成基础特征对象，统一记录消息里是否含图、链接、转发等信息。
function createFeatureState() {
  return {
    hasText: false,
    hasVisual: false,
    hasFile: false,
    hasForward: false,
    hasLink: false,
    hasEmbed: false,
  }
}

// 合并子节点特征，供递归解析消息段使用。
function mergeFeatureState(target, source) {
  target.hasText = target.hasText || source.hasText
  target.hasVisual = target.hasVisual || source.hasVisual
  target.hasFile = target.hasFile || source.hasFile
  target.hasForward = target.hasForward || source.hasForward
  target.hasLink = target.hasLink || source.hasLink
  target.hasEmbed = target.hasEmbed || source.hasEmbed
}

// 统一昵称展示，解析聊天记录节点时避免把奇怪符号直接塞进上下文。
function sanitizeDisplayName(name = '', sanitizeUserName) {
  if (typeof sanitizeUserName === 'function') return sanitizeUserName(name || '群友')
  return normalizeText(name || '群友') || '群友'
}

// 递归统计消息段特征，判断当前消息是否主要是图片/转发/文件这类内容。
function collectSegmentFeatures(segments, depth = 0) {
  const features = createFeatureState()
  if (!Array.isArray(segments) || depth > 4) return features

  for (const segment of segments) {
    const type = String(segment?.type || '')
    const data = segment?.data || {}

    if (type === 'text' && normalizeText(data.text || '')) {
      features.hasText = true
      continue
    }

    if (type === 'face' || type === 'at') continue
    if (type === 'mface' || type === 'image' || type === 'img' || type === 'video' || type === 'record') {
      features.hasVisual = true
      continue
    }

    if (type === 'file') {
      features.hasFile = true
      continue
    }

    if (type === 'json' || type === 'xml' || type === 'share') {
      features.hasEmbed = true
      continue
    }

    if (type === 'forward') {
      features.hasForward = true
      mergeFeatureState(features, collectSegmentFeatures(data.content, depth + 1))
      continue
    }

    if (type === 'node') {
      features.hasForward = true
      mergeFeatureState(features, collectSegmentFeatures(data.content, depth + 1))
      continue
    }
  }

  return features
}

// 基于纯文本内容推断消息特征，给没有结构化消息段的场景兜底。
function collectFallbackFeatures(content = '') {
  const value = String(content)
  const features = createFeatureState()

  if (!value) return features
  if (normalizeText(stripUrls(value))) features.hasText = true
  if (URL_TEST_RE.test(value) || /\bBV[0-9A-Za-z]{10}\b/i.test(value)) features.hasLink = true
  if (/\[CQ:(?:json|xml|share),/i.test(value) || /<(?:json|xml)[^>]*>/i.test(value) || /appid=|appId=|miniapp|小程序/i.test(value)) features.hasEmbed = true
  if (/\[CQ:(?:forward|longmsg),/i.test(value) || /<forward\b[^>]*\/?>/i.test(value) || MESSAGE_RECORD_CUE_RE.test(value)) features.hasForward = true
  if (/\[CQ:(?:image|img|mface|face|record|video),/i.test(value) || /<(?:img|image|audio|video|mface)[^>]*\/?>/i.test(value)) features.hasVisual = true
  if (/\[CQ:file,/i.test(value) || /<file\b[^>]*\/?>/i.test(value)) features.hasFile = true

  return features
}

// 汇总转发节点文本，尽量把聊天记录转成可读句子。
function summarizeForwardNodes(nodes, depth = 0, sanitizeUserName) {
  if (!Array.isArray(nodes) || depth > MAX_FORWARD_DEPTH) return ''

  const indent = depth > 0 ? '  '.repeat(depth) + '└─ ' : ''
  const prefix = depth > 0 ? indent + '[内层转发] ' : '[对话] '

  const items = nodes
    .slice(0, MAX_FORWARD_NODES)
    .map((node) => {
      const type = String(node?.type || '')
      const data = node?.data || {}

      if (type === 'forward') return summarizeForwardNodes(data.content, depth + 1, sanitizeUserName)
      if (type !== 'node') return ''

      const nickname = sanitizeDisplayName(data.nickname || data.name || data.user_id || data.uin || '群友', sanitizeUserName)
      const content = extractSegmentText(data.content, { includeFace: true, includeForward: true, depth: depth + 1, sanitizeUserName })
      if (!content) return ''
      return `${nickname}：${content}`
    })
    .filter(Boolean)

  let result = prefix + items.join('；')

  if (nodes.length > MAX_FORWARD_NODES) {
    result += '；……还有' + (nodes.length - MAX_FORWARD_NODES) + '条消息未显示'
  }

  return result
}

// 把消息段提取成纯文本，供模型输入和上下文记忆使用。
function extractSegmentText(segments, options = {}) {
  const {
    includeFace = true,
    includeForward = true,
    includeMediaLabel = false,
    depth = 0,
    sanitizeUserName,
  } = options

  if (!Array.isArray(segments) || depth > 4) return ''

  const parts = []
  for (const segment of segments) {
    const type = String(segment?.type || '')
    const data = segment?.data || {}

    if (type === 'text') {
      if (data.text) parts.push(String(data.text))
      continue
    }

    if (type === 'at') {
      if (String(data.qq || data.id || '') === 'all') parts.push('@全体')
      continue
    }

    if (type === 'face') {
      if (includeFace) parts.push(`【QQ表情：${normalizeQQFaceName(data.text || data.raw || data.name, data.id)}】`)
      continue
    }

    if (type === 'mface') {
      if (includeFace) parts.push('【QQ表情包】')
      continue
    }

    if (type === 'forward') {
      if (!includeForward) continue
      const summary = summarizeForwardNodes(data.content, depth + 1, sanitizeUserName)
      parts.push(summary ? `【转发消息：${summary}】` : '【转发消息】')
      continue
    }

    if (type === 'node') {
      if (!includeForward) continue
      const nickname = sanitizeDisplayName(data.nickname || data.name || data.user_id || data.uin || '群友', sanitizeUserName)
      const nested = extractSegmentText(data.content, { includeFace, includeForward, includeMediaLabel, depth: depth + 1, sanitizeUserName })
      if (nested) parts.push(`${nickname}：${nested}`)
      continue
    }

    if (includeMediaLabel && ['image', 'img', 'record', 'video', 'file'].includes(type)) {
      parts.push('【非文本消息】')
    }
  }

  return normalizeText(parts.join(' '))
}

// 从纯文本消息兜底提取可读内容，避免 CQ/HTML 样式残留污染模型输入。
function extractContentFallback(content = '', options = {}) {
  const { forMemory = false } = options

  const text = String(content)
    .replace(/<quote\b[^>]*\/?>/gi, ' ')
    .replace(/<at\b[^>]*?name="([^"]+)"[^>]*\/?>/gi, ' @$1 ')
    .replace(/<at\b[^>]*?id="([^"]+)"[^>]*\/?>/gi, ' ')
    .replace(/\[CQ:reply,[^\]]+\]/gi, ' ')
    .replace(/\[CQ:at,[^\]]+\]/gi, ' ')
    .replace(/\[CQ:face,[^\]]*?id=(\d+)[^\]]*\]/gi, (_, id) => forMemory ? ' ' : ` 【QQ表情：${normalizeQQFaceName('', id)}】 `)
    .replace(/<face\b[^>]*?name="([^"]+)"[^>]*\/?>/gi, (_, name) => forMemory ? ' ' : ` 【QQ表情：${normalizeQQFaceName(name)}】 `)
    .replace(/<face\b[^>]*?id="([^"]+)"[^>]*\/?>/gi, (_, id) => forMemory ? ' ' : ` 【QQ表情：${normalizeQQFaceName('', id)}】 `)
    .replace(/\[CQ:forward,[^\]]+\]/gi, ' 【转发消息】 ')
    .replace(/<forward\b[^>]*\/?>/gi, ' 【转发消息】 ')
    .replace(/\[CQ:(?:image|img|mface|record|video|file|json|xml|share),[^\]]+\]/gi, ' ')
    .replace(/<(?:img|image|audio|video|file|json|xml|mface)[^>]*\/?>/gi, ' ')

  const visible = forMemory ? stripUrls(text) : text
  return normalizeText(visible)
}

// 统一分析本次消息，给主逻辑返回文本、回复链和富媒体特征。
function analyzeIncomingMessage(session, options = {}) {
  const { sanitizeUserName } = options
  const rawContent = String(session.content || '')
  const replyToId = extractReplyMessageId(rawContent)
  const rawSegments = Array.isArray(session.event?.message) ? session.event.message : []

  const segmentFeatures = rawSegments.length ? collectSegmentFeatures(rawSegments) : createFeatureState()
  const fallbackFeatures = collectFallbackFeatures(rawContent)
  const features = createFeatureState()
  mergeFeatureState(features, segmentFeatures)
  mergeFeatureState(features, fallbackFeatures)

  let plain = ''
  let memory = ''

  if (rawSegments.length) {
    plain = extractSegmentText(rawSegments, { includeFace: true, includeForward: true, sanitizeUserName })
    memory = normalizeText(stripUrls(extractSegmentText(rawSegments, { includeFace: false, includeForward: true, sanitizeUserName })))
  } else {
    plain = extractContentFallback(rawContent, { forMemory: false })
    memory = extractContentFallback(rawContent, { forMemory: true })
  }

  const hasMessageRecordCue = features.hasForward || MESSAGE_RECORD_CUE_RE.test(plain) || MESSAGE_RECORD_CUE_RE.test(rawContent)
  const hasUsableText = !!memory
  const shouldSkipForRandomReply = (!hasUsableText && !features.hasVisual) || features.hasFile || (features.hasLink && !features.hasVisual) || features.hasEmbed

  return {
    plain,
    memory,
    replyToId,
    hasUsableText,
    hasMessageRecordCue,
    hasVisual: features.hasVisual,
    hasFile: features.hasFile,
    hasLink: features.hasLink,
    hasEmbed: features.hasEmbed,
    shouldSkipForRandomReply,
  }
}

module.exports = {
  summarizeForwardNodes,
  analyzeIncomingMessage,
  normalizeText,
}
