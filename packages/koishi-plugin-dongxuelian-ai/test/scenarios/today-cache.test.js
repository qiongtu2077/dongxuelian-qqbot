const { withScenario } = require('./_setup')

// 场景：today-cache 运行期回读（issue #11 依赖项，也是"详细日报只有最近几百条"的根因）。
// 背景：群安静超过 CHANNEL_RUNTIME_CACHE_TTL_MS(6h) 后内存缓存被驱逐，下一条消息
// 重建缓存。修复前直接建空缓存并把磁盘文件覆盖掉，当天历史全丢；修复后先回读磁盘。
async function run(t) {
  t.section('scenario: today-cache runtime read-back')

  await withScenario({}, async ({ data, makeSession, run }) => {
    const { todayCst } = require('../../lib/core/utils')
    const today = todayCst()
    const baseTs = Date.now() - 3600000 // 1 小时前：属于今天，且未过保留期

    const row = (index, extra = {}) => ({
      time: `10:${String(index + 1).padStart(2, '0')}:00`,
      ts: baseTs + index,
      user: `User${index + 1}`,
      userId: `u${index + 1}`,
      content: `早上第${index + 1}条 @消息`,
      messageId: `morning-${index + 1}`,
      mentionUserIds: ['100000000'],
      ...extra,
    })

    // 前置：群在白名单，磁盘上有今天早上的历史；插件刚加载（内存缓存为空，
    // 且不触发 ready 阶段的启动恢复，等价于"运行期 TTL 驱逐之后"的状态）。
    data.writeJson('summary-whitelist.json', ['10001'])
    data.writeJson('today-cache-10001.json', { date: today, messages: [row(0), row(1), row(2)] })

    // 群冷掉 6h 后来了第一条新消息：应回读磁盘历史再追加，而不是从空开始。
    await run(makeSession({
      userId: '100000000',
      author: { id: '100000000', name: 'morning-user' },
      content: '下午好',
    }))

    // 断言走「谁艾特我」：它读内存缓存。修复前缓存只剩刚那条（无 mention），
    // 查询应为空；修复后早上 3 条 @ 记录必须完整出现。
    const whoAtMe = await run(makeSession({ content: '谁艾特我' }))
    const nodes = whoAtMe.internalCalls.find(call => call.method === 'sendGroupForwardMsg')?.messages || []
    const numbered = nodes.filter(node => /^\d+\. /.test(String(node?.data?.content || '')))
    t.check('scenario read-back keeps morning @ history after idle eviction', numbered.length === 3
      && String(numbered[0].data.content).includes('早上第3条 @消息')
      && String(numbered[2].data.content).includes('早上第1条 @消息'),
      JSON.stringify({ nodes: nodes.length, numbered: numbered.map(n => n.data && n.data.content), sent: whoAtMe.sent }))

    // 回读后的缓存再落盘时不能把新消息之前的记录丢掉（flush 是全量覆盖写）。
    // 对齐真实日报流程：先 flushTodayCacheToDisk 再 collectReportData 读盘。
    const { flushTodayCacheToDisk, channelTodayCache: liveCache } = require('../../lib/conversation')
    if (liveCache && liveCache.size > 0) flushTodayCacheToDisk('10001')
    const { collectReportData } = require('koishi-plugin-daily-report/lib/data-collector')
    const reportData = collectReportData('10001')
    const contents = (reportData && reportData.messages || []).map(m => String(m.content || ''))
    t.check('scenario read-back merges disk history with new message for daily report',
      contents.includes('早上第1条 @消息') && contents.includes('早上第3条 @消息') && contents.includes('下午好'),
      JSON.stringify(contents))
  })

  // 回读的健壮性：磁盘文件损坏/缺失时必须回退到空缓存而不是抛错。
  await withScenario({}, async ({ data, makeSession, run }) => {
    data.writeJson('summary-whitelist.json', ['10001'])
    data.writeJson('today-cache-10001.json', null) // 等价于不可解析内容
    let threw = false
    try {
      await run(makeSession({ userId: '100000000', author: { id: '100000000', name: 'u' }, content: '你好' }))
    } catch {
      threw = true
    }
    t.check('scenario read-back tolerates corrupt cache file', !threw)
  })
}

module.exports = { run }
