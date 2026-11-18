const fs = require('fs')
const { withScenario } = require('./_setup')

const SNAPSHOT_FILE = 'today-cache-10001.json'
const FULL_CACHE_SIZE = 5000
const FLUSH_INTERVAL_MS = 5 * 60 * 1000

// --- 节流夹具 ---

// 预装旧格式的有序历史快照，不写入日报索引。
function seedSnapshot(data, now, length) {
  const { todayCst } = require('../../lib/core/utils')
  data.writeJson(SNAPSHOT_FILE, {
    date: todayCst(new Date(now)),
    messages: Array.from({ length }, (_, index) => ({
      time: '14:59:00', ts: now - 60000 + index, user: '旧用户', userId: '200000000',
      content: '历史消息', messageId: `old-${index}`, mentionUserIds: ['100000000'],
    })),
  })
}

// 仅在同步消息处理中固定时钟、跟踪目标快照和注入故障，不修改定时器或日报写入。
function withSnapshotProbe(data, now, exercise) {
  const tempPath = data.pathFor('today-cache-10001.tmp')
  const originalNow = Date.now
  const originalWrite = fs.writeFileSync
  const originalRename = fs.renameSync
  const probe = { now, writes: [], failAt: null }
  try {
    Date.now = () => probe.now
    fs.writeFileSync = (file, content, ...options) => {
      if (file === tempPath && probe.failAt === 'write') throw new Error('injected today-cache write failure')
      originalWrite(file, content, ...options)
      if (file === tempPath) probe.writes.push(Buffer.byteLength(content))
    }
    fs.renameSync = (source, target) => {
      if (source === tempPath && probe.failAt === 'rename') throw new Error('injected today-cache rename failure')
      return originalRename(source, target)
    }
    exercise(probe)
  } finally {
    fs.renameSync = originalRename
    fs.writeFileSync = originalWrite
    Date.now = originalNow
  }
}

// --- 刷盘节流 ---

// 验证满载追加、显式刷盘和 TTL 驱逐后的磁盘回读。
async function runFullCacheScenario(test) {
  await withScenario({ data: { summaryWhitelist: ['10001'] } }, ({ data, makeSession }) => {
    const { channelTodayCache, flushTodayCacheToDisk, saveSharedChannelTurn, trimChannelRuntimeCaches } = require('../../lib/conversation')
    const { createReportPeriod } = require('../../lib/daily-precompute/report-period')
    const { readReportRecords } = require('../../lib/daily-precompute/report-records')
    const now = Date.parse('2026-11-18T15:00:00+08:00')
    seedSnapshot(data, now, FULL_CACHE_SIZE)
    const session = makeSession()
    const messageIds = Array.from({ length: 25 }, (_, index) => `new-${index}`)
    withSnapshotProbe(data, now, probe => {
      for (const [index, messageId] of messageIds.entries()) {
        saveSharedChannelTurn(session, '新用户', `新消息 ${index}`, 'user', {
          messageId, realSeq: 778100 + index, groupId: '10001', botId: '90000', mentionUserIds: ['100000000'],
        })
      }

      const cache = channelTodayCache.get('10001')
      test.check('full today-cache writes once after 25 additions, at the twentieth', probe.writes.length === 1
        && data.readJson(SNAPSHOT_FILE).messages.at(-1).messageId === 'new-19' && cache.pendingMessageCount === 5,
        JSON.stringify({ writes: probe.writes.length, bytes: probe.writes.reduce((total, size) => total + size, 0) }))
      const { records } = readReportRecords('10001', createReportPeriod(now))
      test.check('full today-cache independently indexes all 25 new messages for reports',
        records.length === messageIds.length && records.every((record, index) => record.messageId === messageIds[index]))

      probe.now += 1000
      flushTodayCacheToDisk('10001')
      const snapshot = data.readJson(SNAPSHOT_FILE)
      const { messages } = snapshot
      const oldCount = FULL_CACHE_SIZE - messageIds.length
      test.check('explicit flush preserves the newest 5000 messages in order with no runtime fields',
        probe.writes.length === 2 && cache.pendingMessageCount === 0 && cache.lastDiskWrite === probe.now
        && Object.keys(snapshot).sort().join(',') === 'date,messages' && messages.length === FULL_CACHE_SIZE
        && messages.every((message, index) => message.messageId === (index < oldCount ? `old-${index + 25}` : messageIds[index - oldCount])))
      const latest = messages.at(-1)
      test.check('snapshot preserves real sequence and mentions alongside legacy rows',
        latest.realSeq === '778124' && latest.groupId === '10001' && latest.botId === '90000'
        && latest.mentionUserIds[0] === '100000000' && messages[0].realSeq === undefined
        && messages[0].mentionUserIds[0] === '100000000')

      saveSharedChannelTurn(session, '新用户', '驱逐前', 'user', { messageId: 'before-eviction' })
      probe.now += 6 * 60 * 60 * 1000 + 1
      trimChannelRuntimeCaches()
      test.check('TTL eviction flushes the pending tail before removal', !channelTodayCache.has('10001')
        && probe.writes.length === 3 && data.readJson(SNAPSHOT_FILE).messages.at(-1).messageId === 'before-eviction')
      saveSharedChannelTurn(session, '新用户', '驱逐后', 'user', { messageId: 'after-eviction' })
      const rebuilt = channelTodayCache.get('10001')
      test.check('evicted cache rebuilds from disk and starts a fresh flush window', probe.writes.length === 3
        && rebuilt.pendingMessageCount === 1 && rebuilt.lastDiskWrite === probe.now && rebuilt.messages.length === FULL_CACHE_SIZE
        && rebuilt.messages.at(-2).messageId === 'before-eviction' && rebuilt.messages.at(-1).messageId === 'after-eviction')
    })
  })
}

