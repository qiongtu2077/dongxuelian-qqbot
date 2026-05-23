/**
 * MODULE: 搜索/读取路由上下文。
 * 职责: 把对话历史整理成结构化工具 gate 输入。
 * 边界: 不调用模型、不执行工具、不发送消息。
 */
const { normalizeText } = require('./message-reader')
const { getUserMessageContent } = require('./conversation')

const PRIVATE_ACTIVE_HOT_MS = 60 * 60 * 1000
const PRIVATE_ACTIVE_WARM_MS = 3 * 60 * 60 * 1000
const PRIVATE_ACTIVE_COLD_MS = 24 * 60 * 60 * 1000

function isPrivateSession(session = {}) {
  return !session.guildId && (session.subtype === 'private' || session.isDirect || session.channelId || session.userId)
}

function getMessageTs(message = {}, fallbackTs = 0) {
  const ts = Number(message.ts || message.createdAt || message.timestamp || 0)
  return Number.isFinite(ts) && ts > 0 ? ts : fallbackTs
}

function normalizeCandidateText(text = '') {
  return normalizeText(text).replace(/https?:\/\/\S+/ig, '').replace(/\[图片\]/g, '').trim()
}

function looksLikeMetaTurn(text = '') {
  const value = normalizeText(text)
  if (!value) return true
  return /^(?:切换人格|东雪莲人格|人格切换|记住|忘记|清空记忆|AI状态|状态|帮助|help)$/i.test(value)
}

function looksLikeActionOnlyFollowUp(text = '') {
  const value = normalizeText(text)
  if (!value || value.length > 24) return false
  const compact = value.replace(/[？?。.!！~～\s]/g, '')
  const stripped = compact
    .replace(/^(?:你)?(?:能不能|可不可以|帮我|给我|麻烦|方便|顺手|可以|继续|再|能|帮)?(?:帮我)?/, '')
    .replace(/(?:一下|几个|一些|点|个|吗|么|吧|呗|不|呀|啊|捏|嘛)+$/g, '')
  return /^(?:找|找找|搜|搜搜|查|查查|推荐|发|给|来|看看|看一下)$/.test(stripped)
}

function hasConcreteSearchSubject(text = '') {
  const value = normalizeCandidateText(text)
  if (value.length < 4) return false
  if (looksLikeActionOnlyFollowUp(value)) return false
  if (/^(?:这个|那个|这些|那些|刚才|之前|上次|还有|再来|找找|搜搜|看看|怎么说|真的吗|为什么|为啥|然后呢)[？?。.!！]*$/.test(value)) return false
  return /[一-鿿A-Za-z0-9]{2,}/.test(value)
}

function isPotentialSearchFollowUp(text = '') {
  const value = normalizeText(text)
  if (!value || value.length > 48) return false
  if (looksLikeActionOnlyFollowUp(value)) return true
  if (/^(?:那|这个|那个|这些|那些|还有|再|继续|换|顺手|具体|详细)?[^，。！？!?]{0,12}(?:今天|明天|后天|周末|下周|未来(?:\d+|[一二三四五六七两])天)[^，。！？!?]{0,8}[？?。.!！]*$/.test(value)) return true
  if (hasConcreteSearchSubject(value)) return false
  return /(?:找|搜|查|推荐|发|给|来|还有|再|继续|链接|来源|出处|视频|资料|文章|帖子|攻略|榜单|排行|天气|价格|赛程|明天|后天|周末|官网吗|官方)/.test(value)
}

function classifyPrivateAge(ts, now) {
  if (!ts) return 'none'
  const age = now - ts
  if (age <= PRIVATE_ACTIVE_HOT_MS) return 'hot'
  if (age <= PRIVATE_ACTIVE_WARM_MS) return 'warm'
  if (age <= PRIVATE_ACTIVE_COLD_MS) return 'cold'
  return 'expired'
}

function extractTemporalFocus(text = '') {
  const value = normalizeText(text)
  const match = value.match(/(?:今天|明天|后天|周末|下周|未来(?:\d+|[一二三四五六七两])天)/)
  return match ? match[0] : ''
}

function scoreRefinementCandidate(currentText = '', candidateText = '') {
  const current = normalizeText(currentText)
  const candidate = normalizeText(candidateText)
  const currentHasTime = !!extractTemporalFocus(current)
  if (!currentHasTime) return 0
  let score = 0
  if (/(?:天气|气温|温度|冷|热|下雨|降雨|风|湿度|预报)/.test(candidate)) score += 3
  if (/(?:票价|价格|多少钱|汇率|股价|赛程|比分|开售|上映|营业|开放)/.test(candidate)) score += 2
  if (/(?:天气|气温|温度|价格|多少钱|汇率|股价|票价|赛程|比分|开售|上映|营业|开放)/.test(current)) score += 2
  if (extractTemporalFocus(candidate)) score += 1
  return score
}

function mergeTemporalRefinement(candidateText = '', currentText = '') {
  const base = normalizeCandidateText(candidateText)
  const temporal = extractTemporalFocus(currentText)
  if (!base || !temporal) return base
  if (/(?:今天|明天|后天|周末|下周|未来(?:\d+|[一二三四五六七两])天)/.test(base)) {
    return base.replace(/(?:今天|明天|后天|周末|下周|未来(?:\d+|[一二三四五六七两])天)/, temporal).slice(0, 160)
  }
  return `${base} ${temporal}`.slice(0, 160)
}

