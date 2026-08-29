import { flushPromises, mount } from '@vue/test-utils'
import KeyManager from '../../../packages/koishi-plugin-dashboard/frontend/src/components/KeyManager.vue'
import * as dashboardApi from '../../../packages/koishi-plugin-dashboard/frontend/src/api'

jest.mock('../../../packages/koishi-plugin-dashboard/frontend/src/api', () => ({
  fetchCustomProviders: jest.fn(),
  fetchFallbackChains: jest.fn(),
  fetchKeys: jest.fn(),
  fetchKeysUsage: jest.fn(),
  fetchProviders: jest.fn(),
  saveApiConfigTransaction: jest.fn(),
  updateKey: jest.fn(),
}))

const PROVIDER = {
  id: 'openai-official',
  name: 'OpenAI 官方',
  baseURL: 'https://api.openai.com/v1',
  keyFile: 'ai-openai-official-key.txt',
  models: [
    { id: 'gpt-4o', name: 'GPT-4o', vision: true },
    { id: 'gpt-4o-mini', name: 'GPT-4o mini', vision: true },
  ],
}
const SAVED_CHAINS = {
  chat: [{ provider: PROVIDER.id, model: 'gpt-4o', keyFile: PROVIDER.keyFile }],
  vision: [{ provider: PROVIDER.id, model: 'gpt-4o', keyFile: PROVIDER.keyFile }],
  lightweight: [{ provider: PROVIDER.id, model: 'gpt-4o-mini', keyFile: PROVIDER.keyFile }],
}

// Supplies empty API configuration and usage data for component mount.
function arrangeKeyManagerReads() {
  dashboardApi.fetchKeys.mockResolvedValue({ ok: true, data: [] })
  dashboardApi.fetchKeysUsage.mockResolvedValue({ ok: true, data: { days: [], providers: [], models: [] } })
  dashboardApi.fetchProviders.mockResolvedValue({ ok: true, data: {} })
  dashboardApi.fetchFallbackChains.mockResolvedValue({ ok: true, data: { chains: { chat: [], vision: [], lightweight: [] }, defaults: {} } })
  dashboardApi.fetchCustomProviders.mockResolvedValue({ ok: true, data: [] })
}

// Mounts the manager and opens the complete-provider transaction dialog.
async function mountProviderDialog(showAdminDialog = jest.fn()) {
  const wrapper = mount(KeyManager, { global: { provide: { showAdminDialog } } })
  await flushPromises()
  await wrapper.find('button[title="新增 API 配置"]').trigger('click')
  return wrapper
}

// Configures the four post-commit reads to match the expected transaction.
function arrangeMatchingReadback(expectKey = false) {
  dashboardApi.fetchCustomProviders.mockResolvedValue({ ok: true, data: [PROVIDER] })
  dashboardApi.fetchFallbackChains.mockResolvedValue({ ok: true, data: { chains: SAVED_CHAINS, defaults: {} } })
  dashboardApi.fetchProviders.mockResolvedValue({ ok: true, data: { [PROVIDER.id]: PROVIDER } })
  dashboardApi.fetchKeys.mockResolvedValue({
    ok: true,
    data: expectKey ? [{ providerId: PROVIDER.id, file: PROVIDER.keyFile, exists: true }] : [],
  })
}

