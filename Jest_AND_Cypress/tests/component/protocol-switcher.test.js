import { flushPromises, mount } from '@vue/test-utils'
import ProtocolSwitcher from '../../../packages/koishi-plugin-dashboard/frontend/src/components/ProtocolSwitcher.vue'
import ControlPanel from '../../../packages/koishi-plugin-dashboard/frontend/src/components/ControlPanel.vue'
import { protocolState, protocolBusy, protocolView, selectedProtocol } from '../../../packages/koishi-plugin-dashboard/frontend/src/services/protocol-state'
import * as dashboardApi from '../../../packages/koishi-plugin-dashboard/frontend/src/api'

jest.mock('../../../packages/koishi-plugin-dashboard/frontend/src/api', () => ({
  fetchProtocolStatus: jest.fn(), changeProtocol: jest.fn(),
  fetchSlLogin: jest.fn(), acceptSlConsent: jest.fn(), connectSl: jest.fn(), openSlDesktop: jest.fn(),
  botStatus: jest.fn(), startBot: jest.fn(), stopBot: jest.fn(),
  fetchMaintenance: jest.fn(), setMaintenance: jest.fn(), fetchQQToken: jest.fn(),
  fetchSSHInfo: jest.fn(), fetchSelfId: jest.fn(), updateSelfId: jest.fn(),
  fetchThrottle: jest.fn(), saveThrottle: jest.fn(), restartNapcat: jest.fn(),
}))

// --- 协议状态与真实组件夹具 ---

/** 模拟服务端确认的启用协议与互斥运行状态。 */
function statusFor(provider) {
  return {
    supported: true, selected: provider, installed: true, switching: false, conflict: false,
    napcat: { state: provider === 'napcat' ? 'active' : 'inactive', pid: provider === 'napcat' ? 123 : 0 },
    sl: { state: provider === 'sl' ? 'active' : 'inactive', pid: provider === 'sl' ? 456 : 0 },
  }
}

let wrapper
let serverProtocol

/** 联合挂载菜单、终端和 SL 登录组件，只替换无关群开关。 */
function mountPanels(showAdminDialog = jest.fn()) {
  wrapper = mount({
    components: { ProtocolSwitcher, ControlPanel },
    template: '<ProtocolSwitcher /><ControlPanel />',
  }, { global: { provide: { showAdminDialog }, stubs: { ParticipationControls: true } } })
  return wrapper
}

