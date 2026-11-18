const path = require('path')
const { h, Universal } = require('koishi')
const { OneBotMessageEncoder } = require('koishi-plugin-adapter-onebot')

const PLUGIN_PATH = path.resolve(__dirname, '..', 'lib', 'index.js')

let passed = 0
let failed = 0

function check(label, ok, detail = '') {
  if (ok) {
    passed += 1
    console.log(`  OK   ${label}`)
  } else {
    failed += 1
    console.log(`  FAIL ${label}${detail ? ': ' + detail : ''}`)
  }
}

function reloadPlugin() {
  delete require.cache[PLUGIN_PATH]
  return require(PLUGIN_PATH)
}

function makeCtx() {
  const middlewareList = []
  const events = new Map()
  const logs = []
  return {
    middleware(fn) {
      middlewareList.push(fn)
      return fn
    },
    on(event, fn) {
      const list = events.get(event) || []
      list.push(fn)
      events.set(event, list)
      return fn
    },
    async emit(event, ...args) {
      for (const fn of events.get(event) || []) await fn(...args)
    },
    logger(name) {
      const push = (level, args) => logs.push({ level, name, msg: args.map(String).join(' ') })
      return {
        info: (...args) => push('info', args),
        warn: (...args) => push('warn', args),
        error: (...args) => push('error', args),
      }
    },
    middlewareList,
    logs,
  }
}

// 执行真实菜单中间件，并读取用户在消息记录中实际看到的文字。
async function runHelpCase(ctx, content) {
  let nextCalled = false
  const session = { content }
  const result = await ctx.middlewareList[0](session, () => {
    nextCalled = true
    return 'NEXT'
  })
  const elements = h.parse(result)
  const record = elements.length === 1 && elements[0].type === 'figure'
  const text = record ? h.select(elements, 'text').map(node => node.attrs.content).join('') : result
  return { result, text, record, nextCalled }
}

// 使用生产 OneBot 编码器验证长菜单确实选择合并转发接口，替换的仅是发送传输。
async function encodeHelpReply(content, isDirect = false) {
  const calls = []
  const internal = {
    async sendGroupForwardMsg(groupId, nodes) { calls.push({ method: 'group-forward', groupId, nodes }); return 'forward-1' },
    async sendPrivateForwardMsg(userId, nodes) { calls.push({ method: 'private-forward', userId, nodes }); return 'forward-2' },
    async sendGroupMsg(groupId, segments) { calls.push({ method: 'group', groupId, segments }); return 'message-1' },
  }
  const bot = { selfId: '90000', userId: '90000', user: { name: '东雪莲' }, internal, session() { return { event: { message: {} }, app: { emit() {} } } } }
  const encoder = new OneBotMessageEncoder(bot, '10001')
  encoder.session = { event: { channel: { type: isDirect ? Universal.Channel.Type.DIRECT : Universal.Channel.Type.TEXT } }, channelId: '10001', guildId: isDirect ? undefined : '10001', isDirect }
  await encoder.render(h.normalize(content))
  await encoder.flush()
  return calls
}

