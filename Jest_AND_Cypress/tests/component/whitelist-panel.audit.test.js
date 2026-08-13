import { flushPromises, mount } from '@vue/test-utils'
import WhitelistPanel from '../../../packages/koishi-plugin-dashboard/frontend/src/components/WhitelistPanel.vue'
import * as dashboardApi from '../../../packages/koishi-plugin-dashboard/frontend/src/api'

jest.mock('../../../packages/koishi-plugin-dashboard/frontend/src/api', () => ({
  fetchWhitelist: jest.fn(),
  updateWhitelist: jest.fn(),
}))

describe('WhitelistPanel 当前删除行为审查', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    dashboardApi.fetchWhitelist.mockResolvedValue({
      ok: true,
      data: { userBlacklist: { label: '用户黑名单', data: ['123456'] } },
    })
    dashboardApi.updateWhitelist.mockResolvedValue({ ok: true, data: { message: 'saved' } })
  })

  test('已确认：点击删除不二次确认就直接提交新名单', async () => {
    const confirmSpy = jest.spyOn(window, 'confirm').mockReturnValue(true)
    const wrapper = mount(WhitelistPanel, { global: { provide: { showAdminDialog: jest.fn() } } })
    await flushPromises()
    const deleteButton = wrapper.findAll('button').find(button => button.text() === '删除')

    await deleteButton.trigger('click')
    await flushPromises()

    expect(confirmSpy).not.toHaveBeenCalled()
    expect(dashboardApi.updateWhitelist).toHaveBeenCalledWith('userBlacklist', [])
    wrapper.unmount()
  })

  test('已确认：手动刷新失败时仍同时显示“已刷新”', async () => {
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
    expect(wrapper.text()).toContain('已刷新')
    wrapper.unmount()
  })
})
