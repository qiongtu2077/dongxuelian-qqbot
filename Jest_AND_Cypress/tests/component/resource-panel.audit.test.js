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
  fetchReportAnalysis: jest.fn(),
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
  dashboardApi.fetchReportAnalysis.mockResolvedValue({ ok: true, data: { state: 'legacy_unknown', message: '旧版本未记录分析覆盖信息', notification: { status: 'pending' } } })
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

  test('取消冲突弹窗显示中文原因和原始错误码，关闭后正常任务仍可取消', async () => {
    dashboardApi.cancelResourceTask.mockResolvedValueOnce({ ok: false, data: { code: 'TASK_ID_CONFLICT', message: '任务 ID 与已有记录重复，系统为保留历史记录拒绝取消。' } }).mockResolvedValueOnce(OPERATIONS[1].success)
    const wrapper = await mountResource()
    await invokeOperation(wrapper, OPERATIONS[1])
    const dialog = wrapper.find('[role="alertdialog"]')
    expect(dialog.exists()).toBe(true)
    expect(dialog.text()).toContain('取消任务失败')
    expect(dialog.text()).toContain('任务 ID 与已有记录重复')
    expect(dialog.text()).toContain(TASK.id)
    expect(dialog.find('pre').text()).toContain('TASK_ID_CONFLICT')
    expect(wrapper.text()).not.toContain('任务已取消')
    await findButton(wrapper, '知道了').trigger('click')
    expect(wrapper.find('[role="alertdialog"]').exists()).toBe(false)
    await invokeOperation(wrapper, OPERATIONS[1])
    expect(wrapper.text()).toContain('任务已取消')
    wrapper.unmount()
  })

  test('取消请求抛出网络异常时弹窗解释原因并保留原始报错', async () => {
    dashboardApi.cancelResourceTask.mockRejectedValueOnce(new TypeError('Failed to fetch'))
    const wrapper = await mountResource()
    await invokeOperation(wrapper, OPERATIONS[1])
    expect(wrapper.find('[role="alertdialog"]').text()).toContain('未能连接到服务器')
    expect(wrapper.find('[role="alertdialog"] pre').text()).toContain('Failed to fetch')
    expect(findButton(wrapper, '取消').attributes('disabled')).toBeUndefined()
    wrapper.unmount()
  })

  test('取消请求进行中禁用重复提交，失败后恢复操作', async () => {
    let resolve
    dashboardApi.cancelResourceTask.mockReturnValueOnce(new Promise(done => { resolve = done }))
    const wrapper = await mountResource()
    await findButton(wrapper, '取消').trigger('click')
    expect(findButton(wrapper, '取消中…').attributes('disabled')).toBeDefined()
    expect(dashboardApi.cancelResourceTask).toHaveBeenCalledTimes(1)
    resolve({ ok: false, data: { message: '请求超时' } })
    await flushPromises()
    expect(wrapper.find('[role="alertdialog"]').text()).toContain('请求超时')
    expect(findButton(wrapper, '取消').attributes('disabled')).toBeUndefined()
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
    expect(dashboardApi.fetchResourceDiagnosticDetail).not.toHaveBeenCalled()
    await wrapper.find('.diagnostic-toggle').trigger('click')
    await flushPromises()
    expect(dashboardApi.fetchResourceDiagnosticDetail).toHaveBeenCalledTimes(1)
    expect(wrapper.text()).toContain('系统保存的完整报错')
    await wrapper.find('.diagnostic-toggle').trigger('click')
    expect(wrapper.find('.diagnostic-detail').exists()).toBe(false)
    await wrapper.find('.diagnostic-toggle').trigger('click')
    await flushPromises()
    expect(dashboardApi.fetchResourceDiagnosticDetail).toHaveBeenCalledTimes(1)
    await wrapper.findAll('.diagnostic-toggle')[1].trigger('click')
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

  test('任务记录按状态查询，独立详情按钮保留完整 ID 与复制操作', async () => {
    const doneTask = {
      id: 'external_video_download-json_data_quot_prompt_very_long_internal_id',
      kind: 'external_video_download', status: 'done', step: 'done', channelKey: '1072587329',
      updatedAt: '2026-10-05T11:44:36.984Z', notify: { target: 'qq-group', channelKey: '1072587329', status: 'pending' },
      displaySummary: { bvId: 'BV1xx411c7mD' },
    }
    dashboardApi.fetchResourceTasks.mockImplementation(async status => ({ ok: true, data: { tasks: status === 'done' ? [doneTask] : [] } }))
    const writeText = jest.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    const wrapper = await mountResource()
    expect(dashboardApi.fetchResourceTasks).toHaveBeenLastCalledWith('pending,claiming,running,deferred')
    expect(wrapper.find('.resource-task-card').text()).toContain('当前没有进行中的任务')
    await findButton(wrapper, '已完成').trigger('click')
    await flushPromises()
    expect(dashboardApi.fetchResourceTasks).toHaveBeenLastCalledWith('done')
    expect(wrapper.find('.resource-task-row').text()).toContain('下载 B 站视频 · BV1xx411c7mD')
    expect(wrapper.find('.resource-task-row').text()).toContain('来源：群 1072587329')
    expect(wrapper.find('.resource-task-row').text()).toContain('10-05 19:44:36')
    expect(wrapper.find('.resource-task-row').text()).not.toContain(doneTask.id)
    expect(wrapper.find('.resource-task-row').text()).not.toContain('已发送')
    await wrapper.find('.resource-task-content').trigger('click')
    expect(wrapper.find('.resource-task-detail').exists()).toBe(false)
    await findButton(wrapper, '查看详情').trigger('click')
    expect(wrapper.find('.resource-task-detail').text()).toContain(doneTask.id)
    await findButton(wrapper, '复制任务 ID').trigger('click')
    await flushPromises()
    expect(writeText).toHaveBeenCalledWith(doneTask.id)
    expect(wrapper.text()).toContain('任务 ID 已复制')
    await findButton(wrapper, '失败').trigger('click')
    await flushPromises()
    expect(dashboardApi.fetchResourceTasks).toHaveBeenLastCalledWith('failed')
    expect(wrapper.find('.resource-task-detail').exists()).toBe(false)
    expect(wrapper.find('.resource-task-card').text()).toContain('暂无失败记录')
    wrapper.unmount()
  })

  test('暂缓原因使用真实记录，读取失败可刷新重试', async () => {
    dashboardApi.fetchResourceTasks.mockResolvedValueOnce({ ok: true, data: { tasks: [{
      id: 'deferred-1', kind: 'media_image_analysis', status: 'deferred',
      error: 'available memory is below task min memory budget',
    }] } }).mockResolvedValueOnce({ ok: false, data: { message: '任务读取错误详情' } })
      .mockResolvedValueOnce({ ok: true, data: { tasks: [] } })
    const wrapper = await mountResource()
    expect(wrapper.find('.resource-task-row').text()).toContain('暂缓处理')
    expect(wrapper.find('.resource-task-row').text()).toContain('等待可用内存恢复')
    await findButton(wrapper, '失败').trigger('click')
    await flushPromises()
    expect(wrapper.find('.resource-task-card').text()).toContain('任务读取错误详情')
    expect(wrapper.find('.resource-task-row').exists()).toBe(false)
    await findButton(wrapper, '刷新记录').trigger('click')
    await flushPromises()
    expect(wrapper.find('.resource-task-error').exists()).toBe(false)
    expect(wrapper.find('.resource-task-card').text()).toContain('暂无失败记录')
    wrapper.unmount()
  })

  test('失败说明与资源事件使用中文，原始错误和事件代码仅放在独立展开项', async () => {
    const error = 'worker heartbeat stale: local-video-sender-main'
    dashboardApi.fetchResourceTasks.mockImplementation(async status => ({ ok: true, data: { tasks: status === 'failed' ? [{
      id: 'legacy-video', kind: 'external_video_download', status: 'failed', error,
    }] : [] } }))
    dashboardApi.fetchResourceEvents.mockResolvedValue({ ok: true, data: { events: [
      { source: 'S6', event: 'media_task_done', createdAt: '2026-10-05T12:22:56.771Z' },
      { source: 'S1', event: 'admission_decided', reason: 'resource budget accepted', createdAt: '2026-10-05T12:22:50.748Z' },
    ] } })
    const wrapper = await mountResource()
    const summaries = wrapper.findAll('.resource-event-summary')
    expect(summaries[0].text()).toContain('媒体处理')
    expect(summaries[0].text()).toContain('媒体分析任务已完成')
    expect(summaries[0].text()).toContain('10-05 20:22:56')
    expect(summaries[0].text()).not.toContain('media_task_done')
    expect(summaries[1].text()).toContain('资源满足要求，允许执行。')
    expect(wrapper.find('.resource-event-raw').attributes('open')).toBeUndefined()
    expect(wrapper.find('.resource-event-raw').text()).toContain('media_task_done')
    await findButton(wrapper, '失败').trigger('click')
    await flushPromises()
    await findButton(wrapper, '查看详情').trigger('click')
    expect(wrapper.find('.resource-task-reason p').text()).toContain('误判为失联')
    expect(wrapper.find('.resource-task-reason p').text()).toContain('无法证明视频是否已发送')
    expect(wrapper.find('.resource-task-reason details').attributes('open')).toBeUndefined()
    expect(wrapper.find('.resource-task-reason pre').text()).toBe(error)
    wrapper.unmount()
  })
})

