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

const DEFAULT_TOOL_CONFIG = {
  channels: {
    qq: { enabled: true, tools: { get_current_time: true, calculate: true, web_search: true } },
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

  // 失败 5：reasoning-only 响应 → 不应泄漏 reasoning 也不应空回复
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
      await session.waitForSend(() => true, 5000)
      const replyText = session.sent.join(' ')
      assertNoEmptyAgentReply(t, 'reasoning-only fallback', replyText)
      assertNoReasoningLeak(t, 'reasoning-only fallback', replyText)
      t.check('reasoning-only used fallback call', mocked.calls.length >= 2, `calls=${mocked.calls.length}`)
    })
  })

  // === 正路测试（mocked 模型 + 真实工具路径） ===

  // 正路 1：显式 web_search 请求 → Agent 工具链 → chat 转述
  await withScenario({}, async ({ makeSession, run, data }) => {
    const mocked = mockFetch([
      { json: { choices: [{ message: { content: '', tool_calls: [{ id: 'tc1', type: 'function', function: { name: 'web_search', arguments: '{"query":"鸣潮最新角色"}' } }] } }] } },
      { json: { choices: [{ message: { content: '根据搜索结果，鸣潮最新角色是绯雪。' } }] } },
      { json: { choices: [{ message: { content: '绯雪是鸣潮最新角色。' } }] } },
    ])
    await withFetch(mocked, async () => {
      const webSearch = require(path.join(AI_ROOT, 'lib', 'agent', 'tools', 'web-search.js'))
      const originalExecute = webSearch.execute
      webSearch.execute = async () => '已搜索：鸣潮 最新角色\n搜索结果：\n1. 官方公告\n   https://kurogames.com/news\n   可信度分：100\n   绯雪与达妮娅'
      try {
        data.writeJson('ai-tool-config.json', {
          ...DEFAULT_TOOL_CONFIG,
          autoRoute: { qq: { enabled: true }, dashboard: { enabled: false } },
        })
        const session = makeSession({ userId: 'ok-user', guildId: '10001', channelId: '10001', selfId: '90000' })
        session.content = atBot(session, '调用web_search查鸣潮最新角色是谁')
        const result = await run(session, { flushTicks: 120 })
        await session.waitForSend(() => true, 10000)
        const replyText = session.sent.join(' ')
        t.check('mocked explicit search sends reply', session.sent.length > 0)
        assertNoEmptyAgentReply(t, 'mocked explicit search', replyText)
        assertNoReasoningLeak(t, 'mocked explicit search', replyText)
        t.check('mocked explicit search has tool answer', replyText.includes('绯雪') || replyText.includes('搜索结果'), replyText.slice(0, 200))
        const firstCallTools = mocked.calls[0]?.requestBody?.tools || []
        t.check('mocked explicit search exposes web_search', firstCallTools.some(item => item.function?.name === 'web_search'), JSON.stringify(firstCallTools))
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

  // 正路 3：mocked HTTP 搜索提取路径（不 mock webSearch.execute，mock fetch 返回 HTML）
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
        await session.waitForSend(() => true, 10000)
        const replyText = session.sent.join(' ')
        t.check('mocked http extraction sends reply', session.sent.length > 0)
        assertNoEmptyAgentReply(t, 'mocked http extraction', replyText)
        assertNoReasoningLeak(t, 'mocked http extraction', replyText)
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

  // 坏路 2：web_search 返回失败结果 → Agent 不应编造答案
  await withScenario({}, async ({ makeSession, run, data }) => {
    const mocked = mockFetch([
      { json: { choices: [{ message: { content: '', tool_calls: [{ id: 'tc1', type: 'function', function: { name: 'web_search', arguments: '{"query":"未知查询"}' } }] } }] } },
      { json: { choices: [{ message: { content: '这次搜索没有拿到可靠结果。' } }] } },
      { json: { choices: [{ message: { content: '搜索失败' } }] } },
    ])
    await withFetch(mocked, async () => {
      const webSearch = require(path.join(AI_ROOT, 'lib', 'agent', 'tools', 'web-search.js'))
      const originalExecute = webSearch.execute
      webSearch.execute = async () => '搜索失败：未提取到有效搜索结果。'
      try {
        data.writeJson('ai-tool-config.json', {
          ...DEFAULT_TOOL_CONFIG,
          autoRoute: { qq: { enabled: true }, dashboard: { enabled: false } },
        })
        const session = makeSession({ userId: 'fail-user', guildId: '10001', channelId: '10001', selfId: '90000' })
        session.content = atBot(session, '调用web_search查不存在的东西')
        const result = await run(session, { flushTicks: 120 })
        await session.waitForSend(() => true, 10000)
        const replyText = session.sent.join(' ')
        assertNoEmptyAgentReply(t, 'search failure response', replyText)
        // 不应编造直接答案
        t.check('search failure does not fabricate', replyText.includes('没有拿到可靠结果') || replyText.includes('未提取到') || replyText.includes('搜索失败'), replyText.slice(0, 300))
      } finally {
        webSearch.execute = originalExecute
      }
    })
  })
}

module.exports = { run }
