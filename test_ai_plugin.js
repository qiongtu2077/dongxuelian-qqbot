const assert = require('assert')
const Module = require('module')

const originalLoad = Module._load
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === 'koishi') return { h: () => ({}) }
  return originalLoad.call(this, request, parent, isMain)
}

const plugin = require('./packages/koishi-plugin-dongxuelian-ai/lib/index.js')

const t = plugin.__test
assert(t, 'AI plugin test helpers must be exported')
assert.strictEqual(t.REPEAT_TRIGGER_COUNT, 5)

function makeSession() {
  return {
    guildId: '10001',
    channelId: '10001',
    userId: '20002',
    author: { id: '20002' },
    username: 'tester',
  }
}

t.clearConversationHistory()
const session = makeSession()
assert.strictEqual(t.isConsecutiveUserRepeat(session, '复读'), false)
for (let i = 0; i < 3; i += 1) {
  t.saveConversationTurn(session, '用户(测试)：复读', `reply-${i}`)
}
assert.strictEqual(t.isConsecutiveUserRepeat(session, '复读'), false, '4 total repeats must not trigger')
t.saveConversationTurn(session, '用户(测试)：复读', 'reply-4')
assert.strictEqual(t.isConsecutiveUserRepeat(session, '复读'), true, '5 total repeats must trigger')

assert.deepStrictEqual(t.parseSilentGroupCommand('东雪莲静默添加123456'), { action: 'add', groupId: '123456' })
assert.deepStrictEqual(t.parseSilentGroupCommand('东雪莲静默添加“123456”'), { action: 'add', groupId: '123456' })
assert.deepStrictEqual(t.parseSilentGroupCommand('东雪莲静默删除"123456"'), { action: 'delete', groupId: '123456' })
assert.deepStrictEqual(t.parseSilentGroupCommand('东雪莲静默查看'), { action: 'view' })
assert.strictEqual(t.parseSilentGroupCommand('东雪莲静默添加abc'), null)

for (let i = 0; i < 100; i += 1) {
  const delay = t.getRandomDelayMs()
  assert(delay >= 1000 && delay <= 1500, `delay out of range: ${delay}`)
}

console.log('test_ai_plugin passed')
