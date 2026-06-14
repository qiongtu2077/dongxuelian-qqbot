<template>
  <div class="resource-panel">
    <div class="resource-toolbar">
      <div>
        <h2>资源中心</h2>
        <div class="resource-subline">最后刷新：{{ lastRefreshLabel }}</div>
      </div>
      <div class="resource-actions">
        <button class="btn btn-sm" :disabled="loading" @click="refreshAll">刷新</button>
        <button class="btn btn-sm" @click="toggleMaintenance">{{ maintenanceLabel }}</button>
        <button class="btn btn-sm" @click="reclaimStale">回收 stale</button>
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
                <span>模式</span>
                <strong>{{ display(status.mode) }}</strong>
              </div>
              <div class="resource-kpi">
                <span>服务器模式</span>
                <strong>{{ display(status.serverMode) }}</strong>
              </div>
              <div class="resource-kpi">
                <span>档位</span>
                <strong :class="'state-' + display(status.resourceState)">{{ display(status.resourceState) }}</strong>
              </div>
              <div class="resource-kpi">
                <span>可用内存</span>
                <strong>{{ memoryLabel }}</strong>
              </div>
              <div class="resource-kpi">
                <span>排队</span>
                <strong>{{ numberValue(status.queueLength) }}</strong>
              </div>
            </div>
            <div class="resource-mode-switch">
              <div class="resource-section-title">服务器资源模式</div>
              <div class="resource-segmented">
                <button
                  class="resource-segmented-btn"
                  :class="{ active: status.serverMode === 'small' }"
                  :disabled="loadingMode"
                  @click="setMode('small')"
                >
                  小内存服务器
                </button>
                <button
                  class="resource-segmented-btn"
                  :class="{ active: status.serverMode === 'large' }"
                  :disabled="loadingMode"
                  @click="setMode('large')"
                >
                  大内存服务器
                </button>
              </div>
              <div class="resource-subline">配置来源：{{ display(status.serverModeSource) }}</div>
              <div class="resource-mode-meta">
                <span class="resource-pill" :class="status.tool_active ? 'pill-warn' : ''">tool_active: {{ boolText(status.tool_active) }}</span>
                <span class="resource-pill" :class="status.render_active ? 'pill-warn' : ''">render_active: {{ boolText(status.render_active) }}</span>
                <span class="resource-pill" :class="status.background_allowed ? 'pill-ok' : 'pill-off'">background_allowed: {{ boolText(status.background_allowed) }}</span>
              </div>
            </div>
            <div class="resource-running">
              <div class="resource-section-title">当前独占</div>
              <div v-if="running" class="resource-runbox">
                <b>{{ display(running.kind) }}</b>
                <span>{{ display(running.taskId) }}</span>
                <small>{{ display(running.step) }} · {{ display(running.owner) }}</small>
              </div>
              <div v-else class="resource-empty">暂无独占任务</div>
            </div>
          </div>
        </div>
      </section>

      <section class="card resource-worker-card">
        <h2>worker</h2>
        <div v-if="workers.length" class="resource-list">
          <div v-for="worker in workers" :key="display(worker.name)" class="resource-row">
            <span class="status-dot" :class="worker.alive ? 'active' : 'offline'"></span>
            <div>
              <b>{{ display(worker.name) }}</b>
              <small>{{ display(worker.step) }} · {{ lagLabel(worker.heartbeatLagMs) }}</small>
            </div>
          </div>
        </div>
        <div v-else class="resource-empty">暂无 worker 心跳</div>
      </section>

      <section class="card resource-media-card">
        <h2>媒体背压</h2>
        <div class="resource-metric-row"><span>图片 pending</span><b>{{ numberValue(media.imagePending) }}</b></div>
        <div class="resource-metric-row"><span>文件 pending</span><b>{{ numberValue(media.filePending) }}</b></div>
        <div class="resource-metric-row"><span>语音 pending</span><b>{{ numberValue(media.voicePending) }}</b></div>
        <div class="resource-metric-row"><span>running</span><b>{{ arrayLength(media.running) }}</b></div>
        <div class="resource-metric-row"><span>dropped</span><b>{{ numberValue(media.droppedCount) }}</b></div>
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
          <select v-model="memoryRange" class="memory-range-select" @change="loadMemoryHistory({ animate: true })">
            <option v-for="option in memoryRangeOptions" :key="option.value" :value="option.value">{{ option.label }}</option>
          </select>
        </div>
        <div class="memory-chart-wrap">
          <svg class="memory-chart" :class="{ 'is-transitioning': memoryChartTransitioning }" viewBox="0 0 640 220" preserveAspectRatio="none" role="img" aria-label="已使用内存折线图">
            <line
              v-for="tick in memoryYTicks"
              :key="tick.y"
              x1="44"
              :y1="tick.y"
              x2="624"
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

    <section class="card">
      <div class="resource-card-head">
        <h2>任务队列</h2>
        <button class="btn btn-sm" :disabled="loadingTasks" @click="loadTasks">刷新队列</button>
      </div>
      <div class="resource-table-wrap">
        <table class="resource-table">
          <thead>
            <tr>
              <th>状态</th>
              <th>类型</th>
              <th>任务</th>
              <th>步骤</th>
              <th>时间</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="task in tasks" :key="display(task.id)">
              <td><span class="resource-pill">{{ display(task.status) }}</span></td>
              <td>{{ display(task.kind) }}</td>
              <td class="resource-id">{{ display(task.id) }}</td>
              <td>{{ display(task.step) }}</td>
              <td>{{ display(task.updatedAt || task.createdAt) }}</td>
              <td>
                <button
                  v-if="canCancel(task)"
                  class="btn btn-sm"
                  @click="cancelTask(task)"
                >取消</button>
              </td>
            </tr>
            <tr v-if="!tasks.length">
              <td colspan="6" class="resource-empty-cell">暂无任务</td>
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
      <div class="resource-events">
        <div v-for="event in events" :key="eventKey(event)" class="resource-event">
          <span>{{ display(event.source) }}</span>
          <b>{{ display(event.event) }}</b>
          <small>{{ display(event.reason || event.error || event.createdAt) }}</small>
        </div>
        <div v-if="!events.length" class="resource-empty">暂无事件</div>
      </div>
    </section>
  </div>
