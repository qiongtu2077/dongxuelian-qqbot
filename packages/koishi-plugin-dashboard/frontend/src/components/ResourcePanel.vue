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

          <div class="memory-chart-panel">
            <div class="memory-chart-head">
              <div>
                <h2>内存走势</h2>
                <div class="resource-subline">{{ memorySampleLabel }}</div>
              </div>
              <select v-model="memoryRange" class="memory-range-select" @change="loadMemoryHistory">
                <option v-for="option in memoryRangeOptions" :key="option.value" :value="option.value">{{ option.label }}</option>
              </select>
            </div>
            <div class="memory-chart-wrap">
              <svg class="memory-chart" viewBox="0 0 640 220" preserveAspectRatio="none" role="img" aria-label="可用内存折线图">
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
                <circle
                  v-for="point in memoryChartPoints"
                  :key="point.ts"
                  :cx="point.x"
                  :cy="point.y"
                  r="3"
                  class="memory-chart-dot"
                />
              </svg>
              <div v-if="!memoryHistory.length" class="memory-chart-empty">
                {{ loadingMemory ? '加载中...' : '暂无内存采样' }}
              </div>
            </div>
            <div class="memory-chart-meta">
              <span>点数 {{ memoryHistory.length }}</span>
              <span>当前 {{ memoryCurrentLabel }}</span>
              <span>最低 {{ memoryMinLabel }}</span>
              <span>最高 {{ memoryMaxLabel }}</span>
            </div>
          </div>
        </div>
      </section>

      <section class="card">
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

      <section class="card">
        <h2>媒体背压</h2>
        <div class="resource-metric-row"><span>图片 pending</span><b>{{ numberValue(media.imagePending) }}</b></div>
        <div class="resource-metric-row"><span>文件 pending</span><b>{{ numberValue(media.filePending) }}</b></div>
        <div class="resource-metric-row"><span>语音 pending</span><b>{{ numberValue(media.voicePending) }}</b></div>
        <div class="resource-metric-row"><span>running</span><b>{{ arrayLength(media.running) }}</b></div>
        <div class="resource-metric-row"><span>dropped</span><b>{{ numberValue(media.droppedCount) }}</b></div>
      </section>

      <section class="card">
        <h2>日报预计算</h2>
        <div class="resource-metric-row"><span>coverage</span><b>{{ numberValue(precompute.coverageCount) }}</b></div>
        <div class="resource-metric-row"><span>slots</span><b>{{ numberValue(precompute.slotCount) }}</b></div>
        <div v-if="coverage.length" class="resource-list compact">
          <div v-for="item in coverage" :key="coverageKey(item)" class="resource-row">
            <div>
              <b>{{ display(item.channelKey) }}</b>
              <small>{{ percentLabel(item.coverageRate) }} · {{ display(item.updatedAt) }}</small>
            </div>
          </div>
        </div>
        <div v-else class="resource-empty">暂无 coverage</div>
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
import { computed, onMounted, onUnmounted, ref } from 'vue'
import {
  cancelResourceTask,
  fetchResourceEvents,
  fetchResourceMemoryHistory,
  fetchResourceStatus,
  fetchResourceTasks,
  reclaimResourceStale,
  setResourceMaintenance,
} from '../api'
import { asArray, asRecord, errorMessage, type JsonRecord, type MessageState } from '../types'

