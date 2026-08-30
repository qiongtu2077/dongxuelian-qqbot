/**
 * MODULE: 金句分析器。
 * 职责: 从群聊中精选有趣/有梗的对话。
 * 边界: 只做分析，不调API，通过 aiClient.callAI 间接调用。
 */
const { createGoldenQuote } = require('../models') as typeof import('../models')
const { getErrorMessage } = require('../error-utils') as typeof import('../error-utils')

interface TokenUsage {
  promptTokens: number
  completionTokens: number
  totalTokens: number
}

interface GoldenQuote {
  content: string
  sender: string
  reason: string
  userId: string
}

interface ReportMessage {
  time?: string
  user?: string
  content?: string
}

interface AiClientLike {
  callAI(prompt: string, userMessage: string, maxTokens?: number): Promise<string>
}

interface GoldenQuotePayload {
  sender?: unknown
  content?: unknown
  reason?: unknown
  userId?: unknown
}

interface GoldenQuoteResult {
  goldenQuotes: GoldenQuote[]
  tokenUsage: TokenUsage
}

async function analyzeGoldenQuotes(
  aiClient: { callAI(prompt: string, userMessage: string, maxTokens?: number): Promise<string> },
  messages: Array<{ time?: unknown, user?: unknown, content?: unknown }>,
): Promise<{ goldenQuotes: Array<{ content: string, sender: string, reason: string, userId: string }>, tokenUsage: { promptTokens: number, completionTokens: number, totalTokens: number } }> {
  const prompt = `你是段子手，请从今日群聊中精选3-5条最有趣/最有梗的对话。

要求：
1. 选择标准：搞笑、有梗、反转、金句、神回复
2. 每条包含：发言者、原话、为什么有趣（简短点评）
3. 不要选敏感/争议内容
4. 点评要幽默风趣

今日消息（前200条）：
${messages.slice(0, 200).map(m => `[${m.time}] ${m.user}：${m.content}`).join('\n').slice(0, 6000)}

输出JSON格式：
{
  "goldenQuotes": [
    {
      "sender": "用户名",
      "content": "原文内容",
      "reason": "点评内容",
      "userId": "用户ID（如果能识别）"
    }
  ],
  "tokenUsage": {
    "promptTokens": 0,
    "completionTokens": 0,
    "totalTokens": 0
  }
}`

  try {
    const text = await aiClient.callAI(prompt, '请选出今日圣经', 1500)
    const jsonMatch = text.match(/\{[\s\S]*\}/)
    if (jsonMatch) {
      const data = JSON.parse(jsonMatch[0]) as { goldenQuotes?: GoldenQuotePayload[], tokenUsage?: TokenUsage }
      return {
        goldenQuotes: (data.goldenQuotes || []).map(q => createGoldenQuote(q.content as string, q.sender as string, q.reason as string, q.userId as string | undefined)),
        tokenUsage: data.tokenUsage || { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      }
    }
  } catch (err) {
    console.error('[golden-quote-analyzer] 分析失败:', getErrorMessage(err))
  }

  return { goldenQuotes: [], tokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } }
}

export = { analyzeGoldenQuotes }
