/**
 * MODULE: 数据模型定义。
 * 参考Python插件的dataclass设计。
 */
import type { GroundedReportResult } from './report-runner';
interface ReportDisplayState {
    analysisVersion?: GroundedReportResult['analysisVersion'];
    meta?: Pick<GroundedReportResult['meta'], 'analysisState'>;
    audit?: Pick<GroundedReportResult['audit'], 'modules'>;
}
declare const REPORT_EMPTY_STATES: Readonly<{
    topics: "本期未形成可总结的实质话题。";
    quotes: "本期暂无适合展示的金句。";
    portraits: "本期发言不足以形成有据的群友画像。";
    review: "本期互动依据不足，暂不生成锐评。";
}>;
interface TokenUsage {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
}
interface Topic {
    id: number;
    title: string;
    summary: string;
    participants: string[];
}
interface UserTitle {
    name: string;
    userId: string;
    title: string;
    reason: string;
    mbti: string;
}
interface GoldenQuote {
    content: string;
    sender: string;
    reason: string;
    userId: string;
}
interface QualityDimension {
    name: string;
    percentage: number;
    comment: string;
    color: string;
}
interface QualityReview {
    title: string;
    subtitle: string;
    dimensions: QualityDimension[];
    summary: string;
}
interface AnalysisResult extends ReportDisplayState {
    topics: Topic[];
    userTitles: UserTitle[];
    goldenQuotes: GoldenQuote[];
    qualityReview: QualityReview | null;
    tokenUsage: TokenUsage;
    meta?: GroundedReportResult['meta'];
}
declare function getReportEmptyStates(analysis: ReportDisplayState): Partial<Record<keyof typeof REPORT_EMPTY_STATES, string>>;
/**
 * 创建默认的分析结果
 */
declare function createDefaultAnalysisResult(): AnalysisResult;
/**
 * 创建话题对象
 */
declare function createTopic(id: number, title: string, summary: string, participants: string[]): Topic;
/**
 * 创建用户称号对象
 */
declare function createUserTitle(name: string, userId: string, title: string, reason: string, mbti?: string): UserTitle;
/**
 * 创建金句对象
 */
declare function createGoldenQuote(content: string, sender: string, reason: string, userId?: string): GoldenQuote;
declare const _default: {
    getReportEmptyStates: typeof getReportEmptyStates;
    createDefaultAnalysisResult: typeof createDefaultAnalysisResult;
    createTopic: typeof createTopic;
    createUserTitle: typeof createUserTitle;
    createGoldenQuote: typeof createGoldenQuote;
};
export = _default;
