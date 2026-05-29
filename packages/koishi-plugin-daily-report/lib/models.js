"use strict";
/**
 * MODULE: 数据模型定义。
 * 参考Python插件的dataclass设计。
 */
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
    createDefaultAnalysisResult,
    createTopic,
    createUserTitle,
    createGoldenQuote,
};