// 完整日报详情仅按需查询，覆盖未知状态、管理员验证和异步任务切换。
describe('ResourcePanel 日报分析详情', () => {
  const dailyTask = { id: 'daily-1', kind: 'daily_report', status: 'running', createdAt: '2026-10-01T15:59:00Z' }
  const payload = {
    state: 'available', taskStatus: 'running',
    analysis: {
      analysisState: 'processing', sourceCompleteness: 'legacy_unknown', periodBackfilled: true,
      reportPeriod: { reportDate: '2026-10-01', periodStartMs: Date.parse('2026-10-01T04:00:00+08:00'), periodEndMs: Date.parse('2026-10-02T04:00:00+08:00'), cutoffMs: Date.parse('2026-10-01T23:59:00+08:00') },
      windowMessageCount: 4500, selectedMessageCount: 4000, excludedByLimitCount: 500, submittedMessageCount: 0, summarizedMessageCount: 0,
      topicInputMessageCount: 0, omittedMessageCount: 4000, unprocessedCount: 4000, coverageRate: 0, batchCount: 41, mergeLevels: 0,
      requestCount: 0, reportCallCount: 0, retryCount: 0, usageReadableRequests: 0, tokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      stages: { compression: 'processing', basic: 'pending', full: 'pending' }, stageDurationsMs: { basic: 0 }, failedBatches: [], warnings: [],
    },
    notification: { status: 'pending' },
  }

  beforeEach(() => {
    jest.useFakeTimers()
    jest.clearAllMocks()
    arrangeResourceReads()
    dashboardApi.fetchResourceTasks.mockResolvedValue({ ok: true, data: { tasks: [dailyTask] } })
    dashboardApi.fetchReportAnalysis.mockResolvedValue({ ok: true, data: payload })
  })
  afterEach(() => jest.useRealTimers())

  test('仅展开日报时读取，零值和北京时间保留，刷新展开详情更新进度', async () => {
    const wrapper = await mountResource()
    expect(dashboardApi.fetchReportAnalysis).not.toHaveBeenCalled()
    await findButton(wrapper, '查看详情').trigger('click')
    await flushPromises()
    expect(dashboardApi.fetchReportAnalysis).toHaveBeenCalledWith('daily-1')
    const detail = wrapper.find('.report-analysis-detail')
    expect(detail.text()).toContain('旧版本未记录正文完整性')
    expect(detail.text()).toContain('旧任务按创建时间补齐报告窗口')
    expect(detail.text()).toContain('2026-10-01 04:00:00')
    expect(detail.text()).toContain('2026-10-01 23:59:00')
    expect(detail.text()).toContain('话题输入覆盖率0%')
    expect(detail.text()).toContain('因条数上限未选入500')
    expect(detail.text()).toContain('已提交摘要请求0')
    expect(detail.text()).toContain('未知：未取得可读用量')
    expect(detail.findAll('button')).toHaveLength(0)
    expect(wrapper.find('.resource-task-detail').element.tagName).toBe('DIV')
    dashboardApi.fetchReportAnalysis.mockResolvedValueOnce({ ok: true, data: { ...payload, analysis: { ...payload.analysis, analysisState: 'complete', topicInputMessageCount: 4000, omittedMessageCount: 0, coverageRate: 100, requestCount: 4, usageReadableRequests: 2, tokenUsage: { promptTokens: 12, completionTokens: 3, totalTokens: 15 } } } })
    await findButton(wrapper, '刷新记录').trigger('click')
    await flushPromises()
    expect(detail.text()).toContain('完整成功')
    expect(detail.text()).toContain('2/4 次请求有可读用量（仅统计已读部分）')
    expect(detail.text()).toContain('12 / 3 / 15')
    wrapper.unmount()
  })

  test('新排队日报显示固定窗口，分析数量尚未计算', async () => {
    dashboardApi.fetchReportAnalysis.mockResolvedValueOnce({ ok: true, data: { state: 'not_started', message: '尚未保存分析进度', reportPeriod: payload.analysis.reportPeriod } })
    const wrapper = await mountResource()
    await findButton(wrapper, '查看详情').trigger('click')
    await flushPromises()
    const text = wrapper.find('.report-analysis-detail').text()
    expect(text).toContain('2026-10-01 04:00:00')
    expect(text).toContain('2026-10-01 23:59:00')
    expect(text).toContain('尚未计算')
    expect(text).not.toContain('100%')
    wrapper.unmount()
  })

  test('历史未知与零条消息不显示100%覆盖', async () => {
    dashboardApi.fetchReportAnalysis.mockResolvedValueOnce({ ok: true, data: { state: 'legacy_unknown', message: '旧版本未记录分析覆盖信息', notification: { status: 'sent' } } })
    const wrapper = await mountResource()
    await findButton(wrapper, '查看详情').trigger('click')
    await flushPromises()
    expect(wrapper.find('.report-analysis-detail').text()).toContain('旧版本未记录分析覆盖信息')
    expect(wrapper.find('.report-analysis-detail').text()).not.toContain('100%')
    dashboardApi.fetchReportAnalysis.mockResolvedValueOnce({ ok: true, data: { ...payload, analysis: { ...payload.analysis, selectedMessageCount: 0, coverageRate: null } } })
    await findButton(wrapper, '刷新记录').trigger('click')
    await flushPromises()
    expect(wrapper.find('.report-analysis-detail').text()).toContain('无可分析消息')
    wrapper.unmount()
  })

  test('管理员失效仅显式打开时请求验证，自动刷新不重复弹窗', async () => {
    let retry
    const prompt = jest.fn((_message, callback) => { retry = callback })
    dashboardApi.fetchReportAnalysis.mockResolvedValue(ADMIN_REQUIRED)
    const wrapper = await mountResource(prompt)
    await findButton(wrapper, '查看详情').trigger('click')
    await flushPromises()
    expect(prompt).toHaveBeenCalledTimes(1)
    expect(wrapper.find('.report-analysis-detail').text()).toContain('需要管理员验证')
    await findButton(wrapper, '刷新记录').trigger('click')
    await flushPromises()
    expect(prompt).toHaveBeenCalledTimes(1)
    dashboardApi.fetchReportAnalysis.mockResolvedValueOnce({ ok: true, data: payload })
    await retry()
    await flushPromises()
    expect(wrapper.find('.report-analysis-detail').text()).toContain('4000')
    wrapper.unmount()
  })

  test('切换日报时旧请求的迟到响应不能覆盖新任务', async () => {
    let resolveFirst
    dashboardApi.fetchResourceTasks.mockResolvedValue({ ok: true, data: { tasks: [dailyTask, { ...dailyTask, id: 'daily-2' }] } })
    dashboardApi.fetchReportAnalysis.mockReturnValueOnce(new Promise(resolve => { resolveFirst = resolve }))
      .mockResolvedValueOnce({ ok: true, data: { state: 'legacy_unknown', message: '第二份日报详情' } })
    const wrapper = await mountResource()
    await wrapper.findAll('button').filter(button => button.text() === '查看详情')[0].trigger('click')
    await flushPromises()
    await findButton(wrapper, '查看详情').trigger('click')
    await flushPromises()
    expect(wrapper.find('.report-analysis-detail').text()).toContain('第二份日报详情')
    resolveFirst({ ok: true, data: payload })
    await flushPromises()
    expect(wrapper.find('.report-analysis-detail').text()).toContain('第二份日报详情')
    expect(wrapper.find('.report-analysis-detail').text()).not.toContain('4500')
    wrapper.unmount()
  })
})
