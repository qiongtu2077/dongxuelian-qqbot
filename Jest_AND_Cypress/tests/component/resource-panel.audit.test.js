import { flushPromises, mount } from '@vue/test-utils'
import ResourcePanel from '../../../packages/koishi-plugin-dashboard/frontend/src/components/ResourcePanel.vue'
import * as dashboardApi from '../../../packages/koishi-plugin-dashboard/frontend/src/api'

jest.mock('../../../packages/koishi-plugin-dashboard/frontend/src/api', () => ({
  cancelResourceTask: jest.fn(),
  fetchResourceDiagnosticDetail: jest.fn(),
  fetchResourceDiagnostics: jest.fn(),
  fetchResourceEvents: jest.fn(),
  fetchResourceMemoryHistory: jest.fn(),
  fetchResourceStatus: jest.fn(),
  fetchResourceTasks: jest.fn(),
  isAdminRequired: jest.fn(res => res?.code === 'ADMIN_REQUIRED' || res?.data?.code === 'ADMIN_REQUIRED'),
  setResourceMode: jest.fn(),
  setResourceMaintenance: jest.fn(),
}))

const ADMIN_REQUIRED = { ok: false, code: 'ADMIN_REQUIRED', data: { code: 'ADMIN_REQUIRED' } }
const TASK = { id: 'task-1', kind: 'video', status: 'pending', createdAt: '2026-08-30T00:00:00.000Z' }
const OPERATIONS = [
  {
    name: '维护模式', api: 'setResourceMaintenance', button: '进入维护模式',
    prompt: '切换资源维护模式需要管理员密码',
    success: { ok: true, data: { message: '维护模式已开启，机器人将回复维护提示' } },
    successText: '维护模式已开启，机器人将回复维护提示',
  },
  {
    name: '取消任务', api: 'cancelResourceTask', button: '取消',
    prompt: '取消资源任务需要管理员密码',
    success: { ok: true, data: { message: 'cancelled' } }, successText: '任务已取消',
  },
]

// Builds one readable resource status fixture with all backend conclusions present.
function resourceStatus(overrides = {}) {
  return {
    maintenance: false, mode: 'normal', resourceState: 'yellow', serverMode: 'small',
    serverModeSource: 'resource-control/config.json', memAvailableMb: 500, memTotalMb: 1600,
    background_allowed: true, backgroundPauseReasons: [], workers: [],
    media: {
      mediaRiskCode: 'idle', mediaRiskKinds: ['image', 'file', 'voice'],
      mediaRiskByKind: { image: 'idle', file: 'idle', voice: 'idle' },
      queues: {
        image: { queueTotal: 0, queueLimit: 120, readyCount: 0, deferredCount: 0, runningCount: 0 },
        file: { queueTotal: 0, queueLimit: 60, readyCount: 0, deferredCount: 0, runningCount: 0 },
        voice: { queueTotal: 0, queueLimit: 80, readyCount: 0, deferredCount: 0, runningCount: 0 },
      },
      unfinishedByReason: {},
    },
    ...overrides,
  }
}

// Supplies harmless read responses used during mount and post-action refresh.
function arrangeResourceReads(status = resourceStatus()) {
  dashboardApi.fetchResourceStatus.mockResolvedValue({ ok: true, data: status })
  dashboardApi.fetchResourceTasks.mockResolvedValue({ ok: true, data: { tasks: [TASK] } })
  dashboardApi.fetchResourceEvents.mockResolvedValue({ ok: true, data: { events: [] } })
  dashboardApi.fetchResourceMemoryHistory.mockResolvedValue({ ok: true, data: { points: [] } })
  dashboardApi.fetchResourceDiagnostics.mockResolvedValue({ ok: true, data: { items: [], total: 0, counts: { all: 0, unknown: 0, media: 0 }, hasMore: false, nextCursor: '' } })
  dashboardApi.fetchResourceDiagnosticDetail.mockResolvedValue({ ok: true, data: { error: '', diagnostics: {} } })
  dashboardApi.setResourceMode.mockResolvedValue({ ok: true, data: {} })
}

