/**
 * MODULE: 聊天质量分析器。
 * 职责: 分析群聊氛围，生成质量锐评。
 * 边界: 只做分析，不调API，通过 aiClient.callAI 间接调用。
 */

async function analyzeChatQuality(aiClient, data) {
  const prompt = `你是群聊氛围评论员，请为今日群聊写一段犀利的质量锐评。

要求：
1. 分析4-5个维度（如：游戏生态、技术讨论、水聊、情感交流等）
2. 每个维度给出占比（总和100%）和一句点评
3. 写一个吸引人的标题和副标题
4. 最后写一段总结

今日数据：
- 消息数：${data.totalMessages}
- 活跃成员：${data.activeMembers}
- 高峰时段：${data.peakHour}
- 表情互动：${data.emojiCount}

输出JSON格式：
{
  "qualityReview": {
    "title": "标题",
    "subtitle": "副标题",
    "dimensions": [
      {
        "name": "维度名称",
        "percentage": 40.0,
        "comment": "点评内容",
        "color": "#39C5BB"
      }
    ],
    "summary": "总结内容"
  },
  "tokenUsage": {
    "promptTokens": 0,
    "completionTokens": 0,
    "totalTokens": 0
  }
}`

  try {
    const text = await aiClient.callAI(prompt, '请写群聊锐评', 1500)
    const jsonMatch = text.match(/\{[\s\S]*\}/)
    if (jsonMatch) {
      const data = JSON.parse(jsonMatch[0])
      return {
        qualityReview: data.qualityReview || null,
        tokenUsage: data.tokenUsage || { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      }
    }
  } catch (err) {
    console.error('[chat-quality-analyzer] 分析失败:', err.message)
  }

  return { qualityReview: null, tokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } }
}

module.exports = { analyzeChatQuality }
