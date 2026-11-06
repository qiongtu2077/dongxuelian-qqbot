const fs = require('fs')
const path = require('path')
const { withScenario } = require('./_setup')
const { mockFetch } = require('../fake/fetch')

// 构造可播放 WAV，并预置新鲜缓存，避免本地测试依赖 ffmpeg 安装。
function seedRareVoiceCache(rareVoice) {
  const buffer = Buffer.alloc(48)
  buffer.write('RIFF', 0)
  buffer.writeUInt32LE(40, 4)
  buffer.write('WAVEfmt ', 8)
  buffer.writeUInt32LE(16, 16)
  buffer.writeUInt16LE(1, 20)
  buffer.writeUInt16LE(1, 22)
  buffer.writeUInt32LE(16000, 24)
  buffer.writeUInt32LE(32000, 28)
  buffer.writeUInt16LE(2, 32)
  buffer.writeUInt16LE(16, 34)
  buffer.write('data', 36)
  buffer.writeUInt32LE(4, 40)
  fs.mkdirSync(path.dirname(rareVoice.RARE_VOICE_WAV_CACHE), { recursive: true })
  fs.writeFileSync(rareVoice.RARE_VOICE_WAV_CACHE, buffer)
  const future = new Date(Date.now() + 60000)
  fs.utimesSync(rareVoice.RARE_VOICE_WAV_CACHE, future, future)
}

// 隔离执行真实聊天与语音发送流程，只模拟模型 HTTP 和 QQ 会话。
async function runRareChatCase(t, input, confirmed, { missingAudio = false, random = 0.1, sendFailure = false, gateRejected = false } = {}) {
  await withScenario({}, async ({ data, harness, makeSession }) => {
    data.writeText('ai-test-mode.txt', 'on')
    const rareVoice = require('../../lib/behavior/rare-voice')
    seedRareVoiceCache(rareVoice)
    const cachedRead = fs.readFileSync
    const mocked = mockFetch([{ json: { choices: [{ message: {
      content: `<rare_provocation>${confirmed ? 'Y' : 'N'}</rare_provocation>这句听到了。`,
    } }] } }])
    const previousFetch = global.fetch
    const previousRandom = Math.random
    const previousAvailable = process.env.RESOURCE_SCHEDULER_MEM_AVAILABLE_MB_OVERRIDE
    const previousTotal = process.env.RESOURCE_SCHEDULER_MEM_TOTAL_MB_OVERRIDE
    global.fetch = mocked.fetch
    Math.random = () => random
    process.env.RESOURCE_SCHEDULER_MEM_AVAILABLE_MB_OVERRIDE = gateRejected ? '50' : '1200'
    process.env.RESOURCE_SCHEDULER_MEM_TOTAL_MB_OVERRIDE = '1600'
    try {
      const session = makeSession({ guildId: '1072587329', channelId: '1072587329', messageId: 'rare-' + input })
      const originalSend = session.send.bind(session)
      // QQ 收发被模拟：语音投递可明确拒绝，成功时返回已知消息 ID。
      session.send = async message => {
        if (sendFailure && /<audio\b/.test(String(message))) throw new Error('QQ record rejected: retcode=1200')
        await originalSend(message)
        return ['fake-qq-record-id']
      }
      const meta = {}
      const chat = require('../../lib/chat')
      const reply = await chat.chat(session, input, harness.ctx, { meta, directAt: true })
      t.checkEqual(`rare semantic metadata: ${input}`, meta.rareConfirmed, confirmed)
      t.check(`rare semantic prompt always reaches main model: ${input}`, mocked.calls.some(call =>
        call.requestBody?.messages?.some(message => String(message.content).includes('【罕见语义判定】'))))
      t.check(`rare semantic marker removed before history: ${input}`, !reply.includes('rare_provocation')
        && !JSON.stringify(require('../../lib/conversation').getRecentAssistantReplies(session)).includes('rare_provocation'))
      t.checkEqual(`rare reaction follows semantic verdict: ${input}`, reply.includes('骂谁罕见'), confirmed)
      if (missingAudio) {
        // 模拟真实缓存读取失败，保留资源门控与文字回退代码。
        fs.readFileSync = function readWithoutRareAudio(file, ...args) {
          if (String(file) === rareVoice.RARE_VOICE_WAV_CACHE) throw new Error('rare audio fixture unavailable')
          return cachedRead.call(fs, file, ...args)
        }
      }
      const { sendChatReplyFlow } = require('../../lib/chat/chat-send-flow')
      await sendChatReplyFlow({
        ctx: harness.ctx, liveSession: session, channelKey: session.guildId,
        currentUserId: session.userId, userText: input, reply, randomTriggered: false,
        inGuild: true, chatMeta: meta, resolveBot: () => session.bot,
        safeSendReplyWithFreshness: async (_ctx, liveSession, text) => liveSession.send(text),
      })
      const expectedVoice = confirmed && !missingAudio && !sendFailure && !gateRejected && random < 0.5
      t.checkEqual(`rare voice send or text fallback: ${input}`, session.sent.some(text => /<audio\b/.test(text)), expectedVoice)
      t.check(`rare send stays visible without internal marker: ${input}`, session.sent.length > 0
        && !session.sent.some(text => text.includes('rare_provocation')))
      const events = harness.logs.filter(entry => entry.msg.startsWith('rare_voice ')).map(entry => JSON.parse(entry.msg.slice(11)))
      const decisions = events.filter(event => event.stage === 'decision')
      const result = events.find(event => event.stage === 'send_result')
      t.check(`rare decision persists exact draw and threshold: ${input}`, decisions.length === 1
        && decisions[0].draw === (confirmed ? random : null) && decisions[0].rate === 0.5
        && decisions[0].rareConfirmed === confirmed && decisions[0].selected === (confirmed && random < 0.5))
      t.check(`rare logs correlate group and original message: ${input}`, events.every(event =>
        event.channelKey === '1072587329' && event.messageId === session.messageId && event.userId === session.userId && event.createdAt))
      if (confirmed && random < 0.5) {
        const reason = gateRejected ? 'resource_gate_rejected' : missingAudio ? 'audio_unavailable' : sendFailure ? 'send_failed' : 'send_resolved'
        t.check(`rare send result identifies actual stop stage: ${input}`, events.some(event => event.stage === 'send_start')
          && result?.reason === reason && result.sent === expectedVoice && result.elapsedMs >= 0)
        if (expectedVoice) t.check('rare successful send records adapter message IDs', result.messageIds?.[0] === 'fake-qq-record-id')
        if (sendFailure) t.check('rare failed send preserves actual error', result.errorCode === 'send_failed'
          && result.error === 'QQ record rejected: retcode=1200')
        if (gateRejected) t.check('rare rejected resource admission records its decision', result.gateDecision && result.gateReason)
      } else {
        t.check(`rare non-selection is explicit without a send attempt: ${input}`, events.length === 1
          && decisions[0].reason === (confirmed ? 'random_miss' : 'not_rare'))
      }
    } finally {
      fs.readFileSync = cachedRead
      global.fetch = previousFetch
      Math.random = previousRandom
      if (previousAvailable === undefined) delete process.env.RESOURCE_SCHEDULER_MEM_AVAILABLE_MB_OVERRIDE
      else process.env.RESOURCE_SCHEDULER_MEM_AVAILABLE_MB_OVERRIDE = previousAvailable
      if (previousTotal === undefined) delete process.env.RESOURCE_SCHEDULER_MEM_TOTAL_MB_OVERRIDE
      else process.env.RESOURCE_SCHEDULER_MEM_TOTAL_MB_OVERRIDE = previousTotal
    }
  })
}

