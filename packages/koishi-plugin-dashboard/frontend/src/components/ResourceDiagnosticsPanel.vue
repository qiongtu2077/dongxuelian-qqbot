<template>
  <section id="resource-diagnostics" class="card resource-diagnostics-card">
    <div class="diagnostics-head">
      <div>
        <h2>任务诊断记录</h2>
        <div class="diagnostics-subline">集中查看未知任务和未完成媒体任务；具体报错仅在展开时读取。</div>
      </div>
      <button v-if="!opened" class="btn btn-sm" @click="openPanel">打开诊断记录</button>
      <div v-else class="diagnostics-actions">
        <button class="btn btn-sm" :disabled="loading" @click="refreshDiagnostics">刷新诊断记录</button>
        <button class="btn btn-sm" @click="closePanel">收起</button>
      </div>
    </div>

    <template v-if="opened">
      <div class="diagnostics-counts">
        <span>当前保留：{{ numberValue(counts.all) }}</span>
        <span>未知任务：{{ numberValue(counts.unknown) }}</span>
        <span>未完成媒体任务：{{ numberValue(counts.media) }}</span>
      </div>
      <div class="diagnostics-filters">
        <label>
          <span>记录范围</span>
          <select v-model="group" @change="changeFilters">
            <option value="all">全部</option>
            <option value="unknown">未知任务</option>
            <option value="media">未完成媒体任务</option>
          </select>
        </label>
        <label v-if="group === 'media'">
          <span>结束原因</span>
          <select v-model="reason" @change="changeFilters">
            <option value="">全部原因</option>
            <option value="queue_limit">因队列超限舍弃</option>
            <option value="processing_failed">处理失败</option>
            <option value="restart_interrupted">服务重启时中断</option>
            <option value="legacy_unknown">历史原因未知</option>
          </select>
        </label>
      </div>

      <div v-if="error" class="msg err">{{ error }}</div>
      <div class="diagnostics-list">
        <article v-for="item in items" :key="display(item.recordId)" class="diagnostic-item">
          <button class="diagnostic-summary" type="button" @click="toggleDetail(item)">
            <span class="diagnostic-title">
              <b>{{ taskKindDisplay(item.kind) }}</b>
              <span class="resource-pill">{{ recordStatus(item) }}</span>
            </span>
            <span class="diagnostic-time">{{ recordTime(item) }}</span>
            <span class="diagnostic-id">内部任务标识：{{ display(item.taskId) }}</span>
            <span class="diagnostic-toggle">{{ isExpanded(item) ? '收起具体报错' : '展开具体报错' }}</span>
          </button>
          <div v-if="isExpanded(item)" class="diagnostic-detail">
            <div v-if="isDetailLoading(item)" class="diagnostic-muted">正在读取具体报错...</div>
            <template v-else>
              <pre class="diagnostic-error">{{ detailError(item) }}</pre>
              <dl v-if="detailFor(item)" class="diagnostic-facts">
                <template v-for="(value, key) in detailDiagnostics(item)" :key="key">
                  <dt>{{ diagnosticFactLabel(key) }}</dt>
                  <dd>{{ diagnosticFactValue(key, value) }}</dd>
                </template>
              </dl>
            </template>
          </div>
        </article>
        <div v-if="!loading && !items.length" class="diagnostic-muted">当前筛选范围没有诊断记录</div>
      </div>
      <div class="diagnostics-footer">
        <span>已加载 {{ items.length }} / {{ numberValue(total) }} 条</span>
        <button v-if="hasMore" class="btn btn-sm" :disabled="loadingMore" @click="loadMore">
          {{ loadingMore ? '加载中...' : '加载更多' }}
        </button>
      </div>
    </template>
  </section>
</template>

<script lang="ts">
import { inject, ref } from 'vue'
import { fetchResourceDiagnosticDetail, fetchResourceDiagnostics, isAdminRequired } from '../api'
import { asArray, asRecord, errorMessage, type JsonRecord, type ShowAdminDialog } from '../types'
import { dateTimeDisplay, display, mediaFinishReasonDisplay, numberValue, taskKindDisplay } from '../services/resource-model'

