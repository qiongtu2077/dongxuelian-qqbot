const path = require('path')
const fs = require('fs')
const { withScenario } = require('./_setup')
const { AI_ROOT } = require('../fake/file')
const { mockFetch } = require('../fake/fetch')

const ONE_PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=',
  'base64'
)

async function withFetch(mocked, fn) {
  const originalFetch = global.fetch
  global.fetch = mocked.fetch
  try {
    return await fn()
  } finally {
    global.fetch = originalFetch
  }
}

async function run(t) {
  t.section('scenario: vision session helpers')

  await withScenario({}, async ({ makeSession }) => {
    const vision = require(path.join(AI_ROOT, 'lib', 'vision.js'))
    const session = makeSession({
      content: '[CQ:image,file=current.jpg,url=http://example.test/current.jpg]',
      event: { sender: { role: 'member' }, message: [{ type: 'image', data: { file: 'current.jpg', url: 'http://example.test/current.jpg' } }] },
    })
    const marked = vision.prepareVisionRequest(session, { hasVisual: true, hasFile: true, hasEmbed: false }, {
      content: session.content,
      allowCurrentMessage: true,
      includeQuote: false,
    })
    const payload = vision.getVisionPayload(session)
    t.check('scenario vision current image marks session', marked && vision.isVisionSession(session), JSON.stringify(payload))
    t.check('scenario vision current image captures file', payload.file === 'current.jpg', JSON.stringify(payload))
    t.check('scenario vision clear removes current image marker', (vision.clearVisionSession(session), !vision.isVisionSession(session)), JSON.stringify(vision.getVisionPayload(session)))
  })

  await withScenario({}, async ({ makeSession }) => {
    const vision = require(path.join(AI_ROOT, 'lib', 'vision.js'))
    const session = makeSession({
      content: '这张图是什么',
      event: { sender: { role: 'member' }, message: [{ type: 'image', data: { url: 'http://example.test/structured-current.jpg' } }] },
    })
    const marked = vision.prepareVisionRequest(session, { hasVisual: true, hasFile: false, hasEmbed: false }, {
      content: session.content,
      allowCurrentMessage: true,
      includeQuote: false,
    })
    const payload = vision.getVisionPayload(session)
    t.check('scenario vision current structured url marks session', marked && vision.isVisionSession(session), JSON.stringify(payload))
    t.check('scenario vision current structured url captures url', payload.urls.includes('http://example.test/structured-current.jpg'), JSON.stringify(payload))
  })

  await withScenario({}, async ({ makeSession }) => {
    const vision = require(path.join(AI_ROOT, 'lib', 'vision.js'))
    const session = makeSession({
      content: '这张图是什么',
      quote: {
        message: [{ type: 'image', data: { file: 'quoted.jpg', url: 'http://example.test/quoted.jpg' } }],
      },
    })
    const marked = vision.prepareVisionRequest(session, { hasVisual: false, hasFile: false, hasEmbed: false }, {
      content: session.content,
      allowCurrentMessage: false,
      includeQuote: true,
    })
    const payload = vision.getVisionPayload(session)
    t.check('scenario vision quoted image marks session', marked && vision.isVisionSession(session), JSON.stringify(payload))
    t.check('scenario vision quoted image captures file', payload.file === 'quoted.jpg', JSON.stringify(payload))
  })

  await withScenario({}, async ({ makeSession }) => {
    const vision = require(path.join(AI_ROOT, 'lib', 'vision.js'))
    const session = makeSession({ content: 'plain text only' })
    const marked = vision.prepareVisionRequest(session, { hasVisual: false, hasFile: false, hasEmbed: false }, {
      content: session.content,
      allowCurrentMessage: true,
      includeQuote: true,
    })
    t.check('scenario vision plain text does not mark session', !marked && !vision.isVisionSession(session), JSON.stringify(vision.getVisionPayload(session)))
  })

  await withScenario({}, async ({ makeSession, run, data }) => {
    const session = makeSession({
      content: '<img src="file://D:\\qq\\nt_data\\Pic\\Thumb\\local-only.jpg" />',
      messageId: 'img-file-only',
      event: { sender: { role: 'member' }, message: [
        { type: 'image', data: { file: 'local-only.jpg' } },
      ] },
    })
    await run(session, { flushTicks: 20 })
    const store = require(path.join(AI_ROOT, 'lib', 'image-store.js'))
    const entry = await store.getImageEntry(session.guildId, 'img-file-only')
    t.check('scenario image history stores file-only QQ image', entry && entry.file === 'local-only.jpg' && entry.url === '', JSON.stringify(entry))
    t.check('scenario image history file created', fs.existsSync(data.pathFor('image-history', `${session.guildId}.json`)), data.dataDir)
  })

  await withScenario({}, async ({ data }) => {
    data.writeText('ai-model.txt', 'qwen3.5-omni-flash')
    try { require(path.join(AI_ROOT, 'lib', 'runtime-config.js')).resetConfigCache() } catch {}
    const store = require(path.join(AI_ROOT, 'lib', 'image-store.js'))
    const chatTools = require(path.join(AI_ROOT, 'lib', 'chat-tools.js'))
    await store.storeImageUrl('group-image-tool', 'msg-file-tool', '', 'tool-local.jpg', { conversationKey: 'group-image-tool::user-a', userId: 'user-a' })
    await store.cacheImageFile('group-image-tool', 'msg-file-tool', ONE_PIXEL_PNG)
    const mocked = mockFetch([{ json: { choices: [{ message: { content: '图片里有一只橙色小猫。' } }] } }])
    await withFetch(mocked, async () => {
      const result = await chatTools.handleChatToolCalls([{
        id: 'tool-img',
        type: 'function',
        function: { name: 'analyze_historical_image', arguments: '{"messageId":"msg-file-tool","question":"评价一下这张图"}' },
      }], { channelKey: 'group-image-tool' })
      const content = result.results[0]?.content || ''
      t.check('scenario chat image tool returns analysis in current turn', content.includes('橙色小猫'), JSON.stringify(result))
      const entry = await store.getImageEntry('group-image-tool', 'msg-file-tool')
      t.check('scenario chat image tool writes analysis back', entry && entry.analyzed && /橙色小猫/.test(entry.analysis || ''), JSON.stringify(entry))
    })
  })

  await withScenario({}, async ({ makeSession }) => {
    const store = require(path.join(AI_ROOT, 'lib', 'image-store.js'))
    const conversation = require(path.join(AI_ROOT, 'lib', 'conversation.js'))
    const session = makeSession({
      guildId: 'group-image-memory',
      userId: 'user-image-memory',
      messageId: 'img-memory-first',
      content: '[图片]',
    })
    conversation.saveConversationTurn(session, '用户(tester)：[图片]', '')
    await new Promise(resolve => setTimeout(resolve, 20))
    await store.storeImageUrl('group-image-memory', 'img-memory-first', '', 'memory-first.jpg', {
      conversationKey: conversation.getConversationKey(session),
      userId: session.userId,
    })
    const replaced = await store.replaceImagePlaceholder('group-image-memory', 'img-memory-first', '图里是一张期末复习资料截图。')
    const history = conversation.getConversationHistory(session)
    t.check('scenario image placeholder replacement succeeds before third disk flush', replaced, JSON.stringify(history))
    t.check('scenario image placeholder updates hot conversation cache', history.some(item => /\[图片\]: 图里是一张期末复习资料截图/.test(item.content || '')), JSON.stringify(history))
    const disk = conversation.readConversationDisk(conversation.getConversationKey(session))
    t.check('scenario image placeholder writes disk snapshot too', disk && disk.messages.some(item => /\[图片\]: 图里是一张期末复习资料截图/.test(item.content || '')), JSON.stringify(disk))
  })

  await withScenario({}, async ({ makeSession }) => {
    const store = require(path.join(AI_ROOT, 'lib', 'image-store.js'))
    const sanitizer = require(path.join(AI_ROOT, 'lib', 'image-analysis-sanitizer.js'))
    const session = makeSession({
      guildId: 'group-image-sanitize',
      userId: 'user-image-sanitize',
      messageId: 'img-sanitize-first',
      content: '[图片]',
    })
    await store.storeImageUrl('group-image-sanitize', 'img-sanitize-first', '', 'sanitize.jpg', {
      conversationKey: 'group-image-sanitize::user-image-sanitize',
      userId: session.userId,
    })
    const chatty = '呀吼～这广告牌好有意思！指挥官觉得这个广告怎么样？'
    t.check('scenario image sanitizer rejects persona reply', sanitizer.sanitizeImageAnalysis(chatty) === '', sanitizer.sanitizeImageAnalysis(chatty))
    const marked = await store.markAnalyzed('group-image-sanitize', 'img-sanitize-first', chatty)
    const entry = await store.getImageEntry('group-image-sanitize', 'img-sanitize-first')
    t.check('scenario image analysis keeps anchor when persona reply rejected', marked && entry && entry.analysis === null && entry.analyzed === false && entry.analysisStatus === 'unavailable', JSON.stringify(entry))
    const objective = '图中是一辆三轮车，车尾挂着考试前紧张情绪释放的广告。'
    await store.markAnalyzed('group-image-sanitize', 'img-sanitize-first', objective)
    const objectiveEntry = await store.getImageEntry('group-image-sanitize', 'img-sanitize-first')
    t.check('scenario image analysis stores objective summary', objectiveEntry && objectiveEntry.analyzed && objectiveEntry.analysis.includes('三轮车') && objectiveEntry.analysisKind === 'objective', JSON.stringify(objectiveEntry))
  })
}

module.exports = { run }
