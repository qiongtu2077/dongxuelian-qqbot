/**
 * MODULE: 数据模型定义。
 * 参考Python插件的dataclass设计。
 */
import type { GroundedReportResult } from './report-runner'

interface ReportDisplayState {
  analysisVersion?: GroundedReportResult['analysisVersion']
  meta?: Pick<GroundedReportResult['meta'], 'analysisState'>
  audit?: Pick<GroundedReportResult['audit'], 'modules'>
}

const REPORT_EMPTY_STATES = Object.freeze({
  topics: '本期未形成可总结的实质话题。',
  quotes: '本期暂无适合展示的金句。',
  portraits: '本期发言不足以形成有据的群友画像。',
  review: '本期互动依据不足，暂不生成锐评。',
})

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

interface AnalysisResult extends ReportDisplayState {
  topics: Topic[]
  userTitles: UserTitle[]
  goldenQuotes: GoldenQuote[]
  qualityReview: QualityReview | null
  tokenUsage: TokenUsage
  meta?: GroundedReportResult['meta']
}

// 只有整体成功且模块明确不足的新链结果可展示空态，旧链、失败或未知状态不能冒充不足。
function getReportEmptyStates(analysis: ReportDisplayState): Partial<Record<keyof typeof REPORT_EMPTY_STATES, string>> {
  const result: Partial<Record<keyof typeof REPORT_EMPTY_STATES, string>> = {}
  if (analysis.analysisVersion !== 'grounded-report-1' || analysis.meta?.analysisState !== 'complete') return result
  for (const module of ['topics', 'quotes', 'portraits', 'review'] as const) {
    if (analysis.audit?.modules[module] === 'insufficient') result[module] = REPORT_EMPTY_STATES[module]
  }
  return result
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
  getReportEmptyStates,
  createDefaultAnalysisResult,
  createTopic,
  createUserTitle,
  createGoldenQuote,
}