describe('KeyManager API 配置完整事务', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    arrangeKeyManagerReads()
  })

  test('新增供应商只提交一次完整事务，四项回读一致后才关闭', async () => {
    dashboardApi.saveApiConfigTransaction.mockResolvedValue({ ok: true, data: { message: 'committed' } })
    const wrapper = await mountProviderDialog()
    arrangeMatchingReadback()

    await wrapper.findAll('button').find(button => button.text() === '保存配置').trigger('click')
    await flushPromises()

    expect(dashboardApi.saveApiConfigTransaction).toHaveBeenCalledTimes(1)
    expect(dashboardApi.saveApiConfigTransaction).toHaveBeenCalledWith([PROVIDER], PROVIDER.id, undefined, SAVED_CHAINS)
    expect(dashboardApi.updateKey).not.toHaveBeenCalled()
    expect(wrapper.find('.modal-backdrop').exists()).toBe(false)
    wrapper.unmount()
  })

  test('管理员过期后保留完整草稿并只重试同一事务', async () => {
    let resume
    const showAdminDialog = jest.fn((_message, callback) => { resume = callback })
    dashboardApi.saveApiConfigTransaction
      .mockResolvedValueOnce({ ok: false, code: 'ADMIN_REQUIRED', data: { code: 'ADMIN_REQUIRED' } })
      .mockResolvedValueOnce({ ok: true, data: { message: 'committed' } })
    const wrapper = await mountProviderDialog(showAdminDialog)
    await wrapper.find('.modal-panel input[type="password"]').setValue('sk-sensitive')
    arrangeMatchingReadback(true)

    await wrapper.findAll('button').find(button => button.text() === '保存配置').trigger('click')
    await flushPromises()
    expect(wrapper.find('.modal-panel input[type="password"]').element.value).toBe('sk-sensitive')
    await resume()
    await flushPromises()

    expect(dashboardApi.saveApiConfigTransaction).toHaveBeenCalledTimes(2)
    expect(dashboardApi.saveApiConfigTransaction.mock.calls[1][2]).toBe('sk-sensitive')
    expect(wrapper.find('.modal-backdrop').exists()).toBe(false)
    wrapper.unmount()
  })

  test('管理员验证后事务仍被拒绝时停止重试并保留对话框', async () => {
    let resume
    const showAdminDialog = jest.fn((_message, callback) => { resume = callback })
    dashboardApi.saveApiConfigTransaction.mockResolvedValue({ ok: false, code: 'ADMIN_REQUIRED', data: { code: 'ADMIN_REQUIRED' } })
    const wrapper = await mountProviderDialog(showAdminDialog)

    await wrapper.findAll('button').find(button => button.text() === '保存配置').trigger('click')
    await flushPromises()
    await resume()
    await flushPromises()

    expect(showAdminDialog).toHaveBeenCalledTimes(1)
    expect(dashboardApi.saveApiConfigTransaction).toHaveBeenCalledTimes(2)
    expect(wrapper.text()).toContain('管理员验证后完整保存仍被拒绝')
    expect(wrapper.find('.modal-backdrop').exists()).toBe(true)
    wrapper.unmount()
  })

  test('事务后端失败时保留全部输入并明确旧配置已恢复', async () => {
    dashboardApi.saveApiConfigTransaction.mockResolvedValue({
      ok: false,
      data: { message: 'API 配置未生效，旧配置已恢复' },
    })
    const wrapper = await mountProviderDialog()
    await wrapper.find('.modal-panel input[type="password"]').setValue('sk-sensitive')

    await wrapper.findAll('button').find(button => button.text() === '保存配置').trigger('click')
    await flushPromises()

    expect(wrapper.text()).toContain('API 配置未生效，旧配置已恢复')
    expect(wrapper.find('.modal-panel input[type="password"]').element.value).toBe('sk-sensitive')
    expect(wrapper.find('.modal-backdrop').exists()).toBe(true)
    wrapper.unmount()
  })

  test('事务成功但回读不一致时保留对话框并要求人工检查', async () => {
    dashboardApi.saveApiConfigTransaction.mockResolvedValue({ ok: true, data: { message: 'committed' } })
    const wrapper = await mountProviderDialog()

    await wrapper.findAll('button').find(button => button.text() === '保存配置').trigger('click')
    await flushPromises()

    expect(wrapper.text()).toContain('API 配置已提交，但回读不一致，请保持页面并人工检查')
    expect(wrapper.find('.modal-backdrop').exists()).toBe(true)
    wrapper.unmount()
  })
})
