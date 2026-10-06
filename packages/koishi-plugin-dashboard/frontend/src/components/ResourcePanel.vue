<template>
  <div class="resource-panel">
    <div class="resource-toolbar">
      <div>
        <h2>资源中心</h2>
        <div class="resource-subline">资源总览更新于 {{ lastRefreshLabel }}；页面会自动更新</div>
      </div>
      <div class="resource-actions">
        <button class="btn btn-sm" title="立即读取最新总览、任务、事件和内存数据；页面本身也会自动更新" :disabled="loading" @click="refreshAll">立即刷新</button>
        <button class="btn btn-sm" @click="toggleMaintenance()">{{ maintenanceLabel }}</button>
      </div>
    </div>

    <div v-if="message.text" class="msg" :class="message.type">{{ message.text }}</div>

    <div class="resource-grid">
      <section class="card resource-summary">
        <div class="resource-summary-layout">
          <div class="resource-summary-main">
            <h2>资源总览</h2>
            <div class="resource-kpis">
              <div class="resource-kpi">
                <span>服务状态</span>
                <strong :class="'readable-' + botDisplay.level">{{ botDisplay.label }}</strong>
                <small>{{ botDisplay.detail }}</small>
              </div>
              <div class="resource-kpi">
                <span>资源余量</span>
                <strong :class="'readable-' + resourceDisplay.level">{{ resourceDisplay.label }}</strong>
                <small>{{ resourceDisplay.detail }}</small>
              </div>
              <div class="resource-kpi">
                <span>资源保护策略</span>
                <strong>{{ policyDisplay.label }}</strong>
                <small>{{ policyDisplay.detail }}</small>
              </div>
              <div class="resource-kpi">
                <span>全部排队任务</span>
                <strong>{{ numberValue(status.queueLength) }}</strong>
                <small>未知类型不会归到任一处理器</small>
              </div>
            </div>
            <div class="resource-mode-switch">
              <div class="resource-section-title">资源保护策略</div>
              <div class="resource-segmented">
                <button
                  class="resource-segmented-btn"
                  :class="{ active: status.serverMode === 'small' }"
                  :disabled="loadingMode"
                  @click="setMode('small')"
                >
                  小内存策略
                </button>
                <button
                  class="resource-segmented-btn"
                  :class="{ active: status.serverMode === 'large' }"
                  :disabled="loadingMode"
                  @click="setMode('large')"
                >
                  大内存策略
                </button>
              </div>
              <div class="resource-subline">{{ policyDisplay.detail }}</div>
              <div class="resource-background-state" :class="status.background_allowed === false ? 'readable-danger' : 'readable-ok'">{{ activityDisplay.background }}</div>
              <details class="resource-diagnostic-details">
                <summary>资源保护详情</summary>
                <div>{{ activityDisplay.browser }}</div>
                <div>{{ activityDisplay.render }}</div>
                <div>配置来源：{{ display(status.serverModeSource) }}</div>
              </details>
            </div>
            <div class="resource-running">
              <div class="resource-section-title">当前独占</div>
              <div v-if="running" class="resource-runbox">
                <b>{{ taskKindDisplay(running.kind) }}</b>
                <span>已有独占任务正在运行</span>
                <details class="resource-diagnostic-details">
                  <summary>查看诊断详情</summary>
                  <small>内部任务标识：{{ display(running.taskId) }}</small>
                  <small>内部步骤：{{ display(running.step) }}</small>
                  <small>处理所有者：{{ display(running.owner) }}</small>
                </details>
              </div>
              <div v-else class="resource-empty">暂无独占任务</div>
            </div>
          </div>
        </div>
      </section>

      <section class="card resource-worker-card">
        <h2>后台处理器</h2>
        <div v-if="workers.length" class="resource-list">
          <div v-for="worker in workers" :key="display(worker.name)" class="resource-row">
            <span class="status-dot" :class="workerDisplay(worker).level === 'danger' ? 'offline' : worker.alive ? 'active' : 'offline'"></span>
            <div class="resource-worker-main">
              <div class="resource-worker-head">
                <b>{{ workerDisplay(worker).name }}</b>
                <span
                  class="resource-pill worker-progress-pill"
                  :class="'worker-progress-' + workerDisplay(worker).level"
                >{{ workerDisplay(worker).label }}</span>
              </div>
              <small>{{ workerDisplay(worker).lastContactText }} · {{ workerDisplay(worker).backlogText }}</small>
              <small v-if="workerDisplay(worker).pauseReasons.length">暂停原因：{{ workerDisplay(worker).pauseReasons.join('、') }}</small>
              <details class="resource-diagnostic-details">
                <summary>查看诊断详情</summary>
                <small>内部名称：{{ display(worker.name) }}</small>
                <small>原始步骤：{{ display(worker.step) }}</small>
                <small>轮询次数：{{ display(worker.loopIterations) }}</small>
                <small>最近检查队列：{{ display(worker.lastClaimAttemptAt) }}</small>
                <small>当前内部任务标识：{{ display(worker.currentTaskId) }}</small>
                <small>现在可以处理：{{ numberValue(worker.readyCount) }} · 稍后重试：{{ numberValue(worker.deferredCount) }}</small>
              </details>
            </div>
          </div>
        </div>
        <div v-else class="resource-empty">暂无后台处理器状态</div>
      </section>

      <section class="card resource-media-card">
        <h2>媒体处理队列：{{ mediaSummary.label }}</h2>
        <div class="resource-subline">用于排队处理图片、文件和语音，避免高峰时占满资源。{{ mediaSummary.detail }}</div>
        <div v-for="queue in mediaQueues" :key="queue.kind" class="media-queue-box" :class="'media-risk-' + queue.display.level">
          <div class="media-queue-head"><b>{{ queue.display.name }}</b><span>{{ queue.display.label }}</span></div>
          <div class="resource-metric-row"><span>排队总数</span><b>{{ queue.display.queueTotal }} / {{ queue.display.queueLimit }}</b></div>
          <div class="resource-metric-row"><span>现在可以处理</span><b>{{ queue.display.readyCount }}</b></div>
          <div class="resource-metric-row"><span>稍后重试</span><b>{{ queue.display.deferredCount }}</b></div>
          <div class="resource-metric-row"><span>正在处理</span><b>{{ queue.display.runningCount }}</b></div>
        </div>
        <div v-if="numberValue(mediaUnfinished.queue_limit) > 0" class="media-history-notice">
          曾因队列超限舍弃 {{ numberValue(mediaUnfinished.queue_limit) }} 项，最近一次发生在 {{ dateTimeDisplay(media.lastQueueLimitAt, '未记录发生时间') }}。
          <a href="#resource-diagnostics">前往任务诊断记录</a>
        </div>
        <details class="resource-diagnostic-details media-history-details">
          <summary>保留记录与缓存统计</summary>
          <div class="resource-metric-row"><span>已完成记录（保留）</span><b>{{ numberValue(media.doneCount) }}</b></div>
          <div class="resource-metric-row"><span>缓存可复用</span><b>{{ numberValue(media.cacheIndexSize) }}</b></div>
          <div class="resource-metric-row"><span>因队列超限舍弃</span><b>{{ numberValue(mediaUnfinished.queue_limit) }}</b></div>
          <div class="resource-metric-row"><span>处理失败</span><b>{{ numberValue(mediaUnfinished.processing_failed) }}</b></div>
          <div class="resource-metric-row"><span>服务重启时中断</span><b>{{ numberValue(mediaUnfinished.restart_interrupted) }}</b></div>
          <div class="resource-metric-row"><span>历史原因未知</span><b>{{ numberValue(mediaUnfinished.legacy_unknown) }}</b></div>
        </details>
      </section>

      <section class="card resource-precompute-card">
        <h2>日报预计算</h2>
        <input
          v-model="precomputeQuery"
          class="precompute-search"
          type="search"
          inputmode="numeric"
          placeholder="搜索群号"
          aria-label="搜索日报预计算群号"
        />
        <div class="resource-metric-row"><span>coverage</span><b>{{ numberValue(precompute.coverageCount) }}</b></div>
        <div class="resource-metric-row"><span>slots</span><b>{{ numberValue(precompute.slotCount) }}</b></div>
        <div v-if="filteredCoverage.length" class="resource-list compact">
          <div v-for="item in filteredCoverage" :key="coverageKey(item)" class="resource-row">
            <div>
              <b>{{ display(item.channelKey) }}</b>
              <small>{{ percentLabel(item.coverageRate) }} · {{ display(item.updatedAt) }}</small>
            </div>
          </div>
        </div>
        <div v-else class="resource-empty">{{ coverage.length ? '未找到匹配群号' : '暂无 coverage' }}</div>
      </section>

      <section class="card memory-chart-card">
        <div class="memory-chart-head">
          <div>
            <h2>内存走势</h2>
            <div class="resource-subline">{{ memorySampleLabel }}</div>
          </div>
          <div class="memory-chart-controls">
            <select v-model="memoryRange" class="memory-range-select" @change="loadMemoryHistory({ animate: true })">
              <option v-for="option in memoryRangeOptions" :key="option.value" :value="option.value">{{ option.label }}</option>
            </select>
            <div class="memory-current-usage">当前 {{ memoryCurrentPercentLabel }}</div>
          </div>
        </div>
        <div class="memory-chart-wrap">
          <svg class="memory-chart" :class="{ 'is-transitioning': memoryChartTransitioning }" viewBox="0 0 640 220" preserveAspectRatio="none" role="img" aria-label="已使用内存折线图">
            <line
              v-for="tick in memoryYTicks"
              :key="tick.y"
              x1="64"
              :y1="tick.y"
              x2="576"
              :y2="tick.y"
              class="memory-chart-grid"
            />
            <text
              v-for="tick in memoryYTicks"
              :key="'label-' + tick.y"
              x="8"
              :y="tick.y + 4"
              class="memory-chart-label"
            >{{ tick.label }}</text>
            <text
              v-for="tick in memoryYTicks"
              :key="'percent-' + tick.y"
              x="632"
              :y="tick.y + 4"
              text-anchor="end"
              class="memory-chart-label memory-chart-percent"
            >{{ tick.percentLabel }}</text>
            <polyline
              v-if="memoryPolyline"
              :points="memoryPolyline"
              class="memory-chart-line"
            />
          </svg>
          <div v-if="!hasMemoryChartData" class="memory-chart-empty">
            {{ memoryEmptyText }}
          </div>
        </div>
        <div class="memory-chart-meta">
          <span>平均 {{ memoryAverageLabel }}</span>
          <span>最小 {{ memoryMinLabel }}</span>
          <span>最大 {{ memoryMaxLabel }}</span>
        </div>
      </section>

      <section class="card resource-disk-card">
        <div class="resource-card-head compact-head">
          <div>
            <h2>磁盘占用</h2>
            <div class="resource-subline">关键目录按体积排序，数据缓存 {{ diskCacheLabel }}</div>
          </div>
        </div>
        <div class="disk-summary">
          <div class="resource-metric-row"><span>总占用</span><b>{{ diskUsageLabel }}</b></div>
          <div class="resource-metric-row"><span>可用空间</span><b>{{ diskAvailableLabel }}</b></div>
        </div>
        <div v-if="diskEntries.length" class="resource-list compact disk-list">
          <div v-for="item in diskEntries" :key="display(item.name)" class="resource-row disk-row">
            <div>
              <b>{{ display(item.label || item.name) }}</b>
              <small>{{ display(item.path) }}</small>
            </div>
            <strong>{{ sizeMbLabel(item.sizeMb) }}</strong>
          </div>
        </div>
        <div v-else class="resource-empty">暂无磁盘详情</div>
      </section>
    </div>

    <ResourceDiagnosticsPanel />

    <section class="card resource-task-card">
      <div class="resource-card-head">
        <h2>任务记录</h2>
        <button class="btn btn-sm" :disabled="loadingTasks" @click="loadTasks">刷新记录</button>
      </div>
      <div class="resource-task-filters" role="group" aria-label="任务状态筛选">
        <button
          v-for="filter in taskFilters"
          :key="filter.status"
          class="btn btn-sm"
          :class="{ 'is-selected': taskFilter === filter.status }"
          :aria-pressed="taskFilter === filter.status"
          :disabled="loadingTasks"
          @click="selectTaskFilter(filter.status)"
        >{{ filter.label }}</button>
      </div>
      <p class="resource-task-hint">进行中包含排队、准备执行、处理和暂缓任务；已完成记录不占等待队列。时间为北京时间。</p>
      <p v-if="taskReadError" class="resource-task-error" role="alert">{{ taskReadError }}</p>
      <div class="resource-table-wrap">
        <table class="resource-table">
          <thead>
            <tr>
              <th>状态</th>
              <th>任务类别</th>
              <th>任务内容</th>
              <th>更新时间</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            <template v-for="task in tasks" :key="display(task.id)">
              <tr class="resource-task-row">
                <td>
                  <span class="resource-pill" :class="'worker-progress-' + taskStatusDisplay(task).level">{{ taskStatusDisplay(task).label }}</span>
                  <small v-if="taskStatusDisplay(task).detail" class="resource-task-secondary">{{ taskStatusDisplay(task).detail }}</small>
                </td>
                <td>{{ taskCategoryDisplay(task.kind) }}</td>
                <td class="resource-task-content">
                  <b>{{ taskContentDisplay(task) }}</b>
                  <small class="resource-task-secondary">{{ taskSourceDisplay(task) }}</small>
                </td>
                <td class="resource-task-time" :title="taskTimeDisplay(task.updatedAt || task.createdAt, true)">{{ taskTimeDisplay(task.updatedAt || task.createdAt) }}</td>
                <td>
                  <div class="resource-task-actions">
                    <button class="btn btn-sm" :aria-expanded="expandedTaskId === task.id" @click="toggleTaskDetail(task)">{{ expandedTaskId === task.id ? '收起详情' : '查看详情' }}</button>
                    <button v-if="canCancel(task)" class="btn btn-sm" :disabled="!!cancellingTaskId" @click="cancelTask(task)">{{ cancellingTaskId === task.id ? '取消中…' : '取消' }}</button>
                  </div>
                </td>
              </tr>
              <tr v-if="expandedTaskId === task.id" class="resource-task-detail-row">
                <td colspan="5">
                  <div class="resource-task-detail">
                    <div class="resource-task-id">
                      <span>任务 ID：<code>{{ task.id }}</code></span>
                      <button class="btn btn-sm" @click="copyTaskId(task)">复制任务 ID</button>
                    </div>
                    <p v-if="taskCopyMessage" class="resource-task-secondary" role="status">{{ taskCopyMessage }}</p>
                    <dl class="resource-task-meta">
                      <div><dt>状态</dt><dd>{{ taskStatusDisplay(task).label }}（{{ display(task.status) }}）</dd></div>
                      <div><dt>内部类型</dt><dd>{{ display(task.kind) }}</dd></div>
                      <div><dt>处理步骤</dt><dd>{{ taskStepDisplay(task) }} · {{ display(task.step) }}</dd></div>
                      <div><dt>来源</dt><dd>{{ taskSourceDisplay(task) }}</dd></div>
                      <div><dt>提交者</dt><dd>{{ display(task.userId, '未记录') }}</dd></div>
                      <div><dt>处理器</dt><dd>{{ display(task.claimedBy, '未记录') }}</dd></div>
                      <div><dt>创建时间</dt><dd>{{ taskTimeDisplay(task.createdAt, true) }}</dd></div>
                      <div><dt>开始时间</dt><dd>{{ taskTimeDisplay(task.startedAt, true) }}</dd></div>
                      <div><dt>结束时间</dt><dd>{{ taskTimeDisplay(task.finishedAt, true) }}</dd></div>
                      <div v-if="task.retryAfter"><dt>重试时间</dt><dd>{{ taskTimeDisplay(task.retryAfter, true) }}</dd></div>
                    </dl>
                    <div v-if="task.error || task.requeueReason" class="resource-task-reason">
                      <b>{{ task.status === 'failed' ? '失败原因' : '记录的原因' }}</b>
                      <p>{{ taskErrorDisplay(task.error || task.requeueReason) }}</p>
                      <details>
                        <summary>展开原始报错</summary>
                        <pre>{{ task.error || task.requeueReason }}</pre>
                      </details>
                    </div>
                    <ReportAnalysisDetail v-if="task.kind === 'daily_report'" :payload="reportAnalysis" :loading="loadingReportAnalysis" :error="reportAnalysisError" />
                  </div>
                </td>
              </tr>
            </template>
            <tr v-if="!tasks.length">
              <td colspan="5" class="resource-empty-cell">
                {{ loadingTasks ? '加载中…' : taskReadError ? '任务读取失败，请刷新重试' : taskEmptyText }}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <section class="card">
      <div class="resource-card-head">
        <h2>最近事件</h2>
        <button class="btn btn-sm" :disabled="loadingEvents" @click="loadEvents">刷新事件</button>
      </div>
      <p class="resource-task-hint">按发生时间排序，时间为北京时间。</p>
      <div class="resource-events">
        <div v-for="event in events" :key="eventKey(event)" class="resource-event">
          <div class="resource-event-summary">
            <span>{{ resourceEventSourceDisplay(event.source) }}</span>
            <div>
              <b>{{ resourceEventDisplay(event.event) }}</b>
              <small v-if="eventDetail(event)">{{ eventDetail(event) }}</small>
            </div>
            <time :datetime="String(event.createdAt || '')" :title="taskTimeDisplay(event.createdAt, true)">{{ taskTimeDisplay(event.createdAt) }}</time>
          </div>
          <details class="resource-event-raw">
            <summary>查看原始事件</summary>
            <div>事件代码：<code>{{ display(event.event) }}</code></div>
            <div>模块代码：{{ display(event.source) }}</div>
            <div v-if="event.taskId">任务 ID：<code>{{ event.taskId }}</code></div>
            <div v-if="event.previousTaskId">旧任务 ID：<code>{{ event.previousTaskId }}</code></div>
            <pre v-if="event.reason || event.error">{{ event.error || event.reason }}</pre>
          </details>
        </div>
        <div v-if="!events.length" class="resource-empty">暂无事件</div>
      </div>
    </section>
    <div v-if="cancelFailure" class="admin-modal-backdrop" @keydown.esc="cancelFailure = null">
      <div class="admin-modal-card resource-cancel-dialog" role="alertdialog" aria-modal="true" aria-labelledby="resource-cancel-title" aria-describedby="resource-cancel-reason">
        <h2 id="resource-cancel-title">取消任务失败</h2>
        <strong>{{ cancelFailure.taskName }}</strong>
        <p id="resource-cancel-reason">{{ cancelFailure.reason }}</p>
        <div class="resource-cancel-task-id">任务 ID：<code>{{ cancelFailure.taskId }}</code></div>
        <details v-if="cancelFailure.rawError">
          <summary>查看原始报错</summary>
          <pre>{{ cancelFailure.rawError }}</pre>
        </details>
        <div class="gate-actions"><button ref="cancelFailureClose" class="btn" @click="cancelFailure = null">知道了</button></div>
      </div>
    </div>
  </div>
