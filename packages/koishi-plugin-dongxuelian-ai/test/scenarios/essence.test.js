const { withScenario } = require('./_setup')

// 创建与 NapCat 精华列表相同字段的测试消息；操作者刻意不同于消息作者。
function essence(seq, userId, nickname) {
  return { msg_seq: seq, msg_random: seq + 100, sender_id: userId, sender_nick: nickname, operator_id: 99999, message_id: seq }
}

// 假接口保留 this 依赖，确保真实适配器不会因方法解构而失效。
class EssenceInternal {
  // 初始化精华响应和调用记录。
  constructor(messages) {
    this.messages = messages
    this.reads = []
    this.forwards = []
  }

  // 记录查询的群号并返回指定精华列表。
  async getEssenceMsgList(groupId) {
    this.reads.push(groupId)
    if (this.readError) throw this.readError
    if (this.pending) await this.pending
    return this.messages
  }

  // 只记录转发载荷，不向真实群发送消息。
  async sendGroupForwardMsg(groupId, messages) {
    if (this.sendError) throw this.sendError
    this.forwards.push({ groupId, messages })
    return { message_id: 123 }
  }
}

// 提取消息记录正文，检验排名而不依赖 QQ 显示的节点昵称。
function forwardText(internal) {
  return internal.forwards.flatMap(call => call.messages.map(node => node.data.content[0].data.text)).join('\n')
}

