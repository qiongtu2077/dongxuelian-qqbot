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
        await store.cacheImageFile('private:vision-sync-user', 'vision-sync-image', ONE_PIXEL_PNG)
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
        await store.cacheImageFile('private:vision-fallback-user', 'vision-fallback-image', ONE_PIXEL_PNG)
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
      await store.storeImageUrl('group-vision-cache', 'img-current-cache', '', 'current-cache.jpg')
      await store.cacheImageFile('group-vision-cache', 'img-current-cache', ONE_PIXEL_PNG)
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
      t.check('scenario chat image tool registers question and allowed source',
        queued && queued.payload.imageDemand?.source === 'history-tool' && queued.payload.imageDemand?.question === '评价一下这张图', JSON.stringify(queued))
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

// 真实运行 middleware 和聊天链，只模拟模型 HTTP，固定本地原图避免远端依赖。
async function runAllowedImageInvitations(t) {
  for (const scenario of [
    { label: 'explicit image with unrelated text', random: false, private: false, text: '今天星期几' },
    { label: 'private image invitation', random: false, private: true, text: '' },
    { label: 'random selected image topic', random: true, private: false, text: '今天随手拍的' },
  ]) {
    await withScenario({ data: scenario.random ? { randomWhitelist: ['10001'], randomRate: { 10001: 1 }, randomVoiceRate: { 10001: 0 } } : {} }, async ({ ready, makeSession, run }) => {
      await ready()
      const store = require(path.join(AI_ROOT, 'lib', 'media', 'image', 'image-store.js'))
      const session = makeSession({
        ...(scenario.private ? { guildId: undefined, isDirect: true } : {}),
        messageId: `allowed-${scenario.random ? 'random' : scenario.private ? 'private' : 'mention'}`,
        content: `${scenario.random || scenario.private ? '' : '<at id="90000"/> '}${scenario.text}<img src="https://example.test/allowed.jpg" file="allowed-file"/>`,
        event: { sender: { role: 'member' }, message: { elements: [{ type: 'img', attrs: { src: 'https://example.test/allowed.jpg', file: 'allowed-file' } }] } },
      })
      const channelKey = scenario.private ? `private:${session.userId}` : session.guildId
      await store.storeImageUrl(channelKey, session.messageId, 'https://example.test/allowed.jpg', 'allowed-file')
      await store.cacheImageFile(channelKey, session.messageId, ONE_PIXEL_PNG)
      const mocked = mockFetch([{ json: { choices: [{ message: { content: '<image_fact>图片中是一只猫。</image_fact>看着挺精神。' } }] } }])
      await withFetch(mocked, async () => {
        await run(session, { flushTicks: 120 })
        await session.waitForSend(() => true)
        const body = mocked.calls[0]?.requestBody || {}
        t.check(`scenario ${scenario.label} performs one actual vision request`, mocked.calls.length === 1 && body.model === 'glm-4.6v-flash', JSON.stringify(mocked.calls))
        t.check(`scenario ${scenario.label} carries selected original image`, (body.messages || []).some(message => Array.isArray(message.content) && message.content.some(part => part.type === 'image_url')), JSON.stringify(body))
        t.check(`scenario ${scenario.label} strips image request diagnostic before upstream`, !Object.hasOwn(body, '_imageRequest'), JSON.stringify(body))
        const entry = await store.getImageEntry(channelKey, session.messageId)
        t.check(`scenario ${scenario.label} writes same request fact into original image`, entry?.analyzed === true && entry.analysis?.includes('猫'), JSON.stringify(entry))
      })
    })
  }
}