</template>

<script lang="ts">
import { computed, inject, nextTick, onMounted, onUnmounted, ref } from 'vue'
import {
  cancelResourceTask,
  fetchResourceEvents,
  fetchResourceMemoryHistory,
  fetchResourceStatus,
  fetchResourceTasks,
  fetchReportAnalysis,
  isAdminRequired,
  setResourceMode,
  setResourceMaintenance,
} from '../api'
import { asArray, asRecord, errorMessage, type JsonRecord, type MessageState, type ShowAdminDialog } from '../types'
import { activityLeaseDisplay, botModeDisplay, canCancel, coverageKey, dateTimeDisplay, display, eventDetail, eventKey, formatInterval, mbLabel, mediaQueueDisplay, mediaSummaryDisplay, memoryUsedValue, numberValue, percentLabel, resourceEventDisplay, resourceEventSourceDisplay, resourceStateDisplay, round, serverModeDisplay, sizeMbLabel, taskCategoryDisplay, taskContentDisplay, taskErrorDisplay, taskKindDisplay, taskSourceDisplay, taskStatusDisplay, taskStepDisplay, taskTimeDisplay, workerDisplay } from '../services/resource-model'
import ResourceDiagnosticsPanel from './ResourceDiagnosticsPanel.vue'
import ReportAnalysisDetail from './ReportAnalysisDetail.vue'

