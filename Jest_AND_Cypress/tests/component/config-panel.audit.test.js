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

describe('ConfigPanel 备用链目标行为', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    localStorage.clear()
    arrangeConfigResponses()
  })

  test('读取真实 defaults 字段并能把单卡恢复为默认链', async () => {
    const wrapper = mount(ConfigPanel, { global: { provide: { showAdminDialog: jest.fn() } } })
    await flushPromises()
    const card = findCard(wrapper, '聊天 Fallback')
    expect(card).toBeDefined()
    expect(card.findAll('.sb-wrap')).toHaveLength(2)

    const reset = card.findAll('button').find(button => button.text() === '重置为默认')
    await reset.trigger('click')

    expect(card.findAll('.sb-wrap')).toHaveLength(2)
    expect(card.text()).toContain('default-chat')
    expect(card.text()).not.toContain('current-chat')
    expect(wrapper.text()).toContain('已恢复默认，尚未保存')
    wrapper.unmount()
  })

  test('三张编辑卡只有一个全量保存入口', async () => {
    const wrapper = mount(ConfigPanel, { global: { provide: { showAdminDialog: jest.fn() } } })
    await flushPromises()
    const saveButtons = wrapper.findAll('button').filter(button => button.text() === '保存全部备用链')
    expect(saveButtons).toHaveLength(1)

    await saveButtons[0].trigger('click')
    await flushPromises()

    expect(dashboardApi.saveFallbackChains).toHaveBeenCalledTimes(1)
    expect(Object.keys(dashboardApi.saveFallbackChains.mock.calls[0][0]).sort()).toEqual(['chat', 'lightweight', 'vision'])
    wrapper.unmount()
  })

  test('无效主模型兜底开关和浏览器存储键已删除', async () => {
    const wrapper = mount(ConfigPanel, { global: { provide: { showAdminDialog: jest.fn() } } })
    await flushPromises()
    const saveButton = wrapper.findAll('button').find(button => button.text() === '保存全部备用链')

    await saveButton.trigger('click')
    await flushPromises()

    expect(wrapper.find('input[type="checkbox"]').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('主模型兜底（最后试一次主模型）')
    expect(localStorage.getItem('cfg_lightweight_main')).toBeNull()
    const payload = dashboardApi.saveFallbackChains.mock.calls[0][0]
    expect(payload).not.toHaveProperty('useMainFallback')
    expect(payload.lightweight).toEqual(chains.lightweight)
    wrapper.unmount()
  })
})
