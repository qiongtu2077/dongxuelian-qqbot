import { flushPromises, mount } from '@vue/test-utils'
import AiModelApiConfigPanel from '../../../packages/koishi-plugin-dashboard/frontend/src/components/AiModelApiConfigPanel.vue'

const fs = require('node:fs')
const path = require('node:path')

const workspaceRoot = path.resolve(__dirname, '..', '..', '..')

// 读取仓库中的真实源码，供前后端契约交叉检查。
function readSource(relativePath) {
  return fs.readFileSync(path.join(workspaceRoot, relativePath), 'utf8')
}

// 按稳定的函数声明边界截取源码，避免 Windows 换行符影响审查断言。
function sourceBetween(source, start, end) {
  const startIndex = source.indexOf(start)
  const endIndex = source.indexOf(end, startIndex + start.length)
  if (startIndex < 0 || endIndex < 0) return ''
  return source.slice(startIndex, endIndex)
}

// --- 统一模型配置行为 ---

const abilities = { text: '文字', vision: '识图', 'voice-asr': '语音识别', 'voice-tts': '语音合成' }
const configEndpoint = '/dashboard/api/ai-model-api/config'
const priorityEndpoint = '/dashboard/api/ai-model-api/priority'
const discoverEndpoint = '/dashboard/api/ai-model-api/discover'
const detectEndpoint = '/dashboard/api/ai-model-api/detect'
const fixtureKey = 'fixture-api-key'
const provider = { id: 'openai', name: '示例供应商', discoveryAvailable: true, supportedCapabilities: Object.keys(abilities) }
const importedProvider = { ...provider, id: 'custom-fixture', name: '测试连接', custom: true }

// 构造当前接口的脱敏响应，每项能力使用独立的已保存模型。
function modelConfig() {
  const capabilities = Object.keys(abilities)
  const models = capabilities.map(capability => ({ id: `${capability}-main`, name: `${capability}-main`, capabilities: [capability] }))
  models.push({ id: 'text-backup', name: 'text-backup', capabilities: ['text'] })
  return {
    version: 1, capabilities,
    providers: { openai: { key: { configured: true, prefix: '****' }, models } },
    priorities: Object.fromEntries(capabilities.map(capability => [capability, [{ provider: 'openai', model: `${capability}-main` }]])),
  }
}

// 提供浏览器传输边界，API 包装与两层模型配置组件均执行真实实现。
function response(status, data) {
  return { status, ok: status >= 200 && status < 300, json: async () => data }
}

// 通过可见能力切换按钮获取相应优先级列表。
async function selectCapability(wrapper, capability) {
  const tab = wrapper.get('nav[aria-label="模型优先级能力"]').findAll('button').find(button => button.text() === abilities[capability])
  await tab.trigger('click')
  return wrapper.findAll('.priority-list li strong').map(model => model.text())
}

// 打开真实导入表单并填写只在本机夹具中使用的值。
async function fillImportDialog(wrapper) {
  await wrapper.get('.connections .section-head button').trigger('click')
  const dialog = wrapper.get('dialog[aria-labelledby="import-key-title"]')
  await dialog.get('input[placeholder="例如：MistEO"]').setValue(importedProvider.name)
  await dialog.get('input[type="url"]').setValue('https://example.test/v1')
  await dialog.get('input[type="password"]').setValue(fixtureKey)
  return dialog
}

