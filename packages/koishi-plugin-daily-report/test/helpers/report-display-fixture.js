/** 仅供展示回归的固定视图，全部人物和文字虚构，不代表模型验收。 */
'use strict'
const { createReportPeriod } = require('koishi-plugin-dongxuelian-ai/lib/public/management-runtime').loadManagementModule('daily.reportPeriod')

// 普通/详细的0、1、2话题分别覆盖不足与独立模块，另有详细全部不足视图。
function makeReportDisplayFixture(detailed, topicCount, allEmpty = false) {
  if (![0, 1, 2].includes(topicCount) || (allEmpty && (!detailed || topicCount !== 0))) throw new Error('未知固定展示场景')
  const topics = [
    { id: 1, title: '安装方案与版本切换', summary: '成员讨论安装步骤和版本切换，约定先在测试环境确认设置。', participants: ['成员甲', '成员乙'] },
    { id: 2, title: '集合时间与参与安排', summary: '成员确认集合时间，分别补充能够参与的时段。', participants: ['成员丙', '成员丁'] },
  ].slice(0, topicCount)
  const quote = !allEmpty && (topicCount === 2 || detailed && topicCount === 0)
  const portrait = detailed && !allEmpty && topicCount !== 1
  const review = detailed && !allEmpty && topicCount !== 1
  const modules = { topics: topics.length ? 'complete' : 'insufficient', quotes: quote ? 'complete' : 'insufficient',
    portraits: detailed ? portrait ? 'complete' : 'insufficient' : 'not_requested', review: detailed ? review ? 'complete' : 'insufficient' : 'not_requested' }
  const reportPeriod = createReportPeriod(Date.parse('2026-10-06T18:00:00+08:00'))
  const data = { date: reportPeriod.reportDate, reportPeriod, totalMessages: 42, activeMembers: 4, emojiCount: 8, totalChars: 2400,
    peakHour: '12:00-12:59', hourlyActivity: Array.from({ length: 24 }, (_, hour) => hour === 12 ? 28 : hour === 11 ? 14 : 0) }
  const analysis = { analysisVersion: 'grounded-report-1', meta: { analysisState: 'complete' }, audit: { modules }, topics,
    goldenQuotes: quote ? [{ userId: 'fixture-a', sender: '成员甲', content: '先确认事实，再一起解决问题。', reason: '表达了共同讨论的方式。' }] : [],
    userTitles: portrait ? [{ userId: 'fixture-a', name: '成员甲', title: '本期参与者', mbti: '', reason: '本期补充具体安排，也及时回应了其他成员的问题。' }] : [],
    qualityReview: review ? { title: '本期互动', subtitle: '主观指数；窗口消息量：42条。窗口活跃成员：4人。',
      summary: '大家围绕实际安排补充信息，讨论清晰简短。', dimensions: [{ name: '交流', percentage: 50, comment: '成员补充了各自的安排。', color: '#39C5BB' }] } : null,
    tokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } }
  return { data, analysis, detailed, topicCount, allEmpty }
}

module.exports = { makeReportDisplayFixture }
