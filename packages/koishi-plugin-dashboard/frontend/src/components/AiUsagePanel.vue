<template>
  <section class="card usage-panel" aria-labelledby="usage-title">
    <div class="section-head">
      <div><p class="step-index">03</p><h3 id="usage-title">模型用量</h3><p>统计 {{ capabilityLabel }} 的用量；无能力标识的历史记录不会归入统计。</p></div>
      <div class="usage-actions">
        <UsageDateRangePicker :preset="preset" :range="displayRange" @apply="applyRange" />
        <button class="refresh-btn" type="button" :disabled="loading" @click="loadUsage">{{ loading ? '加载中…' : '刷新用量' }}</button>
      </div>
    </div>
    <div class="range-caption"><span>{{ displayRange.startDate }} — {{ displayRange.endDate }} · 北京时间，包含起止当天</span><span v-if="usage?.availableRange">已有记录：{{ usage.availableRange.startDate }} — {{ usage.availableRange.endDate }}</span></div>
    <p v-if="error" class="notice error" role="alert">{{ error }}</p>
    <p v-else-if="loading" class="loading-copy" role="status">正在读取所选区间的用量…</p>
    <template v-else-if="usage">
      <p v-if="usage.unavailable" class="token-unavailable" role="status">无法读取模型 Token 用量</p>
      <div class="usage-metrics">
        <div><span>请求次数</span><strong>{{ formatNumber(usage.summary.requests) }}</strong></div>
        <div><span>Token 总量</span><strong>{{ usage.readable ? formatNumber(usage.summary.total) : '—' }}</strong></div>
        <div><span>供应商</span><strong>{{ usage.providers.length }}</strong></div>
        <div><span>模型</span><strong>{{ usage.models.length }}</strong></div>
      </div>
      <template v-if="usage.days.length">
        <div v-if="usage.readable" class="token-details">
          <span>输入 <strong>{{ formatNumber(usage.summary.input) }}</strong></span><span>输出 <strong>{{ formatNumber(usage.summary.output) }}</strong></span>
          <span>缓存创建 <strong>{{ formatNumber(usage.summary.cacheCreation) }}</strong></span><span>缓存命中 <strong>{{ formatNumber(usage.summary.cacheRead) }}</strong></span>
        </div>
        <UsageTrend v-if="usage.readable" :days="usage.days" :range="usage.range" />
        <div class="usage-tables">
          <div><h4>供应商分布</h4><table><thead><tr><th>供应商</th><th>请求</th><th>Token</th></tr></thead><tbody><tr v-for="row in usage.providers" :key="row.key"><td>{{ providerName(row.key) }}</td><td>{{ formatNumber(row.requests) }}</td><td>{{ row.readableRequests ? formatNumber(row.total) : '—' }}</td></tr></tbody></table></div>
          <div><h4>模型分布</h4><table><thead><tr><th>模型</th><th>请求</th><th>Token</th></tr></thead><tbody><tr v-for="row in usage.models" :key="row.key"><td :title="row.label || row.key">{{ row.label || row.key }}</td><td>{{ formatNumber(row.requests) }}</td><td>{{ row.readableRequests ? formatNumber(row.total) : '—' }}</td></tr></tbody></table></div>
        </div>
        <p v-if="usage.readable && usage.summary.unreadableRequests" class="partial-copy">另有 {{ formatNumber(usage.summary.unreadableRequests) }} 次请求未返回 Token 用量，已计入请求次数。</p>
        <details class="daily-usage"><summary>每日明细（{{ usage.days.length }} 个记录日）</summary><div class="table-scroll"><table><thead><tr><th>日期</th><th>请求</th><th>Token 总量</th><th>输入</th><th>输出</th><th>缓存创建</th><th>缓存命中</th></tr></thead><tbody><tr v-for="day in usage.days" :key="day.date"><td>{{ day.date }}</td><td>{{ formatNumber(day.requests) }}</td><td>{{ day.readableRequests ? formatNumber(day.total) : '—' }}</td><td>{{ day.readableRequests ? formatNumber(day.input) : '—' }}</td><td>{{ day.readableRequests ? formatNumber(day.output) : '—' }}</td><td>{{ day.readableRequests ? formatNumber(day.cacheCreation) : '—' }}</td><td>{{ day.readableRequests ? formatNumber(day.cacheRead) : '—' }}</td></tr></tbody></table></div></details>
      </template>
      <p v-else class="empty-copy" role="status">所选日期区间内没有该能力的用量记录。</p>
    </template>
  </section>
</template>

<script setup lang="ts">
import { computed, inject, ref, watch } from 'vue'
import { fetchAiCapabilityUsage, isAdminRequired } from '../api'
import type { ShowAdminDialog } from '../types'
import { messageFromData } from '../types'
import type { AiCapability, AiProviderCatalogItem, CapabilityUsageResponse, UsageDateRange } from '../services/ai-model-api-model'
import { resolveUsagePreset, validateUsageRange } from '../services/usage-range-model'
import type { UsagePreset } from '../services/usage-range-model'
import UsageDateRangePicker from './UsageDateRangePicker.vue'
import UsageTrend from './UsageTrend.vue'

