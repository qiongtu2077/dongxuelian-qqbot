import { flushPromises, mount } from '@vue/test-utils'
import ConfigPanel from '../../../packages/koishi-plugin-dashboard/frontend/src/components/ConfigPanel.vue'
import * as dashboardApi from '../../../packages/koishi-plugin-dashboard/frontend/src/api'

jest.mock('../../../packages/koishi-plugin-dashboard/frontend/src/api', () => ({
  fetchConfig: jest.fn(),
  fetchProviders: jest.fn(),
  updateConfig: jest.fn(),
  fetchFallbackChains: jest.fn(),
  saveFallbackChains: jest.fn(),
  fetchCustomProviders: jest.fn(),
  saveCustomProviders: jest.fn(),
}))

const chains = {
  chat: [{ provider: 'deepseek', model: 'current-chat', keyFile: 'ai-deepseek-key.txt' }],
  vision: [{ provider: 'deepseek', model: 'current-vision', keyFile: 'ai-deepseek-key.txt' }],
  lightweight: [{ provider: 'deepseek', model: 'current-lite', keyFile: 'ai-deepseek-key.txt' }],
}

const defaults = {
  chat: [{ provider: 'deepseek', model: 'default-chat', keyFile: 'ai-deepseek-key.txt' }],
  vision: [{ provider: 'deepseek', model: 'default-vision', keyFile: 'ai-deepseek-key.txt' }],
  lightweight: [{ provider: 'deepseek', model: 'default-lite', keyFile: 'ai-deepseek-key.txt' }],
}

// 返回与真实后端字段一致的模型配置响应。
function arrangeConfigResponses() {
  dashboardApi.fetchProviders.mockResolvedValue({
    ok: true,
    data: {
      deepseek: {
        name: 'DeepSeek',
        models: [
          { id: 'current-chat' }, { id: 'current-vision', vision: true }, { id: 'current-lite' },
          { id: 'default-chat' }, { id: 'default-vision', vision: true }, { id: 'default-lite' },
        ],
      },
    },
  })
  dashboardApi.fetchConfig.mockResolvedValue({ ok: true, data: { provider: 'deepseek', model: 'current-chat', baseUrl: '' } })
  dashboardApi.fetchFallbackChains.mockResolvedValue({ ok: true, data: { chains, defaults } })
  dashboardApi.fetchCustomProviders.mockResolvedValue({ ok: true, data: [] })
  dashboardApi.saveFallbackChains.mockResolvedValue({ ok: true, data: { message: 'saved' } })
}

// 按标题定位指定卡片，避免依赖卡片的物理序号。
function findCard(wrapper, title) {
  return wrapper.findAll('.card').find(card => card.find('h2').text() === title)
}

describe('ConfigPanel 当前按钮行为审查', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    localStorage.clear()
    arrangeConfigResponses()
  })

  test('已确认：真实 defaults 字段未被读取，重置会把当前链清空', async () => {
    const wrapper = mount(ConfigPanel, { global: { provide: { showAdminDialog: jest.fn() } } })
    await flushPromises()
    const card = findCard(wrapper, '聊天 Fallback')
    expect(card).toBeDefined()
    expect(card.findAll('.sb-wrap')).toHaveLength(2)

    const reset = card.findAll('button').find(button => button.text() === '重置为默认')
    await reset.trigger('click')

    expect(card.findAll('.sb-wrap')).toHaveLength(0)
    wrapper.unmount()
  })

  test('已确认：三张卡各有保存按钮，但任一按钮都会提交全部三条链', async () => {
    const wrapper = mount(ConfigPanel, { global: { provide: { showAdminDialog: jest.fn() } } })
    await flushPromises()
    const saveButtons = wrapper.findAll('button').filter(button => /^保存 .*Fallback$/.test(button.text()))
    expect(saveButtons).toHaveLength(3)

    await saveButtons[0].trigger('click')
    await flushPromises()

    expect(dashboardApi.saveFallbackChains).toHaveBeenCalledTimes(1)
    expect(Object.keys(dashboardApi.saveFallbackChains.mock.calls[0][0]).sort()).toEqual(['chat', 'lightweight', 'vision'])
    wrapper.unmount()
  })

  test('已确认：主模型兜底开关只写浏览器，不进入保存接口', async () => {
    const wrapper = mount(ConfigPanel, { global: { provide: { showAdminDialog: jest.fn() } } })
    await flushPromises()
    const toggle = wrapper.find('input[type="checkbox"]')
    await toggle.setValue(false)
    const saveButton = wrapper.findAll('button').find(button => button.text() === '保存 轻量功能 Fallback')

    await saveButton.trigger('click')
    await flushPromises()

    expect(localStorage.getItem('cfg_lightweight_main')).toBe('0')
    const payload = dashboardApi.saveFallbackChains.mock.calls[0][0]
    expect(payload).not.toHaveProperty('useMainFallback')
    expect(payload.lightweight).toEqual(chains.lightweight)
    wrapper.unmount()
  })
})
