/**
 * MODULE: chat-topic-switch
 * 职责: 串行判断 chat.js 当前消息是否切换话题。
 * 边界: 不清理 conversation、不清理 Agent context、不反向依赖 chat.js。
 * 状态: topicSwitchLocks 保存每个 conversation key 的检测串行锁。
 */
const { requestChatCompletions } = require('../core/api')
const { getRecentUserMessages } = require('../conversation')
const { loadConfig } = require('../core/runtime-config')

const topicSwitchLocks = new Map()

// 话题检测：轻量模型优先 → 主模型兜底 → 都失败则返回 null（由调用方决定降级策略）
async function detectTopicSwitch(lastMsg, currentMsg) {
  if (!lastMsg || !currentMsg) return false
  const prompt = [
    { role: 'system', content: '判断用户是否切换了话题。只回复 YES 或 NO。' },
    { role: 'user', content: `上一条消息：${lastMsg.slice(0, 200)}\n当前消息：${currentMsg.slice(0, 200)}` },
  ]
  const config = await loadConfig()
  if (!config.apiKey) return null
  try {
    const result = await requestChatCompletions(prompt, config, { max_tokens: 5, _fallbackSet: 'lightweight', _timeoutMs: 8000 })
    const reply = typeof result === 'string' ? result : (result && result.content) || ''
    if (/^YES/i.test(reply)) return true
    if (/^NO/i.test(reply)) return false
  } catch {}
  return null
}

async function resolveTopicSwitch({ topicKey = '', session, currentText = '' } = {}) {
  const key = String(topicKey || '')
  let topicSwitchResult = false
  const prevLock = topicSwitchLocks.get(key) || Promise.resolve()
  const lockPromise = prevLock.then(async () => {
    const lastUserMsg = getRecentUserMessages(session, 1).pop()
    if (lastUserMsg) topicSwitchResult = await detectTopicSwitch(lastUserMsg, currentText)
    return topicSwitchResult
  })
  topicSwitchLocks.set(key, lockPromise)
  lockPromise.finally(() => { if (topicSwitchLocks.get(key) === lockPromise) topicSwitchLocks.delete(key) })
  return lockPromise
}

function clearTopicSwitchLocks() {
  topicSwitchLocks.clear()
}

module.exports = {
  detectTopicSwitch,
  resolveTopicSwitch,
  clearTopicSwitchLocks,
}