// 验证中文兜底、跨语言模型判定、真实音频发送及失败/概率回退。
async function run(t) {
  t.section('scenario: rare semantic voice route')
  const { parseRareProvocationDecision } = require('../../lib/behavior/rare-provocation')
  const { isRareProvocation } = require('../../lib/core/utils')
  for (const input of ['罕见', '稀有', '你不太常见', '不常见', '稀罕', '难得一见', '汉奸', '漢奸']) {
    t.check(`rare direct fallback covers ${input}`, isRareProvocation(input))
  }
  t.checkEqual('rare parser ignores quoted marker in reply body', parseRareProvocationDecision('引用 <rare_provocation>Y</rare_provocation>').confirmed, null)
  t.checkEqual('rare parser recovers observed unmarked reaction', parseRareProvocationDecision('骂谁罕见').confirmed, true)
  t.checkEqual('rare parser does not turn a phrase definition into a reaction', parseRareProvocationDecision('骂谁罕见是什么意思').confirmed, null)
  t.checkEqual('rare explicit negative verdict overrides quoted reaction', parseRareProvocationDecision('<rare_provocation>N</rare_provocation>骂谁罕见？这是一句梗。').confirmed, false)
  await withScenario({}, async ({ data, harness, makeSession }) => {
    data.writeText('ai-test-mode.txt', 'on')
    const session = makeSession()
    const identity = await require('../../lib/chat')._test.prepareChatIdentityStage(session, '你不太常见', harness.ctx, {})
    t.check('rare direct expression is also a wide candidate', identity.rareProvocation && identity.wideRareHit)
    const { finalizeChatReply } = require('../../lib/chat/chat-final-output-flow')
    const meta = {}
    const empty = await finalizeChatReply({
      reply: '<rare_provocation>N</rare_provocation>', options: { meta },
      session, ctx: harness.ctx, callModel: async () => '正常回复。',
    })
    t.check('rare protocol-only response stays visible', empty.shouldSend && empty.finalReply.length > 0)
    t.checkEqual('rare protocol-only negative response keeps its verdict', meta.rareConfirmed, false)
    const retried = await finalizeChatReply({
      reply: '<rare_provocation>N</rare_provocation>拉黑你', options: { meta },
      session, ctx: harness.ctx,
      callModel: async () => '<rare_provocation>Y</rare_provocation>骂谁罕见。',
    })
    t.check('rare retry removes markers and propagates latest verdict', meta.rareConfirmed === true
      && retried.finalReply.includes('骂谁罕见') && !retried.finalReply.includes('rare_provocation'))
  })
  for (const input of ['你不太常见', '稀有', '汉奸', 'You are uncommon.', 'What a rare specimen you are!', '君は珍しいね', '너 참 희귀하네', 'Tu es un spécimen rare.', 'Du bist eine Seltenheit.', 'Eres poco común.', 'Ты редкий экземпляр.', 'أنت نادر', '你真是个 rare specimen']) {
    await runRareChatCase(t, input, true)
  }
  for (const input of ['这是稀有材料', '这是一种罕见病', 'What does uncommon mean?', '他说你罕见，但我没在骂你']) {
    await runRareChatCase(t, input, false)
  }
  await runRareChatCase(t, '罕见音频读取失败', true, { missingAudio: true })
  await runRareChatCase(t, '罕见概率未抽中', true, { random: 0.99 })
  // 重现用户在 1072587329 群的三条实际输入，明确区分抽签未中与投递失败。
  for (const [input, random] of [['罕见！', 0.91], ['很稀有啊', 0.82], ['你好少见啊', 0.73]]) {
    await runRareChatCase(t, input, true, { random })
  }
  await runRareChatCase(t, '罕见投递失败', true, { sendFailure: true })
  await runRareChatCase(t, '罕见资源拒绝', true, { gateRejected: true })
  await withScenario({}, async ({ harness, makeSession }) => {
    const { shouldTriggerRareVoiceWithDiagnostics } = require('../../lib/diagnostics/rare-voice-diagnostics')
    const session = makeSession({ messageId: 'rare-draw-count' })
    let draws = 0
    const random = () => { draws += 1; return 0.5 }
    t.checkEqual('rare missing verdict stays unselected', shouldTriggerRareVoiceWithDiagnostics(harness.ctx, session, {}, 'chat', random), false)
    t.checkEqual('rare negative verdict stays unselected', shouldTriggerRareVoiceWithDiagnostics(harness.ctx, session, { rareConfirmed: false }, 'chat', random), false)
    t.checkEqual('rare non-candidates never consume a random number for logging', draws, 0)
    t.checkEqual('rare draw at exact 50 percent remains unselected', shouldTriggerRareVoiceWithDiagnostics(harness.ctx, session, { rareConfirmed: true }, 'chat', random), false)
    t.checkEqual('rare positive decision consumes exactly one draw', draws, 1)
    const events = harness.logs.filter(entry => entry.msg.startsWith('rare_voice ')).map(entry => JSON.parse(entry.msg.slice(11)))
    t.check('rare logs distinguish missing verdict, negative verdict and random miss', events[0].reason === 'missing_verdict'
      && events[0].rareConfirmed === null && events[1].reason === 'not_rare' && events[2].draw === 0.5 && events[2].reason === 'random_miss')
  })
  await withScenario({}, async ({ harness, makeSession }) => {
    const { sendChatReplyFlow } = require('../../lib/chat/chat-send-flow')
    const session = makeSession({ messageId: 'rare-stale-selected' })
    const previousRandom = Math.random
    Math.random = () => 0.1
    try {
      await sendChatReplyFlow({ ctx: harness.ctx, liveSession: session, channelKey: session.guildId,
        currentUserId: session.userId, userText: '罕见', reply: '骂谁罕见', randomTriggered: true, inGuild: true,
        chatMeta: { rareConfirmed: true }, randomSendOptions: { randomFreshness: {
          channelKey: session.guildId, triggerMessageVersion: -1, explicitVersion: -1, triggerAt: Date.now(),
        } }, safeSendReplyWithFreshness: async () => { throw new Error('stale reply must not send') } })
      const events = harness.logs.filter(entry => entry.msg.startsWith('rare_voice ')).map(entry => JSON.parse(entry.msg.slice(11)))
      t.check('rare selected but expired reply has a correlated skip record', events.length === 2
        && events[0].selected && events[1].reason === 'stale_random_reply' && events[1].messageId === session.messageId)
      t.checkEqual('rare expired reply never starts voice transport', session.sent.length, 0)
    } finally { Math.random = previousRandom }
  })
}

module.exports = { run }