// Mounts the resource panel and waits for its initial data reads.
async function mountResource(showAdminDialog = jest.fn()) {
  const wrapper = mount(ResourcePanel, { global: { provide: { showAdminDialog } } })
  await flushPromises()
  return wrapper
}

// Finds a visible button by exact user-facing text.
function findButton(wrapper, label) {
  return wrapper.findAll('button').find(item => item.text() === label)
}

// Invokes one administrator-protected operation.
async function invokeOperation(wrapper, operation) {
  const button = findButton(wrapper, operation.button)
  expect(button).toBeDefined()
  await button.trigger('click')
  await flushPromises()
}

describe('ResourcePanel 管理员操作与确认闭环', () => {
  beforeEach(() => {
    jest.useFakeTimers()
    jest.clearAllMocks()
    window.confirm = jest.fn(() => true)
    arrangeResourceReads()
  })

  afterEach(() => jest.useRealTimers())

  test.each(OPERATIONS)('$name 管理员过期后只重试原操作一次并成功', async operation => {
    let resume
    const showAdminDialog = jest.fn((_message, callback) => { resume = callback })
    dashboardApi[operation.api].mockResolvedValueOnce(ADMIN_REQUIRED).mockResolvedValueOnce(operation.success)
    const wrapper = await mountResource(showAdminDialog)
    await invokeOperation(wrapper, operation)
    expect(showAdminDialog).toHaveBeenCalledWith(operation.prompt, expect.any(Function))
    await resume()
    await flushPromises()
    expect(dashboardApi[operation.api]).toHaveBeenCalledTimes(2)
    expect(wrapper.text()).toContain(operation.successText)
    if (operation.name === '维护模式') expect(window.confirm).toHaveBeenCalledTimes(1)
    wrapper.unmount()
  })

  test.each(OPERATIONS)('$name 管理员验证取消后不重试', async operation => {
    const showAdminDialog = jest.fn()
    dashboardApi[operation.api].mockResolvedValue(ADMIN_REQUIRED)
    const wrapper = await mountResource(showAdminDialog)
    await invokeOperation(wrapper, operation)
    expect(showAdminDialog).toHaveBeenCalledTimes(1)
    expect(dashboardApi[operation.api]).toHaveBeenCalledTimes(1)
    wrapper.unmount()
  })

  test.each(OPERATIONS)('$name 后端失败时显示具体错误且不会显示成功', async operation => {
    dashboardApi[operation.api].mockResolvedValue({ ok: false, data: { message: `${operation.name}失败详情` } })
    const wrapper = await mountResource()
    await invokeOperation(wrapper, operation)
    expect(wrapper.text()).toContain(`${operation.name}失败详情`)
    expect(wrapper.text()).not.toContain(operation.successText)
    wrapper.unmount()
  })

  test('进入维护取消确认时不发送请求，结束维护不重复确认', async () => {
    window.confirm.mockReturnValueOnce(false)
    let wrapper = await mountResource()
    await invokeOperation(wrapper, OPERATIONS[0])
    expect(dashboardApi.setResourceMaintenance).not.toHaveBeenCalled()
    wrapper.unmount()

    arrangeResourceReads(resourceStatus({ maintenance: true }))
    dashboardApi.setResourceMaintenance.mockResolvedValue({ ok: true, data: { message: '维护模式已结束，智能回复和后台任务已恢复' } })
    wrapper = await mountResource()
    await findButton(wrapper, '结束维护模式').trigger('click')
    await flushPromises()
    expect(window.confirm).toHaveBeenCalledTimes(1)
    expect(dashboardApi.setResourceMaintenance).toHaveBeenCalledWith(false)
    wrapper.unmount()
  })

  test('资源保护策略确认后，管理员过期只重试一次且不重复确认', async () => {
    let resume
    const showAdminDialog = jest.fn((_message, callback) => { resume = callback })
    dashboardApi.setResourceMode.mockResolvedValueOnce(ADMIN_REQUIRED).mockResolvedValueOnce({ ok: true, data: {} })
    const wrapper = await mountResource(showAdminDialog)
    await findButton(wrapper, '大内存策略').trigger('click')
    await flushPromises()
    expect(window.confirm).toHaveBeenCalledTimes(1)
    expect(showAdminDialog).toHaveBeenCalledWith('切换资源保护策略需要管理员密码', expect.any(Function))
    await resume()
    await flushPromises()
    expect(window.confirm).toHaveBeenCalledTimes(1)
    expect(dashboardApi.setResourceMode).toHaveBeenCalledTimes(2)
    expect(wrapper.text()).toContain('资源保护策略已切换为大内存策略')
    wrapper.unmount()
  })

  test('资源保护策略取消确认时不发送请求', async () => {
    window.confirm.mockReturnValue(false)
    const wrapper = await mountResource()
    await findButton(wrapper, '大内存策略').trigger('click')
    await flushPromises()
    expect(dashboardApi.setResourceMode).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  test('诊断记录首次加载 120 条、继续加载到全部并按需展开报错', async () => {
    const firstItems = Array.from({ length: 120 }, (_, index) => ({
      recordId: `unknown:u-${index}`, recordType: 'unknown_task', taskId: `u-${index}`,
      kind: 'unknown_queue', status: 'failed', createdAt: '2026-08-30T08:00:00.000Z', updatedAt: '2026-08-30T08:00:00.000Z',
    }))
    const lastItem = { recordId: 'media:m-120', recordType: 'unfinished_media', taskId: 'm-120', kind: 'media_image_analysis', status: 'failed', finishReason: 'processing_failed', finishedAt: '2026-08-30T07:00:00.000Z' }
    dashboardApi.fetchResourceDiagnostics
      .mockResolvedValueOnce({ ok: true, data: { items: firstItems, total: 121, counts: { all: 121, unknown: 120, media: 1 }, hasMore: true, nextCursor: 'next-120' } })
      .mockResolvedValueOnce({ ok: true, data: { items: [lastItem], total: 121, counts: { all: 121, unknown: 120, media: 1 }, hasMore: false, nextCursor: '' } })
    dashboardApi.fetchResourceDiagnosticDetail
      .mockResolvedValueOnce({ ok: true, data: { error: '系统保存的完整报错', diagnostics: { step: 'failed' } } })
      .mockResolvedValueOnce({ ok: true, data: { error: '', diagnostics: {} } })
    const wrapper = await mountResource()
    await findButton(wrapper, '打开诊断记录').trigger('click')
    await flushPromises()
    expect(wrapper.findAll('.diagnostic-item')).toHaveLength(120)
    expect(wrapper.text()).toContain('已加载 120 / 121 条')
    await findButton(wrapper, '加载更多').trigger('click')
    await flushPromises()
    expect(wrapper.findAll('.diagnostic-item')).toHaveLength(121)
    expect(wrapper.text()).toContain('已加载 121 / 121 条')
    await wrapper.find('.diagnostic-summary').trigger('click')
    await flushPromises()
    expect(dashboardApi.fetchResourceDiagnosticDetail).toHaveBeenCalledTimes(1)
    expect(wrapper.text()).toContain('系统保存的完整报错')
    await wrapper.findAll('.diagnostic-summary')[1].trigger('click')
    await flushPromises()
    expect(dashboardApi.fetchResourceDiagnosticDetail).toHaveBeenCalledTimes(2)
    expect(wrapper.text()).toContain('未记录具体报错')
    wrapper.unmount()
  })

  test('首屏使用中文状态且不存在人工回收按钮', async () => {
    const base = resourceStatus()
    arrangeResourceReads(resourceStatus({
      media: {
        ...base.media,
        unfinishedByReason: { queue_limit: 3 },
        lastQueueLimitAt: '2026-08-30T08:00:00.000Z',
      },
    }))
    const wrapper = await mountResource()
    expect(wrapper.text()).toContain('服务状态')
    expect(wrapper.text()).toContain('资源余量')
    expect(wrapper.text()).toContain('媒体处理队列：当前空闲')
    expect(wrapper.text()).toContain('曾因队列超限舍弃 3 项，最近一次发生在')
    expect(wrapper.find('.media-history-notice a').attributes('href')).toBe('#resource-diagnostics')
    expect(wrapper.text()).not.toContain('回收 stale')
    expect(wrapper.text()).not.toContain('tool_active')
    wrapper.unmount()
  })
})
