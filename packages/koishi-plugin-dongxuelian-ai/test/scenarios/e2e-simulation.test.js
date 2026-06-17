/**
 * 模拟端到端测试：不依赖 NapCat 登录，使用 fake Koishi + fake session
 * 模拟 NapCat 已经把消息交给 Koishi，真实跑插件 middleware 链
 *
 * 命名约定：mocked HTTP 表示 mock 了 fetch，不能叫真实链路。
 * 核心防线：每条测试必须断言不包含 "Agent 未获取"、不泄漏 reasoning。
 */
const path = require('path')
const { withScenario } = require('./_setup')
const { AI_ROOT } = require('../fake/file')
const { mockFetch } = require('../fake/fetch')

function atBot(session, content) {
  return `<at id="${session.selfId}"/> ${content}`
}

async function withFetch(mocked, fn) {
  const originalFetch = global.fetch
  const originalWarn = console.warn
  global.fetch = mocked.fetch
  console.warn = () => {}
  try { return await fn() } finally {
    global.fetch = originalFetch
    console.warn = originalWarn
  }
}

function assertNoEmptyAgentReply(t, label, replyText) {
  t.check(`${label} does not return empty agent reply`,
    !replyText.includes('Agent 未获取') && !replyText.includes('Agent 调用模型失败'),
    replyText.slice(0, 300))
}

function assertNoReasoningLeak(t, label, replyText) {
  t.check(`${label} does not leak reasoning`,
    !replyText.includes('reasoning_content') && !replyText.includes('内部推理') &&
    !replyText.includes('我应该先分析') && !replyText.includes('我得看看'),
    replyText.slice(0, 300))
}

function assertNoPromptLeak(t, label, replyText) {
  t.check(`${label} does not leak prompt/cache markers`,
    !replyText.includes('这是你在本群的发言') && !replyText.includes('昵称：') &&
    !replyText.includes('[内部参考') && !replyText.includes('[群聊刷到'),
    replyText.slice(0, 300))
}

// 静默受理契约：触发搜索/Agent 队列后，入口绝不向用户发占位垃圾话。
// 用户原始 bug 就是 "我先去后台查一下，拿到可靠结果再说" 与 "完成后会自动发回结果" 这类占位回复，
// 真正结果由 worker 完成后经 notifier→chat 人格转述发回，入口阶段保持沉默。
function assertSilentQueueNoPlaceholder(t, label, sentMessages) {
  const joined = (Array.isArray(sentMessages) ? sentMessages : [sentMessages]).join(' ')
  t.check(`${label} entry stays silent (no placeholder garbage)`,
    !joined.includes('拿到可靠结果再说') && !joined.includes('完成后会自动发回结果') &&
    !joined.includes('我先去后台查一下') && !joined.includes('Agent 未获取'),
    JSON.stringify({ sent: sentMessages }))
}

function listE2eAgentTasks(statuses = ['pending', 'claiming', 'running', 'deferred', 'failed', 'done']) {
  const taskStore = require(path.join(AI_ROOT, 'lib', 'resource-workers', 'task-store.js'))
  return taskStore.listResourceTasks({ statuses, limit: 50 }).filter(task => task.kind === 'agent_task')
}

function getE2eAgentWorkerParts(task = {}) {
  const payload = task.payload || {}
  const agentWorker = payload.agentWorker || {}
  const engineInput = agentWorker.engineInput || {}
  return { payload, agentWorker, engineInput }
}

function findSerializedMatchPaths(value, needle, base = '', result = []) {
  if (value == null) return result
  if (typeof value === 'string') {
    if (value.includes(needle)) result.push(base)
    return result
  }
  if (typeof value !== 'object') return result
  if (Array.isArray(value)) {
    value.forEach((item, index) => findSerializedMatchPaths(item, needle, `${base}[${index}]`, result))
    return result
  }
  for (const [key, item] of Object.entries(value)) findSerializedMatchPaths(item, needle, base ? `${base}.${key}` : key, result)
  return result
}

function containsSecretLikeText(text = '') {
  return /\bsk-[A-Za-z0-9][A-Za-z0-9._-]{5,}\b/.test(String(text || '')) || /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/i.test(String(text || ''))
}

