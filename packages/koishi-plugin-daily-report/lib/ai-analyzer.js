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

// 压缩消息（参考今日情绪的降本方案）
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
  const results = await Promise.all(batches)
  return results.filter(Boolean).join('\n---\n')
}

// 分析话题+金句（基础模式）
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

  const text = await callAI(prompt, '请分析', 2000)
  const jsonMatch = text.match(/\{[\s\S]*\}/)
  if (jsonMatch) {
    try { return JSON.parse(jsonMatch[0]) } catch {}
  }
  return { topics: [], goldenQuotes: [] }
}

// 分析群友画像+锐评（详细模式追加）
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

  const text = await callAI(prompt, '请分析', 2000)
  const jsonMatch = text.match(/\{[\s\S]*\}/)
  if (jsonMatch) {
    try { return JSON.parse(jsonMatch[0]) } catch {}
  }
  return { userTitles: [], qualityReview: null }
}

/**
 * 分析入口
 * @param {Object} data - 统计数据
 * @param {boolean} full - 是否完整模式
 * @returns {Promise<Object>}
 */
async function analyzeWithAI(data, full = false) {
  const result = createDefaultAnalysisResult()

  try {
    // 第一步：压缩消息（共用）
    const compressed = await compressMessages(data.messages)

    if (full) {
      // 详细日报：并行执行基础+详细分析
      const [basicResult, fullResult] = await Promise.all([
        analyzeBasic(compressed, data.messages),
        analyzeFull(compressed, data.messages, data.topMembers),
      ])
      result.topics = basicResult.topics || []
      result.goldenQuotes = basicResult.goldenQuotes || []
      result.userTitles = fullResult.userTitles || []
      result.qualityReview = fullResult.qualityReview || null
    } else {
      // 基础日报：只跑话题+金句
      const basicResult = await analyzeBasic(compressed, data.messages)
      result.topics = basicResult.topics || []
      result.goldenQuotes = basicResult.goldenQuotes || []
    }

    // 统计token（估算）
    result.tokenUsage = {
      promptTokens: compressed.length * 2,
      completionTokens: 0,
      totalTokens: compressed.length * 2,
    }
  } catch (err) {
    console.error('[ai-analyzer] 分析失败:', err.message)
  }

  return result
}

module.exports = { analyzeWithAI }
