/**
 * MODULE: 分析器索引。
 */
const { analyzeTopics } = require('./topic-analyzer') as typeof import('./topic-analyzer')
const { analyzeUserTitles } = require('./user-title-analyzer') as typeof import('./user-title-analyzer')
const { analyzeGoldenQuotes } = require('./golden-quote-analyzer') as typeof import('./golden-quote-analyzer')
const { analyzeChatQuality } = require('./chat-quality-analyzer') as typeof import('./chat-quality-analyzer')

export = {
  analyzeTopics,
  analyzeUserTitles,
  analyzeGoldenQuotes,
  analyzeChatQuality,
}
