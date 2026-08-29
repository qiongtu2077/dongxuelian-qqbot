import { flushPromises, mount } from '@vue/test-utils'
import WhitelistPanel from '../../../packages/koishi-plugin-dashboard/frontend/src/components/WhitelistPanel.vue'
import * as dashboardApi from '../../../packages/koishi-plugin-dashboard/frontend/src/api'

jest.mock('../../../packages/koishi-plugin-dashboard/frontend/src/api', () => ({
  fetchWhitelist: jest.fn(),
  updateWhitelist: jest.fn(),
}))

describe('WhitelistPanel 删除与刷新闭环', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    dashboardApi.fetchWhitelist.mockResolvedValue({
      ok: true,
      data: { userBlacklist: { label: '用户黑名单', data: ['123456'] } },
    })
    dashboardApi.updateWhitelist.mockResolvedValue({ ok: true, data: { message: 'saved' } })
  })

  test('删除前确认准确对象，确认后才提交新名单', async () => {
    const confirmSpy = jest.spyOn(window, 'confirm').mockReturnValue(true)
    const wrapper = mount(WhitelistPanel, { global: { provide: { showAdminDialog: jest.fn() } } })
    await flushPromises()
    const deleteButton = wrapper.findAll('button').find(button => button.text() === '删除')

    await deleteButton.trigger('click')
    await flushPromises()

    expect(confirmSpy).toHaveBeenCalledWith('确定从“用户黑名单”删除条目“123456”吗？')
    expect(dashboardApi.updateWhitelist).toHaveBeenCalledWith('userBlacklist', [])
    wrapper.unmount()
  })

  test('取消删除不发送请求且保留条目', async () => {
    jest.spyOn(window, 'confirm').mockReturnValue(false)
    const wrapper = mount(WhitelistPanel, { global: { provide: { showAdminDialog: jest.fn() } } })
    await flushPromises()

    await wrapper.findAll('button').find(button => button.text() === '删除').trigger('click')

    expect(dashboardApi.updateWhitelist).not.toHaveBeenCalled()
    expect(wrapper.text()).toContain('123456')
    wrapper.unmount()
  })

  test('后端删除失败时保留条目并显示错误', async () => {
    jest.spyOn(window, 'confirm').mockReturnValue(true)
    dashboardApi.updateWhitelist.mockResolvedValueOnce({ ok: false, data: { message: '删除被拒绝' } })
    const wrapper = mount(WhitelistPanel, { global: { provide: { showAdminDialog: jest.fn() } } })
    await flushPromises()

    await wrapper.findAll('button').find(button => button.text() === '删除').trigger('click')
    await flushPromises()

    expect(wrapper.text()).toContain('删除被拒绝')
    expect(wrapper.text()).toContain('123456')
    wrapper.unmount()
  })

  test('管理员过期后沿用删除确认并只重试原名单一次', async () => {
    let resume
    const showAdminDialog = jest.fn((_message, callback) => { resume = callback })
    jest.spyOn(window, 'confirm').mockReturnValue(true)
    dashboardApi.updateWhitelist
      .mockResolvedValueOnce({ ok: false, code: 'ADMIN_REQUIRED', data: { code: 'ADMIN_REQUIRED' } })
      .mockResolvedValueOnce({ ok: true, data: { message: 'saved' } })
    dashboardApi.fetchWhitelist
      .mockResolvedValueOnce({ ok: true, data: { userBlacklist: { label: '用户黑名单', data: ['123456'] } } })
      .mockResolvedValueOnce({ ok: true, data: { userBlacklist: { label: '用户黑名单', data: [] } } })
    const wrapper = mount(WhitelistPanel, { global: { provide: { showAdminDialog } } })
    await flushPromises()

    await wrapper.findAll('button').find(button => button.text() === '删除').trigger('click')
    await flushPromises()
    await resume()
    await flushPromises()

    expect(window.confirm).toHaveBeenCalledTimes(1)
    expect(showAdminDialog).toHaveBeenCalledTimes(1)
    expect(dashboardApi.updateWhitelist).toHaveBeenCalledTimes(2)
    expect(wrapper.text()).not.toContain('123456')
    wrapper.unmount()
  })

  test('管理员验证取消后不重试并保留名单条目', async () => {
    const showAdminDialog = jest.fn()
    jest.spyOn(window, 'confirm').mockReturnValue(true)
    dashboardApi.updateWhitelist.mockResolvedValue({ ok: false, code: 'ADMIN_REQUIRED', data: { code: 'ADMIN_REQUIRED' } })
    const wrapper = mount(WhitelistPanel, { global: { provide: { showAdminDialog } } })
    await flushPromises()

    await wrapper.findAll('button').find(button => button.text() === '删除').trigger('click')
    await flushPromises()

    expect(showAdminDialog).toHaveBeenCalledTimes(1)
    expect(dashboardApi.updateWhitelist).toHaveBeenCalledTimes(1)
    expect(wrapper.text()).toContain('123456')
    wrapper.unmount()
  })

  test('手动刷新失败只显示错误，不显示成功文案', async () => {
    const wrapper = mount(WhitelistPanel, { global: { provide: { showAdminDialog: jest.fn() } } })
    await flushPromises()
    dashboardApi.fetchWhitelist.mockResolvedValueOnce({
      ok: false,
      data: { message: '读取名单失败' },
    })

    const refreshButton = wrapper.findAll('button').find(button => button.text() === '刷新全部')
    await refreshButton.trigger('click')
    await flushPromises()

    expect(wrapper.text()).toContain('读取名单失败')
    expect(wrapper.text()).not.toContain('已刷新')
    wrapper.unmount()
  })
})