export default {
  name: 'ResourcePanel',
  components: { ResourceDiagnosticsPanel, ReportAnalysisDetail },
  setup() {
    const showAdminDialog = inject<ShowAdminDialog>('showAdminDialog')
    const status = ref<JsonRecord>({})
    const tasks = ref<JsonRecord[]>([])
    const taskFilters = [
      { status: 'pending,claiming,running,deferred', label: '进行中', empty: '当前没有进行中的任务' },
      { status: 'done', label: '已完成', empty: '暂无已完成记录' },
      { status: 'failed', label: '失败', empty: '暂无失败记录' },
      { status: 'cancelled', label: '已取消', empty: '暂无已取消记录' },
    ]
    const taskFilter = ref(taskFilters[0].status)
    const taskEmptyText = computed(() => taskFilters.find(filter => filter.status === taskFilter.value)?.empty)
    const taskReadError = ref('')
    const expandedTaskId = ref('')
    const taskCopyMessage = ref('')
    const reportAnalysis = ref<JsonRecord | null>(null)
    const reportAnalysisError = ref('')
    const loadingReportAnalysis = ref(false)
    let reportAnalysisRequest = 0
    const cancellingTaskId = ref('')
    const cancelFailure = ref<{ taskId: string; taskName: string; reason: string; rawError: string } | null>(null)
    const cancelFailureClose = ref<HTMLButtonElement | null>(null)
    const events = ref<JsonRecord[]>([])
    const memoryHistory = ref<JsonRecord[]>([])
    const memoryRange = ref('5m')
    const memoryMeta = ref<JsonRecord>({})
    const memoryError = ref('')
    const precomputeQuery = ref('')
    const message = ref<MessageState>({ type: 'info', text: '' })
    const lastRefresh = ref(0)
    const loading = ref(false)
    const loadingMode = ref(false)
    const loadingTasks = ref(false)
    const loadingEvents = ref(false)
    const loadingMemory = ref(false)
    const memoryChartTransitioning = ref(false)
    let timer: ReturnType<typeof setInterval> | null = null
    let secondaryTimer: ReturnType<typeof setInterval> | null = null
    let memoryTimer: ReturnType<typeof setInterval> | null = null
    let memoryTransitionTimer: ReturnType<typeof setTimeout> | null = null
    let lastMemoryAdminPromptAt = 0

    const memoryRangeOptions = [
      { value: '1m', label: '1分钟' },
      { value: '5m', label: '5分钟' },
      { value: '10m', label: '10分钟' },
      { value: '30m', label: '30分钟' },
      { value: '1h', label: '1小时' },
      { value: '12h', label: '12小时' },
      { value: '24h', label: '24小时' },
      { value: '48h', label: '48小时' },
      { value: '72h', label: '72小时' },
    ]

    const running = computed<JsonRecord | null>(() => {
      const value = status.value.running
      return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : null
    })
    const workers = computed(() => asArray<JsonRecord>(status.value.workers))
    const media = computed(() => asRecord(status.value.media))
    const botDisplay = computed(() => botModeDisplay(status.value.mode))
    const resourceDisplay = computed(() => resourceStateDisplay(status.value.resourceState, status.value.memAvailableMb, status.value.memTotalMb))
    const policyDisplay = computed(() => serverModeDisplay(status.value.serverMode))
    const activityDisplay = computed(() => activityLeaseDisplay(status.value))
    const mediaSummary = computed(() => mediaSummaryDisplay(media.value))
    const mediaUnfinished = computed(() => asRecord(media.value.unfinishedByReason))
    const mediaQueues = computed(() => {
      const queues = asRecord(media.value.queues)
      const risks = asRecord(media.value.mediaRiskByKind)
      return ['image', 'file', 'voice'].map(kind => ({
        kind,
        display: mediaQueueDisplay(kind, asRecord(queues[kind]), risks[kind]),
      }))
    })
    const precompute = computed(() => asRecord(status.value.precompute))
    const disk = computed(() => asRecord(status.value.disk))
    const diskFilesystem = computed(() => asRecord(disk.value.filesystem))
    const diskEntries = computed(() => asArray<JsonRecord>(disk.value.entries).slice(0, 12))
    const coverage = computed(() => asArray<JsonRecord>(precompute.value.coverage))
    const normalizedPrecomputeQuery = computed(() => precomputeQuery.value.trim().toLowerCase())
    const filteredCoverage = computed(() => {
      const query = normalizedPrecomputeQuery.value
      if (!query) return coverage.value
      return coverage.value.filter(item => [
        item.channelKey,
        item.date,
        item.file,
      ].some(value => String(value || '').toLowerCase().includes(query)))
    })
    const diskUsageLabel = computed(() => {
      const used = diskFilesystem.value.usedMb
      const total = diskFilesystem.value.totalMb
      const percent = Number(diskFilesystem.value.usedPercent)
      const usage = `${sizeMbLabel(used)} / ${sizeMbLabel(total)}`
      return Number.isFinite(percent) ? `${usage} (${percent}%)` : usage
    })
    const diskAvailableLabel = computed(() => sizeMbLabel(diskFilesystem.value.availableMb || diskFilesystem.value.freeMb))
    const diskCacheLabel = computed(() => formatInterval(Number(disk.value.cacheTtlMs)))
    const maintenanceLabel = computed(() => status.value.maintenance ? '结束维护模式' : '进入维护模式')
    const lastRefreshLabel = computed(() => lastRefresh.value ? new Date(lastRefresh.value).toLocaleTimeString() : '尚未刷新')
    const memorySeriesPoints = computed(() => memoryHistory.value
      .map((point, index) => ({
        point,
        index,
        value: memoryUsedValue(point),
      }))
      .filter(item => Number.isFinite(item.value)))
    const memoryValues = computed(() => memorySeriesPoints.value.map(item => item.value))
    const memoryAverageValue = computed(() => {
      const values = memoryValues.value
      return values.length ? Math.round(values.reduce((sum, value) => sum + value, 0) / values.length) : null
    })
    const memoryMinValue = computed(() => memoryValues.value.length ? Math.min(...memoryValues.value) : null)
    const memoryMaxValue = computed(() => memoryValues.value.length ? Math.max(...memoryValues.value) : null)
    const memoryAverageLabel = computed(() => mbLabel(memoryAverageValue.value))
    const memoryMinLabel = computed(() => mbLabel(memoryMinValue.value))
    const memoryMaxLabel = computed(() => mbLabel(memoryMaxValue.value))
    // 使用当前服务器总内存换算右轴；状态未返回总量时使用已有历史采样总量。
    const memoryTotalValue = computed(() => {
      const total = Number(status.value.memTotalMb)
      if (Number.isFinite(total) && total > 0) return total
      const sampledTotal = Number(memoryHistory.value.find(item => Number.isFinite(Number(item.memTotalMb)) && Number(item.memTotalMb) > 0)?.memTotalMb)
      return Number.isFinite(sampledTotal) && sampledTotal > 0 ? sampledTotal : null
    })
    // 当前占比来自实时资源状态，避免把所选历史时间段的最后一点当成当前用量。
    const memoryCurrentPercentLabel = computed(() => {
      const total = memoryTotalValue.value
      const available = status.value.memAvailableMb
      return total !== null && typeof available === 'number' && Number.isFinite(available)
        ? percentLabel(Math.max(0, total - available) / total)
        : '—'
    })
    const memorySampleLabel = computed(() => {
      const sample = formatInterval(Number(memoryMeta.value.hostSampleIntervalMs))
      const bucket = formatInterval(Number(memoryMeta.value.bucketMs))
      return `统一采样 ${sample}，当前聚合 ${bucket}`
    })
    const memoryEmptyText = computed(() => {
      if (loadingMemory.value) return '加载中...'
      return memoryError.value || '暂无内存采样'
    })
    const memoryChartScale = computed(() => {
      const min = memoryMinValue.value
      const max = memoryMaxValue.value
      const total = memoryTotalValue.value
      const safeMin = min === null ? 0 : min
      const safeMax = max === null ? Math.max(total || 1, 1) : max
      const pad = Math.max(32, Math.round((safeMax - safeMin) * 0.12))
      const paddedTop = safeMax + pad
      const paddedBottom = Math.max(0, safeMin - pad)
      // 刻度间隔以 100 MB 为单位扩大，两端对齐同一间隔，保留折线边缘空间。
      const step = Math.max(100, Math.ceil((paddedTop - paddedBottom) / 500) * 100)
      const bottom = Math.floor(paddedBottom / step) * step
      const top = Math.max(bottom + step, Math.ceil(paddedTop / step) * step)
      return { min: bottom, max: top, step }
    })
    const memoryChartPoints = computed(() => {
      const points = memorySeriesPoints.value
      const count = points.length
      const scale = memoryChartScale.value
      const height = 176
      const top = 24
      const left = 64
      const width = 512
      const span = Math.max(1, scale.max - scale.min)
      return points.map((item, index) => {
        const point = item.point
        const value = item.value
        const ratio = Number.isFinite(value) ? (value - scale.min) / span : 0
        const x = left + (count <= 1 ? width : (index / (count - 1)) * width)
        const y = top + height - Math.max(0, Math.min(1, ratio)) * height
        return { x: round(x), y: round(y), ts: String(point.ts || point.createdAt || item.index), value }
      })
    })
    const hasMemoryChartData = computed(() => memorySeriesPoints.value.length > 0)
    const memoryPolyline = computed(() => memoryChartPoints.value.map(point => `${point.x},${point.y}`).join(' '))
    const memoryYTicks = computed(() => {
      const scale = memoryChartScale.value
      const count = Math.round((scale.max - scale.min) / scale.step)
      return Array.from({ length: count + 1 }, (_, index) => {
        const value = scale.max - scale.step * index
        const ratio = index / count
        return {
          y: round(24 + 176 * ratio),
          label: mbLabel(Math.round(value)),
          percentLabel: memoryTotalValue.value === null ? '—' : percentLabel(value / memoryTotalValue.value),
        }
      })
    })

    // 读取资源总览。
    async function loadStatus(): Promise<void> {
      const res = await fetchResourceStatus()
      if (res.ok && res.data) {
        status.value = asRecord(res.data)
        lastRefresh.value = Date.now()
        return
      }
      throw new Error(errorMessage(res.data, '资源状态读取失败'))
    }

    // 按选中的状态查询任务，历史列表不会挤占进行中或失败记录的查询额度。
    async function loadTasks(): Promise<void> {
      if (loadingTasks.value) return
      loadingTasks.value = true
      try {
        const res = await fetchResourceTasks(taskFilter.value)
        if (!res.ok || !res.data) throw new Error(errorMessage(res.data, '任务记录读取失败'))
        tasks.value = asArray<JsonRecord>(asRecord(res.data).tasks)
        taskReadError.value = ''
        const expanded = tasks.value.find(task => task.id === expandedTaskId.value)
        if (expanded?.kind === 'daily_report') await loadReportAnalysis(String(expanded.id))
      } catch (error) {
        taskReadError.value = errorMessage(error, '任务记录读取失败')
      } finally {
        loadingTasks.value = false
      }
    }

    // 切换状态后清空旧列表和展开详情，避免将旧筛选结果显示在新分类下。
    async function selectTaskFilter(status: string): Promise<void> {
      if (loadingTasks.value || taskFilter.value === status) return
      taskFilter.value = status
      tasks.value = []
      expandedTaskId.value = ''
      taskCopyMessage.value = ''
      await loadTasks()
    }

    // 只通过独立按钮展开详情，行内文字可正常选中和复制。
    function toggleTaskDetail(task: JsonRecord): void {
      const taskId = String(task.id || '')
      expandedTaskId.value = expandedTaskId.value === taskId ? '' : taskId
      taskCopyMessage.value = ''
      reportAnalysisRequest++
      reportAnalysis.value = null
      reportAnalysisError.value = ''
      loadingReportAnalysis.value = false
      if (expandedTaskId.value && task.kind === 'daily_report') void loadReportAnalysis(taskId, true)
    }

    // 按需读取当前日报，异步旧响应不能覆盖另一个任务；自动刷新不重复弹出验证框。
    async function loadReportAnalysis(taskId: string, promptAdmin = false): Promise<void> {
      if (expandedTaskId.value !== taskId) return
      const request = ++reportAnalysisRequest
      loadingReportAnalysis.value = true
      try {
        const res = await fetchReportAnalysis(taskId)
        if (request !== reportAnalysisRequest || expandedTaskId.value !== taskId) return
        if (isAdminRequired(res)) {
          reportAnalysisError.value = '查看日报分析详情需要管理员验证'
          if (promptAdmin && showAdminDialog) showAdminDialog('查看日报分析详情需要管理员密码', () => loadReportAnalysis(taskId))
          return
        }
        if (!res.ok || !res.data) throw new Error(errorMessage(res.data, '日报分析详情读取失败'))
        reportAnalysis.value = asRecord(res.data)
        reportAnalysisError.value = ''
      } catch (error) {
        if (request === reportAnalysisRequest) reportAnalysisError.value = errorMessage(error, '日报分析详情读取失败')
      } finally { if (request === reportAnalysisRequest) loadingReportAnalysis.value = false }
    }

    // 复制完整任务 ID，浏览器未提供剪贴板时提示用户手动选中复制。
    async function copyTaskId(task: JsonRecord): Promise<void> {
      try {
        await navigator.clipboard.writeText(String(task.id || ''))
        taskCopyMessage.value = '任务 ID 已复制'
      } catch {
        taskCopyMessage.value = '自动复制失败，请选中上方任务 ID 手动复制'
      }
    }

    // 读取最近事件。
    async function loadEvents(): Promise<void> {
      if (loadingEvents.value) return
      loadingEvents.value = true
      try {
        const res = await fetchResourceEvents()
        if (res.ok && res.data) events.value = asArray<JsonRecord>(asRecord(res.data).events)
      } finally {
        loadingEvents.value = false
      }
    }

    // 读取内存历史折线图。
    async function loadMemoryHistory(options: { animate?: boolean } = {}): Promise<void> {
      if (loadingMemory.value) return
      if (options.animate) {
        if (memoryTransitionTimer) clearTimeout(memoryTransitionTimer)
        memoryChartTransitioning.value = true
      }
      loadingMemory.value = true
      try {
        const res = await fetchResourceMemoryHistory(memoryRange.value)
        if (res.ok && res.data) {
          const data = asRecord(res.data)
          memoryMeta.value = data
          memoryHistory.value = asArray<JsonRecord>(data.points)
          memoryError.value = ''
          return
        }
        if (isAdminRequired(res)) {
          memoryError.value = '查看内存走势需要管理员密码'
          const now = Date.now()
          if (showAdminDialog && now - lastMemoryAdminPromptAt > 30000) {
            lastMemoryAdminPromptAt = now
            showAdminDialog('查看内存走势需要管理员密码', loadMemoryHistory)
          }
          return
        }
        memoryError.value = errorMessage(res.data, '内存走势读取失败')
      } finally {
        loadingMemory.value = false
        if (options.animate) {
          memoryTransitionTimer = setTimeout(() => {
            memoryChartTransitioning.value = false
            memoryTransitionTimer = null
          }, 220)
        }
      }
    }

    // 刷新资源中心所有数据。
    async function refreshAllInternal(options: { preserveMessage?: boolean } = {}): Promise<void> {
      if (loading.value) return
      loading.value = true
      if (!options.preserveMessage) {
        message.value = { type: 'info', text: '' }
      }
      try {
        await loadStatus()
        await Promise.all([loadTasks(), loadEvents(), loadMemoryHistory()])
      } catch (error) {
        message.value = { type: 'err', text: errorMessage(error, '刷新失败') }
      } finally {
        loading.value = false
      }
    }

    async function refreshAll(): Promise<void> {
      await refreshAllInternal()
    }

    // 切换维护模式，复用后端 ai-paused.txt。
    async function toggleMaintenance(savedTarget?: boolean, retried = false, confirmed = false): Promise<void> {
      const next = savedTarget ?? !status.value.maintenance
      if (next && !confirmed) {
        const accepted = window.confirm('进入维护模式后，机器人将暂停智能回复和后台任务。是否继续？')
        if (!accepted) return
        confirmed = true
      }
      const res = await setResourceMaintenance(next)
      if (isAdminRequired(res)) {
        if (!retried && showAdminDialog) showAdminDialog('切换资源维护模式需要管理员密码', () => toggleMaintenance(next, true, confirmed))
        else message.value = { type: 'err', text: '管理员验证后维护模式操作仍被拒绝' }
        return
      }
      message.value = {
        type: res.ok ? 'ok' : 'err',
        text: errorMessage(res.data, next
          ? '维护模式已开启，机器人将回复维护提示'
          : '维护模式已结束，智能回复和后台任务已恢复'),
      }
      await refreshAllInternal({ preserveMessage: true })
    }

    // 确认影响后切换资源保护策略，并在管理员过期时只重试同一操作。
    async function setMode(serverMode: string, retried = false, confirmed = false): Promise<void> {
      if (loadingMode.value) return
      if (String(status.value.serverMode || '') === serverMode) return
      if (!confirmed) {
        const label = serverMode === 'small' ? '小内存策略' : '大内存策略'
        const accepted = window.confirm(`切换到${label}会改变浏览器任务与后台任务的并行保护方式。是否继续？`)
        if (!accepted) return
        confirmed = true
      }
      loadingMode.value = true
      try {
        const res = await setResourceMode(serverMode)
        if (res.ok) {
          message.value = { type: 'ok', text: serverMode === 'small' ? '资源保护策略已切换为小内存策略' : '资源保护策略已切换为大内存策略' }
          await refreshAllInternal({ preserveMessage: true })
          return
        }
        if (isAdminRequired(res)) {
          message.value = { type: 'warn', text: '切换资源保护策略需要管理员密码' }
          if (!retried && showAdminDialog) showAdminDialog('切换资源保护策略需要管理员密码', () => setMode(serverMode, true, confirmed))
          else message.value = { type: 'err', text: '管理员验证后资源保护策略操作仍被拒绝' }
          return
        }
        message.value = { type: 'err', text: errorMessage(res.data, '模式切换失败') }
      } finally {
        loadingMode.value = false
      }
    }

    // 在当前操作位置弹出可复制的取消失败原因，避免页面顶部提示被滚动隐藏。
    function showCancelFailure(task: JsonRecord, taskId: string, rawError: string): void {
      const reason = /[\u4e00-\u9fff]/.test(rawError) ? rawError
        : /Failed to fetch|fetch failed|NetworkError/i.test(rawError) ? '取消请求未能连接到服务器，请检查网络连接后重试。'
          : '服务器未能完成取消操作，请查看原始报错，刷新后重试。'
      message.value = { type: 'err', text: `取消任务失败：${reason}` }
      cancelFailure.value = { taskId, taskName: taskContentDisplay(task), reason, rawError }
      void nextTick(() => cancelFailureClose.value?.focus())
    }

    // 取消排队或暂缓任务；权限、状态冲突、网络失败均给出明确反馈。
    async function cancelTask(task: JsonRecord, savedTaskId = '', retried = false): Promise<void> {
      const taskId = savedTaskId || display(task.id, '')
      if (!taskId || cancellingTaskId.value) return
      cancellingTaskId.value = taskId
      try {
        const res = await cancelResourceTask(taskId)
        if (isAdminRequired(res)) {
          if (!retried && showAdminDialog) showAdminDialog('取消资源任务需要管理员密码', () => cancelTask(task, taskId, true))
          else showCancelFailure(task, taskId, '管理员验证后取消任务仍被拒绝，请重新验证管理员权限。')
          return
        }
        if (!res.ok) {
          const data = asRecord(res.data)
          showCancelFailure(task, taskId, errorMessage(data, '服务器未返回取消结果，请检查登录状态并刷新后重试。'))
          if (data.code && cancelFailure.value) cancelFailure.value.rawError = `${display(data.code)}\n${cancelFailure.value.rawError}`
        } else {
          cancelFailure.value = null
          message.value = { type: 'ok', text: '任务已取消' }
        }
        await refreshAllInternal({ preserveMessage: true })
      } catch (error) {
        showCancelFailure(task, taskId, errorMessage(error, '取消请求失败，请刷新后重试。'))
      } finally {
        cancellingTaskId.value = ''
      }
    }

    onMounted(() => {
      refreshAll()
      timer = setInterval(loadStatus, 5000)
      secondaryTimer = setInterval(() => { loadTasks(); loadEvents() }, 15000)
      memoryTimer = setInterval(loadMemoryHistory, 10000)
    })

    onUnmounted(() => {
      if (timer) clearInterval(timer)
      if (secondaryTimer) clearInterval(secondaryTimer)
      if (memoryTimer) clearInterval(memoryTimer)
      if (memoryTransitionTimer) clearTimeout(memoryTransitionTimer)
    })

    return {
      status,
      tasks,
      taskFilters,
      taskFilter,
      taskEmptyText,
      taskReadError,
      expandedTaskId,
      taskCopyMessage,
      reportAnalysis,
      reportAnalysisError,
      loadingReportAnalysis,
      cancellingTaskId,
      cancelFailure,
      cancelFailureClose,
      taskStatusDisplay,
      taskCategoryDisplay,
      taskContentDisplay,
      taskSourceDisplay,
      taskTimeDisplay,
      taskStepDisplay,
      selectTaskFilter,
      toggleTaskDetail,
      copyTaskId,
      events,
      eventDetail,
      resourceEventDisplay,
      resourceEventSourceDisplay,
      taskErrorDisplay,
      memoryHistory,
      memoryRange,
      memoryRangeOptions,
      memoryMeta,
      memoryError,
      precomputeQuery,
      message,
      loading,
      loadingMode,
      loadingTasks,
      loadingEvents,
      loadingMemory,
      memoryChartTransitioning,
      running,
      workers,
      media,
      botDisplay,
      resourceDisplay,
      policyDisplay,
      activityDisplay,
      mediaSummary,
      mediaUnfinished,
      mediaQueues,
      precompute,
      disk,
      diskFilesystem,
      diskEntries,
      coverage,
      filteredCoverage,
      diskUsageLabel,
      diskAvailableLabel,
      diskCacheLabel,
      memorySampleLabel,
      memoryEmptyText,
      memoryAverageLabel,
      memoryMinLabel,
      memoryMaxLabel,
      memoryChartPoints,
      hasMemoryChartData,
      memoryPolyline,
      memoryYTicks,
      memoryCurrentPercentLabel,
      maintenanceLabel,
      lastRefreshLabel,
      display,
      dateTimeDisplay,
      numberValue,
      taskKindDisplay,
      workerDisplay,
      percentLabel,
      sizeMbLabel,
      coverageKey,
      eventKey,
      canCancel,
      refreshAll,
      loadTasks,
      loadEvents,
      loadMemoryHistory,
      toggleMaintenance,
      setMode,
      cancelTask,
    }
  },
}
</script>