// 当前图和引用图同时存在时，模拟获准聊天选择目标，验证不先看图也不双识。
async function runImageTargetSelection(t) {
  await withScenario({}, async ({ makeSession, harness }) => {
    const store = require(path.join(AI_ROOT, 'lib', 'media', 'image', 'image-store.js'))
    const vision = require(path.join(AI_ROOT, 'lib', 'media', 'image', 'vision.js'))
    const chat = require(path.join(AI_ROOT, 'lib', 'chat.js'))
    const session = makeSession({ messageId: 'vision-no-send', content: '<img src="https://example.test/no-send.jpg"/>', event: { message: [{ type: 'image', data: { url: 'https://example.test/no-send.jpg' } }] } })
    await store.storeImageUrl('10001', session.messageId, 'https://example.test/no-send.jpg', '')
    await store.cacheImageFile('10001', session.messageId, ONE_PIXEL_PNG)
    vision.prepareVisionRequest(session, { hasVisual: true }, { allowCurrentMessage: true })
    const mocked = mockFetch([
      { json: { choices: [{ message: { content: '<image_fact>图片中是一只猫。</image_fact>{"mode":"no_send","reply":""}' } }] } },
      { json: { choices: [{ message: { content: '是一只猫。' } }] } },
    ])
    await withFetch(mocked, async () => {
      const reply = await chat.chat(session, '[图片]', harness.ctx, { randomTriggered: true })
      const entry = await store.getImageEntry('10001', session.messageId)
      t.check('scenario random no_send retains already recognized objective fact', reply === '' && entry?.analysis?.includes('猫'), JSON.stringify({ reply, entry }))
      vision.prepareVisionRequest(session, { hasVisual: true }, { allowCurrentMessage: true })
      await chat.chat(session, '图里是什么', harness.ctx)
      t.check('scenario fact from unsent reply is reused without another vision request', mocked.calls.length === 2 && mocked.calls[1].requestBody.model === 'deepseek-v4-flash', JSON.stringify(mocked.calls))
    })
  })

  for (const recovery of [false, true]) {
    await withScenario({}, async ({ makeSession, harness }) => {
      const store = require(path.join(AI_ROOT, 'lib', 'media', 'image', 'image-store.js'))
      const vision = require(path.join(AI_ROOT, 'lib', 'media', 'image', 'vision.js'))
      const chat = require(path.join(AI_ROOT, 'lib', 'chat.js'))
      const session = makeSession({ messageId: 'vision-continuation', content: '<img src="https://example.test/continue.jpg"/>', event: { message: [{ type: 'image', data: { url: 'https://example.test/continue.jpg' } }] } })
      await store.storeImageUrl('10001', session.messageId, 'https://example.test/continue.jpg', '')
      await store.cacheImageFile('10001', session.messageId, ONE_PIXEL_PNG)
      vision.prepareVisionRequest(session, { hasVisual: true }, { allowCurrentMessage: true })
      const initial = recovery ? { content: '<tool_call>{}</tool_call>' } : { content: null, tool_calls: [{ id: 'time-check', type: 'function', function: { name: 'get_current_time', arguments: '{}' } }] }
      const mocked = mockFetch([
        { json: { choices: [{ message: initial }] } },
        { json: { choices: [{ message: { content: '<image_fact>图片中是一只猫。</image_fact>这是一只猫。' } }] } },
      ])
      await withFetch(mocked, async () => {
        await chat.chat(session, '请看图回答', harness.ctx)
        t.check(`scenario raw image ${recovery ? 'recovery' : 'tool continuation'} keeps vision routing`, mocked.calls.length === 2 && mocked.calls.every(call => call.requestBody?.model === 'glm-4.6v-flash'), JSON.stringify(mocked.calls))
      })
    })
  }

  for (const chosen of ['current', 'quoted']) {
    await withScenario({}, async ({ makeSession, run }) => {
      const store = require(path.join(AI_ROOT, 'lib', 'media', 'image', 'image-store.js'))
      const queue = require(path.join(AI_ROOT, 'lib', 'media', 'backpressure', 'media-queue.js'))
      for (const id of ['current', 'quoted']) await store.storeImageUrl('10001', id, `https://example.test/${id}.jpg`, `${id}-file`)
      const mocked = mockFetch([
        { json: { choices: [{ message: { content: null, tool_calls: [{ id: 'choose-image', type: 'function', function: { name: 'analyze_historical_image', arguments: JSON.stringify({ messageId: chosen, question: '请读选定图片的文字', force: true }) } }] } }] } },
        { json: { choices: [{ message: { content: '正在查看你指的那张图片，稍后再问。' } }] } },
      ])
      const session = makeSession({ messageId: 'current', content: '<at id="90000"/> 请看我指的那一张 <img src="https://example.test/current.jpg" file="current-file"/>', quote: { messageId: 'quoted', content: '<img src="https://example.test/quoted.jpg"/>' }, event: { message: [{ type: 'image', data: { url: 'https://example.test/current.jpg', file: 'current-file' } }] } })
      await withFetch(mocked, async () => {
        await run(session, { flushTicks: 120 })
        await session.waitForSend(() => true)
        const tasks = queue.listPendingMediaTasks('media_image_analysis', 10)
        t.check(`scenario simultaneous images selects ${chosen} original ID only`, tasks.length === 1 && tasks[0].messageId === chosen, JSON.stringify(tasks))
        t.check(`scenario simultaneous images never recognizes current image before selecting ${chosen}`, mocked.calls.every(call => call.requestBody?.model !== 'glm-4.6v-flash' && !(call.requestBody?.messages || []).some(message => Array.isArray(message.content) && message.content.some(part => part.type === 'image_url'))), JSON.stringify(mocked.calls))
        const prompt = JSON.stringify(mocked.calls[0]?.requestBody?.messages || [])
        t.check(`scenario simultaneous images exposes both stable candidates for ${chosen}`, prompt.includes('当前图片编号为 current') && prompt.includes('引用图片编号为 quoted'), prompt)
      })
    })
  }

  await withScenario({}, async ({ makeSession, run }) => {
    const store = require(path.join(AI_ROOT, 'lib', 'media', 'image', 'image-store.js'))
    await store.storeImageUrl('10001', 'quoted-old', 'https://example.test/old.jpg', 'old-file')
    const mocked = mockFetch([{ json: { choices: [{ message: { content: '现在回答你的文字问题。' } }] } }])
    await withFetch(mocked, async () => {
      const session = makeSession({ content: '<at id="90000"/> 今天星期几', quote: { messageId: 'quoted-old', content: '<img src="https://example.test/old.jpg"/>' } })
      await run(session, { flushTicks: 120 })
      await session.waitForSend(() => true)
      t.check('scenario unrelated text with quoted image never auto attaches original', mocked.calls.length === 1 && mocked.calls[0].requestBody.model === 'deepseek-v4-flash', JSON.stringify(mocked.calls))
      const queue = require(path.join(AI_ROOT, 'lib', 'media', 'backpressure', 'media-queue.js'))
      t.check('scenario unrelated text with quoted image creates zero image analysis tasks', queue.listPendingMediaTasks('media_image_analysis', 10).length === 0)
    })
  })

  await withScenario({}, async ({ makeSession, harness }) => {
    const store = require(path.join(AI_ROOT, 'lib', 'media', 'image', 'image-store.js'))
    const vision = require(path.join(AI_ROOT, 'lib', 'media', 'image', 'vision.js'))
    const chat = require(path.join(AI_ROOT, 'lib', 'chat.js'))
    const tools = require(path.join(AI_ROOT, 'lib', 'chat', 'chat-tools.js'))
    await store.storeImageUrl('10001', 'summary-image', 'https://example.test/summary.jpg', 'summary-file')
    await store.markAnalyzed('10001', 'summary-image', '图片中是一只猫。')
    const session = makeSession({ messageId: 'summary-image', content: '<img src="https://example.test/summary.jpg"/>', event: { message: [{ type: 'image', data: { url: 'https://example.test/summary.jpg' } }] } })
    vision.prepareVisionRequest(session, { hasVisual: true }, { allowCurrentMessage: true })
    const mocked = mockFetch([{ json: { choices: [{ message: { content: '是一只猫。' } }] } }])
    await withFetch(mocked, async () => {
      await chat.chat(session, '图里是什么', harness.ctx)
      t.check('scenario objective summary reuse sends text only without another vision request', mocked.calls.length === 1 && mocked.calls[0].requestBody.model === 'deepseek-v4-flash', JSON.stringify(mocked.calls))
    })
    await tools.executeChatTool({ function: { name: 'analyze_historical_image', arguments: JSON.stringify({ messageId: 'summary-image', question: '右下角小字完整写了什么', force: true }) } }, { channelKey: '10001' })
    const queue = require(path.join(AI_ROOT, 'lib', 'media', 'backpressure', 'media-queue.js'))
    const tasks = queue.listPendingMediaTasks('media_image_analysis', 10)
    t.check('scenario detail demand bypasses short summary and preserves original question', tasks.length === 1 && tasks[0].payload.imageDemand.force === true && tasks[0].payload.imageDemand.question === '右下角小字完整写了什么', JSON.stringify(tasks))
    const pendingEntry = await store.getImageEntry('10001', 'summary-image')
    t.check('scenario queued detail demand preserves known objective summary', pendingEntry?.analysis === '图片中是一只猫。' && pendingEntry?.analysisStatus === 'pending', JSON.stringify(pendingEntry))
    queue.completeMediaTask(queue.claimNextMediaTask('scenario-detail', 'media_image_analysis'), { ok: true, analysis: '右下角小字完整写着“欢迎光临”。' })
    const completedDetail = await tools.executeChatTool({ function: { name: 'analyze_historical_image', arguments: JSON.stringify({ messageId: 'summary-image', question: '右下角小字完整写了什么', force: true }) } }, { channelKey: '10001' })
    t.check('scenario repeat completed detail demand returns exact result instead of queue notice', String(completedDetail).includes('欢迎光临') && !String(completedDetail).includes('已进入'), String(completedDetail))
    const denied = await tools.executeChatTool({ function: { name: 'analyze_historical_image', arguments: '{"messageId":"summary-image"}' } }, { channelKey: '10001', randomTriggered: true, selectedImageMessageId: 'another-image' })
    t.check('scenario random image permission rejects a different historical target', String(denied).includes('只能读取当前选定'), String(denied))
    const definitions = tools.getChatToolDefinitions({ randomTriggered: true })
    t.check('scenario random text turn exposes no image traversal tools', !definitions.some(tool => ['read_image_history', 'analyze_historical_image'].includes(tool.function.name)), JSON.stringify(definitions))
  })
}

