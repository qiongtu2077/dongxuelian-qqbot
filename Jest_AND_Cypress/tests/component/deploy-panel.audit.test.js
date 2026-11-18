import { flushPromises, mount } from '@vue/test-utils'
import { KeepAlive, defineComponent, h, nextTick, ref } from 'vue'
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

describe('DeployPanel 前端重建轮询', () => {
  beforeEach(() => {
    jest.useFakeTimers()
    jest.clearAllMocks()
    arrangeDeployResponses()
    dashboardApi.rebuildFrontend.mockReset().mockResolvedValue({ ok: true, data: {} })
    dashboardApi.rebuildFrontendStatus.mockReset()
  })

  afterEach(() => jest.useRealTimers())

  test('慢请求在途期间只读取一次，完成后再等两秒', async () => {
    let finishRead
    dashboardApi.rebuildFrontendStatus
      .mockReturnValueOnce(new Promise(resolve => { finishRead = resolve }))
      .mockResolvedValueOnce({ ok: false, data: null })
      .mockResolvedValueOnce({ ok: true, data: { state: 'failed', message: '构建失败', detail: 'fixture error' } })
    const wrapper = await mountRemote()
    await wrapper.findAll('button').find(button => button.text() === '重建前端').trigger('click')
    await jest.advanceTimersByTimeAsync(10000)
    expect(dashboardApi.rebuildFrontendStatus).toHaveBeenCalledTimes(1)
    finishRead({ ok: true, data: { state: 'building' } })
    await flushPromises()
    await jest.advanceTimersByTimeAsync(1999)
    expect(dashboardApi.rebuildFrontendStatus).toHaveBeenCalledTimes(1)
    await jest.advanceTimersByTimeAsync(2001)
    expect(dashboardApi.rebuildFrontendStatus).toHaveBeenCalledTimes(3)
    expect(wrapper.text()).toContain('构建失败：fixture error')
    expect(wrapper.vm.rebuilding).toBe(false)
    wrapper.unmount()
  })

  test('超时取消旧读取，迟到成功无法结束新轮次', async () => {
    let finishStale
    dashboardApi.rebuildFrontendStatus
      .mockReturnValueOnce(new Promise(resolve => { finishStale = resolve }))
      .mockResolvedValueOnce({ ok: true, data: { state: 'building' } })
      .mockResolvedValueOnce({ ok: true, data: { state: 'success' } })
    const wrapper = await mountRemote()
    await wrapper.vm.doRebuildFrontend()
    await jest.advanceTimersByTimeAsync(150000)
    expect(wrapper.text()).toContain('构建超时')
    const staleSignal = dashboardApi.rebuildFrontendStatus.mock.calls[0][0]
    expect(staleSignal.aborted).toBe(true)
    expect(dashboardApi.rebuildFrontendStatus).toHaveBeenCalledTimes(1)

    await wrapper.vm.doRebuildFrontend()
    finishStale({ ok: true, data: { state: 'success' } })
    await flushPromises()
    expect(wrapper.vm.rebuilding).toBe(true)
    expect(wrapper.text()).toContain('前端构建中')
    await jest.advanceTimersByTimeAsync(4000)
    expect(dashboardApi.rebuildFrontendStatus).toHaveBeenCalledTimes(3)
    expect(wrapper.text()).toContain('前端构建成功，请刷新页面')
    expect(wrapper.vm.rebuilding).toBe(false)
    wrapper.unmount()
  })

  test('管理员确认只重试当前轮次并拒绝重复或卸载后的回调', async () => {
    const showAdminDialog = jest.fn()
    dashboardApi.rebuildFrontend.mockResolvedValueOnce({ ok: false, code: 'ADMIN_REQUIRED', data: {} })
    const wrapper = await mountRemote(showAdminDialog)
    await wrapper.vm.doRebuildFrontend()
    const retry = showAdminDialog.mock.calls[0][1]
    await Promise.all([retry(), retry()])
    expect(dashboardApi.rebuildFrontend).toHaveBeenCalledTimes(2)
    expect(dashboardApi.rebuildFrontend.mock.calls[0][0].aborted).toBe(true)
    wrapper.unmount()
    await retry()
    expect(dashboardApi.rebuildFrontend).toHaveBeenCalledTimes(2)
  })

  test('卸载撤销在途启动且迟到鉴权结果不会打开密码框', async () => {
    let finishStart
    const showAdminDialog = jest.fn()
    dashboardApi.rebuildFrontend.mockReturnValueOnce(new Promise(resolve => { finishStart = resolve }))
    const wrapper = await mountRemote(showAdminDialog)
    const pending = wrapper.vm.doRebuildFrontend()
    const signal = dashboardApi.rebuildFrontend.mock.calls[0][0]
    wrapper.unmount()
    expect(signal.aborted).toBe(true)
    finishStart({ ok: false, code: 'ADMIN_REQUIRED', data: {} })
    await pending
    expect(showAdminDialog).not.toHaveBeenCalled()
    expect(dashboardApi.rebuildFrontendStatus).not.toHaveBeenCalled()
  })

  test('卸载取消在途状态读取且释放后续计时器', async () => {
    let finishRead
    dashboardApi.rebuildFrontendStatus.mockReturnValueOnce(new Promise(resolve => { finishRead = resolve }))
    const wrapper = await mountRemote()
    await wrapper.vm.doRebuildFrontend()
    await jest.advanceTimersByTimeAsync(2000)
    const signal = dashboardApi.rebuildFrontendStatus.mock.calls[0][0]
    wrapper.unmount()
    expect(signal.aborted).toBe(true)
    finishRead({ ok: true, data: { state: 'building' } })
    await jest.advanceTimersByTimeAsync(150000)
    expect(dashboardApi.rebuildFrontendStatus).toHaveBeenCalledTimes(1)
  })
})

