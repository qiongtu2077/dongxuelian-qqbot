/** 正常不足必须来自明确成功状态，文字展示保留其余独立模块与程序统计。 */
'use strict'
const assert = require('assert').strict
const { getReportEmptyStates } = require('../lib/models')
const { composeDailyReportText } = require('../lib/report-pipeline')
const { makeReportDisplayFixture } = require('./helpers/report-display-fixture')

// 失败、未完成、旧版和未请求模块不能因为数组为空而展示成功不足。
function checkDisplayStateBoundary() {
  const { analysis } = makeReportDisplayFixture(true, 0, true)
  assert.equal(Object.keys(getReportEmptyStates(analysis)).length, 4)
  for (const change of [{ analysisVersion: undefined }, { meta: undefined }, { audit: undefined }, { meta: { analysisState: 'failed' } }, { meta: { analysisState: 'running' } }]) {
    assert.deepEqual(getReportEmptyStates({ ...analysis, ...change }), {})
  }
  assert.deepEqual(Object.keys(getReportEmptyStates(makeReportDisplayFixture(false, 0).analysis)), ['topics', 'quotes'])
}

// 0/1/2话题和独立不足正常输出全文，不用无话题分支删除金句、画像或锐评。
function checkTextStates() {
  for (const detailed of [false, true]) for (const count of [0, 1, 2]) {
    const { data, analysis } = makeReportDisplayFixture(detailed, count), empty = getReportEmptyStates(analysis)
    const text = composeDailyReportText(data, analysis, { detail: detailed })
    assert(text.includes('消息：42 条') && text.includes('活跃成员：4 人'))
    for (const message of Object.values(empty)) assert(text.includes(message))
    for (const topic of analysis.topics) assert(text.includes(topic.title) && text.includes(topic.summary))
    for (const quote of analysis.goldenQuotes) assert(text.includes(quote.content))
    for (const portrait of analysis.userTitles) assert(text.includes(portrait.reason))
    if (analysis.qualityReview) assert(text.includes(analysis.qualityReview.summary))
    if (!detailed) assert(!text.includes('群友画像：') && !text.includes('群聊锐评：'))
  }
  const { data, analysis } = makeReportDisplayFixture(true, 0, true), text = composeDailyReportText(data, analysis, { detail: true })
  assert(Object.values(getReportEmptyStates(analysis)).every(message => text.includes(message)))
  const incomplete = composeDailyReportText(data, { ...analysis, meta: { analysisState: 'failed' } }, { detail: true })
  assert(!Object.values(getReportEmptyStates(analysis)).some(message => incomplete.includes(message)))
}

// 正式行为入口同时检验成功不足边界和完整文字，图片另用真实浏览器矩阵验收。
function runReportDisplayTests(check) {
  for (const [name, run] of [['只有整体成功且模块明确不足才生成空态文案', checkDisplayStateBoundary], ['普通详细0/1/2话题文字保留独立模块及程序统计', checkTextStates]]) {
    try { run(); check(name, true) } catch (error) { check(name, false, error.stack || String(error)) }
  }
}
module.exports = { runReportDisplayTests }