export default {
  name: 'ResourcePanel',
  setup() {
    const status = ref<JsonRecord>({})
    const tasks = ref<JsonRecord[]>([])
    const events = ref<JsonRecord[]>([])
    const memoryHistory = ref<JsonRecord[]>([])
    const memoryRange = ref('5m')
    const memoryMeta = ref<JsonRecord>({})
    const message = ref<MessageState>({ type: 'info', text: '' })
    const lastRefresh = ref(0)
    const loading = ref(false)
    const loadingTasks = ref(false)
    const loadingEvents = ref(false)
    const loadingMemory = ref(false)
    let timer: ReturnType<typeof setInterval> | null = null
    let secondaryTimer: ReturnType<typeof setInterval> | null = null
    let memoryTimer: ReturnType<typeof setInterval> | null = null

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
    const coverage = computed(() => asArray<JsonRecord>(precompute.value.coverage))
    const memoryLabel = computed(() => {
      const available = status.value.memAvailableMb
      const total = status.value.memTotalMb
      if (typeof available !== 'number') return 'unknown'
      return typeof total === 'number' ? `${available} / ${total} MB` : `${available} MB`
    })
    const maintenanceLabel = computed(() => status.value.maintenance ? '关闭维护' : '开启维护')
    const lastRefreshLabel = computed(() => lastRefresh.value ? new Date(lastRefresh.value).toLocaleTimeString() : '尚未刷新')
    const memoryValues = computed(() => memoryHistory.value
      .map(point => Number(point.memAvailableMb))
      .filter(value => Number.isFinite(value)))
    const memoryMinValue = computed(() => memoryValues.value.length ? Math.min(...memoryValues.value) : null)
    const memoryMaxValue = computed(() => memoryValues.value.length ? Math.max(...memoryValues.value) : null)
    const memoryCurrentValue = computed(() => {
      const values = memoryValues.value
      return values.length ? values[values.length - 1] : null
    })
    const memoryCurrentLabel = computed(() => mbLabel(memoryCurrentValue.value))
    const memoryMinLabel = computed(() => mbLabel(memoryMinValue.value))
    const memoryMaxLabel = computed(() => mbLabel(memoryMaxValue.value))
    const memorySampleLabel = computed(() => {
      const worker = formatInterval(Number(memoryMeta.value.workerSampleIntervalMs))
      const dashboard = formatInterval(Number(memoryMeta.value.dashboardSampleIntervalMs))
      const bucket = formatInterval(Number(memoryMeta.value.bucketMs))
      return `worker 采样 ${worker}，面板补采样 ${dashboard}，当前聚合 ${bucket}`
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
      const points = memoryHistory.value
      const count = points.length
      const scale = memoryChartScale.value
      const height = 176
      const top = 24
      const left = 44
      const width = 580
      const span = Math.max(1, scale.max - scale.min)
      return points.map((point, index) => {
        const value = Number(point.memAvailableMb)
        const ratio = Number.isFinite(value) ? (value - scale.min) / span : 0
        const x = left + (count <= 1 ? width : (index / (count - 1)) * width)
        const y = top + height - Math.max(0, Math.min(1, ratio)) * height
        return { x: round(x), y: round(y), ts: String(point.ts || point.createdAt || index), value }
      })
    })
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
      if (loading.value) return
      const res = await fetchResourceStatus()
      if (res.ok && res.data) {
        status.value = asRecord(res.data)
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
    async function loadMemoryHistory(): Promise<void> {
      if (loadingMemory.value) return
      loadingMemory.value = true
      try {
        const res = await fetchResourceMemoryHistory(memoryRange.value)
        if (res.ok && res.data) {
          const data = asRecord(res.data)
          memoryMeta.value = data
          memoryHistory.value = asArray<JsonRecord>(data.points)
        }
      } finally {
        loadingMemory.value = false
      }
    }

    // 刷新资源中心所有数据。
    async function refreshAll(): Promise<void> {
      if (loading.value) return
      loading.value = true
      message.value = { type: 'info', text: '' }
      try {
        const res = await fetchResourceStatus()
        if (res.ok && res.data) {
          status.value = asRecord(res.data)
          lastRefresh.value = Date.now()
        } else {
          throw new Error(errorMessage(res.data, '资源状态读取失败'))
        }
        await Promise.all([loadTasks(), loadEvents(), loadMemoryHistory()])
      } catch (error) {
        message.value = { type: 'err', text: errorMessage(error, '刷新失败') }
      } finally {
        loading.value = false
      }
    }

    // 切换维护模式，复用后端 ai-paused.txt。
    async function toggleMaintenance(): Promise<void> {
      const next = !status.value.maintenance
      const res = await setResourceMaintenance(next)
      message.value = { type: res.ok ? 'ok' : 'err', text: errorMessage(res.data, next ? '维护模式已开启' : '维护模式已关闭') }
      await refreshAll()
    }

    // 请求后端按 stale 规则回收 S0 锁。
    async function reclaimStale(): Promise<void> {
      const res = await reclaimResourceStale()
      message.value = { type: res.ok ? 'ok' : 'err', text: res.ok ? 'stale 回收检查已完成' : errorMessage(res.data, '回收失败') }
      await refreshAll()
    }

    // 取消 pending/deferred 任务。
    async function cancelTask(task: JsonRecord): Promise<void> {
      const taskId = display(task.id, '')
      if (!taskId) return
      const res = await cancelResourceTask(taskId)
      message.value = { type: res.ok ? 'ok' : 'err', text: res.ok ? '任务已取消' : errorMessage(res.data, '取消失败') }
      await refreshAll()
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
    })

    return {
      status,
      tasks,
      events,
      memoryHistory,
      memoryRange,
      memoryRangeOptions,
      memoryMeta,
      message,
      loading,
      loadingTasks,
      loadingEvents,
      loadingMemory,
      running,
      workers,
      media,
      precompute,
      coverage,
      memoryLabel,
      memorySampleLabel,
      memoryCurrentLabel,
      memoryMinLabel,
      memoryMaxLabel,
      memoryChartPoints,
      memoryPolyline,
      memoryYTicks,
      maintenanceLabel,
      lastRefreshLabel,
      display,
      numberValue,
      arrayLength,
      lagLabel,
      percentLabel,
      coverageKey,
      eventKey,
      canCancel,
      refreshAll,
      loadTasks,
      loadEvents,
      loadMemoryHistory,
      toggleMaintenance,
      reclaimStale,
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
  grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
  gap: 16px;
}

.resource-summary {
  grid-column: span 2;
}

.resource-summary-layout {
  display: grid;
  grid-template-columns: minmax(260px, 0.9fr) minmax(320px, 1.1fr);
  gap: 16px;
  align-items: stretch;
}

.resource-summary-main,
.memory-chart-panel {
  min-width: 0;
}

.resource-kpis {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
  gap: 10px;
  margin-bottom: 16px;
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

.memory-chart-panel {
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--input);
  padding: 12px;
}

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
  height: 220px;
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
}

.memory-chart-dot {
  fill: var(--accent);
  stroke: var(--card);
  stroke-width: 2;
  vector-effect: non-scaling-stroke;
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
  grid-template-columns: repeat(4, minmax(0, 1fr));
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

@media (max-width: 760px) {
  .resource-toolbar,
  .resource-card-head {
    align-items: stretch;
    flex-direction: column;
  }

  .resource-actions {
    justify-content: flex-start;
  }

  .resource-summary {
    grid-column: span 1;
  }

  .resource-summary-layout,
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