describe('协议菜单浏览与服务启停分离', () => {
  beforeEach(() => {
    jest.useFakeTimers()
    jest.resetAllMocks()
    protocolState.value = null
    protocolView.value = null
    protocolBusy.value = false
    serverProtocol = 'napcat'
    dashboardApi.fetchProtocolStatus.mockImplementation(async () => ({ ok: true, data: statusFor(serverProtocol) }))
    dashboardApi.changeProtocol.mockImplementation(async provider => {
      serverProtocol = provider
      return { ok: true, data: { status: statusFor(provider), message: '协议启动完成' } }
    })
    dashboardApi.fetchSlLogin.mockResolvedValue({ ok: true, data: {
      agreements: { version: '1234567890abcdef', consentRequired: true, documents: [] },
      accounts: [], processes: [],
    } })
    dashboardApi.botStatus.mockResolvedValue({ ok: true, data: { running: true, workers: 1 } })
    dashboardApi.fetchMaintenance.mockResolvedValue({ ok: true, data: { enabled: false } })
    dashboardApi.fetchSSHInfo.mockResolvedValue({ ok: true, data: { host: '', user: 'root' } })
    dashboardApi.fetchSelfId.mockResolvedValue({ ok: true, data: { selfId: '10000' } })
    dashboardApi.fetchThrottle.mockResolvedValue({ ok: true, data: { maxPerMinute: 20 } })
  })

  afterEach(() => {
    wrapper?.unmount()
    wrapper = undefined
    protocolState.value = null
    protocolView.value = null
    protocolBusy.value = false
    jest.useRealTimers()
  })

  test('首次打开跟随服务端 SL 选择且不请求启停', async () => {
    serverProtocol = 'sl'
    mountPanels()
    await flushPromises()

    expect(wrapper.get('#qq-protocol').element.value).toBe('sl')
    expect(wrapper.text()).toContain('SnowLuma 登录')
    expect(dashboardApi.changeProtocol).not.toHaveBeenCalled()
    expect(wrapper.text()).not.toContain('NapCat 已停止')
  })

  test.each(['napcat', 'sl'])('从 %s 浏览另一协议及返回都不启停，轮询保留浏览选择', async initial => {
    serverProtocol = initial
    const target = initial === 'sl' ? 'napcat' : 'sl'
    const showAdminDialog = jest.fn()
    mountPanels(showAdminDialog)
    await flushPromises()
    dashboardApi.fetchSlLogin.mockClear()

    await wrapper.get('#qq-protocol').setValue(target)
    await flushPromises()
    expect(wrapper.text()).toContain(target === 'sl' ? '当前仅查看 SnowLuma' : '当前仅查看 NapCat')
    expect(selectedProtocol.value).toBe(initial)
    expect(serverProtocol).toBe(initial)
    expect(dashboardApi.changeProtocol).not.toHaveBeenCalled()
    expect(dashboardApi.fetchSlLogin).not.toHaveBeenCalled()
    expect(showAdminDialog).not.toHaveBeenCalled()
    expect(wrapper.findComponent(ProtocolSwitcher).emitted('viewed')).toHaveLength(1)
    expect(wrapper.findComponent(ProtocolSwitcher).emitted('switched')).toBeUndefined()
    const inactiveButton = target === 'sl'
      ? wrapper.findAll('button').find(button => button.text() === '刷新登录状态')
      : wrapper.findAll('button').find(button => button.text() === '重启 NapCat')
    expect(inactiveButton.element.disabled).toBe(true)

    await jest.advanceTimersByTimeAsync(10000)
    await flushPromises()
    expect(wrapper.get('#qq-protocol').element.value).toBe(target)
    expect(selectedProtocol.value).toBe(initial)
    expect(dashboardApi.changeProtocol).not.toHaveBeenCalled()
    expect(dashboardApi.fetchSlLogin).not.toHaveBeenCalled()

    await wrapper.get('#qq-protocol').setValue(initial)
    await flushPromises()
    expect(wrapper.text()).not.toContain('当前仅查看')
    expect(dashboardApi.changeProtocol).not.toHaveBeenCalled()
  })

  // --- 明确启动、验证和失败回执 ---

  test.each(['napcat', 'sl'])('从 %s 点击启动按钮后才启用所查看协议', async initial => {
    serverProtocol = initial
    const target = initial === 'sl' ? 'napcat' : 'sl'
    mountPanels()
    await flushPromises()
    await wrapper.get('#qq-protocol').setValue(target)
    expect(dashboardApi.changeProtocol).not.toHaveBeenCalled()

    await wrapper.get('.protocol-switcher button').trigger('click')
    await flushPromises()
    expect(dashboardApi.changeProtocol).toHaveBeenCalledTimes(1)
    expect(dashboardApi.changeProtocol).toHaveBeenCalledWith(target)
    expect(selectedProtocol.value).toBe(target)
    expect(serverProtocol).toBe(target)
    expect(wrapper.text()).not.toContain('当前仅查看')
    expect(wrapper.findComponent(ProtocolSwitcher).emitted('switched')).toHaveLength(1)
    if (target === 'sl') expect(dashboardApi.fetchSlLogin).toHaveBeenCalled()
  })

  test('启动失败保留原协议和浏览面板，重新浏览清除旧回执', async () => {
    dashboardApi.changeProtocol.mockResolvedValueOnce({ ok: false, data: { message: '目标协议启动失败，旧协议已恢复' } })
    mountPanels()
    await flushPromises()
    await wrapper.get('#qq-protocol').setValue('sl')
    await wrapper.get('.protocol-switcher button').trigger('click')
    await flushPromises()

    expect(selectedProtocol.value).toBe('napcat')
    expect(wrapper.get('#qq-protocol').element.value).toBe('sl')
    expect(wrapper.get('.protocol-switcher [role="status"]').text()).toContain('目标协议启动失败')
    expect(dashboardApi.fetchSlLogin).not.toHaveBeenCalled()
    expect(protocolBusy.value).toBe(false)

    await wrapper.get('#qq-protocol').setValue('napcat')
    expect(wrapper.find('.protocol-switcher [role="status"]').exists()).toBe(false)
    expect(dashboardApi.changeProtocol).toHaveBeenCalledTimes(1)
  })

  test('管理员验证只由启动触发，未完成验证不切换，验证后重试原启动目标', async () => {
    const showAdminDialog = jest.fn()
    dashboardApi.changeProtocol.mockResolvedValueOnce({ ok: false, code: 'ADMIN_REQUIRED', data: {} })
    mountPanels(showAdminDialog)
    await flushPromises()
    await wrapper.get('#qq-protocol').setValue('sl')
    expect(showAdminDialog).not.toHaveBeenCalled()
    await wrapper.get('.protocol-switcher button').trigger('click')
    await flushPromises()

    expect(showAdminDialog).toHaveBeenCalledTimes(1)
    expect(selectedProtocol.value).toBe('napcat')
    expect(dashboardApi.fetchSlLogin).not.toHaveBeenCalled()
    await jest.advanceTimersByTimeAsync(10000)
    expect(dashboardApi.changeProtocol).toHaveBeenCalledTimes(1)

    await wrapper.get('#qq-protocol').setValue('napcat')
    await showAdminDialog.mock.calls[0][1]()
    await flushPromises()
    expect(dashboardApi.changeProtocol.mock.calls).toEqual([['sl'], ['sl']])
    expect(selectedProtocol.value).toBe('sl')
    expect(wrapper.get('#qq-protocol').element.value).toBe('sl')
  })
})