// 多图无法按共享消息编号选中一张；明确邀请必须澄清，不能静默或先识别首图。
async function runAmbiguousCurrentImages(t) {
  for (const isPrivate of [true, false]) {
    await withScenario({}, async ({ ready, makeSession, run }) => {
      await ready()
      const mocked = mockFetch([])
      const session = makeSession({
        ...(isPrivate ? { isDirect: true, guildId: undefined } : {}),
        messageId: `ambiguous-${isPrivate ? 'private' : 'mention'}`,
        content: `${isPrivate ? '' : '<at id="90000"/>'}<img src="https://example.test/a.jpg"/><img src="https://example.test/b.jpg"/>`,
        event: { message: { elements: [
          { type: 'img', attrs: { src: 'https://example.test/a.jpg' } },
          { type: 'img', attrs: { src: 'https://example.test/b.jpg' } },
        ] } },
      })
      await withFetch(mocked, async () => {
        const result = await run(session, { flushTicks: 60 })
        t.check(`scenario ${isPrivate ? 'private' : 'explicit'} pure multi-image invitation asks for unique target`, result.sent.some(message => String(message).includes('多张图片')), JSON.stringify(result.sent))
        t.check(`scenario ${isPrivate ? 'private' : 'explicit'} pure multi-image invitation never recognizes first image`, mocked.calls.length === 0, JSON.stringify(mocked.calls))
      })
    })
  }
}

module.exports = { run: async t => { await run(t); await runAllowedImageInvitations(t); await runImageTargetSelection(t); await runAmbiguousCurrentImages(t) } }