describe('统一 AI 模型与 API 配置契约', () => {
  let wrapper, previousFetch, config

  // jsdom 补齐原生 dialog 的打开和关闭，保留表单与事件处理。
  beforeAll(() => {
    Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value: function showModal() { this.setAttribute('open', '') } })
    Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value: function close() { this.removeAttribute('open') } })
  })
  afterAll(() => { delete HTMLDialogElement.prototype.showModal; delete HTMLDialogElement.prototype.close })

  beforeEach(() => {
    localStorage.clear()
    localStorage.setItem('dashboard_token', 'fixture-login')
    localStorage.setItem('dashboard_server_token', JSON.stringify({ token: 'fixture-admin', expires: Date.now() + 60000 }))
    config = modelConfig()
    previousFetch = global.fetch
    global.fetch = jest.fn().mockResolvedValueOnce(response(200, { ok: true, config, catalog: [provider] }))
  })
  afterEach(() => {
    wrapper?.unmount()
    wrapper = undefined
    global.fetch = previousFetch
    localStorage.clear()
  })

  // 挂载完整配置页，隔离与这四条契约无关的统计周期查询。
  async function mountConfig(showAdminDialog = jest.fn()) {
    wrapper = mount(AiModelApiConfigPanel, { global: { provide: { showAdminDialog }, stubs: { AiUsagePanel: true } } })
    await flushPromises()
    return wrapper
  }

  test('从统一配置读取四条已保存优先级，切换能力只切换当前展示', async () => {
    const panel = await mountConfig()
    for (const capability of Object.keys(abilities)) expect(await selectCapability(panel, capability)).toEqual([`${capability}-main`])
    expect(global.fetch.mock.calls.map(([url]) => url)).toEqual([configEndpoint])
    expect(global.fetch.mock.calls[0][1].headers).toMatchObject({ Authorization: 'Bearer fixture-login', 'X-Admin-Token': 'fixture-admin' })
  })

  test('旧主模型兜底的本地标记不生成额外模型或保存字段', async () => {
    localStorage.setItem('cfg_lightweight_main', 'true')
    config.priorities.text = []
    const panel = await mountConfig()
    expect(panel.get('.empty-priority').text()).toBe('该能力未配置模型')
    global.fetch.mockResolvedValueOnce(response(200, { ok: true, config }))
    await panel.get('button.primary-btn').trigger('click')
    await flushPromises()
    expect(global.fetch.mock.calls.map(([url]) => url)).toEqual([configEndpoint, priorityEndpoint])
    expect(JSON.parse(global.fetch.mock.calls[1][1].body)).toEqual({ capability: 'text', steps: [] })
  })

  test('自定义供应商提交一次导入并采用事务回包，后续检测只发送供应商和模型编号', async () => {
    const panel = await mountConfig()
    const dialog = await fillImportDialog(panel)
    const next = { ...config, providers: { ...config.providers, [importedProvider.id]: {
      key: { configured: true, prefix: 'fixture****' }, models: [{ id: 'fixture-model', name: '测试模型', capabilities: ['text'] }],
    } } }
    global.fetch.mockResolvedValueOnce(response(200, { ok: true, config: next, providerId: importedProvider.id, catalog: [provider, importedProvider] }))
      .mockResolvedValueOnce(response(200, { ok: true, config: next }))
    await dialog.get('form').trigger('submit')
    await flushPromises()
    expect(global.fetch.mock.calls.map(([url, options]) => [url, options.method || 'GET'])).toEqual([
      [configEndpoint, 'GET'], [discoverEndpoint, 'POST'], [detectEndpoint, 'POST'],
    ])
    expect(JSON.parse(global.fetch.mock.calls[1][1].body)).toEqual({ providerId: 'custom-new', apiKey: fixtureKey,
      detectCapabilities: true, name: importedProvider.name, baseURL: 'https://example.test/v1', note: '' })
    expect(JSON.parse(global.fetch.mock.calls[2][1].body)).toEqual({ providerId: importedProvider.id, modelId: 'fixture-model' })
    expect(panel.get('.connections tbody').text()).toContain(importedProvider.name)
    expect(panel.get('.connections tbody').text()).toContain('fixture****')
    expect(dialog.attributes('open')).toBeUndefined()
    expect(dialog.get('input[type="password"]').element.value).toBe('')
    for (const capability of Object.keys(abilities)) expect(await selectCapability(panel, capability)).toEqual([`${capability}-main`])
  })

  test('导入被拒绝时保留表单输入并显示错误，成功前只访问导入接口', async () => {
    const panel = await mountConfig()
    const dialog = await fillImportDialog(panel)
    global.fetch.mockResolvedValueOnce(response(422, { ok: false, message: '该密钥未返回可导入模型', code: 'DISCOVERY_EMPTY' }))
    await dialog.get('form').trigger('submit')
    await flushPromises()
    expect(global.fetch.mock.calls.map(([url]) => url)).toEqual([configEndpoint, discoverEndpoint])
    expect(dialog.attributes('open')).toBeDefined()
    expect(dialog.get('[role="alert"]').text()).toContain('该密钥未返回可导入模型')
    expect(dialog.get('input[type="password"]').element.value).toBe(fixtureKey)
  })

  test('管理员验证后重新提交同一导入草稿', async () => {
    const showAdminDialog = jest.fn()
    const panel = await mountConfig(showAdminDialog)
    const dialog = await fillImportDialog(panel)
    global.fetch.mockResolvedValueOnce(response(403, { ok: false, code: 'ADMIN_REQUIRED' }))
    await dialog.get('form').trigger('submit')
    await flushPromises()
    expect(showAdminDialog).toHaveBeenCalledTimes(1)
    expect(dialog.attributes('open')).toBeDefined()
    expect(dialog.get('input[type="password"]').element.value).toBe(fixtureKey)

    localStorage.setItem('dashboard_server_token', JSON.stringify({ token: 'renewed-admin', expires: Date.now() + 60000 }))
    global.fetch.mockResolvedValueOnce(response(422, { ok: false, code: 'DISCOVERY_EMPTY', message: '该密钥未返回可导入模型' }))
    await showAdminDialog.mock.calls[0][1]()
    expect(global.fetch.mock.calls.map(([url]) => url)).toEqual([configEndpoint, discoverEndpoint, discoverEndpoint])
    expect(global.fetch.mock.calls[2][1].body).toBe(global.fetch.mock.calls[1][1].body)
    expect(global.fetch.mock.calls[2][1].headers['X-Admin-Token']).toBe('renewed-admin')
    expect(showAdminDialog).toHaveBeenCalledTimes(1)
    expect(dialog.get('[role="alert"]').text()).toContain('该密钥未返回可导入模型')
  })

  test('优先级只有一个保存入口，仅提交当前能力且保留另一能力草稿', async () => {
    const panel = await mountConfig()
    const saveButtons = panel.findAll('button').filter(button => button.text() === '保存优先级')
    expect(saveButtons).toHaveLength(1)
    await selectCapability(panel, 'vision')
    await panel.get('.priority-list button.danger').trigger('click')
    await selectCapability(panel, 'text')
    await panel.get('select[aria-label="选择要加入优先级的模型"]').setValue('openai\u0000text-backup')
    await panel.get('.add-model-row button').trigger('click')
    await panel.get('button[aria-label="上移 text-backup"]').trigger('click')
    const steps = [{ provider: 'openai', model: 'text-backup' }, { provider: 'openai', model: 'text-main' }]
    const saved = { ...config, priorities: { ...config.priorities, text: steps } }
    global.fetch.mockResolvedValueOnce(response(200, { ok: true, config: saved, message: '模型优先级已保存' }))
    await saveButtons[0].trigger('click')
    await flushPromises()
    expect(global.fetch.mock.calls.map(([url]) => url)).toEqual([configEndpoint, priorityEndpoint])
    expect(global.fetch.mock.calls[1][1].method).toBe('PUT')
    expect(JSON.parse(global.fetch.mock.calls[1][1].body)).toEqual({ capability: 'text', steps })
    expect(await selectCapability(panel, 'text')).toEqual(['text-backup', 'text-main'])
    expect(await selectCapability(panel, 'vision')).toEqual([])
  })
})

