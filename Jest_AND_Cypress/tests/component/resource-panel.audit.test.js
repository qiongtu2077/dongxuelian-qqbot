import { flushPromises, mount } from '@vue/test-utils'
import ResourcePanel from '../../../packages/koishi-plugin-dashboard/frontend/src/components/ResourcePanel.vue'
import * as dashboardApi from '../../../packages/koishi-plugin-dashboard/frontend/src/api'

jest.mock('../../../packages/koishi-plugin-dashboard/frontend/src/api', () => ({
  cancelResourceTask: jest.fn(),
  fetchResourceEvents: jest.fn(),
  fetchResourceMemoryHistory: jest.fn(),
  fetchResourceMode: jest.fn(),
  fetchResourceStatus: jest.fn(),
  fetchResourceTasks: jest.fn(),
  isAdminRequired: jest.fn(res => res?.code === 'ADMIN_REQUIRED' || res?.data?.code === 'ADMIN_REQUIRED'),
  reclaimResourceStale: jest.fn(),
  setResourceMode: jest.fn(),
  setResourceMaintenance: jest.fn(),
}))

const ADMIN_REQUIRED = { ok: false, code: 'ADMIN_REQUIRED', data: { code: 'ADMIN_REQUIRED' } }
const TASK = { id: 'task-1', kind: 'video', status: 'pending', createdAt: '2026-08-30T00:00:00.000Z' }
const OPERATIONS = [
  {
    name: '维护模式',
    api: 'setResourceMaintenance',
    prompt: '切换资源维护模式需要管理员密码',
    success: { ok: true, data: { message: '维护模式已开启' } },
    successText: '维护模式已开启',
  },
  {
    name: '回收 stale',
    api: 'reclaimResourceStale',
    prompt: '回收过期资源锁需要管理员密码',
    success: { ok: true, data: { message: 'reclaimed' } },
    successText: 'stale 回收检查已完成',
  },
  {
    name: '取消任务',
    api: 'cancelResourceTask',
    prompt: '取消资源任务需要管理员密码',
    success: { ok: true, data: { message: 'cancelled' } },
    successText: '任务已取消',
  },
]

// Supplies all harmless read responses used during mount and post-action refresh.
function arrangeResourceReads() {
  dashboardApi.fetchResourceStatus.mockResolvedValue({ ok: true, data: { maintenance: false, workers: [] } })
  dashboardApi.fetchResourceMode.mockResolvedValue({ ok: true, data: { serverMode: 'small' } })
  dashboardApi.fetchResourceTasks.mockResolvedValue({ ok: true, data: { tasks: [TASK] } })
  dashboardApi.fetchResourceEvents.mockResolvedValue({ ok: true, data: { events: [] } })
  dashboardApi.fetchResourceMemoryHistory.mockResolvedValue({ ok: true, data: { points: [] } })
  dashboardApi.setResourceMode.mockResolvedValue({ ok: true, data: {} })
}

// Mounts the resource panel and waits for its initial four data reads.
async function mountResource(showAdminDialog = jest.fn()) {
  const wrapper = mount(ResourcePanel, { global: { provide: { showAdminDialog } } })
  await flushPromises()
  return wrapper
}

// Invokes one of the three administrator-protected resource buttons.
async function invokeOperation(wrapper, operation) {
  const label = operation.name === '维护模式' ? '开启维护' : operation.name === '取消任务' ? '取消' : '回收 stale'
  const button = wrapper.findAll('button').find(item => item.text() === label)
  expect(button).toBeDefined()
  await button.trigger('click')
  await flushPromises()
}

describe('ResourcePanel 管理员重试闭环', () => {
  beforeEach(() => {
    jest.useFakeTimers()
    jest.clearAllMocks()
    arrangeResourceReads()
  })

  afterEach(() => {
    jest.useRealTimers()
  })

  test.each(OPERATIONS)('$name 管理员过期后只重试原操作一次并成功', async operation => {
    let resume
    const showAdminDialog = jest.fn((_message, callback) => { resume = callback })
    dashboardApi[operation.api]
      .mockResolvedValueOnce(ADMIN_REQUIRED)
      .mockResolvedValueOnce(operation.success)
    const wrapper = await mountResource(showAdminDialog)

    await invokeOperation(wrapper, operation)
    expect(showAdminDialog).toHaveBeenCalledWith(operation.prompt, expect.any(Function))
    await resume()
    await flushPromises()

    expect(dashboardApi[operation.api]).toHaveBeenCalledTimes(2)
    expect(wrapper.text()).toContain(operation.successText)
    wrapper.unmount()
  })

  test.each(OPERATIONS)('$name 管理员验证取消后不重试且页面可继续操作', async operation => {
    const showAdminDialog = jest.fn()
    dashboardApi[operation.api].mockResolvedValue(ADMIN_REQUIRED)
    const wrapper = await mountResource(showAdminDialog)

    await invokeOperation(wrapper, operation)

    expect(showAdminDialog).toHaveBeenCalledTimes(1)
    expect(dashboardApi[operation.api]).toHaveBeenCalledTimes(1)
    expect(wrapper.text()).not.toContain('操作中')
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
})
