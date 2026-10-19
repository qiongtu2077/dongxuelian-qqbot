/** 固定日报模型节点的公共调用契约测试，不访问真实供应商。 */
'use strict'
const assert = require('assert').strict
const path = require('path'), { createHash } = require('crypto')
const managementPath = require.resolve('koishi-plugin-dongxuelian-ai/lib/public/management-runtime')
const modelPath = path.resolve(__dirname, '../lib/report-model')

// 临时替换已知公共管理入口，返回形状严格采用当前已实现的冻结契约。
async function withModelConfiguration(configured, run, failure, resolveNode) {
  const original = require.cache[managementPath].exports, calls = []
  const api = { freezeChatRoute(config, explicit) {
    const steps = (explicit || config.steps || [config]).map((step, priorityIndex) => ({ ...step, priorityIndex, chatProtocol: step.chatProtocol || 'openai-chat' }))
    return { version: 1, capability: 'text', identity: createHash('sha256').update(JSON.stringify(steps)).digest('hex'),
      routeRevision: createHash('sha256').update('revision-' + JSON.stringify(steps)).digest('hex'), steps }
  }, getChatFailureMetadata(error) { return failure && error === failure.error ? failure.metadata : null }, async requestChatCompletions(messages, config, extra) {
    calls.push({ messages, config, extra }); extra._onRequestAttempt?.({ model: config.model })
    if (failure) throw failure.error
    return { type: 'text', content: '{"completed":true}', reasoning: '' }
  } }
  require.cache[managementPath].exports = { ...original, loadManagementModule(name) {
    if (name === 'core.runtimeConfig') return { loadConfig: async () => configured }
    if (name === 'core.api') return api
    if (name === 'core.aiCapabilityConfig' && resolveNode) return { resolveConfiguredCapabilityModel: resolveNode }
    return original.loadManagementModule(name)
  } }
  delete require.cache[require.resolve(modelPath)]
  try { await run(require(modelPath), calls) }
  finally { require.cache[managementPath].exports = original; delete require.cache[require.resolve(modelPath)] }
}

// 显式供应商和型号从已配置池只读解析，不依赖全局主备恰好包含该节点。
async function checkConfiguredNode() {
  const global = { capability: 'text', apiKey: 'fake-global', baseURL: 'https://global.example.invalid/v1', provider: 'global-provider', model: 'global-model' }
  const node = { capability: 'text', apiKey: 'fake-node', baseURL: 'https://selected.example.invalid/v1', provider: 'selected-provider', model: 'deepseek-v4-flash', chatProtocol: 'openai-chat', priorityIndex: 0 }
  await withModelConfiguration(global, async (model, calls) => {
    const profile = await model.createGroundedModelRequest({ configuredNode: { provider: node.provider, model: node.model } })
    for (const attempt of [1, 2]) await profile.request('classification', attempt, 'JSON', '{}', 4096, {})
    assert.equal(calls.length, 2)
    assert(calls.every(call => call.config.apiKey === node.apiKey && call.config.baseURL === node.baseURL && call.extra._frozenRoute.steps.length === 1))
    assert(profile.routing.every(route => route.provider === node.provider && route.model === node.model))
    assert.equal(profile.classificationCachePolicy.first.routeIdentity, profile.classificationCachePolicy.recovery.routeIdentity)
    assert.equal(global.model, 'global-model')
    await assert.rejects(model.createGroundedModelRequest({ configuredNode: { provider: 'not-configured', model: node.model } }), /未配置节点/)
    await assert.rejects(model.createGroundedModelRequest({ configuredNode: { provider: node.provider, model: node.model }, onlyConfiguredModel: node.model }), /不能同时使用/)
    assert.equal(calls.length, 2)
  }, undefined, (capability, provider, name) => {
    assert.equal(capability, 'text')
    if (provider !== node.provider || name !== node.model) throw new Error('未配置节点')
    return { ...node }
  })
}