// 覆盖真实命令中间件、聚合排序、长列表、错误恢复和并发隔离。
async function run(t) {
  t.section('scenario: group essence ranking')
  await withScenario({}, async ({ makeSession, run }) => {
    const internal = new EssenceInternal([
      essence(1, 100, '同名'), essence(2, 200, '同名'),
      essence(3, 200, '同名'), essence(4, 300, '[CQ:at,qq=all]'),
      essence(5, 300, '[CQ:at,qq=all]'), essence(6, 300, '[CQ:at,qq=all]'),
      essence(1, 100, '同名'),
    ])
    const session = makeSession({ content: '统计群精华', userId: '12345', bot: { selfId: '90000', internal } })
    const result = await run(session)
    const text = forwardText(internal)
    t.check('essence command works for ordinary group member without summary whitelist', internal.forwards.length === 1, JSON.stringify(result))
    t.check('essence reads and sends only current group', internal.reads[0] === session.guildId && internal.forwards[0]?.groupId === session.guildId)
    t.check('essence aggregates by author, deduplicates and sorts descending', text.includes('共 6 条精华，3 位群友') && text.includes('1. [CQ:at,qq=all]（300）：3 条') && text.includes('2. 同名（200）：2 条') && text.includes('3. 同名（100）：1 条'), text)
    t.check('essence sends only one merged record without extra chat reply', result.sent.length === 0 && internal.forwards.length === 1)
    t.check('essence treats special nickname as literal text segment', internal.forwards[0]?.messages.every(node => node.type === 'node' && node.data.content[0].type === 'text'))

    const cooldownResult = await run(makeSession({ content: '统计群精华', userId: '67890', bot: { internal } }))
    t.check('essence cooldown is shared by all users in the same group', internal.reads.length === 1 && internal.forwards.length === 1 && cooldownResult.sent.some(text => text.includes('冷却中')))

    internal.messages = Array.from({ length: 65 }, (_, index) => essence(index, 1000 + index, `群友${index}`))
    internal.forwards = []
    await run(makeSession({ content: '统计群精华', guildId: 'large-group', channelId: 'large-group', bot: { selfId: '90000', internal } }))
    t.check('essence large ranking keeps all members in one record', internal.forwards.length === 1 && internal.forwards[0].messages.length === 5 && forwardText(internal).includes('65. 群友64（1064）：1 条'))

    internal.messages = []
    internal.forwards = []
    const emptyResult = await run(makeSession({ content: '统计群精华', guildId: 'empty-group', channelId: 'empty-group', bot: { internal } }))
    t.check('essence empty group sends exact plain text without a forward record', internal.forwards.length === 0 && emptyResult.sent.length === 1 && emptyResult.sent[0] === '本群群精华数量0')
    const emptyCooldown = await run(makeSession({ content: '统计群精华', guildId: 'empty-group', channelId: 'empty-group', bot: { internal } }))
    t.check('essence empty result also starts group cooldown', emptyCooldown.sent.some(text => text.includes('冷却中')))

    internal.reads = []
    const privateResult = await run(makeSession({ content: '统计群精华', isDirect: true, guildId: '', bot: { internal } }))
    t.check('essence private command rejected before API access', internal.reads.length === 0 && privateResult.sent.some(text => text.includes('只能在群里')))
    const unsupported = await run(makeSession({ content: '统计群精华', bot: { internal: {} } }))
    t.check('essence unsupported adapter reports reason', unsupported.sent.some(text => text.includes('不支持')))

    internal.forwards = []
    internal.readError = new Error('test get essence failed')
    const failed = await run(makeSession({ content: '统计群精华', guildId: 'read-failure', channelId: 'read-failure', bot: { internal } }))
    t.check('essence API failure does not send a misleading empty ranking', internal.forwards.length === 0 && failed.sent.some(text => text.includes('获取群精华失败')))
    internal.readError = null
    internal.messages = [essence(1, 100, '恢复')]
    internal.sendError = new Error('test forward failed')
    const sendFailed = await run(makeSession({ content: '统计群精华', guildId: 'send-failure', channelId: 'send-failure', bot: { internal } }))
    t.check('essence forward failure returns explicit error', sendFailed.sent.some(text => text.includes('发送群精华排行榜失败')))
    internal.sendError = null
    const failureCooldown = await run(makeSession({ content: '统计群精华', guildId: 'send-failure', channelId: 'send-failure', bot: { internal } }))
    t.check('essence failure keeps cooldown without keeping in-flight lock', internal.forwards.length === 0 && failureCooldown.sent.some(text => text.includes('冷却中')))
  })

  // 直接验证并发控制，避免中间件自身的同群串行队列遮蔽此行为。
  const { handleEssenceCommand, rankEssenceMessages } = require('../../lib/commands/essence-command')
  const internal = new EssenceInternal([essence(1, 200, '乙'), essence(2, 100, '甲')])
  let release
  internal.pending = new Promise(resolve => { release = resolve })
  const session = { guildId: '1', selfId: '90000', bot: { internal } }
  const ctx = { logger: () => ({ warn() {} }) }
  const first = handleEssenceCommand(session, ctx, 0)
  const second = await handleEssenceCommand(session, ctx, 1000)
  t.check('essence coalesces concurrent commands in same group', internal.reads.length === 1 && second.response.includes('正在统计'))
  const otherInternal = new EssenceInternal([essence(3, 300, '丙')])
  const otherSession = { guildId: '2', selfId: '90000', bot: { internal: otherInternal } }
  await handleEssenceCommand(otherSession, ctx, 5000)
  t.check('essence group B completes while group A is still fetching', internal.forwards.length === 0 && otherInternal.forwards.length === 1 && otherInternal.reads[0] === '2')
  release()
  await first
  internal.pending = null
  const beforeExpiry = await handleEssenceCommand(session, ctx, 59_999)
  t.check('essence same group remains blocked just before 60 seconds', internal.reads.length === 1 && beforeExpiry.response === '本群统计群精华冷却中，请 1 秒后再试。')
  await handleEssenceCommand(session, ctx, 60_000)
  t.check('essence same group can run exactly at 60 seconds', internal.reads.length === 2 && internal.forwards.length === 2)
  const otherCooldown = await handleEssenceCommand(otherSession, ctx, 60_000)
  t.check('essence groups have independent cooldown deadlines', otherInternal.reads.length === 1 && otherCooldown.response === '本群统计群精华冷却中，请 5 秒后再试。')
  await handleEssenceCommand(otherSession, ctx, 65_000)
  t.check('essence group B can run while group A is cooling down again', otherInternal.reads.length === 2 && otherInternal.forwards.length === 2)
  const tie = rankEssenceMessages(internal.messages)
  t.check('essence ties have deterministic QQ order', tie[0].userId === '100' && tie[1].userId === '200')
  internal.messages = Array.from({ length: 1000 }, (_, index) => essence(index, 100, '甲'))
  internal.forwards = []
  await handleEssenceCommand(session, ctx, 120_000)
  t.check('essence upstream limit is explicitly disclosed', forwardText(internal).includes('1000 条读取上限'))

  internal.readError = new Error('retry after cooldown')
  await handleEssenceCommand(session, ctx, 180_000)
  internal.readError = null
  internal.messages = [essence(2000, 400, '新数据')]
  internal.forwards = []
  const errorCooldown = await handleEssenceCommand(session, ctx, 180_001)
  t.check('essence API failure also retains the 60 second cooldown', errorCooldown.response.includes('冷却中') && internal.forwards.length === 0)
  await handleEssenceCommand(session, ctx, 240_000)
  t.check('essence retry after cooldown fetches fresh data instead of cached ranking', internal.forwards.length === 1 && forwardText(internal).includes('共 1 条精华，1 位群友') && forwardText(internal).includes('新数据') && !forwardText(internal).includes('1000 条读取上限'))
}

module.exports = { run }
