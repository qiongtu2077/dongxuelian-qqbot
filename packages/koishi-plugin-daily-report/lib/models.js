/**
 * MODULE: 数据模型定义。
 * 参考Python插件的dataclass设计。
 */

/**
 * 话题总结
 * @typedef {Object} Topic
 * @property {number} id - 话题编号
 * @property {string} title - 话题标题
 * @property {string} summary - 话题摘要
 * @property {string[]} participants - 参与成员
 */

/**
 * 用户称号
 * @typedef {Object} UserTitle
 * @property {string} name - 用户名
 * @property {string} userId - 用户ID
 * @property {string} title - 称号（如：活跃水怪、夜猫子）
 * @property {string} mbti - MBTI类型（可选）
 * @property {string} reason - 原因说明
 */

/**
 * 今日金句
 * @typedef {Object} GoldenQuote
 * @property {string} content - 原文内容
 * @property {string} sender - 发送者
 * @property {string} reason - 点评
 * @property {string} userId - 用户ID（可选）
 */

/**
 * 聊天质量维度
 * @typedef {Object} QualityDimension
 * @property {string} name - 维度名称
 * @property {number} percentage - 占比
 * @property {string} comment - 点评
 * @property {string} color - 颜色
 */

/**
 * 聊天质量锐评
 * @typedef {Object} QualityReview
 * @property {string} title - 标题
 * @property {string} subtitle - 副标题
 * @property {QualityDimension[]} dimensions - 维度列表
 * @property {string} summary - 总结
 */

/**
 * 分析结果
 * @typedef {Object} AnalysisResult
 * @property {Topic[]} topics - 话题列表
 * @property {UserTitle[]} userTitles - 用户称号列表
 * @property {GoldenQuote[]} goldenQuotes - 金句列表
 * @property {QualityReview|null} qualityReview - 质量锐评
 * @property {TokenUsage} tokenUsage - Token使用统计
 */

/**
 * Token使用统计
 * @typedef {Object} TokenUsage
 * @property {number} promptTokens - 提示词token数
 * @property {number} completionTokens - 完成token数
 * @property {number} totalTokens - 总token数
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
  }
}

/**
 * 创建话题对象
 */
function createTopic(id, title, summary, participants) {
  return { id, title, summary, participants }
}

/**
 * 创建用户称号对象
 */
function createUserTitle(name, userId, title, reason, mbti = '') {
  return { name, userId, title, reason, mbti }
}

/**
 * 创建金句对象
 */
function createGoldenQuote(content, sender, reason, userId = '') {
  return { content, sender, reason, userId }
}

module.exports = {
  createDefaultAnalysisResult,
  createTopic,
  createUserTitle,
  createGoldenQuote,
}