<style scoped>
.resource-panel {
  min-width: 0;
}

.resource-toolbar,
.resource-card-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 14px;
}

.resource-subline {
  color: var(--text3);
  font-size: 12px;
}

.resource-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  justify-content: flex-end;
}

.resource-grid {
  display: grid;
  grid-template-columns: minmax(250px, 0.9fr) minmax(250px, 0.9fr) minmax(270px, 1fr);
  gap: 16px;
  align-items: stretch;
}

.resource-summary {
  grid-column: 1;
}

.resource-summary-layout {
  display: block;
  min-width: 0;
}

.resource-summary-main {
  min-width: 0;
}

.resource-worker-card {
  grid-column: 2;
}

.resource-media-card {
  grid-column: 3;
}

.resource-precompute-card {
  grid-column: 1;
}

.resource-disk-card {
  grid-column: 1 / -1;
}

.compact-head {
  margin-bottom: 10px;
}

.precompute-search {
  width: 100%;
  min-height: 34px;
  margin: 0 0 8px;
  padding: 7px 10px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--input);
  color: var(--text);
  font: inherit;
  font-size: 13px;
  outline: none;
}

.precompute-search::placeholder {
  color: var(--text3);
}

.precompute-search:focus {
  border-color: color-mix(in srgb, var(--accent) 64%, var(--border));
  box-shadow: 0 0 0 3px var(--accentDim);
}