// 所有阶段使用当前主节点和唯一备用，独立凭据与协议随节点冻结。
async function checkFixedModels() {
  const configured = { capability: 'text', searchEnabled: true, steps: [
    { apiKey: 'fake-primary-key', baseURL: 'https://primary.example.invalid/v1', provider: 'configured-primary', model: 'deepseek-v4-flash', capability: 'text' },
    { apiKey: 'fake-backup-key', baseURL: 'https://backup.example.invalid/v1', provider: 'configured-backup', model: 'gpt-4.1-mini', capability: 'text' }] }
  await withModelConfiguration(configured, async (model, calls) => {
    const profile = await model.createGroundedModelRequest()
    let attempts = 0
    for (const stage of ['classification', 'grouping', 'selection', 'overview', 'quotes', 'portraits', 'review']) for (const attempt of [1, 2]) {
      const text = await profile.request(stage, attempt, '严格JSON对象', '{}', 2048, { _frozenRouteStartStepIndex: 9, _onRequestAttempt() { attempts++ } })
      assert.equal(text, '{"completed":true}')
      const call = calls.at(-1), node = configured.steps[attempt - 1], expected = node.model
      assert.equal(call.config.model, expected); assert.equal(call.extra._frozenRoute.steps.length, 1)
      assert.equal(call.config.apiKey, node.apiKey); assert.equal(call.config.provider, node.provider); assert.equal(call.config.baseURL, node.baseURL)
      assert.equal(call.extra._frozenRoute.steps[0].model, expected); assert.equal(call.extra._frozenRouteStartStepIndex, 0)
      assert.equal(call.extra._thinkingEnabled, false); assert.equal(call.extra.temperature, 0.2)
      assert.equal(call.extra._structuredOutput, undefined); assert.equal(call.config.searchEnabled, false)
    }
    assert.equal(attempts, 14); assert.match(profile.policyIdentity, /^[a-f0-9]{64}$/)
    assert.equal(profile.classificationCachePolicy.identity, profile.policyIdentity)
    assert.equal(profile.classificationCachePolicy.first.model, 'deepseek-v4-flash')
    assert.equal(profile.classificationCachePolicy.recovery.model, 'gpt-4.1-mini')
    assert.match(profile.classificationCachePolicy.first.routeRevision, /^[a-f0-9]{64}$/)
    assert(!JSON.stringify(profile.classificationCachePolicy).includes('fake-primary-key'))
    assert(!JSON.stringify(profile.classificationCachePolicy).includes('fake-backup-key'))
    for (const stage of ['grouping', 'selection', 'overview', 'quotes', 'portraits', 'review']) {
      const policy = profile.stageCachePolicies[stage]
      assert.match(policy.identity, /^[a-f0-9]{64}$/)
      assert.equal(policy.first.model, 'deepseek-v4-flash')
      assert.equal(policy.recovery.model, 'gpt-4.1-mini')
      assert.equal(policy.first.routeIdentity, profile.classificationCachePolicy.first.routeIdentity)
    }
    assert.equal(new Set(Object.values(profile.stageCachePolicies).map(policy => policy.identity)).size, 6)
    assert(!JSON.stringify(profile.stageCachePolicies).includes('fake-primary-key'))
    assert.equal(configured.steps[0].model, 'deepseek-v4-flash'); assert.equal(configured.searchEnabled, true)
    const previousIdentity = profile.policyIdentity
    configured.steps[0].model = 'changed-model'
    await profile.request('quotes', 1, 'JSON', '{}', 256, {})
    assert.equal(calls.at(-1).config.model, 'deepseek-v4-flash')
    assert.notEqual((await model.createGroundedModelRequest()).policyIdentity, previousIdentity)
    const callsBefore = calls.length
    await assert.rejects(profile.request('quotes', 3, 'JSON', '{}', 256, {}), /只允许首轮/)
    assert.equal(calls.length, callsBefore)
  })
}

// 明确单节点配置只恢复自身，不产生第二个型号或供应商。
async function checkSingleModel() {
  await withModelConfiguration({ apiKey: 'fake-key', baseURL: 'https://single.example.invalid/v1', provider: 'single', model: 'configured-only', capability: 'text' },
    async (model, calls) => {
      const profile = await model.createGroundedModelRequest()
      await profile.request('review', 1, 'JSON', '{}', 256, {})
      await profile.request('review', 2, 'JSON', '{}', 256, {})
      assert.equal(calls.length, 2); assert(calls.every(call => call.config.model === 'configured-only' && call.extra._frozenRoute.steps.length === 1))
      assert.equal(profile.classificationCachePolicy.first.routeIdentity, profile.classificationCachePolicy.recovery.routeIdentity)
    })
}

