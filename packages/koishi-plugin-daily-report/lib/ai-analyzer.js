/**
 * MODULE: AI分析模块。
 * 职责: 根据模式执行不同深度的分析。
 * 边界: 复用主插件的 runtime-config.js + api.js。
 */
const { loadConfig } = require('../../koishi-plugin-dongxuelian-ai/lib/runtime-config')
const { requestChatCompletions } = require('../../koishi-plugin-dongxuelian-ai/lib/api')
const { createDefaultAnalysisResult } = require('./models')

async function callAI(systemPrompt, userMessage, maxTokens = 1500) {
  const config = await loadConfig()
  const result = await requestChatCompletions([
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userMessage },
  ], config, { max_tokens: maxTokens })
  return result
}

async function compressMessages(messages) {
  const batchSize = 100
  const batches = []
  for (let i = 0; i < messages.length; i += batchSize) {
    const batch = messages.slice(i, i + batchSize)
    const batchText = batch.map(m => `[${m.time}] ${m.user}：${m.content}`).join('\n')
    batches.push(callAI(
      '你是群聊摘要助手。将以下群聊记录压缩成100字以内的摘要，保留主要话题和有趣对话。不要评价，只摘要。',
      batchText.slice(0, 4000),
      200
    ))
  }
  const results = await Promise.allSettled(batches)
  return results
    .filter(r => r.status === 'fulfilled' && r.value)
    .map(r => r.value)
    .join('\n---\n')
}

async function analyzeBasic(compressed, messages) {
  const prompt = `你是群聊分析师。根据以下压缩后的群聊摘要，完成两项任务：

1. 提取4-5个主要话题（标题6-12字，摘要50-80字，参与成员）
2. 精选3条最有趣/有梗的金句（发言者、原话、简短点评）

压缩摘要：
${compressed.slice(0, 6000)}

输出JSON：
{
  "topics": [{"id":1,"title":"标题","summary":"摘要","participants":["用户1"]}],
  "goldenQuotes": [{"sender":"用户","content":"原话","reason":"点评"}]
}`

  try {
    const text = await callAI(prompt, '请分析', 2000)
    const jsonMatch = text.match(/\{[\s\S]*\}/)
    if (jsonMatch) return JSON.parse(jsonMatch[0])
  } catch (err) {
    console.error('[ai-analyzer] basic分析失败:', err.message)
  }
  return { topics: [], goldenQuotes: [] }
}

async function analyzeFull(compressed, messages, topMembers) {
  const memberData = topMembers.slice(0, 8).map(m => {
    const sample = messages
      .filter(msg => msg.userId === m.userId || msg.user === m.name)
      .slice(0, 15)
      .map(msg => msg.content).join(' | ')
    return { name: m.name, userId: m.userId, msgCount: m.msgCount, sample: sample.slice(0, 300) }
  })

  const prompt = `你是群聊分析师。根据以下压缩摘要和成员数据，完成两项任务：

1. 为每位活跃成员生成画像（角色标签、MBTI可选、50字特征描述）
2. 写一段群聊质量锐评（标题、副标题、4-5个维度含占比和点评、总结）

压缩摘要：
${compressed.slice(0, 4000)}

成员数据：
${JSON.stringify(memberData, null, 2)}

输出JSON：
{
  "userTitles": [{"name":"用户名","userId":"ID","title":"角色标签","mbti":"","reason":"描述"}],
  "qualityReview": {
    "title":"标题","subtitle":"副标题",
    "dimensions": [{"name":"维度","percentage":40,"comment":"点评","color":"#39C5BB"}],
    "summary":"总结"
  }
}`

  try {
    const text = await callAI(prompt, '请分析', 2000)
    const jsonMatch = text.match(/\{[\s\S]*\}/)
    if (jsonMatch) return JSON.parse(jsonMatch[0])
  } catch (err) {
    console.error('[ai-analyzer] full分析失败:', err.message)
  }
  return { userTitles: [], qualityReview: null }
}

async function analyzeWithAI(data, full = false) {
  const result = createDefaultAnalysisResult()

  try {
    const compressed = await compressMessages(data.messages)

    if (full) {
      const [basicResult, fullResult] = await Promise.allSettled([
        analyzeBasic(compressed, data.messages),
        analyzeFull(compressed, data.messages, data.topMembers),
      ])
      const basic = basicResult.status === 'fulfilled' ? basicResult.value : {}
      const fullR = fullResult.status === 'fulfilled' ? fullResult.value : {}
      result.topics = basic.topics || []
      result.goldenQuotes = basic.goldenQuotes || []
      result.userTitles = fullR.userTitles || []
      result.qualityReview = fullR.qualityReview || null
    } else {
      const basicResult = await analyzeBasic(compressed, data.messages)
      result.topics = basicResult.topics || []
      result.goldenQuotes = basicResult.goldenQuotes || []
    }

    // token估算：中文约2字符=1 token，加上prompt开销
    // 压缩阶段：N批 × 200 tokens
    // 分析阶段：1-2次调用 × 1500 tokens
    const batches = Math.ceil(data.messages.length / 100)
    const compressTokens = batches * 200
    const analysisTokens = full ? 3500 : 2000
    result.tokenUsage = {
      promptTokens: compressTokens + analysisTokens,
      completionTokens: 0,
      totalTokens: compressTokens + analysisTokens,
    }
  } catch (err) {
    console.error('[ai-analyzer] 分析失败:', err.message)
  }

  return result
}

module.exports = { analyzeWithAI }