.memory-chart-card {
  grid-column: 2 / 4;
  min-height: 320px;
}

.disk-summary {
  display: grid;
  grid-template-columns: repeat(2, minmax(160px, 1fr));
  gap: 16px;
  margin-bottom: 12px;
}

.disk-summary .resource-metric-row {
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--input);
  padding: 10px 12px;
}

.disk-list {
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  max-height: 260px;
}

.disk-row {
  align-items: center;
  justify-content: space-between;
}

.disk-row > div {
  min-width: 0;
}

.disk-row strong {
  color: var(--text);
  white-space: nowrap;
}

.resource-kpis {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
  gap: 10px;
  margin-bottom: 16px;
}

.resource-mode-switch {
  margin-bottom: 16px;
}

.resource-segmented {
  display: inline-flex;
  gap: 0;
  border: 1px solid var(--border);
  border-radius: 8px;
  overflow: hidden;
  background: var(--input);
}

.resource-segmented-btn {
  min-width: 118px;
  min-height: 34px;
  padding: 0 12px;
  border: 0;
  border-right: 1px solid var(--border);
  background: transparent;
  color: var(--text2);
  font: inherit;
  font-size: 13px;
}

.resource-segmented-btn:last-child {
  border-right: 0;
}

.resource-segmented-btn.active {
  background: color-mix(in srgb, var(--accent) 14%, var(--input));
  color: var(--text);
  font-weight: 800;
}

