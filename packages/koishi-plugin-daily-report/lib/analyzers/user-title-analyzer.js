/**
 * MODULE: 用户称号分析器。
 * 职责: 分析群友行为，生成称号和画像。
 * 边界: 只做分析，不调API，通过 aiClient.callAI 间接调用。
 */
const { createUserTitle } = require('../models')

async function analyzeUserTitles(aiClient, messages, topMembers) {
  const memberData = topMembers.slice(0, 10).map(m => {
    const memberMsgs = messages
      .filter(msg => msg.userId === m.userId || msg.user === m.name)
      .slice(0, 20)
      .map(msg => msg.content)
      .join(' | ')
    return {
      name: m.name,
      userId: m.userId,
      msgCount: m.msgCount,
      sample: memberMsgs.slice(0, 500),
    }
  })

  const prompt = `你是群友行为分析师。请根据以下成员的发言记录，为每人生成简短画像。

要求：
1. 每人50字以内的特征描述
2. 可以包含：发言风格、活跃时间、关注话题、性格特点
3. 语言要生动有趣
4. 为每人分配一个角色标签（如：活跃水怪、游戏宅、夜猫子、话痨等）
5. 如果能判断MBTI类型，也请标注

成员数据：
${JSON.stringify(memberData, null, 2)}

输出JSON格式：
{
  "userTitles": [
    {
      "name": "用户名",
      "userId": "用户ID",
      "title": "角色标签",
      "mbti": "MBTI类型（如ENFP，不确定可留空）",
      "reason": "特征描述"
    }
  ],
  "tokenUsage": {
    "promptTokens": 0,
    "completionTokens": 0,
    "totalTokens": 0
  }
}`

  try {
    const text = await aiClient.callAI(prompt, '请生成群友画像', 1500)
    const jsonMatch = text.match(/\{[\s\S]*\}/)
    if (jsonMatch) {
      const data = JSON.parse(jsonMatch[0])
      return {
        userTitles: (data.userTitles || []).map(t => createUserTitle(t.name, t.userId, t.title, t.reason, t.mbti)),
        tokenUsage: data.tokenUsage || { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      }
    }
  } catch (err) {
    console.error('[user-title-analyzer] 分析失败:', err.message)
  }

  return { userTitles: [], tokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } }
}

module.exports = { analyzeUserTitles }
