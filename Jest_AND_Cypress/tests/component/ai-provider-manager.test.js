import { defineComponent, h, ref } from 'vue'
import { flushPromises, mount } from '@vue/test-utils'
import AiProviderManager from '../../../packages/koishi-plugin-dashboard/frontend/src/components/AiProviderManager.vue'
import * as dashboardApi from '../../../packages/koishi-plugin-dashboard/frontend/src/api'

jest.mock('../../../packages/koishi-plugin-dashboard/frontend/src/api', () => ({
  deleteAiProviderKey: jest.fn(), detectAiModelCapabilities: jest.fn(), discoverAiProviderModels: jest.fn(),
  isAdminRequired: jest.fn(() => false), saveAiProviderKey: jest.fn(),
}))

const capabilities = ['text', 'vision', 'voice-asr', 'voice-tts']
const provider = { id: 'custom-checks', name: '测试供应商', custom: true, discoveryAvailable: true, supportedCapabilities: capabilities }

// 构造完整四能力状态，复现后端 HTTP 错误被标记 unsupported 的实际返回。
function modelWithCheck(id, status = 'pending', reason = '等待接口能力检测') {
  return { id, name: id, capabilities: [], capabilityChecks: Object.fromEntries(capabilities.map(capability => [capability, { status, reason }])) }
}

// 为展示测试生成独立配置，不访问线上服务或保存真实 Key。
function configWithModels(models) {
  return { version: 1, capabilities, providers: { [provider.id]: { key: { configured: true, prefix: 'sk-test****' }, models } }, priorities: Object.fromEntries(capabilities.map(capability => [capability, []])) }
}

// 通过真实更新事件回传父组件配置，验证逐项统计随检测返回更新。
function mountManager(config, catalog = [provider]) {
  return mount(defineComponent({
    setup() {
      const current = ref(config)
      return () => h(AiProviderManager, { config: current.value, catalog, onUpdated: next => { current.value = next } })
    },
  }), { global: { provide: { showAdminDialog: jest.fn() } } })
}

// 从用户可见入口打开检测详情。
async function openModels(wrapper) {
  await wrapper.findAll('button').find(button => button.text() === '管理模型').trigger('click')
  return wrapper.find('dialog[aria-labelledby="managed-models-title"]')
}