.resource-segmented-btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.resource-mode-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 10px;
}

.pill-ok {
  border-color: color-mix(in srgb, var(--success) 36%, var(--border));
}

.pill-warn {
  border-color: color-mix(in srgb, var(--accent) 48%, var(--border));
}

.pill-off {
  border-color: color-mix(in srgb, var(--danger) 48%, var(--border));
}

.resource-kpi {
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--input);
  padding: 10px 12px;
  min-width: 0;
}

.resource-kpi span,
.resource-metric-row span {
  display: block;
  color: var(--text3);
  font-size: 12px;
  margin-bottom: 4px;
}

.resource-kpi strong {
  display: block;
  color: var(--text);
  font-size: 18px;
  overflow-wrap: anywhere;
}

.resource-kpi small {
  display: block;
  margin-top: 5px;
  color: var(--text3);
  font-size: 12px;
  line-height: 1.45;
}

.readable-ok { color: var(--success) !important; }
.readable-info { color: var(--accent) !important; }
.readable-warn { color: var(--accent) !important; }
.readable-danger { color: var(--danger) !important; }
.readable-off { color: var(--text3) !important; }

.resource-background-state {
  margin-top: 10px;
  font-size: 13px;
  font-weight: 800;
}

.resource-diagnostic-details {
  margin-top: 9px;
  color: var(--text3);
  font-size: 12px;
}

