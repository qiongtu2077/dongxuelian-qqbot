/** Verifies output leak guards, semantic profiles, memory, and will-factor behavior. */
async function runOutputMemoryContracts(context) {
  const {
    fs, path, dns, spawnSync,
    ROOT, PKG_ROOT, AI_ROOT, LIB, HELP, TEST_ROOT,
    STR, CMD, modules, c, u, p, api, conv, reader, handler, index, rootPkg, constantsSrc,
    section, pass, fail, skip, check, checkEqual, checkIncludes, checkThrows,
    read, readJson, runSyntaxCheck, runShellSyntaxCheck, gitCheckIgnored, gitTrackedFiles,
    makeLoggerStore, makeSession, makeHandlerState, runHandler, getCounts,
  } = context
  section('16. thinking leak guard')
  const thinkingLeakSample = [
    '好的，用户菜狗荒显现发了个消息说“建议神卡”，这应该是在回应之前敏龟大感头问的“赢左和神卡有建议吗”吧',
    '我得看看现在是什么情况，用户菜狗荒显现的消息是在群聊刷到的，而且前面敏龟大感头确实问了关于鹰佐和神卡的建议',
    '嗯，我是东雪莲，现在处于友善模式，对方没有敌意，就是正常聊天',
    '我记得性格设定是平时正常聊天，不主动毒舌，但也不是软柿子，可以有点小嘴臭',
    '这个场景看起来是群友在讨论游戏角色或者什么游戏建议，我应该用轻松的态度来回应，毕竟这不是什么严肃的问题',
    '用户菜狗荒显现直接说“建议神卡”，这回答挺干脆的，我得接上这个话茬',
    '可以顺着这个意思说，但要用我的风格',
  ].join('\n')
  check('isThinkingLeak catches incident sample', u.isThinkingLeak(thinkingLeakSample))
  for (const sample of [
    '我得看看现在是什么情况',
    '我记得性格设定是平时正常聊天',
    '这个场景看起来是群友在讨论游戏角色',
    '我应该用轻松的态度来回应',
    '我得接上这个话茬',
    '可以顺着这个意思说',
    '用户A发了个消息说“建议神卡”，这应该是在回应上一句',
    '用户问的是文件内容，但历史记录中没有相关文件信息。我会尝试调用analyze_file工具来检查文件内容',
    '如果找不到，就说明没有文件。之后我会根据结果给出回复',
    '用户询问文件内容，但历史中没有相关文件记录。我将调用analyze_file工具来检查文件内容',
  ]) {
    check(`isThinkingLeak catches: ${sample}`, u.isThinkingLeak(sample))
  }
  for (const sample of [
    '建议神卡',
    '那就神卡吧',
    '鹰佐也行，但神卡更稳',
    '我建议神卡',
    '历史记录中没有相关文件信息。',
    '如果找不到，就说明没有文件。',
    '文件里没有这个字段。',
    '没有找到相关图片记录，可能需要你重新发一下。',
    '历史记录中没有相关文件信息。如果找不到，请用上传工具重新发一下。',
    '历史记录中没有相关文件信息。如果找不到原文件，就请用上传工具重新发一下。',
    '历史记录中没有相关文件信息。如果找不到，说明可能已经过期，请用上传工具重新发一下。',
  ]) {
    check(`isThinkingLeak allows: ${sample}`, !u.isThinkingLeak(sample))
  }
  check('THINKING_OUTPUT_RE remains available', constantsSrc.includes('THINKING_OUTPUT_RE'))

  section('16.5 semantic profile guard')
  check('semantic: triple hit blocked', u.isSemanticProfile('韩国那个姓金的将军就是狗屎'))
  check('semantic: region+insult only NOT blocked', !u.isSemanticProfile('韩国队踢得像狗屎'))
  check('semantic: name+insult only NOT blocked', !u.isSemanticProfile('那个姓金的真是狗屎'))
  check('semantic: normal chat NOT blocked', !u.isSemanticProfile('今天天气不错'))
  check('semantic: empty text NOT blocked', !u.isSemanticProfile(''))

  section('17. memory system behavior')
  var tmpMem = require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'cascade-mem-'))
  try {
    var oldDir = process.env.DONGXUELIAN_AI_DATA_DIR
    process.env.DONGXUELIAN_AI_DATA_DIR = tmpMem
    delete require.cache[require('path').join(TEST_ROOT, '..', 'lib', 'constants')]
    delete require.cache[require('path').join(TEST_ROOT, '..', 'lib', 'core', 'constants')]
    delete require.cache[require('path').join(TEST_ROOT, '..', 'lib', 'conversation')]
    delete require.cache[require('path').join(TEST_ROOT, '..', 'lib', 'utils')]
    delete require.cache[require('path').join(TEST_ROOT, '..', 'lib', 'core', 'utils')]
    var memConv = require(require('path').join(TEST_ROOT, '..', 'lib', 'conversation'))

    await memConv.writeMemory('mem-u1', '', 'mem-g1', 'apple')
    await memConv.writeMemory('mem-u1', '', 'mem-g1', 'banana')
    var sum2 = await memConv.getMemorySummary('mem-u1', 'mem-g1')
    check('memory: write 2 items produces non-empty summary', !!sum2 && sum2.includes('apple'), sum2 || '(empty)')

    await memConv.deleteMemory('mem-u1', 'mem-g1', 'apple')
    var sumDel = await memConv.getMemorySummary('mem-u1', 'mem-g1')
    check('memory: delete removes item', sumDel.includes('banana') && !sumDel.includes('apple'), sumDel)

    await memConv.writeMemory('mem-u1', '', 'mem-g1', 'banana')
    var sumDedup = await memConv.getMemorySummary('mem-u1', 'mem-g1')
    check('memory: duplicate write does not add duplicate', sumDedup.indexOf('banana') === sumDedup.lastIndexOf('banana'), sumDedup)

    var emptySum = await memConv.getMemorySummary('mem-u2', 'mem-g2')
    check('memory: no memory returns empty string', emptySum === '', emptySum || '(truthy)')

    await memConv.writeMemory('mem-u3', '', 'mem-g3', 'a')
    await memConv.writeMemory('mem-u3', '', 'mem-g3', 'b')
    await memConv.writeMemory('mem-u3', '', 'mem-g3', 'c')
    await memConv.writeMemory('mem-u3', '', 'mem-g3', 'd')
    await memConv.writeMemory('mem-u3', '', 'mem-g3', 'e')
    var sum5 = await memConv.getMemorySummary('mem-u3', 'mem-g3')
    check('memory: more than 5 items returns 3', sum5.split('、').length === 3, sum5)
  } finally {
    delete require.cache[require('path').join(TEST_ROOT, '..', 'lib', 'constants')]
    delete require.cache[require('path').join(TEST_ROOT, '..', 'lib', 'core', 'constants')]
    delete require.cache[require('path').join(TEST_ROOT, '..', 'lib', 'conversation')]
    delete require.cache[require('path').join(TEST_ROOT, '..', 'lib', 'utils')]
    delete require.cache[require('path').join(TEST_ROOT, '..', 'lib', 'core', 'utils')]
    if (oldDir) process.env.DONGXUELIAN_AI_DATA_DIR = oldDir
    else delete process.env.DONGXUELIAN_AI_DATA_DIR
    try { require('fs').rmSync(tmpMem, { recursive: true, force: true }) } catch {}
  }

  section('17.5 willFactor behavior')
  var fakeShared = new Map()
  var now = Date.now()
  fakeShared.set('cold', [{ ts: now - 500 }])
  fakeShared.set('hot',  Array.from({length:25}, function(_,i){ return {ts: now - i*1000} }))
  var coldFactor = u.calculateWillFactor('cold', null, fakeShared)
  var hotFactor  = u.calculateWillFactor('hot', null, fakeShared)
  check('willFactor: cold group > hot group', coldFactor > hotFactor, coldFactor + ' vs ' + hotFactor)

  var chunCold  = u.calculateWillFactor('cold', '椿', fakeShared)
  var changliCold = u.calculateWillFactor('cold', '长离', fakeShared)
  check('willFactor: 椿 > 长离 (same group)', chunCold > changliCold, chunCold + ' vs ' + changliCold)

  var zeroMsgs = u.calculateWillFactor('empty-g', null, new Map())
  check('willFactor: no channel cache returns default', zeroMsgs > 0, zeroMsgs)
}

module.exports = { runOutputMemoryContracts }
