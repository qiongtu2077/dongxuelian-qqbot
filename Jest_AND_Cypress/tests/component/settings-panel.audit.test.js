import { flushPromises, mount } from '@vue/test-utils'
import SettingsPanel from '../../../packages/koishi-plugin-dashboard/frontend/src/components/SettingsPanel.vue'
import * as dashboardApi from '../../../packages/koishi-plugin-dashboard/frontend/src/api'

jest.mock('../../../packages/koishi-plugin-dashboard/frontend/src/api', () => ({
  changePassword: jest.fn(),
  clearDashboardSession: jest.fn(),
}))

// Mounts the browser settings view with the supplied administrator dialog.
function mountSettings(showAdminDialog = jest.fn()) {
  return mount(SettingsPanel, {
    global: { provide: { isElectronDeployer: false, showAdminDialog } },
  })
}

describe('SettingsPanel 密码变更认证闭环', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  test('访问密码修改成功后立即清除两层会话并返回登录流程', async () => {
    dashboardApi.changePassword.mockResolvedValue({ ok: true, data: { message: '访问密码已更新' } })
    const wrapper = mountSettings()
    await wrapper.find('input[placeholder="新访问密码"]').setValue('new-access')

    await wrapper.findAll('button').find(button => button.text() === '修改访问密码').trigger('click')
    await flushPromises()

    expect(dashboardApi.changePassword).toHaveBeenCalledWith('access', '', 'new-access')
    expect(dashboardApi.clearDashboardSession).toHaveBeenCalledWith('密码已修改，请重新登录')
    expect(wrapper.find('input[placeholder="新访问密码"]').element.value).toBe('')
    wrapper.unmount()
  })

  test('管理员密码修改成功后立即清除会话且清空密码输入', async () => {
    dashboardApi.changePassword.mockResolvedValue({ ok: true, data: { message: '管理员密码已更新' } })
    const wrapper = mountSettings()
    await wrapper.find('input[placeholder="当前管理员密码"]').setValue('old-admin')
    await wrapper.find('input[placeholder="新管理员密码"]').setValue('new-admin')

    await wrapper.findAll('button').find(button => button.text() === '修改管理员密码').trigger('click')
    await flushPromises()

    expect(dashboardApi.changePassword).toHaveBeenCalledWith('admin', 'old-admin', 'new-admin')
    expect(dashboardApi.clearDashboardSession).toHaveBeenCalledWith('密码已修改，请重新登录')
    expect(wrapper.find('input[placeholder="当前管理员密码"]').element.value).toBe('')
    expect(wrapper.find('input[placeholder="新管理员密码"]').element.value).toBe('')
    wrapper.unmount()
  })

  test('管理员密码错误保留页面、输入和普通会话', async () => {
    dashboardApi.changePassword.mockResolvedValue({
      ok: false,
      code: 'ADMIN_PASSWORD_INVALID',
      data: { code: 'ADMIN_PASSWORD_INVALID', message: '当前管理员密码错误' },
    })
    const wrapper = mountSettings()
    await wrapper.find('input[placeholder="当前管理员密码"]').setValue('wrong-admin')
    await wrapper.find('input[placeholder="新管理员密码"]').setValue('new-admin')

    await wrapper.findAll('button').find(button => button.text() === '修改管理员密码').trigger('click')
    await flushPromises()

    expect(wrapper.text()).toContain('当前管理员密码错误')
    expect(wrapper.find('input[placeholder="当前管理员密码"]').element.value).toBe('wrong-admin')
    expect(wrapper.find('input[placeholder="新管理员密码"]').element.value).toBe('new-admin')
    expect(dashboardApi.clearDashboardSession).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  test('访问密码管理员过期时保留输入，验证后只重试原修改', async () => {
    let resume
    const showAdminDialog = jest.fn((_message, callback) => { resume = callback })
    dashboardApi.changePassword
      .mockResolvedValueOnce({ ok: false, code: 'ADMIN_REQUIRED', data: { code: 'ADMIN_REQUIRED' } })
      .mockResolvedValueOnce({ ok: true, data: { message: '访问密码已更新' } })
    const wrapper = mountSettings(showAdminDialog)
    await wrapper.find('input[placeholder="新访问密码"]').setValue('new-access')

    await wrapper.findAll('button').find(button => button.text() === '修改访问密码').trigger('click')
    await flushPromises()
    expect(wrapper.find('input[placeholder="新访问密码"]').element.value).toBe('new-access')
    expect(dashboardApi.clearDashboardSession).not.toHaveBeenCalled()
    await resume()
    await flushPromises()

    expect(dashboardApi.changePassword).toHaveBeenCalledTimes(2)
    expect(dashboardApi.clearDashboardSession).toHaveBeenCalledTimes(1)
    wrapper.unmount()
  })

  test('访问密码验证后仍被拒绝时停止重试且不退出', async () => {
    let resume
    const showAdminDialog = jest.fn((_message, callback) => { resume = callback })
    dashboardApi.changePassword.mockResolvedValue({ ok: false, code: 'ADMIN_REQUIRED', data: { code: 'ADMIN_REQUIRED' } })
    const wrapper = mountSettings(showAdminDialog)
    await wrapper.find('input[placeholder="新访问密码"]').setValue('new-access')

    await wrapper.findAll('button').find(button => button.text() === '修改访问密码').trigger('click')
    await flushPromises()
    await resume()
    await flushPromises()

    expect(showAdminDialog).toHaveBeenCalledTimes(1)
    expect(dashboardApi.changePassword).toHaveBeenCalledTimes(2)
    expect(wrapper.text()).toContain('管理员验证后修改访问密码仍被拒绝')
    expect(dashboardApi.clearDashboardSession).not.toHaveBeenCalled()
    wrapper.unmount()
  })
})