function buildPrivateSearchContext(session, history = [], options = {}) {
  const now = Number(options.now || Date.now())
  const currentText = normalizeText(options.currentText || '')
  const messages = Array.isArray(history) ? history : []
  const userMessages = messages
    .filter(item => item && item.role === 'user')
    .map(item => ({
      raw: item,
      text: normalizeText(getUserMessageContent(item.content || '')),
      ts: getMessageTs(item, 0),
    }))
    .filter(item => item.text)

  const recentUserMessages = userMessages.slice(-4).map(item => item.text)
  const currentIsFollowUp = isPotentialSearchFollowUp(currentText)
  const hints = []
  for (let index = userMessages.length - 1; index >= 0 && hints.length < 4; index -= 1) {
    const item = userMessages[index]
    if (!item || item.text === currentText) continue
    const confidence = classifyPrivateAge(item.ts, now)
    const source = confidence === 'hot' ? 'private_hot' : confidence === 'warm' ? 'private_warm' : confidence === 'cold' ? 'private_cold' : 'private_background'
    const metaTurn = looksLikeMetaTurn(item.text)
    if (!hasConcreteSearchSubject(item.text) || metaTurn) continue
    hints.unshift({
      text: normalizeCandidateText(item.text).slice(0, 160),
      ts: item.ts,
      source,
      interrupted: userMessages.slice(index + 1).some(next => next.text !== currentText && hasConcreteSearchSubject(next.text)),
      metaTurn,
      confidence: confidence === 'hot' ? 'hot' : confidence === 'warm' ? 'warm_weak' : 'cold',
    })
  }

  if (!isPrivateSession(session)) {
    return {
      recentUserMessages,
      searchContextHints: hints,
      searchReadiness: 'needs_chat_handling',
      queryCandidate: '',
      gateReason: 'non_private_context_not_built',
      blockedReason: '',
    }
  }

  if (!currentIsFollowUp) {
    return {
      recentUserMessages,
      searchContextHints: hints,
      searchReadiness: 'self_contained',
      queryCandidate: '',
      gateReason: 'current_message_not_short_follow_up',
      blockedReason: '',
    }
  }

  const executable = hints.filter(item => item.source === 'private_hot' || item.source === 'private_warm')
  const refinementMatches = executable
    .map(item => ({ item, score: scoreRefinementCandidate(currentText, item.text) }))
    .filter(entry => entry.score > 0)
    .sort((a, b) => b.score - a.score || b.item.ts - a.item.ts)
  if (refinementMatches.length && (refinementMatches.length === 1 || refinementMatches[0].score > refinementMatches[1].score)) {
    const selected = refinementMatches[0].item
    return {
      recentUserMessages,
      searchContextHints: hints,
      searchReadiness: selected.source === 'private_hot' ? 'can_complete_from_hot' : 'can_complete_from_warm',
      queryCandidate: mergeTemporalRefinement(selected.text, currentText),
      gateReason: 'same_topic_private_refinement',
      blockedReason: '',
    }
  }
  const unambiguous = executable.filter(item => !item.interrupted)
  const hot = unambiguous.filter(item => item.source === 'private_hot')
  if (hot.length === 1) {
    return {
      recentUserMessages,
      searchContextHints: hints,
      searchReadiness: 'can_complete_from_hot',
      queryCandidate: hot[0].text,
      gateReason: 'single_hot_private_candidate',
      blockedReason: '',
    }
  }

  const warm = unambiguous.filter(item => item.source === 'private_warm')
  if (warm.length === 1 && unambiguous.length === 1) {
    return {
      recentUserMessages,
      searchContextHints: hints,
      searchReadiness: 'can_complete_from_warm',
      queryCandidate: warm[0].text,
      gateReason: 'single_warm_private_candidate',
      blockedReason: '',
    }
  }

  const hasOnlyCold = hints.some(item => item.source === 'private_cold' || item.source === 'private_background') && !executable.length
  return {
    recentUserMessages,
    searchContextHints: hints,
    searchReadiness: hasOnlyCold ? 'blocked_by_cold' : 'needs_chat_handling',
    queryCandidate: '',
    gateReason: '',
    blockedReason: hasOnlyCold ? 'only_cold_private_candidates' : 'no_unique_executable_candidate',
  }
}

function mergeSearchContext(base = {}, override = {}) {
  return Object.assign({}, base || {}, override || {}, {
    recentUserMessages: Array.isArray(override.recentUserMessages) ? override.recentUserMessages : (Array.isArray(base.recentUserMessages) ? base.recentUserMessages : []),
    searchContextHints: Array.isArray(override.searchContextHints) ? override.searchContextHints : (Array.isArray(base.searchContextHints) ? base.searchContextHints : []),
  })
}

module.exports = {
  PRIVATE_ACTIVE_HOT_MS,
  PRIVATE_ACTIVE_WARM_MS,
  PRIVATE_ACTIVE_COLD_MS,
  buildPrivateSearchContext,
  mergeSearchContext,
  hasConcreteSearchSubject,
  isPotentialSearchFollowUp,
  looksLikeActionOnlyFollowUp,
}
