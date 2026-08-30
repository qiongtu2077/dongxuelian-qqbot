/**
 * MODULE: 话题分析器。
 * 职责: 分析群聊消息，提取主要讨论话题。
 * 边界: 只做分析，不调API，通过 aiClient.callAI 间接调用。
 */
const { createTopic } = require('../models') as typeof import('../models')
const { getErrorMessage } = require('../error-utils') as typeof import('../error-utils')

interface TokenUsage {
  promptTokens: number
  completionTokens: number
  totalTokens: number
}

interface Topic {
  id: number
  title: string
  summary: string
  participants: string[]
}

interface ReportMessage {
  time?: string
  user?: string
  content?: string
}

interface AiClientLike {
  callAI(prompt: string, userMessage: string, maxTokens?: number): Promise<string>
}

interface TopicPayload {
  id?: unknown
  title?: unknown
  summary?: unknown
  participants?: unknown
}

interface TopicResult {
  topics: Topic[]
  tokenUsage: TokenUsage
}

async function analyzeTopics(
  aiClient: { callAI(prompt: string, userMessage: string, maxTokens?: number): Promise<string> },
  messages: Array<{ time?: unknown, user?: unknown, content?: unknown }>,
): Promise<{ topics: Array<{ id: number, title: string, summary: string, participants: string[] }>, tokenUsage: { promptTokens: number, completionTokens: number, totalTokens: number } }> {
  const sample = messages.slice(0, 300)
  const messagesText = sample.map(m => `[${m.time}] ${m.user}：${m.content}`).join('\n')

  const prompt = `你是群聊话题分析专家。请分析以下群聊消息，提取4-5个主要讨论话题。

要求：
1. 每个话题需要：标题（6-12字）、摘要（50-80字）、参与成员列表
2. 按讨论热度排序（发言数多的排前面）
3. 话题要具体，不要笼统（如"怪物猎人武器讨论"而不是"游戏讨论"）

今日消息（前300条）：
${messagesText.slice(0, 6000)}

输出JSON格式：
{
  "topics": [
    {
      "id": 1,
      "title": "话题标题",
      "summary": "话题摘要内容...",
      "participants": ["用户1", "用户2"]
    }
  ],
  "tokenUsage": {
    "promptTokens": 0,
    "completionTokens": 0,
    "totalTokens": 0
  }
}`

  try {
    const text = await aiClient.callAI(prompt, '请分析今日话题', 1500)
    const jsonMatch = text.match(/\{[\s\S]*\}/)
    if (jsonMatch) {
      const data = JSON.parse(jsonMatch[0]) as { topics?: TopicPayload[], tokenUsage?: TokenUsage }
      return {
        topics: (data.topics || []).map(t => createTopic(t.id as number, t.title as string, t.summary as string, t.participants as string[])),
        tokenUsage: data.tokenUsage || { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      }
    }
  } catch (err) {
    console.error('[topic-analyzer] 分析失败:', getErrorMessage(err))
  }

  return { topics: [], tokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } }
}

export = { analyzeTopics }