.resource-diagnostic-details summary {
  color: var(--accent);
  cursor: pointer;
  font-weight: 700;
}

.resource-diagnostic-details[open] summary { margin-bottom: 7px; }

.media-queue-box {
  margin-top: 10px;
  padding: 9px 10px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--input);
}

.media-queue-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 3px;
}

.media-queue-head span { color: var(--text2); font-size: 12px; font-weight: 800; }
.media-risk-warn { border-color: color-mix(in srgb, var(--accent) 58%, var(--border)); }
.media-risk-danger { border-color: color-mix(in srgb, var(--danger) 62%, var(--border)); }
.media-history-notice { margin-top: 12px; color: var(--text2); font-size: 12px; line-height: 1.55; }
.media-history-notice a { color: var(--accent); font-weight: 700; }
.media-history-details { margin-top: 12px; }

.state-green { color: var(--success) !important }
.state-yellow { color: var(--accent) !important }
.state-red { color: var(--danger) !important }

.memory-chart-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 10px;
}

.memory-chart-head h2 {
  margin: 0 0 4px;
}

.memory-chart-controls {
  display: grid;
  flex: 0 0 auto;
  gap: 4px;
  text-align: right;
}

.memory-range-select {
  width: 104px;
  height: 34px;
}

.memory-current-usage {
  color: var(--text2);
  font-size: 12px;
}

.memory-chart-wrap {
  position: relative;
  height: 236px;
  min-width: 0;
}

.memory-chart {
  width: 100%;
  height: 100%;
  display: block;
}

.memory-chart-grid {
  stroke: color-mix(in srgb, var(--border) 72%, transparent);
  stroke-width: 1;
}

.memory-chart-label {
  fill: var(--text3);
  font-size: 11px;
}

.memory-chart-line {
  fill: none;
  stroke: var(--accent);
  stroke-width: 3;
  stroke-linecap: round;
  stroke-linejoin: round;
  vector-effect: non-scaling-stroke;
  transition: opacity 180ms ease, transform 220ms ease;
}

.memory-chart.is-transitioning .memory-chart-line {
  opacity: 0.35;
  transform: translateY(4px);
}

.memory-chart-empty {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text3);
  font-size: 13px;
  pointer-events: none;
}

.memory-chart-meta {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 8px;
  margin-top: 10px;
  color: var(--text2);
  font-size: 12px;
}