// 验证跨日报业务日的未满缓存仍按新增条数写盘，索引按业务日分开读取。
async function runReportBoundaryScenario(test) {
  await withScenario({ data: { summaryWhitelist: ['10001'] } }, ({ data, makeSession }) => {
    const { channelTodayCache, saveSharedChannelTurn } = require('../../lib/conversation')
    const { createReportPeriod } = require('../../lib/daily-precompute/report-period')
    const { readReportRecords } = require('../../lib/daily-precompute/report-records')
    const boundary = Date.parse('2026-11-18T04:00:00+08:00')
    seedSnapshot(data, boundary, 18)
    const session = makeSession()
    withSnapshotProbe(data, boundary - 1, probe => {
      saveSharedChannelTurn(session, '群友', '分界前', 'user', { messageId: 'before-boundary' })
      probe.now = boundary
      for (let index = 1; index < 19; index += 1) {
        saveSharedChannelTurn(session, '群友', '分界后', 'user', { messageId: `after-boundary-${index}` })
      }
      test.check('underfilled today-cache does not flush at 20 retained rows or reset at 04:00',
        probe.writes.length === 0 && channelTodayCache.get('10001').pendingMessageCount === 19)
      saveSharedChannelTurn(session, '群友', '第二十条新增', 'user', { messageId: 'after-boundary-19' })
      const messages = data.readJson(SNAPSHOT_FILE).messages
      test.check('underfilled today-cache flushes after 20 additions and retains both business days',
        probe.writes.length === 1 && messages.length === 38 && messages[18].messageId === 'before-boundary'
        && messages.at(-1).messageId === 'after-boundary-19')
      const previous = readReportRecords('10001', createReportPeriod(boundary - 1)).records
      const current = readReportRecords('10001', createReportPeriod(boundary)).records
      test.check('report windows at 04:00 partition records without losing cache history',
        previous.length === 1 && previous[0].messageId === 'before-boundary'
        && current.length === 19 && current.every((record, index) => record.messageId === `after-boundary-${index + 1}`))
    })
  })
}

// 启动恢复非 20 倍数的满载缓存后，仍能在第 20 条新增时写盘。
async function runStartupCacheScenario(test) {
  const originalLimit = process.env.DONGXUELIAN_TODAY_CACHE_MAX_MESSAGES
  process.env.DONGXUELIAN_TODAY_CACHE_MAX_MESSAGES = '501'
  try {
    await withScenario({ data: { summaryWhitelist: ['10001'] } }, async ({ data, makeSession, ready }) => {
      const { channelTodayCache, saveSharedChannelTurn } = require('../../lib/conversation')
      seedSnapshot(data, Date.now(), 501)
      await ready()
      const cache = channelTodayCache.get('10001')
      test.check('startup recovers a full cache and initializes the flush window',
        cache?.messages.length === 501 && cache.pendingMessageCount === 0 && cache.lastDiskWrite > 0)
      const session = makeSession()
      withSnapshotProbe(data, Date.now(), probe => {
        for (let index = 1; index <= 19; index += 1) {
          saveSharedChannelTurn(session, '群友', '启动后', 'user', { messageId: `startup-${index}` })
        }
        test.check('full 501-row cache has no early writes', probe.writes.length === 0)
        saveSharedChannelTurn(session, '群友', '启动后', 'user', { messageId: 'startup-20' })
        const { messages } = data.readJson(SNAPSHOT_FILE)
        test.check('full 501-row cache flushes at the addition threshold', probe.writes.length === 1
          && messages.length === 501 && messages[0].messageId === 'old-20' && messages.at(-1).messageId === 'startup-20')
      })
    })
  } finally {
    if (originalLimit === undefined) delete process.env.DONGXUELIAN_TODAY_CACHE_MAX_MESSAGES
    else process.env.DONGXUELIAN_TODAY_CACHE_MAX_MESSAGES = originalLimit
  }
}

