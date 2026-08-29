import { flushPromises, mount } from '@vue/test-utils'
import DeployPanel from '../../../packages/koishi-plugin-dashboard/frontend/src/components/DeployPanel.vue'
import * as dashboardApi from '../../../packages/koishi-plugin-dashboard/frontend/src/api'

jest.mock('../../../packages/koishi-plugin-dashboard/frontend/src/electron-deployer', () => ({
  getDongxuelianDeployerBridge: jest.fn(() => null),
  isElectronDeployerEnv: jest.fn(() => false),
}))

jest.mock('../../../packages/koishi-plugin-dashboard/frontend/src/api', () => ({
  checkDeployUpdate: jest.fn(),
  checkLocalEnv: jest.fn(),
  confirmLocalUninstall: jest.fn(),
  deleteLocalConfig: jest.fn(),
  deployLocal: jest.fn(),
  downloadNapcat: jest.fn(),
  downloadNapcatWindows: jest.fn(),
  fetchDeployConfig: jest.fn(),
  getDeployProgress: jest.fn(),
  installPortableNode: jest.fn(),
  koishiDeployStatus: jest.fn(),
  localReadyCheck: jest.fn(),
  napcatDeployStatus: jest.fn(),
  npmInstallStatus: jest.fn(),
  previewLocalConfigDelete: jest.fn(),
  previewLocalUninstall: jest.fn(),
  rebuildFrontend: jest.fn(),
  rebuildFrontendStatus: jest.fn(),
  repairNpmProxyAndInstall: jest.fn(),
  runDeploy: jest.fn(),
  startKoishiLocal: jest.fn(),
  startNapcat: jest.fn(),
  startNpmInstall: jest.fn(),
  updateDeployConfig: jest.fn(),
  uploadDeploy: jest.fn(),
}))

// Supplies harmless mount-time responses and one configured remote target.
function arrangeDeployResponses() {
  dashboardApi.checkLocalEnv.mockResolvedValue({
    ok: true,
    data: {
      host: { platform: 'linux', arch: 'x64', hostname: 'test-host' },
      localDeployTarget: { platform: 'linux', arch: 'x64', canRunWindowsLocalDeploy: false, blockedReason: 'test backend is Linux' },
    },
  })
  dashboardApi.fetchDeployConfig.mockResolvedValue({ ok: true, data: { server: 'test-server', appDir: '/srv/test-app', mode: 'update' } })
  dashboardApi.runDeploy.mockResolvedValue({ ok: true, data: { taskId: 'task123' } })
}

// Mounts the panel and switches to the remote deployment view.
async function mountRemote(showAdminDialog = jest.fn()) {
  const wrapper = mount(DeployPanel, { global: { provide: { showAdminDialog } } })
  await flushPromises()
  await wrapper.findAll('button').find(button => button.text() === '远程 Linux 部署').trigger('click')
  return wrapper
}

describe('DeployPanel 持久化任务轮询闭环', () => {
  beforeEach(() => {
    jest.useFakeTimers()
    jest.clearAllMocks()
    arrangeDeployResponses()
    jest.spyOn(window, 'alert').mockImplementation(() => {})
  })

  afterEach(() => {
    jest.useRealTimers()
  })

  test('running 到 success 使用同一任务编号且请求不重叠', async () => {
    dashboardApi.getDeployProgress
      .mockResolvedValueOnce({ ok: true, data: { state: 'running', stage: 'target_activation', lines: ['running'] } })
      .mockResolvedValueOnce({ ok: true, data: { state: 'success', stage: 'complete', lines: ['done'] } })
    const wrapper = await mountRemote()

    await wrapper.findAll('button').find(button => button.text() === '构建不可变版本并发布').trigger('click')
    await jest.advanceTimersByTimeAsync(0)
    expect(dashboardApi.getDeployProgress).toHaveBeenCalledTimes(1)
    expect(dashboardApi.getDeployProgress).toHaveBeenLastCalledWith('task123')
    await jest.advanceTimersByTimeAsync(1500)
    await flushPromises()

    expect(dashboardApi.runDeploy).toHaveBeenCalledTimes(1)
    expect(dashboardApi.getDeployProgress).toHaveBeenCalledTimes(2)
    expect(wrapper.text()).toContain('部署完成')
    wrapper.unmount()
  })

  test('服务端 failed 立即停止并显示脱敏阶段和错误', async () => {
    dashboardApi.getDeployProgress.mockResolvedValue({ ok: true, data: { state: 'failed', stage: 'health_check', error: 'bot health failed', lines: [] } })
    const wrapper = await mountRemote()

    await wrapper.findAll('button').find(button => button.text() === '构建不可变版本并发布').trigger('click')
    await jest.advanceTimersByTimeAsync(0)
    await flushPromises()

    expect(wrapper.text()).toContain('部署失败（health_check）：bot health failed')
    expect(window.alert).toHaveBeenCalledWith(expect.stringContaining('health_check'))
    await jest.advanceTimersByTimeAsync(10000)
    expect(dashboardApi.getDeployProgress).toHaveBeenCalledTimes(1)
    wrapper.unmount()
  })

  test('管理员过期后只续查原任务，不重新启动发布', async () => {
    let resume = null
    const showAdminDialog = jest.fn((message, callback) => { resume = callback })
    dashboardApi.getDeployProgress
      .mockResolvedValueOnce({ ok: false, code: 'ADMIN_REQUIRED', data: { code: 'ADMIN_REQUIRED' } })
      .mockResolvedValueOnce({ ok: true, data: { state: 'success', stage: 'complete', lines: [] } })
    const wrapper = await mountRemote(showAdminDialog)

    await wrapper.findAll('button').find(button => button.text() === '构建不可变版本并发布').trigger('click')
    await jest.advanceTimersByTimeAsync(0)
    expect(showAdminDialog).toHaveBeenCalledTimes(1)
    expect(resume).toEqual(expect.any(Function))
    resume()
    await jest.advanceTimersByTimeAsync(0)
    await flushPromises()

    expect(dashboardApi.runDeploy).toHaveBeenCalledTimes(1)
    expect(dashboardApi.getDeployProgress).toHaveBeenNthCalledWith(1, 'task123')
    expect(dashboardApi.getDeployProgress).toHaveBeenNthCalledWith(2, 'task123')
    expect(wrapper.text()).toContain('部署完成')
    wrapper.unmount()
  })

  test('连续三次网络失败后终止，短暂失败不会伪造服务端 failed', async () => {
    dashboardApi.getDeployProgress.mockResolvedValue({ ok: false, data: { message: 'network unavailable' } })
    const wrapper = await mountRemote()

    await wrapper.findAll('button').find(button => button.text() === '构建不可变版本并发布').trigger('click')
    await jest.advanceTimersByTimeAsync(0)
    expect(wrapper.text()).toContain('正在重试（1/3）')
    await jest.advanceTimersByTimeAsync(2000)
    expect(wrapper.text()).toContain('正在重试（2/3）')
    await jest.advanceTimersByTimeAsync(2000)
    await flushPromises()

    expect(dashboardApi.getDeployProgress).toHaveBeenCalledTimes(3)
    expect(wrapper.text()).toContain('network unavailable')
    expect(wrapper.text()).not.toContain('服务器未提供错误详情')
    wrapper.unmount()
  })
})
