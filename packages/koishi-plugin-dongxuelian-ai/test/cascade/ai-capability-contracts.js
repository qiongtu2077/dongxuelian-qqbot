'use strict'

const { createCapabilityConfig } = require('../helpers/ai-capability-fixture')

// 验证八供应商白名单、四能力契约、旧链迁移、发现协议、事务纯函数、通知冷却与用量结构。
async function runAiCapabilityContracts(context) {
  const { check, checkEqual, checkThrows, fs, path, LIB } = context
  const configModule = require(path.join(LIB, 'core', 'ai-capability-config'))
  const discovery = require(path.join(LIB, 'core', 'model-discovery'))
  const notifier = require(path.join(LIB, 'core', 'capability-failure-notifier'))
  const constants = require(path.join(LIB, 'core', 'constants'))
  const api = require(path.join(LIB, 'core', 'api'))

  context.section('6b. AI capability configuration contract')

  checkEqual('AI capability contract has four ids', [...configModule.AI_CAPABILITIES].join(','), 'text,vision,voice-asr,voice-tts')
  checkEqual('AI provider catalog has exact eight ids', [...configModule.PROVIDER_IDS].join(','), 'glm,mimorium,dashscope,deepseek,openai,anthropic,gemini,opencode')
  const publicCatalog = configModule.getPublicProviderCatalog()
  checkEqual('public provider catalog keeps eight entries', publicCatalog.length, 8)
  checkEqual('only four providers enable model discovery', publicCatalog.filter(item => item.discoveryAvailable).map(item => item.id).join(','), 'deepseek,openai,anthropic,gemini')
  check('blocked providers expose exact reasons', publicCatalog.filter(item => !item.discoveryAvailable).every(item => typeof item.discoveryReason === 'string' && item.discoveryReason.length > 8), JSON.stringify(publicCatalog))
  check('public provider catalog hides runtime URL and key file', publicCatalog.every(item => !Object.prototype.hasOwnProperty.call(item, 'baseURL') && !Object.prototype.hasOwnProperty.call(item, 'keyFile')), JSON.stringify(publicCatalog))

  const invalidProviderConfig = createCapabilityConfig()
  invalidProviderConfig.providers.outside = { models: [] }
  checkThrows('capability config rejects non-whitelist provider', () => configModule.normalizeCapabilityConfig(invalidProviderConfig), /未知供应商/)

  const previousLegacy = fs.existsSync(constants.FALLBACK_CHAINS_FILE) ? fs.readFileSync(constants.FALLBACK_CHAINS_FILE) : null
  try {
    fs.writeFileSync(constants.FALLBACK_CHAINS_FILE, JSON.stringify({
      chat: [
        { provider: 'glm', model: 'glm-4.6v-flash' },
        { provider: 'outside', model: 'unknown' },
      ],
      lightweight: [
        { provider: 'glm', model: 'glm-4.6v-flash' },
        { provider: 'opencode', model: 'deepseek-v4-flash' },
      ],
      vision: [{ provider: 'glm', model: 'glm-4.6v-flash' }],
    }, null, 2), 'utf8')
    const firstMigration = configModule.buildLegacyMigration()
    const secondMigration = configModule.buildLegacyMigration()
    checkEqual('legacy migration is idempotent', JSON.stringify(firstMigration), JSON.stringify(secondMigration))
    checkEqual('legacy chat and lightweight merge into ordered text', firstMigration.config.priorities.text.map(step => `${step.provider}/${step.model}`).join(','), 'glm/glm-4.6v-flash,opencode/deepseek-v4-flash')
    checkEqual('legacy vision remains independent', firstMigration.config.priorities.vision.map(step => `${step.provider}/${step.model}`).join(','), 'glm/glm-4.6v-flash')
    check('legacy voice capabilities initialize empty', firstMigration.config.priorities['voice-asr'].length === 0 && firstMigration.config.priorities['voice-tts'].length === 0)
    check('legacy migration reports invalid removed step', firstMigration.diagnostics.some(item => item.includes('已移除无法解析')))
  } finally {
    if (previousLegacy === null) fs.rmSync(constants.FALLBACK_CHAINS_FILE, { force: true })
    else fs.writeFileSync(constants.FALLBACK_CHAINS_FILE, previousLegacy)
  }

  const poolConfig = createCapabilityConfig({
    text: [
      { provider: 'openai', model: 'gpt-4o' },
      { provider: 'openai', model: 'obsolete-model' },
    ],
    vision: [{ provider: 'openai', model: 'gpt-4o' }],
  })
  const replaced = configModule.replaceProviderModels(poolConfig, 'openai', [
    { id: 'gpt-4o', name: 'GPT-4o', capabilities: ['text'] },
  ])
  checkEqual('model pool replacement counts removed models', replaced.removedModels, 1)
  checkEqual('model pool replacement removes incompatible priority references', replaced.removedSteps, 2)
  checkEqual('model pool replacement keeps valid text priority', replaced.config.priorities.text[0]?.model, 'gpt-4o')
  check('model pool replacement reports newly empty vision', replaced.emptyCapabilities.includes('vision'))

  fs.writeFileSync(path.join(constants.DATA_DIR, 'ai-openai-official-key.txt'), 'sk-public-mask-test', 'utf8')
  const priorityConfig = configModule.replaceCapabilityPriority(poolConfig, 'vision', [{ provider: 'openai', model: 'gpt-4o' }])
  checkEqual('priority replacement changes only selected capability', priorityConfig.priorities.text.length, 2)
  checkEqual('priority replacement keeps selected model', priorityConfig.priorities.vision[0]?.model, 'gpt-4o')
  checkThrows('priority replacement rejects duplicate steps', () => configModule.replaceCapabilityPriority(poolConfig, 'vision', [
    { provider: 'openai', model: 'gpt-4o' },
    { provider: 'openai', model: 'gpt-4o' },
  ]), /重复模型/)
  const keyStatus = configModule.getProviderKeyStatus('openai')
  check('provider key status masks plaintext', keyStatus.configured === true && keyStatus.prefix.endsWith('****') && !keyStatus.prefix.includes('mask-test'), JSON.stringify(keyStatus))

  const openAiModels = discovery.parseOpenAiModelList('openai', { data: [{ id: 'gpt-4o' }, { id: 'unverified-model' }] })
  check('OpenAI discovery imports exact verified model only', openAiModels[0].importable === true && openAiModels[1].importable === false, JSON.stringify(openAiModels))
  const anthropicModels = discovery.parseAnthropicModelList({ data: [{ id: 'claude-test', display_name: 'Claude Test', capabilities: { image_input: { supported: true } } }] })
  checkEqual('Anthropic discovery reads official image capability', anthropicModels[0].capabilities.join(','), 'text,vision')
  const geminiModels = discovery.parseGeminiModelList({ models: [{ name: 'models/gemini-3.7-flash', displayName: 'Gemini Flash', supportedGenerationMethods: ['generateContent'] }] })
  checkEqual('Gemini discovery removes resource prefix and keeps verified vision', `${geminiModels[0].id}:${geminiModels[0].capabilities.join(',')}`, 'gemini-3.7-flash:text,vision')
  checkThrows('OpenAI discovery rejects missing data array', () => discovery.parseOpenAiModelList('openai', {}), /缺少 data 数组/)

  let blockedFetchCalls = 0
  try {
    await discovery.discoverProviderModels('glm', 'sk-blocked-secret', { fetchImpl: async () => { blockedFetchCalls += 1 } })
    check('blocked provider discovery throws before fetch', false, 'did not throw')
  } catch (error) {
    check('blocked provider discovery throws exact reason before fetch', error.code === 'DISCOVERY_BLOCKED' && /尚未确认/.test(error.message) && blockedFetchCalls === 0, String(error && error.message || error))
  }

  let discoveryRequest = null
  const discovered = await discovery.discoverProviderModels('openai', 'sk-discovery-secret', {
    fetchImpl: async (url, options) => {
      discoveryRequest = { url, options }
      return { ok: true, status: 200, json: async () => ({ data: [{ id: 'gpt-4o' }] }) }
    },
  })
  check('verified discovery uses fixed official endpoint and bearer auth', discoveryRequest.url === 'https://api.openai.com/v1/models' && discoveryRequest.options.headers.Authorization === 'Bearer sk-discovery-secret')
  check('verified discovery response excludes key material', discovered[0].importable === true && !JSON.stringify(discovered).includes('sk-discovery-secret'), JSON.stringify(discovered))
  try {
    await discovery.discoverProviderModels('openai', 'sk-discovery-secret', {
      fetchImpl: async () => ({ ok: false, status: 401, json: async () => ({ detail: 'sensitive upstream body' }) }),
    })
    check('discovery auth error is sanitized', false, 'did not throw')
  } catch (error) {
    const message = String(error && error.message || error)
    check('discovery auth error is sanitized', /HTTP 401/.test(message) && !message.includes('sk-discovery-secret') && !message.includes('sensitive upstream body'), message)
  }

  const notifications = []
  notifier.resetCapabilityFailureNotifier()
  notifier.setCapabilityFailureSender(async (adminId, message) => notifications.push({ adminId, message }))
  const firstNotify = await notifier.notifyCapabilityStepFailure('openai', 'gpt-4o', 1000)
  const cooledNotify = await notifier.notifyCapabilityStepFailure('openai', 'gpt-4o', 1001)
  const expiredNotify = await notifier.notifyCapabilityStepFailure('openai', 'gpt-4o', 1000 + notifier.FAILURE_NOTIFICATION_COOLDOWN_MS)
  check('failure notifier applies provider-model cooldown', firstNotify === true && cooledNotify === false && expiredNotify === true)
  check('failure notifier dynamically sends to all admins', notifications.length === 4 && new Set(notifications.map(item => item.adminId)).size === 2, JSON.stringify(notifications))
  check('failure notification includes provider and model', notifications.every(item => item.message.includes('供应商：GPT') && item.message.includes('模型：gpt-4o')), JSON.stringify(notifications))
  notifier.resetCapabilityFailureNotifier()

  api.recordTokenUsage('openai', 15, { capability: 'text', model: 'capability-usage-readable', usage: { input_tokens: 10, output_tokens: 5 }, readable: true })
  api.recordTokenUsage('openai', 0, { capability: 'vision', model: 'capability-usage-unreadable', readable: false })
  api.recordTokenUsage('openai', 99, { capability: 'chat', model: 'legacy-capability-must-not-write', readable: true })
  api.flushTokenUsage()
  const usageRoot = JSON.parse(fs.readFileSync(path.join(constants.DATA_DIR, 'token-usage.json'), 'utf8'))
  const usageDay = Object.values(usageRoot).find(day => day.capabilities?.text?.models?.['capability-usage-readable'])
  check('token usage persists under capability nodes only', usageDay.capabilities.text.models['capability-usage-readable'].total === 15 && usageDay.capabilities.vision.models['capability-usage-unreadable'].unreadableRequests === 1, JSON.stringify(usageDay))
  check('token usage ignores legacy capability names', !usageDay.capabilities.chat, JSON.stringify(usageDay.capabilities))
}

module.exports = { runAiCapabilityContracts }
