/**
 * MODULE: AI分析模块。
 * 职责: 协调各个分析器，生成完整分析结果。
 * 边界: 不自己实现API调用，复用主插件的 runtime-config.js + api.js。
 */
const { loadConfig } = require('../../koishi-plugin-dongxuelian-ai/lib/runtime-config')
const { requestChatCompletions } = require('../../koishi-plugin-dongxuelian-ai/lib/api')
const { createDefaultAnalysisResult } = require('./models')
const { analyzeTopics } = require('./analyzers/topic-analyzer')
const { analyzeUserTitles } = require('./analyzers/user-title-analyzer')
const { analyzeGoldenQuotes } = require('./analyzers/golden-quote-analyzer')
const { analyzeChatQuality } = require('./analyzers/chat-quality-analyzer')

/**
 * 调用AI（复用主插件的 fallback 链和超时控制）
 * @param {string} systemPrompt - 系统提示词
 * @param {string} userMessage - 用户消息
 * @param {number} maxTokens - 最大token数
 * @returns {Promise<string>} - AI回复文本
 */
async function callAI(systemPrompt, userMessage, maxTokens = 1500) {
  const config = await loadConfig()
  const result = await requestChatCompletions([
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userMessage },
  ], config, { max_tokens: maxTokens })
  return result
}

/**
 * 分析所有内容
 * @param {Object} data - 统计数据
 * @returns {Promise<Object>} - AnalysisResult
 */
async function analyzeWithAI(data) {
  const result = createDefaultAnalysisResult()

  try {
    // 并行执行所有分析
    const [topicsResult, titlesResult, quotesResult, qualityResult] = await Promise.all([
      analyzeTopics({ callAI }, data.messages),
      analyzeUserTitles({ callAI }, data.messages, data.topMembers),
      analyzeGoldenQuotes({ callAI }, data.messages),
      analyzeChatQuality({ callAI }, data),
    ])

    // 合并结果
    result.topics = topicsResult.topics
    result.userTitles = titlesResult.userTitles
    result.goldenQuotes = quotesResult.goldenQuotes
    result.qualityReview = qualityResult.qualityReview

    // 合并token使用统计
    result.tokenUsage = {
      promptTokens: topicsResult.tokenUsage.promptTokens + titlesResult.tokenUsage.promptTokens + quotesResult.tokenUsage.promptTokens + qualityResult.tokenUsage.promptTokens,
      completionTokens: topicsResult.tokenUsage.completionTokens + titlesResult.tokenUsage.completionTokens + quotesResult.tokenUsage.completionTokens + qualityResult.tokenUsage.completionTokens,
      totalTokens: topicsResult.tokenUsage.totalTokens + titlesResult.tokenUsage.totalTokens + quotesResult.tokenUsage.totalTokens + qualityResult.tokenUsage.totalTokens,
    }
  } catch (err) {
    console.error('[ai-analyzer] 分析失败:', err.message)
  }

  return result
}

module.exports = { analyzeWithAI }
