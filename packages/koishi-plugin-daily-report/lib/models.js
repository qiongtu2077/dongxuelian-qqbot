"use strict";
const REPORT_EMPTY_STATES = Object.freeze({
    topics: '本期未形成可总结的实质话题。',
    quotes: '本期暂无适合展示的金句。',
    portraits: '本期发言不足以形成有据的群友画像。',
    review: '本期互动依据不足，暂不生成锐评。',
});
// 只有整体成功且模块明确不足的新链结果可展示空态，旧链、失败或未知状态不能冒充不足。
function getReportEmptyStates(analysis) {
    const result = {};
    if (analysis.analysisVersion !== 'grounded-report-1' || analysis.meta?.analysisState !== 'complete')
        return result;
    for (const module of ['topics', 'quotes', 'portraits', 'review']) {
        if (analysis.audit?.modules[module] === 'insufficient')
            result[module] = REPORT_EMPTY_STATES[module];
    }
    return result;
}
/**
 * 创建默认的分析结果
 */
function createDefaultAnalysisResult() {
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
    };
}
/**
 * 创建话题对象
 */
function createTopic(id, title, summary, participants) {
    return { id, title, summary, participants };
}
/**
 * 创建用户称号对象
 */
function createUserTitle(name, userId, title, reason, mbti = '') {
    return { name, userId, title, reason, mbti };
}
/**
 * 创建金句对象
 */
function createGoldenQuote(content, sender, reason, userId = '') {
    return { content, sender, reason, userId };
}
module.exports = {
    getReportEmptyStates,
    createDefaultAnalysisResult,
    createTopic,
    createUserTitle,
    createGoldenQuote,
};
