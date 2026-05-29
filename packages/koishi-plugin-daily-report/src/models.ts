/**
 * MODULE: 数据模型定义。
 * 参考Python插件的dataclass设计。
 */

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

interface UserTitle {
  name: string
  userId: string
  title: string
  reason: string
  mbti: string
}

interface GoldenQuote {
  content: string
  sender: string
  reason: string
  userId: string
}

interface QualityDimension {
  name: string
  percentage: number
  comment: string
  color: string
}

interface QualityReview {
  title: string
  subtitle: string
  dimensions: QualityDimension[]
  summary: string
}

interface AnalysisResult {
  topics: Topic[]
  userTitles: UserTitle[]
  goldenQuotes: GoldenQuote[]
  qualityReview: QualityReview | null
  tokenUsage: TokenUsage
  meta?: unknown
}

/**
 * 创建默认的分析结果
 */
function createDefaultAnalysisResult(): AnalysisResult {
  return {
    topics: [],
    userTitles: [],
    goldenQuotes: [],
    qualityReview: null,
    tokenUsage: {
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
    },
  }
}

/**
 * 创建话题对象
 */
function createTopic(id: number, title: string, summary: string, participants: string[]): Topic {
  return { id, title, summary, participants }
}

/**
 * 创建用户称号对象
 */
function createUserTitle(name: string, userId: string, title: string, reason: string, mbti = ''): UserTitle {
  return { name, userId, title, reason, mbti }
}

/**
 * 创建金句对象
 */
function createGoldenQuote(content: string, sender: string, reason: string, userId = ''): GoldenQuote {
  return { content, sender, reason, userId }
}

export = {
  createDefaultAnalysisResult,
  createTopic,
  createUserTitle,
  createGoldenQuote,
}