async function run() {
  console.log('\n=== dongxuelian-help: command middleware ===')
  const plugin = reloadPlugin()
  check('plugin exports expected name', plugin.name === 'dongxuelian-help')

  const ctx = makeCtx()
  plugin.apply(ctx)
  await ctx.emit('ready')
  check('ready event logs loaded message', ctx.logs.some(log => log.level === 'info' && log.msg.includes('loaded')), JSON.stringify(ctx.logs))

  let result = await runHelpCase(ctx, 'help东雪莲')
  const expectedRootHelp = [
    '东雪莲帮助：',
    '- helpAI / 帮助AI / AI帮助',
    '- help集合 / 帮助集合 / 东雪莲集合',
    '- 杂项功能',
    '- /help XX （模糊查询）',
  ].join('\n')
  check('root help returns exact compact menu', result.result === expectedRootHelp, String(result.result))
  check('root help no longer lists quick reference menu', typeof result.result === 'string' && !result.result.includes('指令速查') && !result.result.includes('其他帮助'), String(result.result))
  check('root help does not call next', result.nextCalled === false)

  result = await runHelpCase(ctx, '[CQ:at,qq=90000] helpAI')
  check('mentions are stripped before helpAI match', typeof result.result === 'string' && result.result.includes('AI帮助'), String(result.result))
  check('AI help lists current tree branches only', result.text.includes('【群聊主动回复】') && !result.text.includes('【常用】') && !result.text.includes('【集合】'), result.text)
  check('AI help omits the model switching branch', !result.text.includes('切换模型'), result.text)

  result = await runHelpCase(ctx, '杂项功能')
  check('misc help includes group essence ranking', result.result.includes('统计群精华'), String(result.result))
  check('misc help links to the GitHub branch without inlining its commands', result.text.includes('【github解析】') && !result.text.includes('GitHub查询群添加'), result.text)
  check('misc help returns root-level misc branch', result.text.includes('【杂项功能】') && result.text.includes('今日情绪'), result.text)

  result = await runHelpCase(ctx, 'github解析')
  check('GitHub branch includes its own title and default-off group commands', result.text.startsWith('【github解析】') && ['默认关闭', 'GitHub查询群添加', 'GitHub查询群删除', 'GitHub查询群查看', 'GitHub查询状态'].every(text => result.text.includes(text)), result.text)
  check('misc help explains single repository binding, exact numbers and thirty-second local rendering', ['GitHub群项目导入', 'GitHub群项目查看', 'GitHub群项目删除', '每群最多绑定一个', '整条发送 #数字', '最多30秒', '占位'].every(text => result.result.includes(text)), String(result.result))
  check('misc help explains optional matching URL deletion with or without a space', ['删除 [仓库链接]', '删除链接可省略', '直接拼接', '当前群匹配'].every(text => result.result.includes(text)), String(result.result))
  check('misc help explains Issue/PR official rendering and bounded work', result.result.includes('Issue / PR') && /30\s*秒/.test(result.result) && result.result.includes('官方') && result.result.includes('正文'), String(result.result))
  check('misc help explains board-first industrial body screenshots and group themes', ['第一张为看板详情卡片', '原黄色工业风正文长截图', '连续切片最多3张', 'GitHub群主题'].every(text => result.result.includes(text)), String(result.result))
  check('misc help explains image-count record threshold and per-link grouping', ['1～3张直接发送', '4张及以上', '消息记录', '多个链接合计', '每个链接在记录内各占一条消息'].every(text => result.result.includes(text)), String(result.result))
  check('GitHub branch preserves command placeholders as literal text', result.text.includes('<群号>') && result.text.includes('<仓库链接>'), result.text)
  for (const alias of ['【github解析】', 'GitHub解析', '【GITHUB解析】', '[CQ:at,qq=90000] github解析']) {
    const aliasResult = await runHelpCase(ctx, alias)
    check(`GitHub branch alias matches: ${alias}`, aliasResult.result === result.result && !aliasResult.nextCalled, String(aliasResult.result))
  }
  for (const isDirect of [false, true]) {
    const encoded = await encodeHelpReply(result.result, isDirect)
    check(`long GitHub menu uses one ${isDirect ? 'private' : 'group'} forward message`, encoded.length === 1 && encoded[0].method === (isDirect ? 'private-forward' : 'group-forward') && encoded[0].nodes.length === 1, JSON.stringify(encoded))
  }

  result = await runHelpCase(ctx, '【杂项功能】')
  check('bracketed misc branch title also matches', typeof result.result === 'string' && result.result.includes('【杂项功能】'), String(result.result))

  result = await runHelpCase(ctx, 'help集合')
  check('collection help returns collection commands', typeof result.result === 'string' && result.result.includes('集合添加'), String(result.result))

  result = await runHelpCase(ctx, '东雪莲集合')
  check('new collection alias returns collection commands', typeof result.result === 'string' && result.result.includes('集合添加'), String(result.result))

  result = await runHelpCase(ctx, '指令速查')
  check('removed quick reference exact command falls through', result.result === 'NEXT' && result.nextCalled === true, JSON.stringify(result))

  result = await runHelpCase(ctx, '常用')
  check('removed common exact command falls through', result.result === 'NEXT' && result.nextCalled === true, JSON.stringify(result))

  result = await runHelpCase(ctx, '集合')
  check('removed bare collection exact command falls through', result.result === 'NEXT' && result.nextCalled === true, JSON.stringify(result))

  result = await runHelpCase(ctx, '/help 人格')
  check('fuzzy help returns matching lines', typeof result.result === 'string' && result.result.includes('/help人格 结果'), String(result.result))

  for (const command of ['切换模型', '【切换模型与供应商】', '可用模型', '供应商 opencode', '供应商 OpenCode Go']) {
    const menu = await runHelpCase(ctx, command)
    check(`removed model menu falls through: ${command}`, menu.result === 'NEXT' && menu.nextCalled, JSON.stringify(menu))
  }
  result = await runHelpCase(ctx, '/help 供应商')
  check('fuzzy help omits retired provider commands', result.text === '未找到相关帮助。', result.text)

  for (const command of ['help东雪莲', 'helpAI', '杂项功能', 'github解析', 'help集合', '群聊主动回复', '联网', '抓取原始事件', '白名单黑名单管理', '人格', '记忆', '敏感话题检测', '/help GitHub', '/help 人格']) {
    const menu = await runHelpCase(ctx, command)
    check(`100-character threshold applies to ${command} (${menu.text.length})`, menu.record === (menu.text.length > 100) && !menu.nextCalled, menu.result)
  }
  result = await runHelpCase(ctx, '联网')
  const shortCalls = await encodeHelpReply(result.result)
  check('short menu is sent as an ordinary group message', shortCalls.length === 1 && shortCalls[0].method === 'group', JSON.stringify(shortCalls))
  result = await runHelpCase(ctx, '/help GitHub')
  check('fuzzy search includes the new GitHub submenu commands', result.text.includes('GitHub查询群添加'), result.text)

  result = await runHelpCase(ctx, '不是帮助命令')
  check('unknown text falls through to next', result.result === 'NEXT' && result.nextCalled === true, JSON.stringify(result))

  console.log(`\nResult: ${passed} passed, ${failed} failed`)
  if (failed) process.exit(1)
}

run().catch(error => {
  console.error(error)
  process.exit(1)
})
