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

  test('已确认：“测试 startBot API”会调用真实启动接口', async () => {
    const wrapper = mount(ControlPanel, { global: { provide: { showAdminDialog: jest.fn() } } })
    await flushPromises()
    const diagnosticButton = wrapper.findAll('button').find(button => button.text() === '测试 startBot API')

    expect(diagnosticButton).toBeDefined()
    await diagnosticButton.trigger('click')
    await flushPromises()

    expect(dashboardApi.startBot).toHaveBeenCalledTimes(1)
    expect(wrapper.text()).toContain('"message": "启动命令已发送"')
    wrapper.unmount()
  })
})