describe('主控制台前后端契约审查', () => {
  test('仍注册的旧 Fallback 接口保留 defaults 响应字段', () => {
    const backend = readSource('packages/koishi-plugin-dashboard/src/lib/routes/settings.ts')
    const handler = sourceBetween(backend, 'function handleGetFallback', 'function handlePutFallback')
    expect(backend).toContain("'GET /dashboard/api/fallback': handleGetFallback")
    expect(handler).toMatch(/defaults:\s*DEFAULT_FALLBACK_CHAINS/)
  })

  test('诊断启动入口已删除，只保留正常启动调用', () => {
    const api = readSource('packages/koishi-plugin-dashboard/frontend/src/api.ts')
    const control = readSource('packages/koishi-plugin-dashboard/frontend/src/components/ControlPanel.vue')

    expect(api).toMatch(/startBot\(\).*post\('\/bot\/start'/)
    expect(control).toMatch(/async function doStart\(\)[\s\S]*?await startBot\(\)/)
    expect(control).not.toMatch(/testStartBot|测试 startBot API/)
  })

  test('人格、世界观和黑白名单删除都先确认准确对象', () => {
    const persona = readSource('packages/koishi-plugin-dashboard/frontend/src/components/PersonaPanel.vue')
    const whitelist = readSource('packages/koishi-plugin-dashboard/frontend/src/components/WhitelistPanel.vue')
    const personaDeleteBody = sourceBetween(persona, 'async function doPersonaDelete', 'function resetLoreForm')
    const loreDeleteBody = sourceBetween(persona, 'async function doLoreDelete', 'const voicePersona')
    const whitelistDeleteBody = sourceBetween(whitelist, 'async function removeDisplayItem', 'return {')

    expect(personaDeleteBody).toMatch(/window\.confirm/)
    expect(loreDeleteBody).toMatch(/window\.confirm/)
    expect(whitelistDeleteBody).toMatch(/window\.confirm/)
  })

  test('部署进度携带管理员令牌并使用有界、非重叠轮询', () => {
    const api = readSource('packages/koishi-plugin-dashboard/frontend/src/api.ts')
    const deployPanel = readSource('packages/koishi-plugin-dashboard/frontend/src/components/DeployPanel.vue')
    const deployBackend = readSource('packages/koishi-plugin-dashboard/src/lib/routes/deploy.ts')
    const pollBody = sourceBetween(deployPanel, 'function clearProgressPolling()', 'function uploadCookie')

    expect(deployBackend).toMatch(/function handleGetDeployProgress[\s\S]*?requireAdmin\(req, res\)/)
    expect(api).toMatch(/getDeployProgress\(taskId: string\).*return get\('\/deploy\/progress\/' \+ encodeURIComponent\(taskId\), true\)/)
    expect(pollBody).toMatch(/code === 'ADMIN_REQUIRED'/)
    expect(pollBody).toMatch(/progressNetworkFailures >= 3/)
    expect(pollBody).toMatch(/setTimeout/)
    expect(pollBody).not.toMatch(/setInterval/)
  })

  test('管理员密码错误使用 403，只有普通 401 触发全局退出', () => {
    const api = readSource('packages/koishi-plugin-dashboard/frontend/src/api.ts')
    const authBackend = readSource('packages/koishi-plugin-dashboard/src/lib/routes/auth.ts')

    expect(authBackend).toMatch(/admin password is incorrect'[\s\S]*?ADMIN_PASSWORD_INCORRECT'[\s\S]*?403/)
    expect(api).toMatch(/verifyAdmin\(password: string\).*return post<[^>]+>\('\/admin\/verify'/)
    expect(api).toMatch(/function clearDashboardSession[\s\S]*?removeItem\('dashboard_token'\)[\s\S]*?auth-expired/)
    expect(api).toMatch(/function handle401[\s\S]*?res\.status === 401[\s\S]*?clearDashboardSession\(\)/)
  })

  test('修改任一种密码成功后立即清理两层会话', () => {
    const settingsPanel = readSource('packages/koishi-plugin-dashboard/frontend/src/components/SettingsPanel.vue')
    const authBackend = readSource('packages/koishi-plugin-dashboard/src/lib/routes/auth.ts')

    expect((authBackend.match(/rotateSessionSecret\(\)/g) || [])).toHaveLength(2)
    expect((settingsPanel.match(/clearDashboardSession\('密码已修改，请重新登录'\)/g) || [])).toHaveLength(2)
  })

  test('图集三类写操作都有单次管理员验证重试', () => {
    const gallery = readSource('packages/koishi-plugin-dashboard/frontend/src/components/GalleryPanel.vue')

    expect(gallery).toMatch(/await uploadGalleryImage\(/)
    expect(gallery).toMatch(/await deleteGalleryImage\(/)
    expect(gallery).toMatch(/await updateGalleryImageStyle\(/)
    expect(gallery).toMatch(/isAdminRequired\(res\)/)
    expect(gallery).toMatch(/showAdminDialog\('上传图集图片需要管理员密码'/)
    expect(gallery).toMatch(/showAdminDialog\('批量删除图集图片需要管理员密码'/)
    expect(gallery).toMatch(/showAdminDialog\('保存图集闪卡样式需要管理员密码'/)
  })

  test('资源维护、保护策略和取消任务都有确认及管理员验证闭环', () => {
    const resource = readSource('packages/koishi-plugin-dashboard/frontend/src/components/ResourcePanel.vue')
    const maintenanceBody = sourceBetween(resource, 'async function toggleMaintenance', 'async function setMode')
    const modeBody = sourceBetween(resource, 'async function setMode', 'async function cancelTask')
    const cancelBody = sourceBetween(resource, 'async function cancelTask', 'function startReads')

    expect(maintenanceBody).toMatch(/setResourceMaintenance\(/)
    expect(modeBody).toMatch(/setResourceMode\(/)
    expect(cancelBody).toMatch(/cancelResourceTask\(/)
    expect(maintenanceBody + modeBody + cancelBody).toMatch(/ADMIN_REQUIRED|isAdminRequired|showAdminDialog/)
    expect(maintenanceBody).toMatch(/window\.confirm/)
    expect(modeBody).toMatch(/window\.confirm/)
    expect(maintenanceBody).toMatch(/retried/)
    expect(modeBody).toMatch(/retried/)
    expect(cancelBody).toMatch(/retried/)
    expect(resource).not.toMatch(/reclaimResourceStale|回收 stale/)
  })

  test('普通 TTS 试听和测试克隆复用已读内容完成管理员重试', () => {
    const persona = readSource('packages/koishi-plugin-dashboard/frontend/src/components/PersonaPanel.vue')
    const previewBody = sourceBetween(persona, 'async function doPreview', 'function onCloneFileChange')
    const cloneBody = sourceBetween(persona, 'async function submitCloneUpload', 'async function doPreviewAsset')

    expect(previewBody).toMatch(/await ttsPreview\(/)
    expect(cloneBody).toMatch(/await ttsClone\(/)
    expect(previewBody).toMatch(/ADMIN_REQUIRED|isAdminRequired|showAdminDialog/)
    expect(cloneBody).toMatch(/ADMIN_REQUIRED|isAdminRequired|showAdminDialog/)
    expect(cloneBody).toMatch(/submitCloneUpload\(base64, mimeType, personaName, metadata, true\)/)
  })

  test('Fallback 保存接口统一执行严格的三链引用校验', () => {
    const settings = readSource('packages/koishi-plugin-dashboard/src/lib/routes/settings.ts')
    const handlerBody = sourceBetween(settings, 'function handlePutFallback', 'function handleGetAdminIds')

    expect(handlerBody).toMatch(/normalizeFallbackChains\(chains\)/)
    expect(settings).toMatch(/引用未知供应商/)
    expect(settings).toMatch(/引用供应商未登记模型/)
    expect(settings).toMatch(/Key 文件名无效/)
  })

  test('更换 QQ 号文案、原子写、重启和健康检查语义一致', () => {
    const control = readSource('packages/koishi-plugin-dashboard/frontend/src/components/ControlPanel.vue')
    const botBackend = readSource('packages/koishi-plugin-dashboard/src/lib/routes/bot.ts')

    expect(control).toMatch(/@click="saveSelfId\(\)"[\s\S]*?更换 QQ 号并重启机器人/)
    expect(control).toMatch(/window\.confirm\([\s\S]*?短暂离线/)
    expect(botBackend).toMatch(/function writeConfigAtomic[\s\S]*?renameSync\(nextPath, filePath\)/)
    expect(botBackend).toMatch(/function handlePutQqSelfId[\s\S]*?writeConfigAtomic\(ymlPath, nextYml\)[\s\S]*?机器人已通过重启健康检查/)
  })

  test('普通发布不携带 B 站 cookies，执行入口只接受已确认预览', () => {
    const deployBackend = readSource('packages/koishi-plugin-dashboard/src/lib/routes/deploy.ts')
    const release = readSource('packages/koishi-plugin-dashboard/src/lib/release.ts')
    const api = readSource('packages/koishi-plugin-dashboard/frontend/src/api.ts')

    expect(deployBackend).toMatch(/'POST \/dashboard\/api\/deploy\/preview': handlePostDeployPreview/)
    expect(deployBackend).toMatch(/'POST \/dashboard\/api\/deploy\/run': handlePostSafeDeployRun/)
    expect(deployBackend).toMatch(/validateRemoteReleasePreview\([\s\S]*?previewId: input\.previewId[\s\S]*?confirmed: input\.confirmed/)
    expect(api).toMatch(/previewDeploy\(data: unknown\).*post\('\/deploy\/preview', data, true/)
    expect(deployBackend).not.toMatch(/scpCommand\([^\n]*bilibili-cookies\.txt/)
    expect(release).not.toContain('bilibili-cookies.txt')
  })

  test('远端预览完整校验当前清单并冻结提交、基线和有效期', () => {
    const remoteRelease = readSource('packages/koishi-plugin-dashboard/src/lib/remote-release.ts')
    const remoteTarget = readSource('packages/koishi-plugin-dashboard/src/lib/remote-target.ts')

    expect(remoteRelease).toMatch(/git'[\s\S]*?'status'[\s\S]*?'--porcelain=v1'/)
    expect(remoteRelease).toMatch(/verify-release-manifest\.js/)
    expect(remoteRelease).toMatch(/PREVIEW_TTL_MS = 30 \* 60 \* 1000/)
    expect(remoteRelease).toMatch(/compareRemoteBaseline/)
    expect(remoteTarget).toContain('StrictHostKeyChecking=accept-new')
    expect(remoteTarget).not.toContain('StrictHostKeyChecking=no')
    expect(remoteRelease).not.toContain("createHash('md5')")
  })
})