describe('DeployPanel 缓存切页与运行中的发布', () => {
  beforeEach(() => {
    jest.useFakeTimers()
    jest.clearAllMocks()
    arrangeDeployResponses()
    jest.spyOn(window, 'alert').mockImplementation(() => {})
  })

  afterEach(() => jest.useRealTimers())

  // 保留部署页实例，模拟 Dashboard 切换主栏目。
  async function mountCachedDeploy() {
    const visible = ref(true)
    const Other = defineComponent({ render: () => h('p', '其他栏目') })
    const Host = defineComponent({ render: () => h(KeepAlive, null, { default: () => visible.value ? h(DeployPanel) : h(Other) }) })
    const wrapper = mount(Host, { global: { provide: { showAdminDialog: jest.fn() } } })
    await flushPromises()
    return { wrapper, visible }
  }

  test('本地慢采样切走后撤销，再激活及切换部署模式只启动一套', async () => {
    dashboardApi.checkLocalEnv.mockResolvedValue({ ok: true, data: {
      host: { platform: 'win32', arch: 'x64' },
      localDeployTarget: { platform: 'win32', arch: 'x64', canRunWindowsLocalDeploy: true },
    } })
    let finishOld
    dashboardApi.npmInstallStatus.mockResolvedValue({ ok: true, data: {} })
    dashboardApi.npmInstallStatus.mockReturnValueOnce(new Promise(resolve => { finishOld = resolve }))
    dashboardApi.napcatDeployStatus.mockResolvedValue({ ok: true, data: {} })
    dashboardApi.koishiDeployStatus.mockResolvedValue({ ok: true, data: {} })
    const { wrapper, visible } = await mountCachedDeploy()
    expect(dashboardApi.npmInstallStatus).toHaveBeenCalledTimes(1)
    const staleSignal = dashboardApi.npmInstallStatus.mock.calls[0][0]
    await jest.advanceTimersByTimeAsync(7000)
    expect(dashboardApi.npmInstallStatus).toHaveBeenCalledTimes(1)
    visible.value = false
    await nextTick()
    expect(staleSignal.aborted).toBe(true)
    await jest.advanceTimersByTimeAsync(21000)
    expect(dashboardApi.npmInstallStatus).toHaveBeenCalledTimes(1)
    visible.value = true
    await flushPromises()
    expect(dashboardApi.npmInstallStatus).toHaveBeenCalledTimes(2)
    finishOld({ ok: true, data: { status: { logLines: ['过期安装状态'] } } })
    await flushPromises()
    expect(wrapper.text()).not.toContain('过期安装状态')
    await jest.advanceTimersByTimeAsync(3500)
    expect(dashboardApi.npmInstallStatus).toHaveBeenCalledTimes(3)
    await wrapper.findAll('button').find(button => button.text() === '远程 Linux 部署').trigger('click')
    await jest.advanceTimersByTimeAsync(10500)
    expect(dashboardApi.npmInstallStatus).toHaveBeenCalledTimes(3)
    wrapper.unmount()
  })

  test('离开缓存栏后仍跟踪同一远程任务和已启动的前端重建', async () => {
    dashboardApi.getDeployProgress
      .mockResolvedValueOnce({ ok: true, data: { state: 'running', stage: 'target_activation', lines: ['running'] } })
      .mockResolvedValueOnce({ ok: true, data: { state: 'success', stage: 'complete', lines: ['done'] } })
    dashboardApi.rebuildFrontend.mockResolvedValue({ ok: true, data: {} })
    dashboardApi.rebuildFrontendStatus.mockResolvedValue({ ok: true, data: { state: 'success' } })
    const { wrapper, visible } = await mountCachedDeploy()
    const panel = wrapper.findComponent(DeployPanel)
    await panel.findAll('button').find(button => button.text() === '远程 Linux 部署').trigger('click')
    await startConfirmedPreview(panel)
    await panel.vm.doRebuildFrontend()
    visible.value = false
    await nextTick()
    await jest.advanceTimersByTimeAsync(2001)
    expect(dashboardApi.getDeployProgress.mock.calls).toEqual([['task123'], ['task123']])
    expect(dashboardApi.rebuildFrontendStatus).toHaveBeenCalledTimes(1)
    expect(dashboardApi.runDeploy).toHaveBeenCalledTimes(1)
    visible.value = true
    await flushPromises()
    expect(panel.text()).toContain('done')
    expect(panel.text()).toContain('前端构建成功')
    expect(panel.vm.deploying).toBe(false)
    expect(panel.vm.rebuilding).toBe(false)
    wrapper.unmount()
  })

  test('切走后用户主动的安装就绪检查继续完成', async () => {
    dashboardApi.checkLocalEnv.mockResolvedValue({ ok: true, data: {
      host: { platform: 'win32', arch: 'x64' },
      localDeployTarget: { platform: 'win32', arch: 'x64', canRunWindowsLocalDeploy: true },
    } })
    dashboardApi.npmInstallStatus.mockResolvedValue({ ok: true, data: { status: { dependencies: { ready: true } } } })
    dashboardApi.napcatDeployStatus.mockResolvedValue({ ok: true, data: {} })
    dashboardApi.koishiDeployStatus.mockResolvedValue({ ok: true, data: {} })
    const { wrapper, visible } = await mountCachedDeploy()
    const panel = wrapper.findComponent(DeployPanel)
    dashboardApi.npmInstallStatus.mockResolvedValueOnce({ ok: true, data: { status: { dependencies: { ready: false } } } })
    const installation = panel.vm.confirmNpmDone()
    await flushPromises()
    expect(panel.vm.installingDeps).toBe(true)
    visible.value = false
    await nextTick()
    await jest.advanceTimersByTimeAsync(1000)
    await installation
    expect(panel.vm.installingDeps).toBe(false)
    expect(dashboardApi.npmInstallStatus.mock.calls.filter(args => args.length === 0)).toHaveLength(2)
    const completedReadCount = dashboardApi.npmInstallStatus.mock.calls.length
    await jest.advanceTimersByTimeAsync(10500)
    expect(dashboardApi.npmInstallStatus).toHaveBeenCalledTimes(completedReadCount)
    wrapper.unmount()
  })
})
