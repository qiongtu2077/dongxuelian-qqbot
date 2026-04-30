const assert = require('assert')
const Module = require('module')

const originalLoad = Module._load
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === 'koishi') return { segment: { at: (id) => `<at id="${id}"/>` } }
  return originalLoad.call(this, request, parent, isMain)
}

const plugin = require('./packages/koishi-plugin-group-name-at/lib/index.js')
const t = plugin.__test
assert(t, 'group-name-at test helpers must be exported')

assert.deepStrictEqual(t.parseNicknameBlacklistCommand('昵称集合黑名单添加群123456'), { action: 'add', groupId: '123456' })
assert.deepStrictEqual(t.parseNicknameBlacklistCommand('昵称集合黑名单添加群 123456'), { action: 'add', groupId: '123456' })
assert.deepStrictEqual(t.parseNicknameBlacklistCommand('昵称集合黑名单删除群123456'), { action: 'delete', groupId: '123456' })
assert.deepStrictEqual(t.parseNicknameBlacklistCommand('昵称集合黑名单查看'), { action: 'view' })
assert.strictEqual(t.parseNicknameBlacklistCommand('昵称集合黑名单添加群abc'), null)
assert.strictEqual(t.parseNicknameBlacklistCommand('昵称集合黑名单删除123456'), null)

console.log('test_name_plugin passed')
