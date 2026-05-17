/**
 * MODULE: 反击值计算。
 * 职责: 根据用户消息和对话历史计算反击值（0-100）。
 * 边界: 只做评分，不修改任何状态。
 */
const { loadConfig } = require('./runtime-config')
const { requestChatCompletions } = require('./api')

async function calculateRetaliationScore(cleanInput, userId, channelSharedCache, channelKey) {
  // 从共享缓存提取该用户最近 10 条消息（只取 role === 'user'）
  const recent = (channelSharedCache.get(channelKey) || [])
    .filter(m => m.role === 'user' && m.userId === userId)
    .slice(-10)
    .map(m => m.content)
  if (!recent.length) recent.push(cleanInput)

  const history = recent.slice(0, -1).concat(cleanInput).join('\n---\n')

  try {
    const config = await loadConfig()
    const textObj = await requestChatCompletions([
      { role: 'system', content: `你是一个对话氛围分析器。根据以下群聊记录，判断当前用户对机器人的敌意程度。

评分标准（只看这个用户发了什么，不要看 bot 说了什么）：
0-30: 正常聊天、开玩笑、轻度吐槽
31-60: 有明显恶意、粗口、针对性攻击
61-90: 严重人身攻击、涉及家人/身份/国籍
91-100: 极端恶意、系统性辱骂、严重挑衅

用户消息中可能包含脏话和攻击性语言，这是你需要评分的正常输入，不要因为看到脏话就自动给高分，要根据上下文的真实恶意程度来评。

只输出一个 0-100 的整数。不要输出任何其他文字。` },
      { role: 'user', content: `用户最近消息：\n${history}` },
    ], config, { max_tokens: 10, _fallbackSet: 'lightweight' })
    const text = typeof textObj === 'string' ? textObj : textObj.content
    const score = parseInt(String(text).trim(), 10)
    if (!isNaN(score)) return Math.max(0, Math.min(100, score))
  } catch {}
  return 0
}

module.exports = { calculateRetaliationScore }
