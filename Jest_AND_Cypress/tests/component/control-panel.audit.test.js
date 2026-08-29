import { flushPromises, mount } from '@vue/test-utils'
import ControlPanel from '../../../packages/koishi-plugin-dashboard/frontend/src/components/ControlPanel.vue'
import * as dashboardApi from '../../../packages/koishi-plugin-dashboard/frontend/src/api'

jest.mock('../../../packages/koishi-plugin-dashboard/frontend/src/api', () => ({
  botStatus: jest.fn(),
  startBot: jest.fn(),
  stopBot: jest.fn(),
  fetchMaintenance: jest.fn(),
  setMaintenance: jest.fn(),
  fetchQQToken: jest.fn(),
  fetchSSHInfo: jest.fn(),
  fetchSelfId: jest.fn(),
  updateSelfId: jest.fn(),
  fetchThrottle: jest.fn(),
  saveThrottle: jest.fn(),
  restartNapcat: jest.fn(),
}))

// 为组件挂载阶段提供只读接口响应。
function arrangeControlResponses() {
  dashboardApi.botStatus.mockResolvedValue({ ok: true, data: { running: false, workers: 0 } })
  dashboardApi.fetchMaintenance.mockResolvedValue({ ok: true, data: { enabled: false } })
  dashboardApi.fetchSSHInfo.mockResolvedValue({ ok: true, data: { host: '', user: 'root' } })
  dashboardApi.fetchSelfId.mockResolvedValue({ ok: true, data: { selfId: '10000' } })
  dashboardApi.fetchThrottle.mockResolvedValue({ ok: true, data: { maxPerMinute: 20 } })
  dashboardApi.startBot.mockResolvedValue({ ok: true, data: { message: '启动命令已发送' } })
}

describe('ControlPanel 当前按钮行为审查', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    arrangeControlResponses()
  })

  test('删除诊断启动入口且保留唯一正常启动按钮', async () => {
    jest.useFakeTimers()
    const wrapper = mount(ControlPanel, { global: { provide: { showAdminDialog: jest.fn() } } })
    await flushPromises()
    const diagnosticButton = wrapper.findAll('button').find(button => button.text() === '测试 startBot API')
    const startButton = wrapper.findAll('button').find(button => button.text().includes('启动引擎'))

    expect(diagnosticButton).toBeUndefined()
    expect(startButton).toBeDefined()
    await startButton.trigger('click')
    await flushPromises()

    expect(dashboardApi.startBot).toHaveBeenCalledTimes(1)
    expect(wrapper.text()).toContain('启动命令已发送')
    wrapper.unmount()
    jest.useRealTimers()
  })

  test('更换 QQ 号先准确确认，取消不请求，确认后才提交', async () => {
    const confirmSpy = jest.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true)
    dashboardApi.updateSelfId.mockResolvedValue({ ok: true, data: { message: 'QQ 号已更换并通过健康检查' } })
    const wrapper = mount(ControlPanel, { global: { provide: { showAdminDialog: jest.fn() } } })
    await flushPromises()
    await wrapper.find('input[placeholder="输入新的监听 QQ 号"]').setValue('20000')
    const button = wrapper.findAll('button').find(item => item.text() === '更换 QQ 号并重启机器人')

    await button.trigger('click')
    expect(dashboardApi.updateSelfId).not.toHaveBeenCalled()
    await button.trigger('click')
    await flushPromises()

    expect(confirmSpy).toHaveBeenCalledWith(expect.stringContaining('从 10000 更换为 20000'))
    expect(dashboardApi.updateSelfId).toHaveBeenCalledWith('20000')
    expect(wrapper.text()).toContain('QQ 号已更换并通过健康检查')
    wrapper.unmount()
  })

  test('更换 QQ 号管理员过期后复用确认结果并只重试一次', async () => {
    let resume
    const showAdminDialog = jest.fn((_message, callback) => { resume = callback })
    jest.spyOn(window, 'confirm').mockReturnValue(true)
    dashboardApi.updateSelfId
      .mockResolvedValueOnce({ ok: false, code: 'ADMIN_REQUIRED', data: { code: 'ADMIN_REQUIRED' } })
      .mockResolvedValueOnce({ ok: true, data: { message: 'QQ 号已更换并通过健康检查' } })
    const wrapper = mount(ControlPanel, { global: { provide: { showAdminDialog } } })
    await flushPromises()
    await wrapper.find('input[placeholder="输入新的监听 QQ 号"]').setValue('20000')
    const button = wrapper.findAll('button').find(item => item.text() === '更换 QQ 号并重启机器人')

    await button.trigger('click')
    await flushPromises()
    await resume()
    await flushPromises()

    expect(window.confirm).toHaveBeenCalledTimes(1)
    expect(showAdminDialog).toHaveBeenCalledTimes(1)
    expect(dashboardApi.updateSelfId).toHaveBeenCalledTimes(2)
    expect(wrapper.text()).toContain('QQ 号已更换并通过健康检查')
    wrapper.unmount()
  })

  test('更换 QQ 号重试仍被拒绝时停止重试并恢复按钮', async () => {
    let resume
    const showAdminDialog = jest.fn((_message, callback) => { resume = callback })
    jest.spyOn(window, 'confirm').mockReturnValue(true)
    dashboardApi.updateSelfId.mockResolvedValue({ ok: false, code: 'ADMIN_REQUIRED', data: { code: 'ADMIN_REQUIRED' } })
    const wrapper = mount(ControlPanel, { global: { provide: { showAdminDialog } } })
    await flushPromises()
    await wrapper.find('input[placeholder="输入新的监听 QQ 号"]').setValue('20000')

    await wrapper.findAll('button').find(item => item.text() === '更换 QQ 号并重启机器人').trigger('click')
    await flushPromises()
    await resume()
    await flushPromises()

    expect(showAdminDialog).toHaveBeenCalledTimes(1)
    expect(dashboardApi.updateSelfId).toHaveBeenCalledTimes(2)
    expect(wrapper.text()).toContain('管理员验证后更换 QQ 号仍被拒绝')
    expect(wrapper.text()).toContain('更换 QQ 号并重启机器人')
    wrapper.unmount()
  })

  test('更换 QQ 号后端失败时显示错误且不更新当前账号', async () => {
    jest.spyOn(window, 'confirm').mockReturnValue(true)
    dashboardApi.updateSelfId.mockResolvedValue({ ok: false, data: { message: '机器人重启失败，旧配置已恢复' } })
    const wrapper = mount(ControlPanel, { global: { provide: { showAdminDialog: jest.fn() } } })
    await flushPromises()
    await wrapper.find('input[placeholder="输入新的监听 QQ 号"]').setValue('20000')

    await wrapper.findAll('button').find(item => item.text() === '更换 QQ 号并重启机器人').trigger('click')
    await flushPromises()

    expect(wrapper.text()).toContain('机器人重启失败，旧配置已恢复')
    expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining('从 10000 更换为 20000'))
    expect(wrapper.text()).toContain('更换 QQ 号并重启机器人')
    wrapper.unmount()
  })
})
