import { flushPromises, mount } from '@vue/test-utils'
import DeployPanel from '../../../packages/koishi-plugin-dashboard/frontend/src/components/DeployPanel.vue'
import * as dashboardApi from '../../../packages/koishi-plugin-dashboard/frontend/src/api'

jest.mock('../../../packages/koishi-plugin-dashboard/frontend/src/electron-deployer', () => ({
  getDongxuelianDeployerBridge: jest.fn(() => null),
  isElectronDeployerEnv: jest.fn(() => false),
}))

jest.mock('../../../packages/koishi-plugin-dashboard/frontend/src/api', () => ({
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
  previewDeploy: jest.fn(),
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
  dashboardApi.previewDeploy.mockResolvedValue({
    ok: true,
    data: {
      previewId: 'a'.repeat(32),
      expiresAt: Date.now() + 30 * 60 * 1000,
      canDeploy: true,
      blockers: [],
      source: { hostname: 'source-host', repoRoot: '/source', commit: 'b'.repeat(40), clean: true },
      target: { server: 'test-server', hostname: 'target-host', appDir: '/srv/test-app', availableBytes: 1024 * 1024 * 1024, release: { releaseId: 'old-release' } },
      release: { releaseId: 'new-release', totalBytes: 1024, fileCount: 10 },
      requiredBytes: 64 * 1024 * 1024,
      changes: { added: 1, modified: 2, removed: 3, unchanged: 4 },
    },
  })
  dashboardApi.runDeploy.mockResolvedValue({ ok: true, data: { taskId: 'task123' } })
}

// Mounts the panel and switches to the remote deployment view.
async function mountRemote(showAdminDialog = jest.fn()) {
  const wrapper = mount(DeployPanel, { global: { provide: { showAdminDialog } } })
  await flushPromises()
  await wrapper.findAll('button').find(button => button.text() === '远程 Linux 部署').trigger('click')
  return wrapper
}

// Generates, confirms and submits the same frozen preview used by polling tests.
async function startConfirmedPreview(wrapper) {
  await wrapper.findAll('button').find(button => button.text() === '生成部署预览').trigger('click')
  await flushPromises()
  await wrapper.find('.remote-confirm input').setValue(true)
  await wrapper.findAll('button').find(button => button.text() === '发布已确认预览').trigger('click')
  await flushPromises()
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

    await startConfirmedPreview(wrapper)
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

    await startConfirmedPreview(wrapper)
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

    await startConfirmedPreview(wrapper)
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

    await startConfirmedPreview(wrapper)
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

  test('未确认或存在阻止项时不能执行，执行只提交预览编号', async () => {
    const wrapper = await mountRemote()
    const publishButton = () => wrapper.findAll('button').find(button => button.text() === '发布已确认预览')
    expect(publishButton().attributes('disabled')).toBeDefined()

    await wrapper.findAll('button').find(button => button.text() === '生成部署预览').trigger('click')
    await flushPromises()
    expect(wrapper.text()).toContain('new-release')
    expect(publishButton().attributes('disabled')).toBeDefined()
    await wrapper.find('.remote-confirm input').setValue(true)
    expect(publishButton().attributes('disabled')).toBeUndefined()
    await publishButton().trigger('click')
    await flushPromises()
    expect(dashboardApi.runDeploy).toHaveBeenCalledWith({ previewId: 'a'.repeat(32), confirmed: true })
    wrapper.unmount()

    dashboardApi.previewDeploy.mockResolvedValueOnce({ ok: true, data: { previewId: 'c'.repeat(32), expiresAt: Date.now() + 10000, canDeploy: false, blockers: ['远端存在发布锁'] } })
    const blockedWrapper = await mountRemote()
    await blockedWrapper.findAll('button').find(button => button.text() === '生成部署预览').trigger('click')
    await flushPromises()
    expect(blockedWrapper.text()).toContain('远端存在发布锁')
    expect(blockedWrapper.findAll('button').find(button => button.text() === '发布已确认预览').attributes('disabled')).toBeDefined()
    blockedWrapper.unmount()
  })

  test('修改目标字段立即使已生成预览失效', async () => {
    const wrapper = await mountRemote()
    await wrapper.findAll('button').find(button => button.text() === '生成部署预览').trigger('click')
    await flushPromises()
    expect(wrapper.find('.remote-preview').exists()).toBe(true)
    const serverInput = wrapper.findAll('input').find(input => input.attributes('placeholder') === '<YOUR_SERVER_USER>@<YOUR_SERVER_HOST>')
    await serverInput.setValue('root@changed-host')
    await flushPromises()
    expect(wrapper.find('.remote-preview').exists()).toBe(false)
    expect(wrapper.text()).toContain('部署目标已修改，请重新生成预览')
    wrapper.unmount()
  })
})
