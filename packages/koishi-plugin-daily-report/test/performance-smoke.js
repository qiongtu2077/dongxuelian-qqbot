/** 使用已配置模型实测完整分析；只用虚构输入，不加载机器人或发送接口。 */
'use strict'
const assert = require('assert').strict
const fs = require('fs')
const path = require('path')
const { loadConfig } = require('koishi-plugin-dongxuelian-ai/lib/core/runtime-config')
const api = require('koishi-plugin-dongxuelian-ai/lib/core/api')
const request = api.requestChatCompletions
// 原始响应只对应本文件的虚构输入，保存正文和输出额度，不保存请求配置或凭据。
api.requestChatCompletions = async (messages, config, extra) => {
  const result = await request(messages, config, extra)
  const outputDir = path.join(process.env.DONGXUELIAN_AI_DATA_DIR, 'performance-evidence')
  fs.mkdirSync(outputDir, { recursive: true })
  fs.appendFileSync(path.join(outputDir, 'synthetic-model-responses.jsonl'), JSON.stringify({ maxTokens: extra.max_tokens,
    system: messages[0].content, input: messages[1].content, content: result.content }) + '\n')
  return result
}
const { analyzeWithAI } = require('../lib/ai-analyzer')

// 九个独立主题按前中后时段安排，正文及来源数随样例规模增长。
function makeInput(count) {
  const facts = ['露营安排：周六去山顶，携带防雨帐篷。', '跑步训练：每周三次，先热身再跑五公里。', '摄影经验：日落使用三脚架和低感光度。',
    '数据库维护：先备份再迁移，索引用于提高查询速度。', '编程排错：查看异常堆栈，再编写最小复现。', '网络延迟：检查丢包和路由，避免盲目重启。',
    '烘焙经验：面团冷藏发酵，烤箱提前预热。', '阅读计划：下周交流科幻小说的叙事结构。', '电影讨论：比较角色动机与镜头语言。']
  const messages = Array.from({ length: count }, (_, index) => ({ analysisId: index + 1, ts: 1791000000000 + index * 1000,
    time: `时段${Math.floor(index * 3 / count)}`, userId: String(index % 8 + 1), user: `虚构成员${index % 8 + 1}`,
    content: facts[Math.min(2, Math.floor(index * 3 / count)) * 3 + index % 3] }))
  return { messages, totalMessages: count, windowMessageCount: count, sourceCompleteness: 'complete',
    topMembers: Array.from({ length: 8 }, (_, i) => ({ userId: String(i + 1), name: `虚构成员${i + 1}`, msgCount: Math.ceil(count / 8) })) }
}

// 记录真实用量和耗时，不根据批次推算费用或宣称所有未来输入都能成功。
async function main() {
  const config = await loadConfig()
  console.log(JSON.stringify({ provider: config.provider, model: config.model, keyConfigured: !!config.apiKey }))
  const evidence = []
  const counts = process.env.DAILY_REPORT_PERFORMANCE_COUNTS ? process.env.DAILY_REPORT_PERFORMANCE_COUNTS.split(',').map(Number) : [591, 1330, 4000]
  assert(counts.length > 0 && counts.every(count => [591, 1330, 4000].includes(count)))
  for (const count of counts) {
    const startedAtMs = Date.now()
    const deadlineMs = startedAtMs + 600000
    let progress
    try {
      const result = await analyzeWithAI(makeInput(count), true, { deadlineMs, workDeadlineMs: deadlineMs - 30000,
        stageSoftDeadlinesMs: { compression: startedAtMs + 360000, merge: startedAtMs + 420000, basic: startedAtMs + 480000, full: startedAtMs + 480000 },
        onProgress(value) { progress = value } })
      assert.equal(result.meta.topicInputMessageCount, count)
      assert.equal(result.meta.omittedMessageCount, 0)
      assert(result.topics.length >= 5 && result.topics.length <= 10)
      const content = result.topics.map(topic => topic.title + topic.summary).join('\n')
      for (const theme of ['露营', '数据库', '烘焙']) assert(content.includes(theme), `未保留${theme}`)
      evidence.push({ count, ok: true, elapsedMs: Date.now() - startedAtMs, topics: result.topics.map(topic => topic.title), analysis: result.meta })
    } catch (error) {
      evidence.push({ count, ok: false, elapsedMs: Date.now() - startedAtMs, code: error.code || '', error: error.message, analysis: progress })
    }
    const outputDir = path.join(process.env.DONGXUELIAN_AI_DATA_DIR, 'performance-evidence')
    fs.mkdirSync(outputDir, { recursive: true })
    fs.writeFileSync(path.join(outputDir, 'model-performance.json'), JSON.stringify(evidence, null, 2))
    console.log(JSON.stringify(evidence.at(-1)))
  }
  process.exitCode = evidence.some(item => !item.ok) ? 1 : 0
}
main().catch(error => { console.error(error.message); process.exitCode = 1 })
