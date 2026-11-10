'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { OneBot } = require('koishi-plugin-adapter-onebot')
const { Session } = require('@satorijs/core')
const { withScenario } = require('./_setup')

// 使用已安装的真实 OneBot Internal，仅替换网络传输，记录实际协议操作。
function makeBot(dispatch) {
  const requests = []
  const bot = { platform: 'onebot', dispatch, logger: { debug() {} } }
  bot.internal = new OneBot.Internal(bot)
  bot.internal._request = async (action, params) => {
    requests.push({ action, params })
    return { retcode: 0, data: { message_id: 123 } }
  }
  return { bot, requests }
}

// 原子替换配置，模拟 Dashboard 与运行中的机器人使用同一共享文件。
function writePolicy(data, groups, privateEnabled = false) {
  const file = path.join(data.dataDir, 'bot-participation.json')
  fs.writeFileSync(file + '.next', JSON.stringify({ version: 1, privateEnabled, groups }))
  fs.renameSync(file + '.next', file)
}

// 验证总开关的事件入口、实际适配器出口、热切换与卸载还原。
async function run(t) {
  t.section('scenario: group and private participation')
  await withScenario({}, async ({ data, harness }) => {
    const events = []
    const { bot, requests } = makeBot(session => events.push(session))
    const originalInternal = bot.internal
    const originalDispatch = bot.dispatch
    await harness.ctx.emit('bot-connect', bot)
    await harness.ctx.emit('bot-connect', bot)
    for (const type of ['message', 'notice', 'notice/poke', 'guild-member-removed']) bot.dispatch({ guildId: '10001', type })
    bot.dispatch({ isDirect: true, channelId: 'private:100', guildId: '10001' })
    assert.equal(events.length, 0)
    await assert.rejects(bot.internal.sendGroupMsg('10001', '默认不参与'), { code: 'PARTICIPATION_DISABLED' })
    await assert.rejects(bot.internal.sendPrivateMsg('100', '默认不私聊'), { code: 'PARTICIPATION_DISABLED' })
    await assert.rejects(bot.internal.sendMsgAsync('100', undefined, '异步私聊'), { code: 'PARTICIPATION_DISABLED' })
    await assert.rejects(bot.internal.sendLikeAsync('100', 1), { code: 'PARTICIPATION_DISABLED' })
    await assert.rejects(bot.internal._get('upload_private_file_async', { user_id: '100' }), { code: 'PARTICIPATION_DISABLED' })
    assert.equal(requests.length, 0)
    bot.dispatch({ type: 'meta' })
    await bot.internal.getLoginInfo()
    await bot.internal.getGroupMemberInfo('10001', '100')
    assert.equal(events.length, 1)
    assert.equal(requests.length, 2)
    t.check('scenario participation defaults closed without breaking adapter metadata', true)

    writePolicy(data, { 10001: true })
    bot.dispatch({ guildId: '10001', type: 'message' })
    bot.dispatch({ guildId: '10002', type: 'message' })
    bot.dispatch({ isDirect: true, guildId: '10001' })
    assert.equal(events.length, 2)
    await bot.internal.sendGroupMsg('10001', '被动回复/视频/复读')
    await bot.internal.sendGroupForwardMsg('10001', [])
    await bot.internal._get('group_poke', { group_id: '10001', user_id: '100' })
    await assert.rejects(bot.internal._get('send_private_msg', { group_id: '10001', user_id: '100' }), { code: 'PARTICIPATION_DISABLED' })
    await assert.rejects(bot.internal.sendGroupMsg('10002', '其他群'), { code: 'PARTICIPATION_DISABLED' })
    t.check('scenario participation isolates group targets and temporary private messages', true)

    // 任务完成时重新检查开关，不能沿用入队时的开启状态。
    let finishTask
    const pending = new Promise(resolve => { finishTask = resolve }).then(() => bot.internal.sendGroupMsg('10001', '排队结果'))
    writePolicy(data, { 10001: false }, true)
    const before = requests.length
    finishTask()
    await assert.rejects(pending, { code: 'PARTICIPATION_DISABLED' })
    await assert.rejects(bot.internal.sendGroupForwardMsg('10001', []), { code: 'PARTICIPATION_DISABLED' })
    await assert.rejects(bot.internal._get('upload_group_file', { group_id: '10001' }), { code: 'PARTICIPATION_DISABLED' })
    await assert.rejects(bot.internal._get('group_poke', { group_id: '10001' }), { code: 'PARTICIPATION_DISABLED' })
    assert.equal(requests.length, before)
    await bot.internal.sendPrivateMsg('100', '私聊独立开启')
    await bot.internal.sendPrivateForwardMsg('100', [])
    bot.dispatch({ isDirect: true })
    assert.equal(events.length, 3)
    t.check('scenario participation blocks queued results and all group transports after disable', true)

    // 重连会删除并重新赋值 _request；代理必须继续检查新 transport。
    delete bot.internal._request
    bot.internal._request = async () => ({ retcode: 0, data: { message_id: 456 } })
    await assert.rejects(bot.internal.sendGroupMsg('10001', '重连后仍关闭'), { code: 'PARTICIPATION_DISABLED' })
    writePolicy(data, { 10001: true })
    assert.equal(await bot.internal.sendGroupMsg('10001', '热恢复'), 456)
    fs.writeFileSync(path.join(data.dataDir, 'bot-participation.json'), 'broken')
    bot.dispatch({ guildId: '10001' })
    assert.equal(events.length, 3)
    await assert.rejects(bot.internal.sendGroupMsg('10001', '损坏配置不可放行'))
    await harness.ctx.emit('dispose')
    assert.equal(bot.internal, originalInternal)
    assert.equal(bot.dispatch, originalDispatch)
    t.check('scenario participation survives reconnect, fails closed and restores on dispose', true)
  })

  await withScenario({}, async ({ data, harness, makeSession, run }) => {
    const { bot } = makeBot(session => run(session))
    await harness.ctx.emit('bot-connect', bot)
    const command = makeSession({ content: '东雪莲复读开' })
    await bot.dispatch(command)
    assert.equal(command.sent.length, 0)
    assert.deepEqual(data.readJson('ai-repeat-enabled.json'), {})
    // 插件已经加载后再写默认复读配置，验证实际中间件能热读取。
    writePolicy(data, { 10001: true })
    data.writeJson('ai-repeat-enabled.json', { 10001: true })
    await bot.dispatch(makeSession({ userId: '101', content: '热加载复读' }))
    const repeated = makeSession({ userId: '102', content: '热加载复读' })
    await bot.dispatch(repeated)
    assert(repeated.sent.some(message => String(message).includes('热加载复读')))
    writePolicy(data, { 10001: false })
    const closed = makeSession({ content: '东雪莲复读关' })
    await bot.dispatch(closed)
    assert.equal(closed.sent.length, 0)
    assert.equal(data.readJson('ai-repeat-enabled.json')['10001'], true)
    t.check('scenario participation gates real middleware and hot-loads first-enable repeat defaults', true)
  })

  await withScenario({}, async ({ data, harness }) => {
    const events = []
    const { bot } = makeBot(session => events.push(session))
    await harness.ctx.emit('bot-connect', bot)
    // 复现已安装 Satori 3.7.0 的真实 getter：生命周期事件没有 channel。
    const lifecycle = Object.assign(Object.create(Session.prototype), { event: { type: 'login-added' } })
    assert.throws(() => lifecycle.isDirect, /reading 'type'/)
    bot.dispatch(lifecycle)
    assert.equal(events.length, 1, 'channel-less lifecycle must pass without probing isDirect')
    const groupNotice = Object.assign(Object.create(Session.prototype), { event: { type: 'guild-member-removed', guild: { id: '10001' } } })
    bot.dispatch(groupNotice)
    assert.equal(events.length, 1, 'disabled group notice must remain blocked')
    writePolicy(data, { 10001: true })
    bot.dispatch(groupNotice)
    assert.equal(events.length, 2, 'enabled group notice without a channel must pass')
    assert.equal(harness.logs.filter(item => item.name === 'participation').length, 0)
    t.check('scenario participation supports real Satori lifecycle and guild-only event accessors', true)
  })
}

module.exports = { run }
