/**
 * MODULE: 分析器索引。
 */
const { analyzeTopics } = require('./topic-analyzer')
const { analyzeUserTitles } = require('./user-title-analyzer')
const { analyzeGoldenQuotes } = require('./golden-quote-analyzer')
const { analyzeChatQuality } = require('./chat-quality-analyzer')

module.exports = {
  analyzeTopics,
  analyzeUserTitles,
  analyzeGoldenQuotes,
  analyzeChatQuality,
}