describe('供应商能力检测结果展示', () => {
  let wrapper
  // jsdom 不实现原生 dialog 方法；仅补齐本文件用到的打开和关闭行为。
  beforeAll(() => {
    Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value: function showModal() { this.setAttribute('open', '') } })
    Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value: function close() { this.removeAttribute('open') } })
  })
  afterAll(() => { delete HTMLDialogElement.prototype.showModal; delete HTMLDialogElement.prototype.close })
  afterEach(() => { wrapper?.unmount() })

  test('未检测、失败、确认分别展示，失败原因直接可见并保留已有能力', async () => {
    const model = modelWithCheck('混合结果模型')
    model.capabilities = ['text', 'vision']
    model.capabilityChecks.text = { status: 'supported', reason: '接口请求及返回格式验证通过' }
    model.capabilityChecks.vision = { status: 'unsupported', reason: '接口检测 HTTP 404' }
    model.capabilityChecks['voice-asr'] = { status: 'pending', reason: '能力检测超时，请重试' }
    const config = configWithModels([model]), before = JSON.stringify(config)
    wrapper = mountManager(config)
    expect(wrapper.find('.provider-results').text()).toContain('已确认 1 项')
    expect(wrapper.find('.provider-results').text()).toContain('检测失败 2 项')
    expect(wrapper.find('.provider-results').text()).toContain('未检测 1 项')
    expect(wrapper.find('.failure-reason').text()).toContain('未找到接口或模型')
    const dialog = await openModels(wrapper)
    expect(dialog.find('.detection-summary').text()).toContain('共 4 项能力')
    expect(dialog.findAll('.capability-result').map(cell => cell.find('strong').text())).toEqual(['已确认', '检测失败', '检测失败', '未检测'])
    expect(dialog.findAll('.capability-result')[1].text()).toContain('是否需要包含 /v1')
    expect(dialog.findAll('.capability-result')[2].text()).toContain('未在检测时限内返回')
    expect(JSON.stringify(config)).toBe(before)
  })

  test('截图中的十个模型全部 404 时显示 40 项失败，并合并重复原因', async () => {
    wrapper = mountManager(configWithModels(Array.from({ length: 10 }, (_, index) => modelWithCheck(String(index), 'unsupported', '接口检测 HTTP 404'))))
    const dialog = await openModels(wrapper)
    expect(dialog.find('.detection-summary').text()).toContain('10 个模型，共 40 项能力：已确认 0 项，检测失败 40 项，未检测 0 项')
    expect(dialog.findAll('.failure-list li')).toHaveLength(1)
    expect(dialog.find('.failure-list').text()).toContain('40 项：未找到接口或模型')
    expect(dialog.findAll('.capability-result.failed')).toHaveLength(40)
  })

  test('内置目录和已有自定义标签区分证据来源', async () => {
    const model = { id: 'legacy', name: '旧模型', capabilities: ['text'] }
    wrapper = mountManager(configWithModels([model]))
    let dialog = await openModels(wrapper)
    expect(dialog.find('.detection-summary').text()).toContain('已确认 0 项，检测失败 0 项，未检测 4 项')
    wrapper.unmount()
    wrapper = mountManager(configWithModels([model]), [{ ...provider, custom: false }])
    dialog = await openModels(wrapper)
    expect(dialog.find('.detection-summary').text()).toContain('已确认 1 项，检测失败 0 项，未检测 3 项')
    expect(dialog.find('.capability-result.confirmed').text()).toContain('当前 Key 的调用权限仍需实际请求验证')
  })

  test('重新检测全失败时使用最新响应计数，并在列表与弹窗显示警示结果', async () => {
    const next = configWithModels([modelWithCheck('模型', 'unsupported', '接口检测 HTTP 404')])
    dashboardApi.detectAiModelCapabilities.mockResolvedValue({ ok: true, data: { config: next } })
    wrapper = mountManager(configWithModels([modelWithCheck('模型')]))
    const dialog = await openModels(wrapper)
    await dialog.findAll('button').find(button => button.text() === '重新检测全部能力').trigger('click')
    await flushPromises()
    expect(dashboardApi.detectAiModelCapabilities).toHaveBeenCalledWith(provider.id, '模型')
    expect(dialog.find('.notice.warning').text()).toContain('已检测 1 / 1 个模型')
    expect(dialog.find('.notice.warning').text()).toContain('已确认 0 项，检测失败 4 项，未检测 0 项')
    expect(wrapper.findAll('.notice.success')).toHaveLength(0)
    expect(wrapper.text()).not.toContain('四项能力检测完成')
  })

  test('全部检测通过时显示真实确认数量', async () => {
    const next = configWithModels([modelWithCheck('模型', 'supported', '接口请求及返回格式验证通过')])
    dashboardApi.detectAiModelCapabilities.mockResolvedValue({ ok: true, data: { config: next } })
    wrapper = mountManager(configWithModels([modelWithCheck('模型')]))
    const dialog = await openModels(wrapper)
    await dialog.findAll('button').find(button => button.text() === '重新检测全部能力').trigger('click')
    await flushPromises()
    expect(dialog.find('.notice.success').text()).toContain('已确认 4 项，检测失败 0 项，未检测 0 项')
    expect(dialog.findAll('.capability-result.confirmed')).toHaveLength(4)
  })

  test('中途停止时保留未检测数量，不把后续模型标为失败或确认', async () => {
    let finish
    dashboardApi.detectAiModelCapabilities.mockImplementation(() => new Promise(resolve => { finish = resolve }))
    wrapper = mountManager(configWithModels([modelWithCheck('一'), modelWithCheck('二')]))
    const dialog = await openModels(wrapper)
    await dialog.findAll('button').find(button => button.text() === '重新检测全部能力').trigger('click')
    await dialog.findAll('button').find(button => button.text() === '停止检测').trigger('click')
    finish({ ok: true, data: { config: configWithModels([modelWithCheck('一', 'supported', '接口请求及返回格式验证通过'), modelWithCheck('二')]) } })
    await flushPromises()
    expect(dashboardApi.detectAiModelCapabilities).toHaveBeenCalledTimes(1)
    expect(dialog.find('.notice.warning').text()).toContain('已停止后续检测，已检测 1 / 2 个模型')
    expect(dialog.find('.notice.warning').text()).toContain('已确认 4 项，检测失败 0 项，未检测 4 项')
  })

  test('检测请求整体失败时显示错误，不显示本轮成功结束', async () => {
    dashboardApi.detectAiModelCapabilities.mockResolvedValue({ ok: false, data: { message: 'Key 已变更，请重新检测' } })
    wrapper = mountManager(configWithModels([modelWithCheck('模型')]))
    const dialog = await openModels(wrapper)
    await dialog.findAll('button').find(button => button.text() === '重新检测全部能力').trigger('click')
    await flushPromises()
    expect(dialog.find('.notice.error').text()).toContain('Key 已变更，请重新检测')
    expect(dialog.find('.detection-summary').text()).toContain('未检测 4 项')
    expect(wrapper.text()).not.toContain('本轮检测结束')
  })
})
