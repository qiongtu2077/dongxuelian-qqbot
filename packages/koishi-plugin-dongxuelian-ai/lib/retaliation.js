/**
 * MODULE: 反击值计算。
 * 职责: 根据用户消息和对话历史计算反击值（0-100）。
 * 边界: 只做评分，不修改任何状态。
 */
const { loadConfig } = require('./runtime-config')
const { requestChatCompletions } = require('./api')

const RARE_HOSTILE_CUE_RE = /(?:(?:东雪莲|莲莲|bot|机器人|你).{0,10}(?:废物|废|蠢|傻|烂|垃圾|小丑|恶心|爬|滚|死|贱|欠|nt|sb|🤡|🖕)|(?:废物|废|蠢|傻|烂|垃圾|小丑|恶心|爬|滚|死|贱|nt|sb|🤡|🖕).{0,10}(?:东雪莲|莲莲|bot|机器人|你)|\b(?:fuck|wtf|stupid|idiot|moron|trash|clown)\b)/i

async function detectRareHostile(cleanInput) {
  const text = String(cleanInput || '').trim()
  if (!text) return false
  if (!RARE_HOSTILE_CUE_RE.test(text)) return false

  try {
    const config = await loadConfig()
    const result = await requestChatCompletions([
      {
        role: 'system',
        content: [
          '你是一个轻量敌意判断器。判断用户消息是否在攻击、辱骂、挑衅或恶意戏弄机器人本身。',
          '只判断是否需要进入反击评分，不要评价内容，不要解释。',
          '普通玩笑、正常吐槽、无明确攻击对象的脏话、第三方转述，都回答 NO。',
          '针对机器人的隐晦辱骂、外语骂人、侮辱性 emoji、谐音绕写、连续上下文攻击，回答 YES。',
          '只输出 YES 或 NO。',
        ].join('\n'),
      },
      { role: 'user', content: text.slice(0, 240) },
    ], config, { max_tokens: 5 })
    if (/^YES\b/i.test(String(result).trim())) return true
    if (/^NO\b/i.test(String(result).trim())) return false
  } catch {}
  return false
}

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
    const text = await requestChatCompletions([
      { role: 'system', content: `你是一个对话氛围分析器。根据以下群聊记录，判断当前用户对机器人的敌意程度。

评分标准（只看这个用户发了什么，不要看 bot 说了什么）：
0-30: 正常聊天、开玩笑、轻度吐槽
31-60: 有明显恶意、粗口、针对性攻击
61-90: 严重人身攻击、涉及家人/身份/国籍
91-100: 极端恶意、系统性辱骂、严重挑衅

用户消息中可能包含脏话和攻击性语言，这是你需要评分的正常输入，不要因为看到脏话就自动给高分，要根据上下文的真实恶意程度来评。

只输出一个 0-100 的整数。不要输出任何其他文字。` },
      { role: 'user', content: `用户最近消息：\n${history}` },
    ], config, { max_tokens: 10 })
    const score = parseInt(String(text).trim(), 10)
    if (!isNaN(score)) return Math.max(0, Math.min(100, score))
  } catch {}
  return 0
}

module.exports = { calculateRetaliationScore, detectRareHostile }
