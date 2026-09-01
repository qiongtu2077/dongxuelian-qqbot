'use strict'

const PROVIDER_IDS = Object.freeze([
  'glm',
  'mimorium',
  'dashscope',
  'deepseek',
  'openai',
  'anthropic',
  'gemini',
  'opencode',
])

const CAPABILITY_IDS = Object.freeze(['text', 'vision', 'voice-asr', 'voice-tts'])

const PROVIDER_KEY_FILES = Object.freeze({
  glm: 'ai-glm-key.txt',
  mimorium: 'ai-mimorium-key.txt',
  dashscope: 'ai-dashscope-key.txt',
  deepseek: 'ai-deepseek-key.txt',
  openai: 'ai-openai-official-key.txt',
  anthropic: 'ai-anthropic-key.txt',
  gemini: 'ai-gemini-key.txt',
  opencode: 'ai-openai-key.txt',
})

// 根据四条优先级构造完整的八供应商测试配置，并合并同一模型的能力标签。
function createCapabilityConfig(priorities = {}) {
  const config = { version: 1, providers: {}, priorities: {} }
  for (const provider of PROVIDER_IDS) config.providers[provider] = { models: [] }
  for (const capability of CAPABILITY_IDS) config.priorities[capability] = []

  const modelIndexes = new Map()
  for (const capability of CAPABILITY_IDS) {
    const steps = Array.isArray(priorities[capability]) ? priorities[capability] : []
    for (const rawStep of steps) {
      const step = { provider: String(rawStep.provider), model: String(rawStep.model) }
      config.priorities[capability].push(step)
      const indexKey = `${step.provider}\u0000${step.model}`
      let model = modelIndexes.get(indexKey)
      if (!model) {
        model = { id: step.model, name: step.model, capabilities: [] }
        config.providers[step.provider].models.push(model)
        modelIndexes.set(indexKey, model)
      }
      if (!model.capabilities.includes(capability)) model.capabilities.push(capability)
    }
  }
  return config
}

// 把完整能力配置和固定槽位测试 Key 写入 createTestDataDir 返回的数据目录。
function seedCapabilityConfig(data, priorities, options = {}) {
  const config = createCapabilityConfig(priorities)
  data.writeJson('ai-capability-config.json', config)
  const keys = options.keys || {}
  for (const provider of PROVIDER_IDS) {
    const value = Object.prototype.hasOwnProperty.call(keys, provider) ? keys[provider] : `test-${provider}-key`
    data.writeText(PROVIDER_KEY_FILES[provider], value)
  }
  return config
}

module.exports = {
  CAPABILITY_IDS,
  PROVIDER_IDS,
  PROVIDER_KEY_FILES,
  createCapabilityConfig,
  seedCapabilityConfig,
}