// 显式限定型号时每阶段只执行唯一已配置节点，未匹配或重复配置均拒绝。
async function checkExplicitOnlyModel() {
  const node = { apiKey: 'fake-mimo', baseURL: 'https://mimo.example.invalid/v1', provider: 'mimo-fixture', model: 'mimo-v2.6-pro', capability: 'text' }
  const backup = { ...node, apiKey: 'fake-other', model: 'other-model', provider: 'other-fixture' }
  await withModelConfiguration({ capability: 'text', steps: [node, backup] }, async (model, calls) => {
    const standard = await model.createGroundedModelRequest(), only = await model.createGroundedModelRequest({ onlyConfiguredModel: 'mimo-v2.6-pro' })
    assert.notEqual(only.policyIdentity, standard.policyIdentity)
    for (const stage of ['classification', 'grouping', 'selection', 'overview', 'quotes', 'portraits', 'review']) for (const attempt of [1, 2]) {
      await only.request(stage, attempt, 'JSON', '{}', 256, {})
    }
    assert.equal(calls.length, 14)
    assert(calls.every(call => call.config.model === node.model && call.config.apiKey === node.apiKey && call.extra._frozenRoute.steps.length === 1))
    assert(calls.every(call => call.extra.thinking.type === 'disabled' && call.extra._thinkingEnabled === false))
    assert.equal(only.classificationCachePolicy.first.routeIdentity, only.classificationCachePolicy.recovery.routeIdentity)
    assert(only.routing.every(route => route.model === node.model))
    await assert.rejects(model.createGroundedModelRequest({ onlyConfiguredModel: 'not-configured' }), /唯一匹配/)
    assert.equal(calls.length, 14)
  })
  await withModelConfiguration({ capability: 'text', steps: [node, node] }, async (model, calls) => {
    await assert.rejects(model.createGroundedModelRequest({ onlyConfiguredModel: node.model }), /唯一匹配/)
    assert.equal(calls.length, 0)
  })
}

// 缺凭据、未知协议或超过两个节点均先失败，不能偷偷裁剪路由或派生配置。
async function checkUnavailableModelConfig() {
  const node = { apiKey: 'fake-key', baseURL: 'https://example.invalid/v1', provider: 'other', model: 'other', capability: 'text' }
  for (const steps of [[{ ...node, apiKey: '' }], [{ ...node, chatProtocol: 'unknown' }], [node, node, node]]) {
    await withModelConfiguration({ capability: 'text', steps }, async (model, calls) => {
      await assert.rejects(model.createGroundedModelRequest(), /一至两个明确配置/); assert.equal(calls.length, 0)
    })
  }
}

// 已核实的公共错误标量透传为只读事实，未知错误不猜HTTP/余额或保存原正文。
async function checkFailureMetadata() {
  const configured = { apiKey: 'fake-key', baseURL: 'https://fixture.example.invalid/v1', provider: 'test', model: 'test', capability: 'text' }
  for (const metadata of [{ code: 'HTTP_403', status: 403, retryable: true }, null]) {
    const error = new Error(metadata ? 'AI 上游请求失败（HTTP 403）' : '未知上游错误')
    await withModelConfiguration(configured, async (model, calls) => {
      const profile = await model.createGroundedModelRequest()
      await assert.rejects(profile.request('classification', 1, 'JSON', '{}', 4096, {}), failure => {
        assert.equal(failure.kind, 'upstream'); assert.equal(failure.message, error.message)
        assert.deepEqual(failure.upstreamFailure, metadata)
        if (metadata) { assert(Object.isFrozen(failure.upstreamFailure)); metadata.status = 500; assert.equal(failure.upstreamFailure.status, 403) }
        return true
      })
      assert.equal(calls.length, 1)
    }, { error, metadata })
  }
}

// 注册正式测试入口，单节点执行仍需随后真实回放验证端点与型号可用性。
async function runReportModelTests(check) {
  for (const [label, run] of [['日报现有主备冻结及每轮显式单节点', checkFixedModels], ['日报单节点恢复自身且不派生型号', checkSingleModel], ['日报未知节点配置先失败且不改全局路由', checkUnavailableModelConfig],
    ['日报透传已知HTTP事实且未知错误不猜额度', checkFailureMetadata], ['日报显式限定已配置唯一型号，所有阶段首轮恢复均不得回落', checkExplicitOnlyModel],
    ['日报指定池内供应商及型号，不改全局主备且唯一恢复仍用原节点', checkConfiguredNode]]) {
    try { await run(); check(label, true) } catch (error) { check(label, false, error.stack || String(error)) }
  }
}
module.exports = { runReportModelTests }