export default {
  name: 'ResourceDiagnosticsPanel',
  setup() {
    const showAdminDialog = inject<ShowAdminDialog>('showAdminDialog')
    const opened = ref(false)
    const loading = ref(false)
    const loadingMore = ref(false)
    const group = ref('all')
    const reason = ref('')
    const items = ref<JsonRecord[]>([])
    const counts = ref<JsonRecord>({ all: 0, unknown: 0, media: 0 })
    const total = ref(0)
    const nextCursor = ref('')
    const hasMore = ref(false)
    const error = ref('')
    const expandedIds = ref<Set<string>>(new Set())
    const details = ref<Record<string, JsonRecord>>({})
    const detailLoading = ref<Record<string, boolean>>({})

    // --- 列表与分页 --- //

    // Reads the newest fixed-size page and clears state from the previous filter.
    async function loadFirstPage(retried = false): Promise<void> {
      if (loading.value) return
      loading.value = true
      error.value = ''
      try {
        const res = await fetchResourceDiagnostics({ group: group.value, reason: group.value === 'media' ? reason.value : '' })
        if (isAdminRequired(res)) {
          if (!retried && showAdminDialog) showAdminDialog('查看任务诊断记录需要管理员密码', () => loadFirstPage(true))
          else error.value = '管理员验证后诊断记录仍无法读取'
          return
        }
        if (!res.ok || !res.data) throw new Error(errorMessage(res.data, '任务诊断记录读取失败'))
        const data = asRecord(res.data)
        items.value = asArray<JsonRecord>(data.items)
        counts.value = asRecord(data.counts)
        total.value = numberValue(data.total)
        nextCursor.value = String(data.nextCursor || '')
        hasMore.value = data.hasMore === true
        expandedIds.value = new Set()
        details.value = {}
        detailLoading.value = {}
      } catch (failure) {
        error.value = errorMessage(failure, '任务诊断记录读取失败')
      } finally {
        loading.value = false
      }
    }

    // Opens the independent diagnostic section and starts from the newest records.
    async function openPanel(): Promise<void> {
      opened.value = true
      await loadFirstPage()
    }

    // Closes the section without coupling it to the resource-status refresh timer.
    function closePanel(): void {
      opened.value = false
    }

    // Explicitly reloads diagnostics from the newest record while keeping status refresh independent.
    async function refreshDiagnostics(): Promise<void> {
      await loadFirstPage()
    }

    // Resets pagination whenever either diagnostic filter changes.
    async function changeFilters(): Promise<void> {
      if (group.value !== 'media') reason.value = ''
      await loadFirstPage()
    }

    // Loads the next stable 120-record page using the backend cursor.
    async function loadMore(): Promise<void> {
      if (loadingMore.value || !hasMore.value || !nextCursor.value) return
      loadingMore.value = true
      error.value = ''
      try {
        const res = await fetchResourceDiagnostics({
          group: group.value,
          reason: group.value === 'media' ? reason.value : '',
          cursor: nextCursor.value,
        })
        if (!res.ok || !res.data) throw new Error(errorMessage(res.data, '更多诊断记录读取失败'))
        const data = asRecord(res.data)
        const known = new Set(items.value.map(item => String(item.recordId || '')))
        items.value = [...items.value, ...asArray<JsonRecord>(data.items).filter(item => !known.has(String(item.recordId || '')))]
        counts.value = asRecord(data.counts)
        total.value = numberValue(data.total)
        nextCursor.value = String(data.nextCursor || '')
        hasMore.value = data.hasMore === true
      } catch (failure) {
        error.value = errorMessage(failure, '更多诊断记录读取失败')
      } finally {
        loadingMore.value = false
      }
    }

    // --- 详情按需加载 --- //

    // Reports whether one record currently has its detail area open.
    function isExpanded(item: JsonRecord): boolean {
      return expandedIds.value.has(String(item.recordId || ''))
    }

    // Reports whether one record is currently fetching its detail response.
    function isDetailLoading(item: JsonRecord): boolean {
      return detailLoading.value[String(item.recordId || '')] === true
    }

    // Opens or closes one record and lazily reads its saved error exactly once.
    async function toggleDetail(item: JsonRecord, retried = false): Promise<void> {
      const recordId = String(item.recordId || '')
      if (!recordId) return
      if (expandedIds.value.has(recordId) && !retried) {
        const next = new Set(expandedIds.value)
        next.delete(recordId)
        expandedIds.value = next
        return
      }
      expandedIds.value = new Set(expandedIds.value).add(recordId)
      if (details.value[recordId] || detailLoading.value[recordId]) return
      detailLoading.value = { ...detailLoading.value, [recordId]: true }
      try {
        const res = await fetchResourceDiagnosticDetail(recordId)
        if (isAdminRequired(res)) {
          if (!retried && showAdminDialog) showAdminDialog('查看任务具体报错需要管理员密码', () => toggleDetail(item, true))
          else details.value = { ...details.value, [recordId]: { error: '', loadError: '管理员验证后具体报错仍无法读取' } }
          return
        }
        if (!res.ok || !res.data) throw new Error(errorMessage(res.data, '具体报错读取失败'))
        details.value = { ...details.value, [recordId]: asRecord(res.data) }
      } catch (failure) {
        details.value = { ...details.value, [recordId]: { error: '', loadError: errorMessage(failure, '具体报错读取失败') } }
      } finally {
        detailLoading.value = { ...detailLoading.value, [recordId]: false }
      }
    }

    // --- 详情展示 --- //

    // Returns one already-loaded detail response.
    function detailFor(item: JsonRecord): JsonRecord {
      return details.value[String(item.recordId || '')] || {}
    }

    // Returns the saved error verbatim or an explicit absence/failure message.
    function detailError(item: JsonRecord): string {
      const detail = detailFor(item)
      if (detail.loadError) return String(detail.loadError)
      return String(detail.error || '未记录具体报错')
    }

    // Returns safe diagnostic facts supplied by the detail endpoint.
    function detailDiagnostics(item: JsonRecord): JsonRecord {
      return asRecord(detailFor(item).diagnostics)
    }

    // Translates one diagnostic fact key without exposing backend variable names.
    function diagnosticFactLabel(key: string): string {
      if (key === 'claimedBy') return '处理器'
      if (key === 'step') return '退出前步骤'
      if (key === 'source') return '任务来源'
      if (key === 'timeoutMs') return '最长运行时间（毫秒）'
      if (key === 'finishReason') return '结束原因'
      return '诊断信息'
    }

    // Formats one diagnostic fact value and translates stable reason codes.
    function diagnosticFactValue(key: string, value: unknown): string {
      return key === 'finishReason' ? mediaFinishReasonDisplay(value) : display(value)
    }

    // Formats one record's user-facing state or finish reason.
    function recordStatus(item: JsonRecord): string {
      if (item.recordType === 'unfinished_media') return mediaFinishReasonDisplay(item.finishReason)
      const labels: Record<string, string> = {
        pending: '等待处理',
        claiming: '正在领取',
        running: '正在处理',
        done: '已完成',
        failed: '处理失败',
        cancelled: '已取消',
        deferred: '稍后重试',
      }
      return labels[String(item.status || '')] || '状态未知'
    }

    // Formats all required timestamps while preserving unknown-task create/update facts.
    function recordTime(item: JsonRecord): string {
      if (item.recordType === 'unfinished_media') return `结束时间：${dateTimeDisplay(item.finishedAt)}`
      return `创建时间：${dateTimeDisplay(item.createdAt)} · 最近更新：${dateTimeDisplay(item.updatedAt)}`
    }

    return {
      opened,
      loading,
      loadingMore,
      group,
      reason,
      items,
      counts,
      total,
      hasMore,
      error,
      detailLoading,
      display,
      numberValue,
      taskKindDisplay,
      openPanel,
      closePanel,
      refreshDiagnostics,
      changeFilters,
      loadMore,
      isExpanded,
      isDetailLoading,
      toggleDetail,
      detailFor,
      detailError,
      detailDiagnostics,
      diagnosticFactLabel,
      diagnosticFactValue,
      recordStatus,
      recordTime,
    }
  },
}
</script>

