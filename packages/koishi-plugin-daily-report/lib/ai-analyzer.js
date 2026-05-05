/**
 * MODULE: AI分析模块。
 * 职责: 根据模式执行不同深度的分析。
 * 边界: 复用主插件的 runtime-config.js + api.js。
 */
const { loadConfig } = require('../../koishi-plugin-dongxuelian-ai/lib/runtime-config')
const { requestChatCompletions } = require('../../koishi-plugin-dongxuelian-ai/lib/api')
const { createDefaultAnalysisResult, createUserTitle } = require('./models')

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

// 安全JSON解析（处理AI返回的格式错误）
function safeParseJSON(text) {
  // 尝试直接解析
  const jsonMatch = text.match(/\{[\s\S]*\}/)
  if (!jsonMatch) return null
  try {
    return JSON.parse(jsonMatch[0])
  } catch {}

  // 尝试修复常见问题：截断的JSON
  let str = jsonMatch[0]
  // 移除末尾不完整的对象/数组
  str = str.replace(/,\s*\{[^}]*$/, '')
  str = str.replace(/,\s*\[[^\]]*$/, '')
  // 补全缺失的括号
  const openBraces = (str.match(/\{/g) || []).length
  const closeBraces = (str.match(/\}/g) || []).length
  const openBrackets = (str.match(/\[/g) || []).length
  const closeBrackets = (str.match(/\]/g) || []).length
  str += ']'.repeat(Math.max(0, openBrackets - closeBrackets))
  str += '}'.repeat(Math.max(0, openBraces - closeBraces))

  try {
    return JSON.parse(str)
  } catch {
    console.error('[ai-analyzer] JSON修复失败:', str.slice(0, 200))
    return null
  }
}

async function analyzeBasic(compressed, messages) {
  // 构建昵称→QQ号映射表，确保金句能抓到头像
  const nameToUserId = new Map()
  if (messages && messages.length) {
    for (const msg of messages) {
      if (msg.user && msg.userId && !nameToUserId.has(msg.user)) {
        nameToUserId.set(msg.user, msg.userId)
      }
    }
  }
  const memberMapStr = JSON.stringify(Object.fromEntries(nameToUserId))

  const prompt = `你是群聊分析师。根据以下压缩后的群聊摘要，完成两项任务：

1. 提取4-5个主要话题（标题6-12字，摘要50-80字，参与成员）
2. 精选3条最有趣/有梗的金句（发言者、原话、简短点评）

重要规则：
- 金句的sender必须使用原始消息中的确切昵称，不能用"群友""某人"等泛称
- userId必须从以下映射表中查找，查不到的不要编造
- 如果无法确定某条金句的发送者对应映射表中的哪个用户，则不生成该条金句

用户昵称→QQ号映射表：
${memberMapStr}

压缩摘要：
${compressed.slice(0, 6000)}

输出JSON：
{
  "topics": [{"id":1,"title":"标题","summary":"摘要","participants":["用户1"]}],
  "goldenQuotes": [{"sender":"昵称","userId":"QQ号","content":"原话","reason":"点评"}]
}`

  try {
    const text = await callAI(prompt, '请分析', 2000)
    const parsed = safeParseJSON(text)
    return parsed || { topics: [], goldenQuotes: [] }
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
    const text = await callAI(prompt, '请分析', 3000)
    const parsed = safeParseJSON(text)
    return parsed || { userTitles: [], qualityReview: null }
  } catch (err) {
    console.error('[ai-analyzer] full分析失败:', err.message)
  }
  return { userTitles: [], qualityReview: null }
}

function buildFallbackUserTitles(data) {
  const members = Array.isArray(data.topMembers) ? data.topMembers.slice(0, 6) : []
  const titles = ['高频发言担当', '话题推进器', '稳定插话人', '气氛补给站', '边角料捕手', '潜在节奏点']
  return members.map((member, index) => {
    const msgCount = Number(member.msgCount || 0)
    const percent = data.totalMessages ? Math.round(msgCount * 100 / data.totalMessages) : 0
    const name = member.name || '群友'
    const reason = `今天发言 ${msgCount} 条，约占全群 ${percent}%，是本群可见度较高的活跃成员。`
    return createUserTitle(name, member.userId || '', titles[index] || '活跃群友', reason, '')
  })
}

function buildFallbackQualityReview(data) {
  const totalMessages = Number(data.totalMessages || 0)
  const activeMembers = Number(data.activeMembers || 0)
  const emojiCount = Number(data.emojiCount || 0)
  const emojiRate = totalMessages ? Math.round(emojiCount * 100 / totalMessages) : 0
  return {
    title: '今日群聊热度在线',
    subtitle: `${totalMessages} 条消息，${activeMembers} 位成员参与，峰值出现在 ${data.peakHour || '未知时段'}`,
    dimensions: [
      {
        name: '聊天活跃度',
        percentage: 40,
        comment: `全天累计 ${totalMessages} 条消息，峰值时段清晰，群聊热度不低。`,
        color: '#39C5BB',
      },
      {
        name: '成员参与度',
        percentage: 25,
        comment: `${activeMembers} 位成员参与发言，核心发言者撑起了主要讨论。`,
        color: '#A7E7E3',
      },
      {
        name: '信息密度',
        percentage: 20,
        comment: `累计文字约 ${data.totalChars || 0} 字，适合提炼成话题和金句。`,
        color: '#FCD34D',
      },
      {
        name: '表情浓度',
        percentage: 15,
        comment: `表情互动 ${emojiCount} 次，约占消息量 ${emojiRate}%，气氛有明显波动。`,
        color: '#F472B6',
      },
    ],
    summary: '整体来看，今天的群聊有明确活跃高峰和核心发言成员，内容足够支撑日报复盘；如果话题再集中一点，阅读价值还能继续上升。',
  }
}

function buildFallbackFullAnalysis(data) {
  return {
    userTitles: buildFallbackUserTitles(data),
    qualityReview: buildFallbackQualityReview(data),
  }
}

function completeFullAnalysis(result, data) {
  const fallback = buildFallbackFullAnalysis(data)
  if (!Array.isArray(result.userTitles) || result.userTitles.length === 0) {
    result.userTitles = fallback.userTitles
  }
  if (!result.qualityReview || typeof result.qualityReview !== 'object') {
    result.qualityReview = fallback.qualityReview
  }
  return result
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
      result.goldenQuotes = filterGoldenQuotes(basic.goldenQuotes, data.messages)
      result.userTitles = fullR.userTitles || []
      result.qualityReview = fullR.qualityReview || null
      completeFullAnalysis(result, data)
    } else {
      const basicResult = await analyzeBasic(compressed, data.messages)
      result.topics = basicResult.topics || []
      result.goldenQuotes = filterGoldenQuotes(basicResult.goldenQuotes, data.messages)
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
    if (full) completeFullAnalysis(result, data)
  }

  return result
}

module.exports = { analyzeWithAI, buildFallbackFullAnalysis }

// 过滤金句：用消息映射表验证userId，无匹配的丢弃
function filterGoldenQuotes(quotes, messages) {
  if (!quotes || !quotes.length || !messages || !messages.length) return quotes || []
  const nameToUserId = new Map()
  for (const msg of messages) {
    if (msg.user && msg.userId && !nameToUserId.has(msg.user)) {
      nameToUserId.set(msg.user, msg.userId)
    }
  }
  return quotes.filter(q => {
    if (!q.sender) return false
    const mappedId = nameToUserId.get(q.sender)
    if (!mappedId) return false
    q.userId = mappedId
    return true
  })
}