const props = defineProps<{ capability: AiCapability; capabilityLabel: string; catalog: AiProviderCatalogItem[] }>()
const showAdminDialog = inject<ShowAdminDialog>('showAdminDialog')
const preset = ref<UsagePreset>('30d')
const customRange = ref<UsageDateRange>({ startDate: '', endDate: '' })
const appliedRange = ref(resolveUsagePreset('30d', customRange.value)!)
const usage = ref<CapabilityUsageResponse | null>(null)
const loading = ref(false)
const error = ref('')
let requestId = 0
const displayRange = computed(() => usage.value?.range || appliedRange.value)

// --- 查询与区间选择 ---

// 按当前能力和日期区间读取全部用量视图，丢弃快速切换后的过期响应。
async function loadUsage(): Promise<void> {
  const currentRequest = ++requestId
  const range = resolveUsagePreset(preset.value, customRange.value)
  if (range) appliedRange.value = range
  loading.value = true
  error.value = ''
  usage.value = null
  const response = await fetchAiCapabilityUsage(props.capability, range)
  if (currentRequest !== requestId) return
  loading.value = false
  if (isAdminRequired(response)) {
    if (showAdminDialog) showAdminDialog('查看模型用量需要管理员密码', loadUsage)
    else error.value = '该操作需要管理员验证'
    return
  }
  if (!response.ok || !response.data) {
    error.value = messageFromData(response.data, '模型用量读取失败')
    return
  }
  usage.value = response.data
  appliedRange.value = response.data.range
}

// 确认后才更新筛选条件；切换能力时保留同一日期区间。
function applyRange(nextPreset: UsagePreset, range: UsageDateRange): void {
  const message = validateUsageRange(range)
  if (message) { error.value = message; return }
  preset.value = nextPreset
  customRange.value = { ...range }
  void loadUsage()
}

// --- 统计展示 ---

// 从共享目录读取供应商名称，历史供应商保留原有标识。
function providerName(id: string): string {
  return props.catalog.find(item => item.id === id)?.name || id
}

// 格式化统计数据，完整数值供汇总与明细核对。
function formatNumber(value: number): string {
  return value.toLocaleString('zh-CN')
}

watch(() => props.capability, () => { void loadUsage() }, { immediate: true })
</script>

<style scoped>
.usage-panel { min-width: 0; overflow: visible; padding: 24px; }
.section-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 20px; }
.section-head h3 { margin: 2px 0 6px; color: var(--text); }
.section-head p { color: var(--text3); line-height: 1.6; }
.step-index { color: var(--accent) !important; font-size: 12px; font-weight: 900; letter-spacing: .16em; }
.usage-actions { display: flex; flex-wrap: wrap; align-items: center; justify-content: flex-end; gap: 8px; }
.refresh-btn { min-height: 38px; padding: 0 14px; background: var(--card); color: var(--text); border: 1px solid color-mix(in srgb, var(--accent) 42%, var(--border)); border-radius: 8px; font: inherit; font-weight: 800; cursor: pointer; white-space: nowrap; }
button:disabled { opacity: .45; cursor: not-allowed; }
.range-caption { display: flex; justify-content: space-between; flex-wrap: wrap; gap: 6px 18px; color: var(--text3); font-size: 12px; margin: 18px 0 14px; }
.usage-metrics { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 10px; }
.usage-metrics div { display: grid; gap: 4px; padding: 14px; border: 1px solid var(--border); border-radius: 8px; background: var(--hoverLight); }
.usage-metrics span { color: var(--text3); font-size: 12px; }
.usage-metrics strong { color: var(--text); font-size: 20px; }
.token-details { display: flex; flex-wrap: wrap; gap: 10px 28px; margin-top: 16px; font-size: 12px; color: var(--text3); }
.token-details strong { color: var(--text2); margin-left: 8px; }
.usage-tables { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 18px; margin-top: 20px; }
.usage-tables > div, .table-scroll { min-width: 0; overflow-x: auto; }
h4 { margin-bottom: 10px; color: var(--text); }
table { width: 100%; border-collapse: collapse; color: var(--text2); font-size: 13px; }
th, td { padding: 9px 7px; border-bottom: 1px solid var(--border); text-align: right; white-space: nowrap; }
th:first-child, td:first-child { text-align: left; max-width: 260px; overflow: hidden; text-overflow: ellipsis; }
.daily-usage { margin-top: 20px; border-top: 1px solid var(--border); padding-top: 16px; color: var(--text2); }
.daily-usage summary { cursor: pointer; font-size: 13px; font-weight: 800; margin-bottom: 8px; }
.notice, .token-unavailable { margin: 12px 0; padding: 12px; border: 1px solid color-mix(in srgb, var(--danger) 35%, var(--border)); border-radius: 8px; color: var(--danger); background: color-mix(in srgb, var(--danger) 8%, var(--card)); }
.empty-copy, .loading-copy { padding: 28px 12px; text-align: center; color: var(--text3); }
.partial-copy { margin-top: 12px; font-size: 12px; color: var(--text3); }
@media (max-width: 760px) {
  .usage-panel { padding: 18px; }
  .section-head { flex-direction: column; }
  .usage-actions { width: 100%; justify-content: flex-start; }
  .usage-tables { grid-template-columns: 1fr; }
  .usage-metrics { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
@media (max-width: 540px) { .usage-actions { display: grid; grid-template-columns: minmax(0, 1fr) auto; } }
</style>