const DEFAULT_TOOL_CONFIG = {
  channels: {
    qq: { enabled: true, tools: { get_current_time: true, calculate: true, web_search: true, web_fetch: true } },
    dashboard: { enabled: true, tools: {} },
  },
  autoRoute: { qq: { enabled: false }, dashboard: { enabled: false } },
  dangerousPolicy: 'confirm',
  enabledSkills: [],
  readFileRoots: [],
}

async function run(t) {
  t.section('scenario: simulated end-to-end agent chain (mocked HTTP)')

  // === 失败场景优先：真实失败输入再现 ===

  // 失败 1：短消息 "莲" 不应误进 Agent 空回复
  await withScenario({}, async ({ makeSession, run, data }) => {
    const mocked = mockFetch([
      { json: { choices: [{ message: { content: '嗨' } }] } },
    ])
    await withFetch(mocked, async () => {
      data.writeJson('ai-tool-config.json', DEFAULT_TOOL_CONFIG)
      const session = makeSession({ userId: 'fail-user', guildId: '10001', channelId: '10001', selfId: '90000' })
      session.content = atBot(session, '莲')
      const result = await run(session, { flushTicks: 120 })
      await session.waitForSend(() => true, 5000)
      const replyText = session.sent.join(' ')
      assertNoEmptyAgentReply(t, 'short casual "莲"', replyText)
      assertNoReasoningLeak(t, 'short casual "莲"', replyText)
    })
  })

  // 失败 2：短消息 "你好" 不应误进 Agent 空回复
  await withScenario({}, async ({ makeSession, run, data }) => {
    const mocked = mockFetch([
      { json: { choices: [{ message: { content: '你好呀' } }] } },
    ])
    await withFetch(mocked, async () => {
      data.writeJson('ai-tool-config.json', DEFAULT_TOOL_CONFIG)
      const session = makeSession({ userId: 'fail-user', guildId: '10001', channelId: '10001', selfId: '90000' })
      session.content = atBot(session, '你好')
      const result = await run(session, { flushTicks: 120 })
      await session.waitForSend(() => true, 5000)
      const replyText = session.sent.join(' ')
      assertNoEmptyAgentReply(t, 'short casual "你好"', replyText)
      t.check('casual "你好" uses single call (no Agent)', mocked.calls.length === 1, `calls=${mocked.calls.length}`)
    })
  })

  // 失败 3：auto route 关闭时不应走 Agent
  await withScenario({}, async ({ makeSession, run, data }) => {
    const mocked = mockFetch([
      { json: { choices: [{ message: { content: '现在是下午 2 点' } }] } },
    ])
    await withFetch(mocked, async () => {
      data.writeJson('ai-tool-config.json', DEFAULT_TOOL_CONFIG)
      const session = makeSession({ userId: 'fail-user', guildId: '10001', channelId: '10001', selfId: '90000' })
      session.content = atBot(session, '现在几点了')
      const result = await run(session, { flushTicks: 120 })
      await session.waitForSend(() => true, 5000)
      const replyText = session.sent.join(' ')
      assertNoEmptyAgentReply(t, 'auto route off time query', replyText)
      t.check('auto route off uses single call (no Agent)', mocked.calls.length === 1, `calls=${mocked.calls.length}`)
    })
  })

  // 失败 4：模型返回空 content（无 reasoning、无 tool_calls）→ 不应空回复
  await withScenario({}, async ({ makeSession, run, data }) => {
    const mocked = mockFetch([
      { json: { choices: [{ message: { content: '' } }] } },
    ])
    await withFetch(mocked, async () => {
      data.writeJson('ai-tool-config.json', DEFAULT_TOOL_CONFIG)
      const session = makeSession({ userId: 'fail-user', guildId: '10001', channelId: '10001', selfId: '90000' })
      session.content = atBot(session, '讲个笑话')
      const result = await run(session, { flushTicks: 120 })
      await session.waitForSend(() => true, 5000)
      const replyText = session.sent.join(' ')
      assertNoEmptyAgentReply(t, 'empty content response', replyText)
    })
  })

  // 失败 5：当前性问题可能被 S2 Agent 队列接走；入口不应泄漏 reasoning 也不应空回复
  await withScenario({}, async ({ makeSession, run, data }) => {
    const mocked = mockFetch([
      { json: { choices: [{ message: { content: '', reasoning_content: '我得看看现在是什么情况再回复' } }] } },
      { json: { choices: [{ message: { content: '好的' } }] } },
    ])
    await withFetch(mocked, async () => {
      data.writeJson('ai-tool-config.json', DEFAULT_TOOL_CONFIG)
      const session = makeSession({ userId: 'fail-user', guildId: '10001', channelId: '10001', selfId: '90000' })
      session.content = atBot(session, '今天怎么样')
      const result = await run(session, { flushTicks: 120 })
      const replyText = session.sent.join(' ')
      assertNoEmptyAgentReply(t, 'reasoning-only fallback', replyText)
      assertNoReasoningLeak(t, 'reasoning-only fallback', replyText)
      // 静默契约：当前性问题被 chat-heavy-tool 静默入队时，入口不发占位话；
      // 若没入队而是普通聊天回复，则该回复也不能是占位垃圾话。
      assertSilentQueueNoPlaceholder(t, 'reasoning-only current query', session.sent)
    })
  })

  // === 正路测试（mocked 模型 + 真实工具路径） ===

  // 正路 0：真实私聊搜索请求 → S2 Agent 队列接管，不在入口泄漏 prompt 或密钥
  await withScenario({}, async ({ makeSession, run, data }) => {
    const mocked = mockFetch([
      { json: { choices: [{ message: { content: '我先按搞笑向搜了一轮。' } }] } },
      { json: { choices: [{ message: { content: '那先看搞笑向的。' } }] } },
      { json: { choices: [{ message: { content: '### Agent raw report\nAuthorization: Bearer sk-secret-e2e-123456789\nsystem prompt: 切换成默认东雪莲\n**secret-context**' } }] } },
      { json: { choices: [{ message: { content: '长离语气：我给你挑了几个搞笑向视频。' } }] } },
    ])
    await withFetch(mocked, async () => {
      const webSearch = require(path.join(AI_ROOT, 'lib', 'agent', 'tools', 'web-search.js'))
      const originalExecute = webSearch.execute
      const searchCalls = []
      webSearch.execute = async (params = {}) => {
        searchCalls.push(params)
        return '已搜索：我的世界 搞笑视频 热门 推荐\n搜索状态：usable_hit\n【来源 1】标题：Minecraft Funny Moments\nURL：https://example.com/minecraft-funny\n正文质量：usable\n正文：这里列出几个近期热门搞笑视频片段。Authorization: Bearer sk-tool-secret-123456789'
      }
      try {
        data.writeText('ai-skills/personas/SKILL.changli.md', [
          '---',
          'name: 长离',
          'description: e2e Changli persona',
          '---',
          'CHANGLI_E2E_MARKER',
        ].join('\n'))
        data.writeJson('ai-persona-users.json', { e2e_private: '长离' })
        require(path.join(AI_ROOT, 'lib', 'persona', 'persona.js')).loadPersonaUsers()
        data.writeJson('ai-tool-config.json', DEFAULT_TOOL_CONFIG)
        const session = makeSession({
          userId: 'e2e_private',
          author: { id: 'e2e_private', name: '水落烟雨', nick: '水落烟雨' },
          guildId: '',
          channelId: 'private-e2e',
          selfId: '90000',
          isDirect: true,
        })
        session.content = '我想看我的世界的搞笑视频'
        await run(session, { flushTicks: 120 })
        const replyText = session.sent.join(' ')
        assertSilentQueueNoPlaceholder(t, 'mocked private search', session.sent)
        t.check('mocked private search queues without entry web_search', searchCalls.length === 0 && mocked.calls.length === 0, JSON.stringify({ searchCalls, calls: mocked.calls.length }))
        const privateChannelKey = 'private:e2e_private'
        const tasks = listE2eAgentTasks()
        const task = tasks.find(item =>
          item && item.channelKey === privateChannelKey && item.userId === 'e2e_private' &&
          item.payload && item.payload.entry === 'qq-auto-route' && item.payload.reason === 'general-search-intent'
        ) || {}
        const { payload, agentWorker, engineInput } = getE2eAgentWorkerParts(task)
        t.check('mocked private search stores S2 agent task', tasks.length === 1 && payload.entry === 'qq-auto-route' && payload.reason === 'general-search-intent' && agentWorker.action === 'run', JSON.stringify(tasks))
        const preExecute = Array.isArray(engineInput.preExecuteTools) ? engineInput.preExecuteTools : []
        t.check('mocked private search preserves query in worker payload', engineInput.agentMode === true && preExecute.some(item => item && item.name === 'web_search' && JSON.stringify(item.args || {}).includes('我的世界')), JSON.stringify(engineInput))
        const serializedTask = JSON.stringify(task)
        t.check('mocked private search redacts secrets before queue', !serializedTask.includes('sk-tool-secret') && !serializedTask.includes('sk-secret-e2e') && !serializedTask.includes('CHANGLI_E2E_MARKER') && !containsSecretLikeText(replyText), JSON.stringify({
          skToolPaths: findSerializedMatchPaths(task, 'sk-tool-secret'),
          skSecretPaths: findSerializedMatchPaths(task, 'sk-secret-e2e'),
          markerPaths: findSerializedMatchPaths(task, 'CHANGLI_E2E_MARKER'),
          replyHasSecretLikeText: containsSecretLikeText(replyText),
          sample: serializedTask.slice(0, 500),
        }))
        assertNoEmptyAgentReply(t, 'mocked private contextual search', replyText)
        assertNoReasoningLeak(t, 'mocked private contextual search', replyText)
        assertNoPromptLeak(t, 'mocked private contextual search', replyText)
      } finally {
        webSearch.execute = originalExecute
      }
    })
  })

  // 正路 0.25：多话题私聊中的省略追问 → 只继承同类上下文，避免乱感知
  await withScenario({}, async ({ makeSession, run, data }) => {
    const mocked = mockFetch([])
    await withFetch(mocked, async () => {
      const webSearch = require(path.join(AI_ROOT, 'lib', 'agent', 'tools', 'web-search.js'))
      const originalExecute = webSearch.execute
      const searchCalls = []
      webSearch.execute = async (params = {}) => {
        searchCalls.push(params)
        return [
          `已搜索：${params.query || ''}`,
          '搜索状态：usable_hit',
          '正文质量：usable',
          '正文：上下文选择测试证据。',
        ].join('\n')
      }
      try {
        data.writeJson('ai-tool-config.json', DEFAULT_TOOL_CONFIG)
        const session = makeSession({
          userId: 'e2e_context',
          author: { id: 'e2e_context', name: '水落烟雨', nick: '水落烟雨' },
          guildId: '',
          channelId: 'private-context-e2e',
          selfId: '90000',
          isDirect: true,
        })
        const searchContext = require(path.join(AI_ROOT, 'lib', 'routing', 'search-context.js'))
        const now = Date.now()
        const interruptedContext = searchContext.buildPrivateSearchContext(session, [
          { role: 'user', content: '杭州今天气温多少', ts: now - 20 * 60 * 1000 },
          { role: 'user', content: '我想看我的世界的搞笑视频', ts: now - 5 * 60 * 1000 },
        ], { currentText: '那明天呢', now })
        t.check('mocked private refinement interrupted by another topic stays in chat gate', interruptedContext.searchReadiness === 'needs_chat_handling' && !interruptedContext.queryCandidate, JSON.stringify(interruptedContext))
        t.check('mocked private refinement context does not call model or search in gate check', mocked.calls.length === 0 && searchCalls.length === 0 && session.sent.length === 0, JSON.stringify({ calls: mocked.calls.length, searchCalls, sent: session.sent }))
      } finally {
        webSearch.execute = originalExecute
      }
    })
  })

  // 正路 0.5：群聊自然问热门/推荐，也应走真实搜索工具，而不是只暴露 Chat 工具提示
  await withScenario({}, async ({ makeSession, run, data }) => {
    const mocked = mockFetch([
      { json: { choices: [{ message: { content: '别只看标题，挑正文读到的那几个。' } }] } },
      { json: { choices: [{ message: { content: '群聊转述：有几个近期热度不错的教程和整活视频。' } }] } },
    ])
    await withFetch(mocked, async () => {
      const webSearch = require(path.join(AI_ROOT, 'lib', 'agent', 'tools', 'web-search.js'))
      const originalExecute = webSearch.execute
      const searchCalls = []
      webSearch.execute = async (params = {}) => {
        searchCalls.push(params)
        return '已搜索：最近比较火的视频 推荐\n搜索状态：usable_hit\n【来源 1】标题：热门视频合集\nURL：https://example.com/videos\n正文质量：usable\n正文：近期有人讨论教程、整活、挑战视频。'
      }
      try {
        data.writeJson('ai-tool-config.json', DEFAULT_TOOL_CONFIG)
        const session = makeSession({ userId: 'group-user', guildId: '10001', channelId: '10001', selfId: '90000' })
        session.content = atBot(session, '最近有什么比较火的视频，给我推荐几个')
        await run(session, { flushTicks: 160 })
        const replyText = session.sent.join(' ')
        assertSilentQueueNoPlaceholder(t, 'mocked group fuzzy search', session.sent)
        t.check('mocked group fuzzy search queues without entry web_search', searchCalls.length === 0 && mocked.calls.length === 0, JSON.stringify({ searchCalls, calls: mocked.calls.length }))
        const tasks = listE2eAgentTasks()
        const task = tasks[0] || {}
        const { payload, agentWorker, engineInput } = getE2eAgentWorkerParts(task)
        t.check('mocked group fuzzy search stores S2 agent task', tasks.length === 1 && payload.entry === 'qq-auto-route' && payload.reason === 'general-search-intent' && agentWorker.action === 'run', JSON.stringify(tasks))
        const preExecute = Array.isArray(engineInput.preExecuteTools) ? engineInput.preExecuteTools : []
        t.check('mocked group fuzzy search preserves search query', engineInput.agentMode === true && preExecute.some(item => item && item.name === 'web_search' && /比较火|视频|推荐/.test(JSON.stringify(item.args || {}))), JSON.stringify(engineInput))
        assertNoEmptyAgentReply(t, 'mocked group fuzzy search', replyText)
        assertNoPromptLeak(t, 'mocked group fuzzy search', replyText)
      } finally {
        webSearch.execute = originalExecute
      }
    })
  })

  // 正路 1：显式 web_search 请求 → S2 Agent 队列
  await withScenario({}, async ({ makeSession, run, data }) => {
    const mocked = mockFetch([
      { json: { choices: [{ message: { content: '', tool_calls: [{ id: 'tc1', type: 'function', function: { name: 'web_search', arguments: '{"query":"鸣潮最新角色"}' } }] } }] } },
      { json: { choices: [{ message: { content: '根据搜索结果，鸣潮最新角色是绯雪。' } }] } },
      { json: { choices: [{ message: { content: '绯雪是鸣潮最新角色。' } }] } },
    ])
    await withFetch(mocked, async () => {
      const webSearch = require(path.join(AI_ROOT, 'lib', 'agent', 'tools', 'web-search.js'))
      const originalExecute = webSearch.execute
      const searchCalls = []
      webSearch.execute = async (params = {}) => {
        searchCalls.push(params)
        return '已搜索：鸣潮 最新角色\n搜索结果：\n1. 官方公告\n   https://kurogames.com/news\n   可信度分：100\n   绯雪与达妮娅'
      }
      try {
        data.writeJson('ai-tool-config.json', {
          ...DEFAULT_TOOL_CONFIG,
          autoRoute: { qq: { enabled: true }, dashboard: { enabled: false } },
        })
        const session = makeSession({ userId: 'ok-user', guildId: '10001', channelId: '10001', selfId: '90000' })
        session.content = atBot(session, '调用web_search查鸣潮最新角色是谁')
        const result = await run(session, { flushTicks: 120 })
        const replyText = session.sent.join(' ')
        assertSilentQueueNoPlaceholder(t, 'mocked explicit search', session.sent)
        assertNoEmptyAgentReply(t, 'mocked explicit search', replyText)
        assertNoReasoningLeak(t, 'mocked explicit search', replyText)
        t.check('mocked explicit search does not execute search in entry process', searchCalls.length === 0 && mocked.calls.length === 0, JSON.stringify({ searchCalls, calls: mocked.calls.length }))
        const tasks = listE2eAgentTasks()
        const task = tasks[0] || {}
        const { payload, agentWorker, engineInput } = getE2eAgentWorkerParts(task)
        t.check('mocked explicit search stores S2 agent task', tasks.length === 1 && payload.entry === 'qq-auto-route' && payload.reason === 'explicit-tool-request' && agentWorker.action === 'run', JSON.stringify(tasks))
        const preExecute = Array.isArray(engineInput.preExecuteTools) ? engineInput.preExecuteTools : []
        t.check('mocked explicit search payload preserves web_search', Array.isArray(engineInput.forceTools) && engineInput.forceTools.includes('web_search') && preExecute.some(item => item && item.name === 'web_search' && JSON.stringify(item.args || {}).includes('鸣潮')), JSON.stringify(engineInput))
      } finally {
        webSearch.execute = originalExecute
      }
    })
  })

  // 正路 2：Agent auto route 打开 → 时间查询 → Agent 工具链 → 转述
  await withScenario({}, async ({ makeSession, run, data }) => {
    const mocked = mockFetch([
      { json: { choices: [{ message: { content: '', tool_calls: [{ id: 'tc-time', type: 'function', function: { name: 'get_current_time', arguments: '{}' } }] } }] } },
      { json: { choices: [{ message: { content: '现在是 14:30。' } }] } },
      { json: { choices: [{ message: { content: '14点30分。' } }] } },
    ])
    await withFetch(mocked, async () => {
      data.writeJson('ai-tool-config.json', {
        ...DEFAULT_TOOL_CONFIG,
        autoRoute: { qq: { enabled: true }, dashboard: { enabled: false } },
      })
      const session = makeSession({ userId: 'ok-user', guildId: '10001', channelId: '10001', selfId: '90000' })
      session.content = atBot(session, '现在几点了')
      const result = await run(session, { flushTicks: 120 })
      await session.waitForSend(() => true, 10000)
      const replyText = session.sent.join(' ')
      t.check('mocked auto route sends reply', session.sent.length > 0)
      assertNoEmptyAgentReply(t, 'mocked auto route time', replyText)
      const hasTools = mocked.calls[0]?.requestBody?.tools?.length > 0
      t.check('mocked auto route has tools', hasTools)
    })
  })

  // 正路 3：mocked HTTP 搜索提取路径现在由 S2 worker 执行，入口只入队
  await withScenario({}, async ({ makeSession, run, data }) => {
    const mocked = mockFetch([
      { json: { choices: [{ message: { content: '', tool_calls: [{ id: 'tc1', type: 'function', function: { name: 'web_search', arguments: '{"query":"测试搜索"}' } }] } }] } },
      { json: { choices: [{ message: { content: '搜索完成。' } }] } },
      { json: { choices: [{ message: { content: '搜索结果已获取。' } }] } },
    ])
    await withFetch(mocked, async () => {
      const originalFetch = global.fetch
      global.fetch = async (url, options) => {
        if (options && options.method === 'POST') return mocked.fetch(url, options)
        return { ok: true, async text() { return '<html><body><a href="https://example.com/result">搜索结果标题</a><div>摘要内容</div></body></html>' } }
      }
      try {
        data.writeJson('ai-tool-config.json', {
          ...DEFAULT_TOOL_CONFIG,
          autoRoute: { qq: { enabled: true }, dashboard: { enabled: false } },
        })
        const session = makeSession({ userId: 'ok-user', guildId: '10001', channelId: '10001', selfId: '90000' })
        session.content = atBot(session, '调用web_search查测试搜索')
        const result = await run(session, { flushTicks: 120 })
        const replyText = session.sent.join(' ')
        assertSilentQueueNoPlaceholder(t, 'mocked http extraction', session.sent)
        assertNoEmptyAgentReply(t, 'mocked http extraction', replyText)
        assertNoReasoningLeak(t, 'mocked http extraction', replyText)
        const tasks = listE2eAgentTasks()
        const task = tasks[0] || {}
        const { payload, agentWorker, engineInput } = getE2eAgentWorkerParts(task)
        const searchReasons = new Set(['explicit-tool-request', 'general-search-intent'])
        t.check('mocked http extraction stores S2 agent task', tasks.length === 1 && payload.entry === 'qq-auto-route' && searchReasons.has(payload.reason) && agentWorker.action === 'run', JSON.stringify(tasks))
        const preExecute = Array.isArray(engineInput.preExecuteTools) ? engineInput.preExecuteTools : []
        t.check('mocked http extraction payload preserves query', preExecute.some(item => item && item.name === 'web_search' && JSON.stringify(item.args || {}).includes('测试搜索')), JSON.stringify(engineInput))
      } finally {
        global.fetch = originalFetch
      }
    })
  })

  // 正路 4：Agent rounds 数据结构验证
  await withScenario({}, async ({ makeSession, run, data }) => {
    const mocked = mockFetch([
      { json: { choices: [{ message: { content: '', reasoning_content: '用户问时间', tool_calls: [{ id: 'tc1', type: 'function', function: { name: 'get_current_time', arguments: '{}' } }] } }] } },
      { json: { choices: [{ message: { content: '现在是 14:30。' } }] } },
      { json: { choices: [{ message: { content: '14:30。' } }] } },
    ])
    await withFetch(mocked, async () => {
      data.writeJson('ai-tool-config.json', {
        ...DEFAULT_TOOL_CONFIG,
        autoRoute: { qq: { enabled: true }, dashboard: { enabled: false } },
      })
      const session = makeSession({ userId: 'ok-user', guildId: '10001', channelId: '10001', selfId: '90000' })
      session.content = atBot(session, '现在几点了')
      const result = await run(session, { flushTicks: 120 })
      await session.waitForSend(() => true, 10000)
      const replyText = session.sent.join(' ')
      assertNoReasoningLeak(t, 'rounds data reasoning not leaked', replyText)
    })
  })

  // === 坏路测试 ===

  // 坏路 1：模型返回 tool_calls 后第二轮空回复 → 转述兜底
  await withScenario({}, async ({ makeSession, run, data }) => {
    const mocked = mockFetch([
      { json: { choices: [{ message: { content: '', tool_calls: [{ id: 'tc1', type: 'function', function: { name: 'get_current_time', arguments: '{}' } }] } }] } },
      { json: { choices: [{ message: { content: '' } }] } },
      { json: { choices: [{ message: { content: '暂时没有结果。' } }] } },
    ])
    await withFetch(mocked, async () => {
      data.writeJson('ai-tool-config.json', {
        ...DEFAULT_TOOL_CONFIG,
        autoRoute: { qq: { enabled: true }, dashboard: { enabled: false } },
      })
      const session = makeSession({ userId: 'fail-user', guildId: '10001', channelId: '10001', selfId: '90000' })
      session.content = atBot(session, '现在几点了')
      const result = await run(session, { flushTicks: 120 })
      await session.waitForSend(() => true, 5000)
      const replyText = session.sent.join(' ')
      // 即使第二轮空回复，也不应该发送空兜底
      assertNoEmptyAgentReply(t, 'tool call then empty reply', replyText)
    })
  })

  // 坏路 2：web_search 返回失败结果由 worker 处理；入口不应编造答案或泄漏
  await withScenario({}, async ({ makeSession, run, data }) => {
    const mocked = mockFetch([
      { json: { choices: [{ message: { content: '', tool_calls: [{ id: 'tc1', type: 'function', function: { name: 'web_search', arguments: '{"query":"未知查询"}' } }] } }] } },
      { json: { choices: [{ message: { content: '这次搜索没有拿到可靠结果。' } }] } },
      { json: { choices: [{ message: { content: '搜索失败' } }] } },
    ])
    await withFetch(mocked, async () => {
      const webSearch = require(path.join(AI_ROOT, 'lib', 'agent', 'tools', 'web-search.js'))
      const originalExecute = webSearch.execute
      const searchCalls = []
      webSearch.execute = async (params = {}) => {
        searchCalls.push(params)
        return '搜索失败：未提取到有效搜索结果。'
      }
      try {
        data.writeJson('ai-tool-config.json', {
          ...DEFAULT_TOOL_CONFIG,
          autoRoute: { qq: { enabled: true }, dashboard: { enabled: false } },
        })
        const session = makeSession({ userId: 'fail-user', guildId: '10001', channelId: '10001', selfId: '90000' })
        session.content = atBot(session, '调用web_search查不存在的东西')
        const result = await run(session, { flushTicks: 120 })
        const replyText = session.sent.join(' ')
        assertSilentQueueNoPlaceholder(t, 'search failure response', session.sent)
        assertNoEmptyAgentReply(t, 'search failure response', replyText)
        const tasks = listE2eAgentTasks()
        t.check('search failure is deferred without fabricating final answer', searchCalls.length === 0 && mocked.calls.length === 0 && tasks.length === 1 && !replyText.includes('绯雪') && !replyText.includes('编造'), JSON.stringify({ replyText, searchCalls, tasks: tasks.length }))
      } finally {
        webSearch.execute = originalExecute
      }
    })
  })
}

module.exports = { run }