<style scoped>
.resource-diagnostics-card { margin-top: 16px; }
.diagnostics-head,
.diagnostics-actions,
.diagnostics-counts,
.diagnostics-filters,
.diagnostics-footer { display: flex; align-items: center; gap: 10px; }
.diagnostics-head { justify-content: space-between; }
.diagnostics-head h2 { margin: 0 0 4px; }
.diagnostics-subline,
.diagnostic-muted,
.diagnostic-time,
.diagnostic-id { color: var(--text3); font-size: 12px; }
.diagnostics-counts { flex-wrap: wrap; margin: 14px 0 10px; color: var(--text2); font-size: 13px; }
.diagnostics-filters { align-items: flex-end; flex-wrap: wrap; margin-bottom: 12px; }
.diagnostics-filters label { display: grid; gap: 4px; color: var(--text3); font-size: 12px; }
.diagnostics-filters select { min-width: 160px; min-height: 34px; border: 1px solid var(--border); border-radius: 8px; background: var(--input); color: var(--text); padding: 0 9px; }
.diagnostics-list { display: grid; gap: 8px; }
.diagnostic-item { border: 1px solid var(--border); border-radius: 8px; background: var(--input); overflow: hidden; }
.diagnostic-summary { width: 100%; display: grid; grid-template-columns: minmax(190px, 1fr) minmax(220px, 1fr); gap: 6px 14px; padding: 11px 12px; border: 0; background: transparent; color: var(--text); text-align: left; font: inherit; }
.diagnostic-title { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.diagnostic-id { overflow-wrap: anywhere; }
.diagnostic-toggle { color: var(--accent); font-size: 12px; text-align: right; }
.diagnostic-detail { border-top: 1px solid var(--border); padding: 12px; }
.diagnostic-error { margin: 0; padding: 10px; border-radius: 7px; background: color-mix(in srgb, var(--bg) 75%, var(--input)); color: var(--text2); white-space: pre-wrap; overflow-wrap: anywhere; font: 12px/1.55 ui-monospace, SFMono-Regular, Consolas, monospace; }
.diagnostic-facts { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 5px 12px; margin: 10px 0 0; font-size: 12px; }
.diagnostic-facts dt { color: var(--text3); }
.diagnostic-facts dd { margin: 0; overflow-wrap: anywhere; }
.diagnostics-footer { justify-content: space-between; margin-top: 12px; color: var(--text3); font-size: 12px; }
@media (max-width: 720px) {
  .diagnostics-head { align-items: flex-start; flex-direction: column; }
  .diagnostic-summary { grid-template-columns: 1fr; }
  .diagnostic-toggle { text-align: left; }
}
</style>
