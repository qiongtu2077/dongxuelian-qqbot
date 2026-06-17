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
    const vision = require(path.join(AI_ROOT, 'lib', 'media', 'image', 'vision.js'))
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

  await withScenario({}, async ({ makeSession, harness, data }) => {
    const apiPath = path.join(AI_ROOT, 'lib', 'core', 'api.js')
    const chatPath = path.join(AI_ROOT, 'lib', 'chat.js')
    const visionPath = path.join(AI_ROOT, 'lib', 'media', 'image', 'vision.js')
    const storePath = path.join(AI_ROOT, 'lib', 'media', 'image', 'image-store.js')
    const conversationPath = path.join(AI_ROOT, 'lib', 'conversation.js')
    const api = require(apiPath)
    const originalApi = {
      callGetImage: api.callGetImage,
      readImageAsBase64: api.readImageAsBase64,
      isVisionModel: api.isVisionModel,
    }
    api.callGetImage = async () => ({ file: 'vision-sync-local.png' })
    api.readImageAsBase64 = async () => `data:image/png;base64,${ONE_PIXEL_PNG.toString('base64')}`
    api.isVisionModel = () => true
    const mocked = mockFetch([{
      json: {
        choices: [{
          message: {
            content: '<image_fact>图中是一个提示框，内容为“Bad Gateway (502)”。</image_fact>哎呀，网页炸掉了嘛，过一会儿再刷新试试看！',
          },
        }],
      },
    }])
    await withFetch(mocked, async () => {
      delete require.cache[require.resolve(chatPath)]
      delete require.cache[require.resolve(visionPath)]
      const session = makeSession({
        guildId: '',
        channelId: '',
        isDirect: true,
        userId: 'vision-sync-user',
        author: { id: 'vision-sync-user', name: 'tester', nick: 'tester' },
        messageId: 'vision-sync-image',
        content: '[CQ:image,file=vision-sync.jpg]',
        event: {
          sender: { role: 'member' },
          message: [{ type: 'image', data: { file: 'vision-sync.jpg' } }],
        },
      })
      try {
        data.writeText('ai-model.txt', 'qwen3.5-omni-flash')
        try { require(path.join(AI_ROOT, 'lib', 'core', 'runtime-config.js')).resetConfigCache() } catch {}
        const vision = require(visionPath)
        const chatModule = require(chatPath)
        const store = require(storePath)
        const conversation = require(conversationPath)
        await store.storeImageUrl('private:vision-sync-user', 'vision-sync-image', '', 'vision-sync.jpg', {
          conversationKey: conversation.getConversationKey(session),
          userId: session.userId,
        })
        vision.prepareVisionRequest(session, { hasVisual: true, hasFile: true, hasEmbed: false }, {
          content: session.content,
          allowCurrentMessage: true,
          includeQuote: false,
        })
        const reply = await chatModule.chat(session, '[图片]', harness.ctx, {})
        const entry = await store.getImageEntry('private:vision-sync-user', 'vision-sync-image')
        const history = conversation.getConversationHistory(session)
        const visibleReply = String(reply || '')
        t.check('scenario current vision reply strips hidden image fact from visible output',
          visibleReply.includes('网页炸掉了嘛') && !visibleReply.includes('<image_fact>') && !visibleReply.includes('Bad Gateway (502)'),
          JSON.stringify({ reply: visibleReply, calls: mocked.calls }))
        t.check('scenario current vision reply writes objective fact into image history',
          entry && entry.analyzed === true && entry.analysisStatus === 'analyzed' && /Bad Gateway \(502\)/.test(entry.analysis || ''),
          JSON.stringify(entry))
        t.check('scenario current vision reply backfills conversation image placeholder',
          history.some(item => /\[图片\]: 图中是一个提示框/.test(String(item.content || ''))),
          JSON.stringify(history))
      } finally {
        api.callGetImage = originalApi.callGetImage
        api.readImageAsBase64 = originalApi.readImageAsBase64
        api.isVisionModel = originalApi.isVisionModel
      }
    })
  })

  await withScenario({}, async ({ makeSession, harness, data }) => {
    const apiPath = path.join(AI_ROOT, 'lib', 'core', 'api.js')
    const chatPath = path.join(AI_ROOT, 'lib', 'chat.js')
    const visionPath = path.join(AI_ROOT, 'lib', 'media', 'image', 'vision.js')
    const storePath = path.join(AI_ROOT, 'lib', 'media', 'image', 'image-store.js')
    const conversationPath = path.join(AI_ROOT, 'lib', 'conversation.js')
    const api = require(apiPath)
    const originalApi = {
      callGetImage: api.callGetImage,
      readImageAsBase64: api.readImageAsBase64,
      isVisionModel: api.isVisionModel,
    }
    api.callGetImage = async () => ({ file: 'vision-fallback-local.png' })
    api.readImageAsBase64 = async () => `data:image/png;base64,${ONE_PIXEL_PNG.toString('base64')}`
    api.isVisionModel = () => true
    const mocked = mockFetch([{
      json: {
        choices: [{
          message: {
            content: '图中是一个提示框，内容为“Bad Gateway (502)”。哎呀，网页炸掉了嘛，过一会儿再刷新试试看！',
          },
        }],
      },
    }])
    await withFetch(mocked, async () => {
      delete require.cache[require.resolve(chatPath)]
      delete require.cache[require.resolve(visionPath)]
      const session = makeSession({
        guildId: '',
        channelId: '',
        isDirect: true,
        userId: 'vision-fallback-user',
        author: { id: 'vision-fallback-user', name: 'tester', nick: 'tester' },
        messageId: 'vision-fallback-image',
        content: '[CQ:image,file=vision-fallback.jpg]',
        event: {
          sender: { role: 'member' },
          message: [{ type: 'image', data: { file: 'vision-fallback.jpg' } }],
        },
      })
      try {
        data.writeText('ai-model.txt', 'qwen3.5-omni-flash')
        try { require(path.join(AI_ROOT, 'lib', 'core', 'runtime-config.js')).resetConfigCache() } catch {}
        const vision = require(visionPath)
        const chatModule = require(chatPath)
        const store = require(storePath)
        const conversation = require(conversationPath)
        await store.storeImageUrl('private:vision-fallback-user', 'vision-fallback-image', '', 'vision-fallback.jpg', {
          conversationKey: conversation.getConversationKey(session),
          userId: session.userId,
        })
        vision.prepareVisionRequest(session, { hasVisual: true, hasFile: true, hasEmbed: false }, {
          content: session.content,
          allowCurrentMessage: true,
          includeQuote: false,
        })
        const reply = await chatModule.chat(session, '[图片]', harness.ctx, {})
        const entry = await store.getImageEntry('private:vision-fallback-user', 'vision-fallback-image')
        const history = conversation.getConversationHistory(session)
        const visibleReply = String(reply || '')
        t.check('scenario current vision reply without hidden tag keeps visible persona reply',
          visibleReply.includes('网页炸掉了嘛') && !visibleReply.includes('<image_fact>'),
          JSON.stringify({ reply: visibleReply, calls: mocked.calls }))
        t.check('scenario current vision reply without hidden tag still writes image history',
          entry && entry.analyzed === true && entry.analysisStatus === 'analyzed' && /Bad Gateway \(502\)/.test(entry.analysis || ''),
          JSON.stringify(entry))
        t.check('scenario current vision reply without hidden tag still backfills conversation image placeholder',
          history.some(item => /\[图片\]: 图中是一个提示框/.test(String(item.content || ''))),
          JSON.stringify(history))
      } finally {
        api.callGetImage = originalApi.callGetImage
        api.readImageAsBase64 = originalApi.readImageAsBase64
        api.isVisionModel = originalApi.isVisionModel
      }
    })
  })

  await withScenario({}, async ({ makeSession }) => {
    const vision = require(path.join(AI_ROOT, 'lib', 'media', 'image', 'vision.js'))
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
    const vision = require(path.join(AI_ROOT, 'lib', 'media', 'image', 'vision.js'))
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
    const vision = require(path.join(AI_ROOT, 'lib', 'media', 'image', 'vision.js'))
    const session = makeSession({ content: 'plain text only' })
    const marked = vision.prepareVisionRequest(session, { hasVisual: false, hasFile: false, hasEmbed: false }, {
      content: session.content,
      allowCurrentMessage: true,
      includeQuote: true,
    })
    t.check('scenario vision plain text does not mark session', !marked && !vision.isVisionSession(session), JSON.stringify(vision.getVisionPayload(session)))
  })

  await withScenario({}, async ({ makeSession }) => {
    const apiPath = path.join(AI_ROOT, 'lib', 'core', 'api.js')
    const storePath = path.join(AI_ROOT, 'lib', 'media', 'image', 'image-store.js')
    const visionPath = path.join(AI_ROOT, 'lib', 'media', 'image', 'vision.js')
    const api = require(apiPath)
    const store = require(storePath)
    const originalApi = {
      callGetImage: api.callGetImage,
      readImageAsBase64: api.readImageAsBase64,
      downloadImageAsBase64: api.downloadImageAsBase64,
      isVisionModel: api.isVisionModel,
    }
    const originalReadCachedImage = store.readCachedImage
    let downloadCalls = 0
    const cachedBase64 = `data:image/png;base64,${ONE_PIXEL_PNG.toString('base64')}`
    api.callGetImage = async () => null
    api.readImageAsBase64 = async () => null
    api.downloadImageAsBase64 = async () => {
      downloadCalls += 1
      return null
    }
    api.isVisionModel = () => true
    store.readCachedImage = async () => cachedBase64
    delete require.cache[require.resolve(visionPath)]
    try {
      const vision = require(visionPath)
      const session = makeSession({
        guildId: 'group-vision-cache',
        messageId: 'img-current-cache',
        content: '[CQ:image,file=current-cache.jpg]',
        event: { sender: { role: 'member' }, message: [{ type: 'image', data: { file: 'current-cache.jpg' } }] },
      })
      const marked = vision.prepareVisionRequest(session, { hasVisual: true, hasFile: true, hasEmbed: false }, {
        content: session.content,
        allowCurrentMessage: true,
        includeQuote: false,
      })
      const messages = []
      const result = await vision.appendVisionMessage(messages, session, { provider: 'dashscope', model: 'qwen3.5-omni-flash' }, {
        logger: () => ({ warn: () => {} }),
      }, {
        promptText: '看看这张图',
      })
      const content = Array.isArray(messages[0] && messages[0].content) ? messages[0].content : []
      const injectedUrl = content[1] && content[1].image_url && content[1].image_url.url
      t.check('scenario vision current image reuses cached base64 when source file unavailable',
        marked && result.ok && injectedUrl === cachedBase64,
        JSON.stringify({ result, messages }))
      t.check('scenario vision current image cache path avoids url download fallback', downloadCalls === 0, `downloadCalls=${downloadCalls}`)
      t.check('scenario vision current image cache path clears session marker', !vision.isVisionSession(session), JSON.stringify(vision.getVisionPayload(session)))
    } finally {
      api.callGetImage = originalApi.callGetImage
      api.readImageAsBase64 = originalApi.readImageAsBase64
      api.downloadImageAsBase64 = originalApi.downloadImageAsBase64
      api.isVisionModel = originalApi.isVisionModel
      store.readCachedImage = originalReadCachedImage
      delete require.cache[require.resolve(visionPath)]
    }
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
    const store = require(path.join(AI_ROOT, 'lib', 'media', 'image', 'image-store.js'))
    const entry = await store.getImageEntry(session.guildId, 'img-file-only')
    t.check('scenario image history stores file-only QQ image', entry && entry.file === 'local-only.jpg' && entry.url === '', JSON.stringify(entry))
    t.check('scenario image history file created', fs.existsSync(data.pathFor('image-history', `${session.guildId}.json`)), data.dataDir)
  })

  await withScenario({}, async ({ data }) => {
    data.writeText('ai-model.txt', 'qwen3.5-omni-flash')
    try { require(path.join(AI_ROOT, 'lib', 'core', 'runtime-config.js')).resetConfigCache() } catch {}
    const store = require(path.join(AI_ROOT, 'lib', 'media', 'image', 'image-store.js'))
    const mediaQueue = require(path.join(AI_ROOT, 'lib', 'media', 'backpressure', 'media-queue.js'))
    const chatTools = require(path.join(AI_ROOT, 'lib', 'chat', 'chat-tools.js'))
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
      t.check('scenario chat image tool queues analysis in current turn', content.includes('进入媒体分析队列') && content.includes('read_image_history'), JSON.stringify(result))
      t.check('scenario chat image tool does not call vision model synchronously', mocked.calls.length === 0, `calls=${mocked.calls.length}`)
      const tasks = mediaQueue.listPendingMediaTasks('media_image_analysis', 20)
      const queued = tasks.find(task => task && task.channelKey === 'group-image-tool' && task.messageId === 'msg-file-tool')
      t.check('scenario chat image tool enqueues S6 media image task',
        queued && queued.kind === 'media_image_analysis' && queued.status === 'pending' &&
          queued.url === 'tool-local.jpg' && queued.payload && queued.payload.entry === 'chat-tool-analyze-historical-image',
        JSON.stringify(tasks))
      const entry = await store.getImageEntry('group-image-tool', 'msg-file-tool')
      t.check('scenario chat image tool leaves image pending until media worker writes back',
        entry && entry.analyzed === false && entry.analysis === null && entry.analysisStatus === 'pending',
        JSON.stringify(entry))
    })
  })

  await withScenario({}, async ({ makeSession }) => {
    const store = require(path.join(AI_ROOT, 'lib', 'media', 'image', 'image-store.js'))
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
    const store = require(path.join(AI_ROOT, 'lib', 'media', 'image', 'image-store.js'))
    const sanitizer = require(path.join(AI_ROOT, 'lib', 'media', 'image', 'image-analysis-sanitizer.js'))
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

  await withScenario({}, async ({ data }) => {
    const originalDataDir = process.env.DONGXUELIAN_AI_DATA_DIR
    const legacyDir = data.pathFor('image-history')
    const legacyKey = 'private:vision-user'
    const legacyFile = path.join(legacyDir, `${legacyKey}.json`)
    const safeFile = path.join(legacyDir, 'private_vision-user.json')
    await fs.promises.mkdir(legacyDir, { recursive: true })
    await fs.promises.writeFile(legacyFile, JSON.stringify({
      images: {
        'legacy-image-msg': {
          url: 'https://example.test/legacy.jpg',
          file: 'legacy-local.jpg',
          conversationKey: legacyKey,
          userId: 'vision-user',
          ts: Date.now(),
          analyzed: false,
          analysis: null,
          sourceRole: 'user',
          sentByBot: false,
          analysisStatus: 'pending',
          analysisKind: '',
        },
      },
    }), 'utf8')
    try {
      const store = require(path.join(AI_ROOT, 'lib', 'media', 'image', 'image-store.js'))
      const entry = await store.getImageEntry(legacyKey, 'legacy-image-msg')
      const recent = await store.getRecentImages(legacyKey, 5)
      const cachedRecent = store.getRecentImagesCached(legacyKey, 5)
      await store.storeImageUrl(legacyKey, 'new-image-msg', 'https://example.test/new.jpg', 'new-local.jpg', { conversationKey: legacyKey, userId: 'vision-user' })
      const readBack = await store.getImageEntry(legacyKey, 'new-image-msg')
      const files = fs.readdirSync(legacyDir)
      t.check('scenario image-store legacy private image file remains readable', entry && entry.file === 'legacy-local.jpg' && entry.url === 'https://example.test/legacy.jpg', JSON.stringify(entry))
      t.check('scenario image-store legacy private image history shows in recent list', recent.some(item => item.messageId === 'legacy-image-msg'), JSON.stringify(recent))
      t.check('scenario image-store legacy private image history populates cache', cachedRecent.some(item => item.messageId === 'legacy-image-msg'), JSON.stringify(cachedRecent))
      t.check('scenario image-store new private image writes safe filename', files.includes('private_vision-user.json') && !files.some(name => String(name).includes(':')), JSON.stringify(files))
      t.check('scenario image-store new private image remains readable after safe write', readBack && readBack.file === 'new-local.jpg' && readBack.url === 'https://example.test/new.jpg', JSON.stringify(readBack))
    } finally {
      if (originalDataDir === undefined) delete process.env.DONGXUELIAN_AI_DATA_DIR
      else process.env.DONGXUELIAN_AI_DATA_DIR = originalDataDir
    }
  })
}

module.exports = { run }