// 验证慢流量触发以及写临时文件、替换快照两种失败的重试。
async function runFlushRetryScenario(test) {
  await withScenario({ data: { summaryWhitelist: ['10001'] } }, ({ data, makeSession }) => {
    const { channelTodayCache, saveSharedChannelTurn } = require('../../lib/conversation')
    const session = makeSession()
    const now = Date.parse('2026-11-18T15:00:00+08:00')
    withSnapshotProbe(data, now, probe => {
      saveSharedChannelTurn(session, '群友', '首次消息', 'user', { messageId: 'first' })
      const cache = channelTodayCache.get('10001')
      test.check('new today-cache flushes its first message immediately', probe.writes.length === 1
        && cache.pendingMessageCount === 0 && cache.lastDiskWrite === now)
      probe.now += FLUSH_INTERVAL_MS
      saveSharedChannelTurn(session, '群友', '时限边缘', 'user', { messageId: 'at-limit' })
      test.check('slow traffic still waits at exactly five minutes', probe.writes.length === 1 && cache.pendingMessageCount === 1)

      // 超时后两次失败都不能延后下一条消息重试，也不能覆盖旧快照。
      probe.now += 1
      probe.failAt = 'write'
      saveSharedChannelTurn(session, '群友', '写入失败', 'user', { messageId: 'write-failed' })
      test.check('failed temporary write preserves count and successful write time', probe.writes.length === 1
        && cache.pendingMessageCount === 2 && cache.lastDiskWrite === now && data.readJson(SNAPSHOT_FILE).messages.length === 1)
      probe.now += 1
      probe.failAt = 'rename'
      saveSharedChannelTurn(session, '群友', '替换失败', 'user', { messageId: 'rename-failed' })
      test.check('failed snapshot replacement leaves the previous snapshot and pending state intact', probe.writes.length === 2
        && cache.pendingMessageCount === 3 && cache.lastDiskWrite === now && data.readJson(SNAPSHOT_FILE).messages.length === 1)
      probe.now += 1
      probe.failAt = null
      saveSharedChannelTurn(session, '群友', '重试成功', 'user', { messageId: 'recovered' })
      test.check('only successful retry resets count and time and persists all pending messages',
        probe.writes.length === 3 && cache.pendingMessageCount === 0 && cache.lastDiskWrite === probe.now
        && data.readJson(SNAPSHOT_FILE).messages.map(message => message.messageId).join(',') === 'first,at-limit,write-failed,rename-failed,recovered')
    })
  })
}

// --- 消息命令与日报回读 ---

// 场景：today-cache 运行期回读（issue #11 依赖项，也是"详细日报只有最近几百条"的根因）。
// 背景：群安静超过 CHANNEL_RUNTIME_CACHE_TTL_MS(6h) 后内存缓存被驱逐，下一条消息
// 重建缓存。修复前直接建空缓存并把磁盘文件覆盖掉，当天历史全丢；修复后先回读磁盘。
async function run(t) {
  t.section('scenario: today-cache runtime read-back')

  await runFullCacheScenario(t)
  await runReportBoundaryScenario(t)
  await runStartupCacheScenario(t)
  await runFlushRetryScenario(t)

  await withScenario({}, async ({ data, makeSession, run }) => {
    const { todayCst } = require('../../lib/core/utils')
    const { createReportPeriod } = require('../../lib/daily-precompute/report-period')
    const { appendReportRecord } = require('../../lib/daily-precompute/report-records')
    const today = todayCst()
    const cutoffMs = Date.now()
    const baseTs = Math.max(createReportPeriod(cutoffMs).periodStartMs, cutoffMs - 3600000)

    const row = (index, extra = {}) => ({
      time: `10:${String(index + 1).padStart(2, '0')}:00`,
      ts: Math.min(baseTs + index, cutoffMs),
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
    // 日报完整输入来自原始索引；共享缓存回读仍独立服务“谁艾特我”，不能把其截短正文当完整来源。
    for (const message of [row(0), row(1), row(2)]) {
      const recordDate = new Date(message.ts + 8 * 3600000).toISOString().slice(0, 10)
      appendReportRecord(recordDate, '10001', { messageId: message.messageId, timestamp: message.ts,
        userId: message.userId, userName: message.user, text: message.content })
    }

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