.memory-chart-meta span {
  min-width: 0;
  overflow-wrap: anywhere;
}

.resource-section-title {
  color: var(--text2);
  font-weight: 800;
  font-size: 13px;
  margin-bottom: 8px;
}

.resource-runbox,
.resource-row,
.resource-event {
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--input);
  padding: 10px 12px;
  min-width: 0;
}

.resource-runbox b,
.resource-runbox span,
.resource-runbox small,
.resource-row b,
.resource-row small {
  display: block;
  min-width: 0;
  overflow-wrap: anywhere;
}

.resource-runbox small,
.resource-row small,
.resource-event small {
  color: var(--text3);
  font-size: 12px;
  margin-top: 3px;
}

.resource-list {
  display: grid;
  gap: 8px;
}

.resource-list.compact {
  max-height: 180px;
  overflow: auto;
}

.resource-row {
  display: flex;
  align-items: flex-start;
  gap: 10px;
}

.resource-worker-main {
  min-width: 0;
  flex: 1;
}

.resource-worker-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 8px;
  min-width: 0;
}

.worker-progress-pill {
  flex: 0 0 auto;
  padding: 2px 7px;
  font-size: 11px;
  line-height: 1.35;
}

.worker-progress-ok {
  border-color: color-mix(in srgb, var(--success) 36%, var(--border));
  color: var(--success);
}

.worker-progress-info {
  border-color: color-mix(in srgb, var(--accent) 42%, var(--border));
  color: var(--accent);
}

.worker-progress-warn {
  border-color: color-mix(in srgb, var(--accent) 54%, var(--border));
  color: var(--accent);
}

.worker-progress-danger {
  border-color: color-mix(in srgb, var(--danger) 58%, var(--border));
  color: var(--danger);
}

.worker-progress-off {
  border-color: color-mix(in srgb, var(--text3) 48%, var(--border));
  color: var(--text3);
}

.resource-metric-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  border-bottom: 1px solid var(--border);
  padding: 8px 0;
}

.resource-metric-row:last-child {
  border-bottom: 0;
}

.resource-metric-row b {
  color: var(--text);
}

.resource-empty,
.resource-empty-cell {
  color: var(--text3);
  font-size: 13px;
  padding: 10px 0;
}

.resource-table-wrap {
  overflow: auto;
}

.resource-table {
  width: 100%;
  min-width: 760px;
  border-collapse: collapse;
  font-size: 13px;
}

.resource-table th,
.resource-table td {
  border-bottom: 1px solid var(--border);
  padding: 9px 8px;
  text-align: left;
  vertical-align: top;
}

.resource-table th {
  color: var(--text2);
  font-size: 12px;
  font-weight: 800;
}

/* --- 可读任务记录与详情 --- */

.resource-task-card { user-select: text; }
.resource-task-filters,
.resource-task-actions { display: flex; flex-wrap: wrap; gap: 8px; }
.resource-task-filters .is-selected { color: var(--accent); border-color: var(--accent); background: var(--input); }
.resource-task-hint,
.resource-task-secondary { color: var(--text3); font-size: 12px; line-height: 1.55; }
.resource-task-hint { margin: 10px 0; }
.resource-task-secondary { display: block; margin-top: 4px; }
.resource-task-error { color: var(--danger); font-size: 13px; }
.resource-task-content { min-width: 230px; overflow-wrap: anywhere; }
.resource-task-content b { font-weight: 700; }
.resource-task-time { white-space: nowrap; }
.resource-task-detail { padding: 8px 4px; }
.resource-cancel-dialog { width: min(620px, 100%); max-height: 85vh; overflow-y: auto; user-select: text; }
.resource-cancel-dialog p { line-height: 1.7; }
.resource-cancel-task-id, .resource-cancel-dialog pre { overflow-wrap: anywhere; white-space: pre-wrap; }
.resource-cancel-dialog details { margin-top: 16px; }
.resource-cancel-dialog summary { cursor: pointer; }
.resource-task-detail-row { background: var(--input); }
.resource-task-id { display: flex; align-items: flex-start; gap: 12px; }
.resource-task-id span { flex: 1; min-width: 0; overflow-wrap: anywhere; }
.resource-task-id button { flex: 0 0 auto; }
.resource-task-meta { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px 20px; margin: 16px 0 0; }
.resource-task-meta dt { color: var(--text3); font-size: 12px; margin-bottom: 3px; }
.resource-task-meta dd { margin: 0; overflow-wrap: anywhere; }
.resource-task-reason { margin-top: 14px; }
.resource-task-reason p { margin: 6px 0; line-height: 1.6; }
.resource-task-reason summary,
.resource-event-raw summary { cursor: pointer; color: var(--accent); font-size: 12px; }
.resource-task-reason pre { margin: 6px 0 0; white-space: pre-wrap; overflow-wrap: anywhere; font-size: 12px; }

.resource-pill {
  display: inline-flex;
  align-items: center;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--input);
  padding: 3px 8px;
  font-size: 12px;
  font-weight: 800;
}

.resource-events {
  display: grid;
  gap: 8px;
  max-height: 360px;
  overflow: auto;
}

.resource-event-summary {
  display: grid;
  grid-template-columns: 84px minmax(160px, 1fr) auto;
  gap: 10px;
  align-items: center;
}

.resource-event time { color: var(--text3); font-size: 12px; white-space: nowrap; }
.resource-event { user-select: text; }
.resource-event-raw { margin-top: 6px; color: var(--text3); font-size: 12px; }
.resource-event-raw[open] summary { margin-bottom: 6px; }
.resource-event-raw div { overflow-wrap: anywhere; margin-top: 4px; }
.resource-event-raw pre { white-space: pre-wrap; overflow-wrap: anywhere; margin: 5px 0 0; }

.resource-event span {
  color: var(--accent);
  font-weight: 900;
  font-size: 12px;
}

.resource-event b,
.resource-event small {
  overflow-wrap: anywhere;
}

@media (max-width: 1100px) {
  .resource-grid {
    grid-template-columns: repeat(2, minmax(250px, 1fr));
  }

  .resource-summary,
  .resource-worker-card,
  .resource-media-card,
  .resource-precompute-card,
  .memory-chart-card {
    grid-column: auto;
  }

  .memory-chart-card {
    grid-column: 1 / -1;
  }
}

@media (max-width: 760px) {
  .resource-toolbar,
  .resource-card-head {
    align-items: stretch;
    flex-direction: column;
  }

  .resource-actions {
    justify-content: flex-start;
  }

  .resource-grid {
    grid-template-columns: 1fr;
  }

  .resource-summary,
  .resource-worker-card,
  .resource-media-card,
  .resource-precompute-card,
  .memory-chart-card {
    grid-column: auto;
  }

  .memory-chart-meta {
    grid-template-columns: 1fr;
  }

  .memory-chart-head {
    align-items: stretch;
    flex-direction: column;
  }

  .memory-range-select {
    width: 100%;
    flex-basis: auto;
  }

  .resource-event-summary {
    grid-template-columns: 1fr;
    gap: 4px;
  }

  .resource-worker-head {
    align-items: flex-start;
    flex-direction: column;
  }
}
</style>
