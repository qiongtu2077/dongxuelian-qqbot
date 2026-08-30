'use strict'

const path = require('path')

/** Creates cascade fixtures bound to the current AI build directory. */
function createCascadeFixtures(LIB) {
/** Creates an in-memory Koishi logger fixture. */
function makeLoggerStore() {
  const logs = []
  return {
    logs,
    ctx: {
      logger(name) {
        return {
          info: (msg) => logs.push({ level: 'info', name, msg: String(msg) }),
          warn: (msg) => logs.push({ level: 'warn', name, msg: String(msg) }),
          error: (msg) => logs.push({ level: 'error', name, msg: String(msg) }),
        }
      },
    },
  }
}

/** Creates a message session fixture with sent-message capture. */
function makeSession(overrides = {}) {
  const sent = []
  return {
    sent,
    userId: '100000000',
    author: { id: '100000000', name: 'tester', nick: 'tester' },
    username: 'tester',
    guildId: '10001',
    channelId: '10001',
    isDirect: false,
    selfId: '90000',
    content: '',
    event: { sender: { role: 'member' }, message: [] },
    bot: { selfId: '90000' },
    async send(message) {
      sent.push(String(message))
      return message
    },
    ...overrides,
  }
}

/** Creates the mutable handler state used by command contract tests. */
function makeHandlerState(overrides = {}) {
  const calls = {
    loadConfig: 0,
    loadRuntimeSettings: 0,
    loadSkills: 0,
    loadSkillsContentCache: 0,
    repeat: [],
    resetConfigCache: 0,
    callOpenAI: 0,
  }
  const repeatEnabledCache = {}
  const channelMissCount = new Map([['10001', 3]])
  const state = {
    plain: '',
    inGuild: true,
    channelKey: '10001',
    currentUserId: '100000000',
    adminCommandMatched: false,
    async loadConfig() {
      calls.loadConfig++
      return {
        provider: 'opencode',
        model: 'deepseek-v4-flash',
        baseURL: 'https://opencode.ai/zen/go/v1',
        apiKey: 'sk-secret-regression-test',
        searchEnabled: false,
      }
    },
    async loadRuntimeSettings() { calls.loadRuntimeSettings++ },
    async loadSkills() { calls.loadSkills++ },
    async loadSkillsContentCache() { calls.loadSkillsContentCache++ },
    async callOpenAI() { calls.callOpenAI++; return 'emotion-ok' },
    setRepeatEnabled(channelKey, enabled) {
      repeatEnabledCache[String(channelKey)] = !!enabled
      calls.repeat.push({ channelKey: String(channelKey), enabled: !!enabled })
    },
    getRandomTriggerBaseRate() { return 0.008 },
    getRandomWhitelistStatus() { return false },
    getThinkingEnabled() { return false },
    setThinkingEnabled(value) { calls.thinking = !!value },
    resetConfigCache() { calls.resetConfigCache++ },
    getSkillsCount() { return 3 },
    channelMissCount,
    repeatEnabledCache,
    channelTodayCache: new Map(),
    lastEmotionCache: new Map(),
    _calls: calls,
    ...overrides,
  }
  return state
}

const STR = {
  qqFaceLike: '\u3010QQ\u8868\u60c5\uff1a\u8d5e\u3011',
  qqStickerLike: '\u3010QQ\u8868\u60c5\u5305\u3011',
  forwardLike: '\u3010\u8f6c\u53d1\u6d88\u606f\u3011',
  grass: '\u8349',
  hello: '\u4f60\u597d',
}

const CMD = {
  aiStatus: 'AI\u72b6\u6001',
  aiReload: 'AI\u91cd\u8f7d',
  repeatOn: '\u4e1c\u96ea\u83b2\u590d\u8bfb\u5f00',
  repeatOff: '\u4e1c\u96ea\u83b2\u590d\u8bfb\u5173',
  repeatStatus: '\u4e1c\u96ea\u83b2\u590d\u8bfb\u72b6\u6001',
  thinkingOn: '\u4e1c\u96ea\u83b2\u601d\u8003\u5f00',
  thinkingOff: '\u4e1c\u96ea\u83b2\u601d\u8003\u5173',
  todayEmotion: '\u4eca\u65e5\u60c5\u7eea',
  helpCollection: '\u5e2e\u52a9\u96c6\u5408',
  helpCollectionDongxuelian: '东雪莲集合',
  misc: '杂项功能',
  provider: '供应商',
  other: '\u5176\u4ed6',
  groupReply: '\u7fa4\u804a\u4e3b\u52a8\u56de\u590d',
  network: '\u8054\u7f51',
  eventDump: '\u6293\u53d6\u539f\u59cb\u4e8b\u4ef6',
  whitelistBlacklist: '\u767d\u540d\u5355\u9ed1\u540d\u5355\u7ba1\u7406',
  persona: '\u4eba\u683c',
  sensitive: '\u654f\u611f\u8bdd\u9898\u68c0\u6d4b',
}

/** Runs one command through the production handler with isolated fixtures. */
async function runHandler(plain, options = {}) {
  const logger = makeLoggerStore()
  const session = makeSession(options.session || {})
  const state = makeHandlerState({ plain, ...(options.state || {}) })
  const handler = require(path.join(LIB, 'handler'))
  const result = await handler.handleCommand(session, logger.ctx, state)
  return { result, session, state, logs: logger.logs }
}

  return {
    STR,
    CMD,
    makeLoggerStore,
    makeSession,
    makeHandlerState,
    runHandler,
  }
}

module.exports = { createCascadeFixtures }