</template>

<script lang="ts">
import { computed, inject, onMounted, onUnmounted, ref } from 'vue'
import {
  cancelResourceTask,
  fetchResourceEvents,
  fetchResourceMode,
  fetchResourceMemoryHistory,
  fetchResourceStatus,
  fetchResourceTasks,
  isAdminRequired,
  reclaimResourceStale,
  setResourceMode,
  setResourceMaintenance,
} from '../api'
import { asArray, asRecord, errorMessage, type JsonRecord, type MessageState, type ShowAdminDialog } from '../types'

export default {
  name: 'ResourcePanel',
  setup() {
    const showAdminDialog = inject<ShowAdminDialog>('showAdminDialog')
    const status = ref<JsonRecord>({})
    const tasks = ref<JsonRecord[]>([])
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
    const memoryLabel = computed(() => {
      const available = status.value.memAvailableMb
      const total = status.value.memTotalMb
      if (typeof available !== 'number') return 'unknown'
      return typeof total === 'number' ? `${available} / ${total} MB` : `${available} MB`
    })
    function boolText(value: unknown): string {
      return value ? '是' : '否'
    }
    const diskUsageLabel = computed(() => {
      const used = diskFilesystem.value.usedMb
      const total = diskFilesystem.value.totalMb
      const percent = Number(diskFilesystem.value.usedPercent)
      const usage = `${sizeMbLabel(used)} / ${sizeMbLabel(total)}`
      return Number.isFinite(percent) ? `${usage} (${percent}%)` : usage
    })
    const diskAvailableLabel = computed(() => sizeMbLabel(diskFilesystem.value.availableMb || diskFilesystem.value.freeMb))
    const diskCacheLabel = computed(() => formatInterval(Number(disk.value.cacheTtlMs)))
    const maintenanceLabel = computed(() => status.value.maintenance ? '关闭维护' : '开启维护')
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
    const memorySampleLabel = computed(() => {
      const worker = formatInterval(Number(memoryMeta.value.workerSampleIntervalMs))
      const dashboard = formatInterval(Number(memoryMeta.value.dashboardSampleIntervalMs))
      const bucket = formatInterval(Number(memoryMeta.value.bucketMs))
      return `worker 采样 ${worker}，面板补采样 ${dashboard}，当前聚合 ${bucket}`
    })
    const memoryEmptyText = computed(() => {
      if (loadingMemory.value) return '加载中...'
      return memoryError.value || '暂无内存采样'
    })
    const memoryChartScale = computed(() => {
      const min = memoryMinValue.value
      const max = memoryMaxValue.value
      const total = Number(status.value.memTotalMb || memoryHistory.value.find(item => Number.isFinite(Number(item.memTotalMb)))?.memTotalMb)
      const safeMin = min === null ? 0 : min
      const safeMax = max === null ? Math.max(total || 1, 1) : max
      const pad = Math.max(32, Math.round((safeMax - safeMin) * 0.12))
      const top = Math.max(safeMax + pad, total && total > 0 ? Math.min(total, safeMax + pad) : safeMax + pad)
      const bottom = Math.max(0, safeMin - pad)
      return top <= bottom ? { min: 0, max: Math.max(1, top || 1) } : { min: bottom, max: top }
    })
    const memoryChartPoints = computed(() => {
      const points = memorySeriesPoints.value
      const count = points.length
      const scale = memoryChartScale.value
      const height = 176
      const top = 24
      const left = 44
      const width = 580
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
      const ticks = [0, 0.5, 1]
      return ticks.map(ratio => {
        const value = scale.max - (scale.max - scale.min) * ratio
        return {
          y: round(24 + 176 * ratio),
          label: mbLabel(Math.round(value)),
        }
      })
    })

    // 将未知值压成短展示文本，避免长对象撑破表格。
    function display(value: unknown, fallback = '-'): string {
      if (value === null || value === undefined || value === '') return fallback
      if (typeof value === 'object') return JSON.stringify(value).slice(0, 120)
      return String(value)
    }

    // 数字展示统一归一，未知值显示 0。
    function numberValue(value: unknown): number {
      const parsed = Number(value || 0)
      return Number.isFinite(parsed) ? parsed : 0
    }

    // 数组长度展示，非数组按 0 处理。
    function arrayLength(value: unknown): number {
      return Array.isArray(value) ? value.length : 0
    }

    // 心跳延迟展示。
    function lagLabel(value: unknown): string {
      const ms = Number(value)
      if (!Number.isFinite(ms)) return '无心跳'
      if (ms < 1000) return `${ms}ms`
      return `${Math.round(ms / 1000)}s`
    }

    // coverage 百分比展示。
    function percentLabel(value: unknown): string {
      const parsed = Number(value)
      if (!Number.isFinite(parsed)) return '-'
      return `${Math.round(parsed * 1000) / 10}%`
    }

    // 内存 MB 标签。
    function mbLabel(value: unknown): string {
      const parsed = Number(value)
      return Number.isFinite(parsed) ? `${Math.round(parsed)} MB` : '-'
    }

    // 优先消费后端已用内存字段，兼容旧采样用 total-available 推导。
    function memoryUsedValue(point: JsonRecord): number {
      const direct = Number(point.memUsedMb)
      if (Number.isFinite(direct)) return Math.max(0, direct)
      const total = Number(point.memTotalMb)
      const available = Number(point.memAvailableMb)
      if (Number.isFinite(total) && Number.isFinite(available)) return Math.max(0, total - available)
      return Number.NaN
    }

    // 磁盘容量按大小自动切换 MB/GB，减少长数字噪声。
    function sizeMbLabel(value: unknown): string {
      const parsed = Number(value)
      if (!Number.isFinite(parsed)) return '-'
      if (Math.abs(parsed) >= 1024) return `${Math.round((parsed / 1024) * 10) / 10} GB`
      return `${Math.round(parsed)} MB`
    }

    // 毫秒间隔标签。
    function formatInterval(value: unknown): string {
      const ms = Number(value)
      if (!Number.isFinite(ms) || ms <= 0) return '-'
      if (ms < 1000) return `${ms}ms`
      if (ms < 60000) return `${Math.round(ms / 100) / 10}s`
      if (ms < 3600000) return `${Math.round(ms / 6000) / 10}m`
      return `${Math.round(ms / 360000) / 10}h`
    }

    // SVG 坐标保留一位小数，减少模板噪声。
    function round(value: number): number {
      return Math.round(value * 10) / 10
    }

    // coverage 列表稳定 key。
    function coverageKey(item: JsonRecord): string {
      return `${display(item.date)}:${display(item.channelKey)}:${display(item.updatedAt)}`
    }

    // event 列表稳定 key。
    function eventKey(item: JsonRecord): string {
      return `${display(item.source)}:${display(item.event)}:${display(item.createdAt)}:${display(item.taskId)}`
    }

    // 判断任务是否允许从面板取消。
    function canCancel(task: JsonRecord): boolean {
      return ['pending', 'deferred'].includes(String(task.status || ''))
    }

    // 读取资源总览。
    async function loadStatus(): Promise<void> {
      const res = await fetchResourceStatus()
      if (res.ok && res.data) {
        status.value = asRecord(res.data)
        const modeRes = await fetchResourceMode()
        if (modeRes.ok && modeRes.data) {
          const modeData = asRecord(modeRes.data)
          status.value = {
            ...status.value,
            serverMode: modeData.serverMode ?? status.value.serverMode,
            serverModeSource: modeData.serverModeSource ?? status.value.serverModeSource,
            tool_active: modeData.tool_active ?? status.value.tool_active,
            render_active: modeData.render_active ?? status.value.render_active,
            background_allowed: modeData.background_allowed ?? status.value.background_allowed,
          }
        }
        lastRefresh.value = Date.now()
        return
      }
      throw new Error(errorMessage(res.data, '资源状态读取失败'))
    }

    // 读取任务列表。
    async function loadTasks(): Promise<void> {
      if (loadingTasks.value) return
      loadingTasks.value = true
      try {
        const res = await fetchResourceTasks()
        if (res.ok && res.data) tasks.value = asArray<JsonRecord>(asRecord(res.data).tasks)
      } finally {
        loadingTasks.value = false
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
    async function toggleMaintenance(): Promise<void> {
      const next = !status.value.maintenance
      const res = await setResourceMaintenance(next)
      message.value = { type: res.ok ? 'ok' : 'err', text: errorMessage(res.data, next ? '维护模式已开启' : '维护模式已关闭') }
      await refreshAllInternal({ preserveMessage: true })
    }

    // 请求后端按 stale 规则回收 S0 锁。
    async function reclaimStale(): Promise<void> {
      const res = await reclaimResourceStale()
      message.value = { type: res.ok ? 'ok' : 'err', text: res.ok ? 'stale 回收检查已完成' : errorMessage(res.data, '回收失败') }
      await refreshAllInternal({ preserveMessage: true })
    }

    // 切换服务器资源模式。
    async function setMode(serverMode: string): Promise<void> {
      if (loadingMode.value) return
      loadingMode.value = true
      try {
        const res = await setResourceMode(serverMode)
        if (res.ok) {
          message.value = { type: 'ok', text: serverMode === 'small' ? '已切换到小内存服务器' : '已切换到大内存服务器' }
          await refreshAllInternal({ preserveMessage: true })
          return
        }
        if (isAdminRequired(res)) {
          message.value = { type: 'warn', text: '切换服务器资源模式需要管理员密码' }
          if (showAdminDialog) showAdminDialog('切换服务器资源模式需要管理员密码', () => setMode(serverMode))
          return
        }
        message.value = { type: 'err', text: errorMessage(res.data, '模式切换失败') }
      } finally {
        loadingMode.value = false
      }
    }

    // 取消 pending/deferred 任务。
    async function cancelTask(task: JsonRecord): Promise<void> {
      const taskId = display(task.id, '')
      if (!taskId) return
      const res = await cancelResourceTask(taskId)
      message.value = { type: res.ok ? 'ok' : 'err', text: res.ok ? '任务已取消' : errorMessage(res.data, '取消失败') }
      await refreshAllInternal({ preserveMessage: true })
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
      events,
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
      precompute,
      disk,
      diskFilesystem,
      diskEntries,
      coverage,
      filteredCoverage,
      memoryLabel,
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
      maintenanceLabel,
      lastRefreshLabel,
      display,
      boolText,
      numberValue,
      arrayLength,
      lagLabel,
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
      reclaimStale,
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

.state-green { color: var(--success) !important }
.state-yellow { color: var(--accent) !important }
.state-red,
.state-black { color: var(--danger) !important }

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

.memory-range-select {
  flex: 0 0 104px;
  height: 34px;
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

.resource-id {
  max-width: 260px;
  overflow-wrap: anywhere;
  color: var(--text2);
}

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

.resource-event {
  display: grid;
  grid-template-columns: 52px minmax(120px, 0.8fr) minmax(0, 1.6fr);
  gap: 10px;
  align-items: center;
}

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

  .resource-event {
    grid-template-columns: 1fr;
    gap: 4px;
  }
}
</style>
