<template>
  <div class="card">
    <h2>API Key 管理</h2>
    <div style="color:var(--text3);font-size:13px;margin-bottom:16px">
      修改后自动热加载，无需重启
    </div>
    <div class="api-toolbar">
      <button class="icon-btn" type="button" title="新增 API 配置" @click="openProviderDialog">+</button>
    </div>
    <div v-for="k in keys" :key="k.file" class="grp">
      <div style="display:flex;justify-content:space-between;align-items:center">
        <div>
          <div class="grp-name">{{ k.label }} <span v-if="k.source === 'custom'" class="source-pill">Custom</span></div>
          <div style="font-size:12px;color:var(--text3);font-family:monospace">{{ k.exists ? k.prefix : '（未设置）' }}</div>
        </div>
        <button class="btn btn-sm" @click="editKey(k)">编辑</button>
      </div>
    </div>

    <div v-if="editing" class="msg ok" style="margin-top:16px">
      <div style="margin-bottom:8px;font-weight:700">编辑 {{ editing.label }}</div>
      <input v-model="editValue" style="width:100%;font-family:monospace" :placeholder="'输入新的 ' + editing.file" />
      <div style="display:flex;gap:8px;margin-top:8px">
        <button class="btn btn-sm" @click="saveKey" :disabled="saving">{{ saving ? '保存中...' : '保存' }}</button>
        <button class="btn btn-sm" style="background:var(--border);color:var(--text2)" @click="editing=null">取消</button>
      </div>
      <div v-if="keyMsg" style="margin-top:8px;font-size:13px" :style="{color: keyMsg.type === 'ok' ? 'var(--success)' : 'var(--error)'}">{{ keyMsg.text }}</div>
    </div>
    <div v-else-if="keyMsg" class="msg" :class="keyMsg.type" style="margin-top:16px">{{ keyMsg.text }}</div>
  </div>

  <div v-if="providerDialogOpen" class="modal-backdrop" @click.self="closeProviderDialog">
    <div class="modal-panel">
      <div class="modal-head">
        <h2>新增 API 配置</h2>
        <button class="icon-btn ghost" type="button" title="关闭" @click="closeProviderDialog">×</button>
      </div>
      <div class="provider-grid">
        <label>
          <span>供应商 ID</span>
          <input v-model="providerDraft.id" placeholder="openai-official" />
        </label>
        <label>
          <span>显示名称</span>
          <input v-model="providerDraft.name" placeholder="OpenAI 官方" />
        </label>
        <label class="wide">
          <span>Base URL</span>
          <input v-model="providerDraft.baseURL" placeholder="https://api.openai.com/v1" />
        </label>
        <label>
          <span>Key 文件</span>
          <input v-model="providerDraft.keyFile" placeholder="ai-openai-official-key.txt" />
        </label>
        <label>
          <span>API Key</span>
          <input v-model="providerDraft.apiKey" type="password" autocomplete="off" placeholder="sk-..." />
        </label>
      </div>
      <div class="model-editor">
        <div class="editor-title">
          <strong>模型</strong>
          <button class="btn btn-sm" type="button" @click="addProviderModel">+ 模型</button>
        </div>
        <div v-for="(model, index) in providerDraft.models" :key="index" class="model-row">
          <input v-model="model.id" placeholder="gpt-4o" />
          <input v-model="model.name" placeholder="显示名" />
          <label class="check-label"><input type="checkbox" v-model="model.vision" /> 视觉</label>
          <button class="icon-btn danger" type="button" title="删除模型" :disabled="providerDraft.models.length <= 1" @click="removeProviderModel(index)">×</button>
        </div>
      </div>
      <div v-if="providerMsg" class="msg" :class="providerMsg.type">{{ providerMsg.text }}</div>
      <div class="modal-actions">
        <button class="btn" type="button" @click="saveProvider()" :disabled="savingProvider">{{ savingProvider ? '保存中...' : '保存配置' }}</button>
        <button class="btn btn-sm muted-btn" type="button" @click="closeProviderDialog">取消</button>
      </div>
    </div>
  </div>

  <div class="token-dashboard">
    <section class="card token-card token-distribution-card">
      <div class="token-card-head">
        <div>
          <h2>模型分布</h2>
          <div class="token-subtitle">{{ rangeLabel }}</div>
        </div>
        <button class="btn btn-sm token-refresh" @click="loadUsage" :disabled="loadingUsage">{{ loadingUsage ? '加载中...' : '刷新' }}</button>
      </div>
      <div class="token-range-bar">
        <button v-for="preset in rangePresets" :key="preset.key" class="range-chip" :class="{ active: usageRange === preset.key }" @click="setUsageRange(preset.key)">{{ preset.label }}</button>
        <label class="date-jump">
          <span>日期</span>
          <input type="date" v-model="selectedUsageDate" :min="usageMinDate" :max="usageMaxDate" @change="setUsageRange('date')" />
        </label>
      </div>
      <div v-if="distributionRows.length" class="distribution-layout">
        <div class="donut-wrap" :style="{ '--donut-gradient': donutGradient }">
          <div class="donut-hole">
            <strong>{{ formatTokens(usageTotal) }}</strong>
            <span>Total</span>
          </div>
        </div>
        <div class="distribution-table-wrap">
          <table class="distribution-table">
            <thead>
              <tr>
                <th>模型</th>
                <th>请求</th>
                <th>Token</th>
                <th>占比</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="row in distributionRows" :key="row.key">
                <td>
                  <span class="model-name">
                    <span class="model-dot" :style="{ background: row.color }"></span>
                    {{ row.label }}
                  </span>
                </td>
                <td>{{ row.requests ? formatNumber(row.requests) : '—' }}</td>
                <td>{{ formatTokens(row.total) }}</td>
                <td>{{ formatPercent(row.ratio) }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
      <div v-else class="token-empty">暂无用量数据</div>
    </section>

    <section class="card token-card trend-card">
      <div class="token-card-head">
        <h2>Token 使用趋势</h2>
        <div class="token-subtitle">{{ rangeLabel }}</div>
      </div>
      <div v-if="filteredUsageDays.length" class="trend-legend">
        <span v-for="line in trendLines" :key="line.key" class="trend-legend-item">
          <span class="legend-ring" :style="{ borderColor: line.color, background: line.fill || 'transparent' }"></span>
          {{ line.label }}
        </span>
      </div>
      <div v-if="filteredUsageDays.length" class="trend-chart">
        <svg :viewBox="'0 0 ' + chart.width + ' ' + chart.height" role="img" aria-label="Token 使用趋势图">
          <g class="chart-grid">
            <line v-for="tick in yTicks" :key="'grid-' + tick.value" :x1="chart.left" :x2="chart.right" :y1="tick.y" :y2="tick.y" />
          </g>
          <g class="chart-axis">
            <text v-for="tick in yTicks" :key="'label-' + tick.value" :x="chart.left - 10" :y="tick.y + 4" text-anchor="end">{{ formatTokens(tick.value) }}</text>
            <text v-for="point in xLabels" :key="'x-' + point.label" :x="point.x" :y="chart.bottom + 24" text-anchor="middle">{{ point.label }}</text>
          </g>
          <path v-if="cacheReadAreaPath" :d="cacheReadAreaPath" class="area-path cache-read-area" />
          <path v-if="inputAreaPath" :d="inputAreaPath" class="area-path input-area" />
          <path v-for="line in trendLines" :key="'line-' + line.key" :d="line.path" fill="none" class="trend-line" :style="{ stroke: line.color }" />
          <g v-for="line in trendLines" :key="'points-' + line.key">
            <circle v-for="point in line.points" :key="line.key + '-' + point.x" :cx="point.x" :cy="point.y" r="4" class="trend-point" :style="{ stroke: line.color }">
              <title>{{ line.label }}: {{ formatTokens(point.value) }}</title>
            </circle>
          </g>
          <line v-if="hasCacheHitRate" :x1="chart.left" :x2="chart.right" :y1="chart.top" :y2="chart.top" class="cache-hit-line" />
          <text v-if="hasCacheHitRate" :x="chart.right + 8" :y="chart.top + 4" class="cache-hit-label">100%</text>
        </svg>
      </div>
      <div v-else class="token-empty">暂无用量数据</div>
    </section>
  </div>
</template>

<script lang="ts">
import { computed, inject, ref, onMounted } from 'vue'
import { fetchKeys, updateKey, fetchKeysUsage, fetchProviders, fetchFallbackChains, fetchCustomProviders, saveApiConfigTransaction } from '../api'
import type { CustomProvider, FallbackChains, MessageState, ProviderInfo, ProviderModel, ShowAdminDialog } from '../types'
import { asRecord, errorMessage, messageFromData } from '../types'

const providerColors: Record<string, string> = {
  opencode: '#f7c948',
  openai: '#f7c948',
  dashscope: '#38bdf8',
  deepseek: '#4f7cf3',
  glm: '#34d399',
  mimorium: '#f472b6',
  unknown: '#94a3b8',
}

const distributionPalette = [
  '#f472b6',
  '#38bdf8',
  '#34d399',
  '#f7c948',
  '#8b6cff',
  '#fb7185',
  '#22d3ee',
  '#a3e635',
  '#f97316',
  '#60a5fa',
  '#c084fc',
  '#2dd4bf',
  '#facc15',
  '#e879f9',
  '#4ade80',
  '#93c5fd',
]

const trendColors = {
  input: '#4f7cf3',
  output: '#45c781',
  cacheCreation: '#f5b45b',
  cacheRead: '#58bcd8',
  cacheHitRate: '#8b6cff',
}

const UNKNOWN_MODEL_DISTRIBUTION_KEY = '__unknown-models__'

type UsageRange = 'today' | '7d' | '30d' | 'date'

interface KeyItem {
  file: string
  label: string
  exists?: boolean
  prefix?: string
  source?: 'builtin' | 'custom'
  providerId?: string
  baseURL?: string
  models?: ProviderModel[]
}

type FallbackKey = 'chat' | 'vision' | 'lightweight'

interface FallbackCard {
  key: FallbackKey
  label: string
}

interface ProviderDraft {
  id: string
  name: string
  baseURL: string
  keyFile: string
  apiKey: string
  models: Array<ProviderModel & { name?: string }>
}

interface UsageStat {
  key: string
  label: string
  provider: string
  total: number
  requests: number
  input: number
  output: number
  cacheCreation: number
  cacheRead: number
  color?: string
  ratio?: number
}

interface UsageDay extends Record<string, unknown> {
  date: string
  total: number
  requests: number
  input: number
  output: number
  cacheCreation: number
  cacheRead: number
  models: Record<string, UsageStat>
}

interface ChartPoint {
  x: number
  y: number
  value: number
  label?: string
}

interface TrendLine {
  key: string
  label: string
  color: string
  fill?: string
  points: ChartPoint[]
  path: string
}

const EMPTY_USAGE_STAT: UsageStat = {
  key: '',
  label: '',
  provider: '',
  total: 0,
  requests: 0,
  input: 0,
  output: 0,
  cacheCreation: 0,
  cacheRead: 0,
}

const rangePresets: Array<{ key: UsageRange, label: string }> = [
  { key: 'today', label: '今天' },
  { key: '7d', label: '7天' },
  { key: '30d', label: '30天' },
  { key: 'date', label: '指定日' },
]

const FALLBACK_CARDS: FallbackCard[] = [
  { key: 'chat', label: '聊天优先级' },
  { key: 'vision', label: '视觉优先级' },
  { key: 'lightweight', label: '轻量任务优先级' },
]

function createProviderDraft(): ProviderDraft {
  return {
    id: 'openai-official',
    name: 'OpenAI 官方',
    baseURL: 'https://api.openai.com/v1',
    keyFile: 'ai-openai-official-key.txt',
    apiKey: '',
    models: [
      { id: 'gpt-4o', name: 'GPT-4o', vision: true },
      { id: 'gpt-4o-mini', name: 'GPT-4o mini', vision: true },
    ],
  }
}

function pickProviderModelForQueue(provider: CustomProvider, key: FallbackKey): string {
  const models = Array.isArray(provider.models) ? provider.models : []
  if (key === 'vision') return (models.find(model => model.vision) || models[0])?.id || ''
  if (key === 'lightweight') return (models.find(model => /(?:mini|flash|lite|turbo|small)/i.test(model.id || model.name || '')) || models[0])?.id || ''
  return models[0]?.id || ''
}

function appendProviderToFallbackTail(chains: FallbackChains, provider: CustomProvider): FallbackChains {
  const next: FallbackChains = { ...chains }
  for (const card of FALLBACK_CARDS) {
    const list = [...(next[card.key] || [])]
    if (list.some(step => step.provider === provider.id)) {
      next[card.key] = list
      continue
    }
    const model = pickProviderModelForQueue(provider, card.key)
    if (model) list.push({ provider: provider.id, model, keyFile: provider.keyFile || '' })
    next[card.key] = list
  }
  return next
}

function formatTokens(n: unknown) {
  const value = Number(n || 0)
  if (value >= 1000000000) return (value / 1000000000).toFixed(2) + 'B'
  if (value >= 1000000) return (value / 1000000).toFixed(value >= 10000000 ? 1 : 2) + 'M'
  if (value >= 1000) return (value / 1000).toFixed(value >= 10000 ? 1 : 2) + 'K'
  return String(Math.round(value))
}

function formatNumber(n: unknown) {
  return new Intl.NumberFormat('zh-CN').format(Number(n || 0))
}

function formatPercent(n: unknown) {
  return Math.round(Number(n || 0) * 100) + '%'
}

function normalizeProvider(raw: unknown): UsageStat {
  if (raw && typeof raw === 'object') {
    const data = asRecord(raw)
    const key = String(data.key || data.provider || data.name || '').trim()
    const label = String(data.label || data.name || key || 'unknown').trim()
    return {
      ...EMPTY_USAGE_STAT,
      key: key || label || 'unknown',
      label: label || key || 'unknown',
      provider: String(data.provider || key || '').trim(),
      total: toNumber(data.total),
      requests: toNumber(data.requests),
      input: toNumber(data.input),
      output: toNumber(data.output),
      cacheCreation: toNumber(data.cacheCreation),
      cacheRead: toNumber(data.cacheRead),
    }
  }
  const key = String(raw || '').trim()
  return { ...EMPTY_USAGE_STAT, key: key || 'unknown', label: key || 'unknown', provider: key || 'unknown' }
}

function toNumber(value: unknown) {
  const n = Number(value || 0)
  return Number.isFinite(n) && n > 0 ? n : 0
}

function buildSmoothPath(points: ChartPoint[]) {
  if (!points.length) return ''
  if (points.length === 1) return `M ${points[0].x} ${points[0].y}`
  const parts = [`M ${points[0].x} ${points[0].y}`]
  for (let i = 1; i < points.length; i++) {
    const prev = points[i - 1]
    const cur = points[i]
    const midX = (prev.x + cur.x) / 2
    parts.push(`C ${midX} ${prev.y}, ${midX} ${cur.y}, ${cur.x} ${cur.y}`)
  }
  return parts.join(' ')
}

function areaFromPoints(points: ChartPoint[], bottom: number) {
  if (!points.length) return ''
  return `${buildSmoothPath(points)} L ${points[points.length - 1].x} ${bottom} L ${points[0].x} ${bottom} Z`
}

function parseDateValue(date = '') {
  const value = String(date || '').trim()
  const ts = Date.parse(value + 'T00:00:00Z')
  return Number.isFinite(ts) ? ts : 0
}

function todayShanghai() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date())
  const pick = (type: string) => parts.find(item => item.type === type)?.value || ''
  return `${pick('year')}-${pick('month')}-${pick('day')}`
}

function filterUsageDays(days: UsageDay[] = [], range: UsageRange = '7d', selectedDate = ''): UsageDay[] {
  const sorted = (Array.isArray(days) ? days : [])
    .filter(day => day && day.date)
    .slice()
    .sort((a, b) => String(a.date).localeCompare(String(b.date)))
  if (!sorted.length) return []
  const latest = sorted[sorted.length - 1].date
  if (range === 'date') {
    const target = selectedDate || latest
    return sorted.filter(day => day.date === target)
  }
  if (range === 'today') {
    const today = todayShanghai()
    return sorted.filter(day => day.date === today)
  }
  const daysBack = range === '30d' ? 30 : 7
  const latestTs = parseDateValue(latest)
  if (!latestTs) return sorted.slice(-daysBack)
  const minTs = latestTs - (daysBack - 1) * 24 * 60 * 60 * 1000
  return sorted.filter(day => parseDateValue(day.date) >= minTs)
}

function normalizeDayModels(models: unknown = {}): Record<string, UsageStat> {
  const result: Record<string, UsageStat> = {}
  if (!models || typeof models !== 'object') return result
  for (const [key, stat] of Object.entries(models)) {
    if (!key || !stat || typeof stat !== 'object') continue
    const row = asRecord(stat)
    const provider = String(row.provider || String(key).split(':')[0] || '')
    const normalizedKey = normalizeModelKey(key, provider)
    if (!result[normalizedKey]) {
      result[normalizedKey] = {
        key: normalizedKey,
        label: getModelLabel(normalizedKey),
        provider,
        total: 0,
        requests: 0,
        input: 0,
        output: 0,
        cacheCreation: 0,
        cacheRead: 0,
      }
    }
    const target = result[normalizedKey]
    target.provider = provider || target.provider
    target.total += toNumber(row.total)
    target.requests += toNumber(row.requests)
    target.input += toNumber(row.input)
    target.output += toNumber(row.output)
    target.cacheCreation += toNumber(row.cacheCreation)
    target.cacheRead += toNumber(row.cacheRead)
  }
  return result
}

function normalizeModelKey(key = '', provider = '') {
  const value = String(key || '').trim()
  const prov = String(provider || '').trim() || value.split(':')[0] || 'unknown'
  if (!value || /:(legacy|unknown)$/i.test(value)) return `${prov}:unknown`
  return value
}

function isUnknownModelKey(key = '') {
  return /:(legacy|unknown)$/i.test(String(key || ''))
}

function addModelStat(map: Map<string, UsageStat>, raw: unknown = {}) {
  const data = asRecord(raw)
  const provider = String(data.provider || String(data.key || '').split(':')[0] || '')
  const key = normalizeModelKey(String(data.key || data.name || data.label || ''), provider)
  const current = map.get(key) || {
    key,
    label: getModelLabel(key),
    provider,
    total: 0,
    requests: 0,
    input: 0,
    output: 0,
    cacheCreation: 0,
    cacheRead: 0,
  }
  current.provider = provider || current.provider
  const label = String(data.label || data.name || '').trim()
  if (label && !/未分模型$/.test(current.label)) current.label = getModelLabel(key) === key ? label : getModelLabel(key)
  current.total += toNumber(data.total)
  current.requests += toNumber(data.requests)
  current.input += toNumber(data.input)
  current.output += toNumber(data.output)
  current.cacheCreation += toNumber(data.cacheCreation)
  current.cacheRead += toNumber(data.cacheRead)
  map.set(key, current)
}

function withDistributionColors(rows: UsageStat[] = []): UsageStat[] {
  return rows.map((row, index) => ({
    ...row,
    color: distributionPalette[index % distributionPalette.length],
  }))
}

function collapseUnknownModelRows(rows: UsageStat[] = []): UsageStat[] {
  const result: UsageStat[] = []
  let unknown: UsageStat | null = null
  for (const row of rows) {
    if (!isUnknownModelKey(row.key)) {
      result.push(row)
      continue
    }
    if (!unknown) {
      unknown = {
        key: UNKNOWN_MODEL_DISTRIBUTION_KEY,
        label: '未分模型（历史数据）',
        provider: 'unknown',
        total: 0,
        requests: 0,
        input: 0,
        output: 0,
        cacheCreation: 0,
        cacheRead: 0,
        color: providerColors.unknown,
      }
    }
    unknown.total += toNumber(row.total)
    unknown.requests += toNumber(row.requests)
    unknown.input += toNumber(row.input)
    unknown.output += toNumber(row.output)
    unknown.cacheCreation += toNumber(row.cacheCreation)
    unknown.cacheRead += toNumber(row.cacheRead)
  }
  if (unknown && unknown.total > 0) result.push(unknown)
  return result
}

function aggregateDayProviderModels(day: Pick<UsageDay, 'models'>): Record<string, UsageStat> {
  const byProvider: Record<string, UsageStat> = {}
  for (const stat of Object.values(day.models || {})) {
    const provider = String(stat.provider || '')
    if (!provider) continue
    if (!byProvider[provider]) {
      byProvider[provider] = {
        key: provider,
        label: provider,
        provider,
        total: 0,
        requests: 0,
        input: 0,
        output: 0,
        cacheCreation: 0,
        cacheRead: 0,
      }
    }
    byProvider[provider].total += toNumber(stat.total)
    byProvider[provider].requests += toNumber(stat.requests)
    byProvider[provider].input += toNumber(stat.input)
    byProvider[provider].output += toNumber(stat.output)
    byProvider[provider].cacheCreation += toNumber(stat.cacheCreation)
    byProvider[provider].cacheRead += toNumber(stat.cacheRead)
  }
  return byProvider
}

function subtractNonNegative(total: unknown, used: unknown) {
  return Math.max(0, toNumber(total) - toNumber(used))
}

function normalizeProviderDayModels(day: UsageDay, providers: UsageStat[]): Record<string, UsageStat> {
  const models = { ...(day.models || {}) }
  const byProvider = aggregateDayProviderModels({ models })
  for (const provider of providers) {
    const key = String(provider.key || '')
    if (!key) continue
    const providerTotal = toNumber(day[key])
    const used = byProvider[key] || {}
    const residual = providerTotal - toNumber(used.total)
    if (residual <= 0) continue
    const unknownKey = `${key}:unknown`
    const current = models[unknownKey] || {
      provider: key,
      total: 0,
      requests: 0,
      input: 0,
      output: 0,
      cacheCreation: 0,
      cacheRead: 0,
    }
    current.provider = key
    current.total = toNumber(current.total) + residual
    current.requests = toNumber(current.requests) + subtractNonNegative(provider.requests, used.requests)
    models[unknownKey] = current
  }
  return models
}

function getModelLabel(key = '') {
  const value = String(key || 'unknown')
  if (isUnknownModelKey(value)) return '未分模型（历史数据）'
  return value
}

function formatChartDate(date = '') {
  const value = String(date || '')
  const match = value.match(/^\d{4}-(\d{2})-(\d{2})$/)
  return match ? `${match[1]}-${match[2]}` : value
}

export default {
  name: 'KeyManager',
  setup() {
    const showAdminDialog = inject<ShowAdminDialog>('showAdminDialog')
    const keys = ref<KeyItem[]>([])
    const editing = ref<KeyItem | null>(null)
    const editValue = ref('')
    const saving = ref(false)
    const keyMsg = ref<MessageState | null>(null)
    const usageDays = ref<UsageDay[]>([])
    const usageProviders = ref<UsageStat[]>([])
    const usageModels = ref<UsageStat[]>([])
    const loadingUsage = ref(false)
    const usageRange = ref<UsageRange>('7d')
    const selectedUsageDate = ref('')
    const providers = ref<Record<string, ProviderInfo>>({})
    const customProviders = ref<CustomProvider[]>([])
    const fallbackChains = ref<FallbackChains>({})
    const providerDialogOpen = ref(false)
    const providerDraft = ref<ProviderDraft>(createProviderDraft())
    const providerMsg = ref<MessageState | null>(null)
    const savingProvider = ref(false)

    const usageMinDate = computed(() => usageDays.value[0]?.date || '')
    const usageMaxDate = computed(() => usageDays.value[usageDays.value.length - 1]?.date || '')
    const filteredUsageDays = computed(() => filterUsageDays(usageDays.value, usageRange.value, selectedUsageDate.value))
    const usageTotal = computed(() => filteredUsageDays.value.reduce((sum, day) => sum + dayTotal(day), 0))
    const chart = { width: 760, height: 250, left: 70, right: 700, top: 28, bottom: 205 }
    const usageMax = computed(() => Math.max(1, ...filteredUsageDays.value.map(day => Math.max(dayTotal(day), toNumber(day.input), toNumber(day.output), toNumber(day.cacheCreation), toNumber(day.cacheRead)))))
    const rangeLabel = computed(() => {
      if (!filteredUsageDays.value.length) return usageDays.value.length ? '当前范围无数据' : 'API 调用后自动记录'
      const first = filteredUsageDays.value[0].date
      const last = filteredUsageDays.value[filteredUsageDays.value.length - 1].date
      if (usageRange.value === 'today') return `今天 ${last}`
      if (usageRange.value === 'date') return `指定日 ${last}`
      return first === last ? last : `${first} 至 ${last}`
    })

    async function loadKeys() {
      const res = await fetchKeys()
      if (res.code === 'ADMIN_REQUIRED') { if (showAdminDialog) showAdminDialog('查看 Key 需要管理员密码', loadKeys); return }
      if (res.ok) keys.value = Array.isArray(res.data) ? res.data as KeyItem[] : []
    }
    async function loadProviderConfig() {
      const [providerRes, customRes, fallbackRes] = await Promise.all([
        fetchProviders(),
        fetchCustomProviders(),
        fetchFallbackChains(),
      ])
      if (providerRes.ok && providerRes.data) providers.value = providerRes.data
      if (customRes.code === 'ADMIN_REQUIRED') {
        if (showAdminDialog) showAdminDialog('查看自定义供应商需要管理员密码', loadProviderConfig)
      } else if (customRes.ok) {
        customProviders.value = Array.isArray(customRes.data) ? customRes.data : []
      }
      if (fallbackRes.code === 'ADMIN_REQUIRED') {
        if (showAdminDialog) showAdminDialog('查看 Fallback 链需要管理员密码', loadProviderConfig)
      } else if (fallbackRes.ok && fallbackRes.data) {
        fallbackChains.value = fallbackRes.data.chains || {}
      }
      for (const card of FALLBACK_CARDS) {
        if (!fallbackChains.value[card.key]) fallbackChains.value[card.key] = []
      }
    }

    onMounted(() => { loadKeys(); loadProviderConfig(); loadUsage() })

    function editKey(k: KeyItem) {
      editing.value = k
      editValue.value = ''
      keyMsg.value = null
    }

    async function saveKey() {
      if (!editValue.value.trim()) return
      saving.value = true
      keyMsg.value = null
      try {
        if (!editing.value) return
        const res = await updateKey(editing.value.file, editValue.value.trim())
        if (res.code === 'ADMIN_REQUIRED') { if (showAdminDialog) showAdminDialog('修改 Key 需要管理员密码', saveKey); saving.value = false; return }
        if (res.ok) {
          keyMsg.value = { type: 'ok', text: 'Key 已更新并热加载' }
          const reload = await fetchKeys()
          if (reload.ok) keys.value = Array.isArray(reload.data) ? reload.data as KeyItem[] : []
          editing.value = null
        } else {
          keyMsg.value = { type: 'err', text: messageFromData(res.data, '保存失败') }
        }
      } catch (e) { keyMsg.value = { type: 'err', text: errorMessage(e) } }
      saving.value = false
    }

    function openProviderDialog() {
      providerDraft.value = createProviderDraft()
      providerMsg.value = null
      providerDialogOpen.value = true
    }

    function closeProviderDialog() {
      providerDialogOpen.value = false
      providerMsg.value = null
    }

    function addProviderModel() {
      providerDraft.value.models.push({ id: '', name: '', vision: false })
    }

    function removeProviderModel(index: number) {
      if (providerDraft.value.models.length > 1) providerDraft.value.models.splice(index, 1)
    }

    function normalizeDraftProvider(): CustomProvider {
      const draft = providerDraft.value
      return {
        id: String(draft.id || '').trim(),
        name: String(draft.name || '').trim(),
        baseURL: String(draft.baseURL || '').trim(),
        keyFile: String(draft.keyFile || '').trim(),
        models: draft.models.map(model => ({
          id: String(model.id || '').trim(),
          name: String(model.name || '').trim() || undefined,
          vision: !!model.vision,
        })).filter(model => model.id),
      }
    }

    // Reloads and verifies all three public views before the provider dialog can close.
    async function reloadSavedApiConfig(provider: CustomProvider, expectedChains: FallbackChains, expectKey: boolean): Promise<boolean> {
      const [keysRes, customRes, fallbackRes, providersRes] = await Promise.all([
        fetchKeys(),
        fetchCustomProviders(),
        fetchFallbackChains(),
        fetchProviders(),
      ])
      if (!keysRes.ok || !customRes.ok || !fallbackRes.ok || !providersRes.ok) return false
      const reloadedProviders = Array.isArray(customRes.data) ? customRes.data : []
      const reloadedKeys = Array.isArray(keysRes.data) ? keysRes.data as KeyItem[] : []
      const savedProvider = reloadedProviders.find(item => item.id === provider.id)
      const keyReady = !expectKey || reloadedKeys.some(item => item.providerId === provider.id && item.file === provider.keyFile && item.exists)
      if (!savedProvider || JSON.stringify(savedProvider) !== JSON.stringify(provider) || !keyReady || JSON.stringify(fallbackRes.data?.chains || {}) !== JSON.stringify(expectedChains)) return false
      customProviders.value = reloadedProviders
      keys.value = reloadedKeys
      fallbackChains.value = fallbackRes.data?.chains || {}
      providers.value = providersRes.data || {}
      return true
    }

    // Commits the complete provider, Key, and fallback-chain transaction once.
    async function saveProvider(retried = false) {
      savingProvider.value = true
      providerMsg.value = null
      try {
        const provider = normalizeDraftProvider()
        if (!provider.id || !provider.name || !provider.baseURL || !provider.keyFile || !provider.models.length) {
          providerMsg.value = { type: 'err', text: '供应商、Base URL、Key 文件和模型不能为空' }
          savingProvider.value = false
          return
        }
        const isNewProvider = !customProviders.value.some(item => item.id === provider.id)
        const existing = customProviders.value.filter(item => item.id !== provider.id)
        const nextProviders = [...existing, provider]
        const nextChains = isNewProvider ? appendProviderToFallbackTail(fallbackChains.value, provider) : fallbackChains.value
        const keyValue = providerDraft.value.apiKey.trim() || undefined
        const transactionRes = await saveApiConfigTransaction(nextProviders, provider.id, keyValue, nextChains)
        if (transactionRes.code === 'ADMIN_REQUIRED') {
          if (!retried && showAdminDialog) showAdminDialog('完整保存 API 配置需要管理员密码', () => saveProvider(true))
          else providerMsg.value = { type: 'err', text: '管理员验证后完整保存仍被拒绝' }
          savingProvider.value = false
          return
        }
        if (!transactionRes.ok) {
          providerMsg.value = { type: 'err', text: messageFromData(transactionRes.data, 'API 配置未生效，旧配置已恢复') }
          savingProvider.value = false
          return
        }
        if (!await reloadSavedApiConfig(provider, nextChains, keyValue !== undefined)) {
          providerMsg.value = { type: 'err', text: 'API 配置已提交，但回读不一致，请保持页面并人工检查' }
          savingProvider.value = false
          return
        }
        providerMsg.value = { type: 'ok', text: 'API 配置已保存' }
        closeProviderDialog()
      } catch (e) {
        providerMsg.value = { type: 'err', text: errorMessage(e) }
      }
      savingProvider.value = false
    }

    async function loadUsage() {
      loadingUsage.value = true
      const res = await fetchKeysUsage()
      const data = asRecord(res.data)
      if (res.ok && res.data) {
        const providerMap = new Map<string, UsageStat>()
        for (const rawProvider of (Array.isArray(data.providers) ? data.providers : [])) {
          const provider = normalizeProvider(rawProvider)
          if (!provider.key || providerMap.has(provider.key)) continue
          providerMap.set(provider.key, {
            ...provider,
            total: toNumber(provider.total),
            requests: toNumber(provider.requests),
            input: toNumber(provider.input),
            output: toNumber(provider.output),
            cacheCreation: toNumber(provider.cacheCreation),
            cacheRead: toNumber(provider.cacheRead),
            color: providerColors[provider.key] || providerColors.unknown,
          })
        }
        usageDays.value = (Array.isArray(data.days) ? data.days : []).map(function(rawDay) {
          const day = asRecord(rawDay)
          const normalized: UsageDay = {
            date: String(day.date || ''),
            total: toNumber(day.total),
            requests: toNumber(day.requests),
            input: toNumber(day.input),
            output: toNumber(day.output),
            cacheCreation: toNumber(day.cacheCreation),
            cacheRead: toNumber(day.cacheRead),
            models: normalizeDayModels(day.models),
          }
          for (const [key, value] of Object.entries(day || {})) {
            if (['date', 'total', 'requests', 'input', 'output', 'cacheCreation', 'cacheRead', 'models'].includes(key)) continue
            normalized[key] = toNumber(value)
            if (!providerMap.has(key)) providerMap.set(key, { ...EMPTY_USAGE_STAT, key, label: key, provider: key, total: 0, requests: 0, color: providerColors[key] || providerColors.unknown })
          }
          normalized.models = normalizeProviderDayModels(normalized, Array.from(providerMap.values()))
          return normalized
        })
        if (!selectedUsageDate.value && usageDays.value.length) selectedUsageDate.value = usageDays.value.find(day => day.date === todayShanghai())?.date || usageDays.value[usageDays.value.length - 1].date
        usageProviders.value = Array.from(providerMap.values())
        const modelMap = new Map<string, UsageStat>()
        for (const model of (Array.isArray(data.models) ? data.models : [])) addModelStat(modelMap, model)
        usageModels.value = Array.from(modelMap.values()).filter(item => item.total > 0)
      }
      loadingUsage.value = false
    }

    function setUsageRange(key: UsageRange) {
      usageRange.value = key
      if (key === 'today') selectedUsageDate.value = todayShanghai()
      if (key === 'date' && !selectedUsageDate.value && usageMaxDate.value) selectedUsageDate.value = usageMaxDate.value
    }

    function dayTotal(day: UsageDay) {
      const explicit = toNumber(day.total)
      if (explicit > 0) return explicit
      let sum = 0
      for (const p of usageProviders.value) sum += toNumber(day[p.key])
      return sum
    }

    function yFor(value: unknown, max = usageMax.value) {
      return chart.bottom - (toNumber(value) / Math.max(max, 1)) * (chart.bottom - chart.top)
    }

    function buildPoints(key: string, max = usageMax.value): ChartPoint[] {
      const days = filteredUsageDays.value
      const count = days.length
      return days.map((day, index) => {
        const x = count <= 1 ? chart.left : chart.left + (index / (count - 1)) * (chart.right - chart.left)
        const value = key === 'total' ? dayTotal(day) : toNumber(day[key])
        return { x, y: yFor(value, max), value }
      })
    }

    const fallbackDistribution = computed(() => usageProviders.value.map(provider => ({
      ...provider,
      total: filteredUsageDays.value.reduce((sum, day) => sum + toNumber(day[provider.key]), 0),
    })).filter(item => item.total > 0))

    const filteredModelDistribution = computed(() => {
      const byModel = new Map<string, UsageStat>()
      for (const day of filteredUsageDays.value) {
        for (const [modelKey, stat] of Object.entries(day.models || {})) {
          const provider = String(stat.provider || '')
          const current = byModel.get(modelKey) || {
            key: modelKey,
            label: getModelLabel(modelKey),
            provider,
            total: 0,
            requests: 0,
            input: 0,
            output: 0,
            cacheCreation: 0,
            cacheRead: 0,
            color: providerColors[provider] || providerColors.unknown,
          }
          current.provider = provider || current.provider
          current.total += toNumber(stat.total)
          current.requests += toNumber(stat.requests)
          current.input += toNumber(stat.input)
          current.output += toNumber(stat.output)
          current.cacheCreation += toNumber(stat.cacheCreation)
          current.cacheRead += toNumber(stat.cacheRead)
          current.color = providerColors[current.provider] || current.color || providerColors.unknown
          byModel.set(modelKey, current)
        }
      }
      return Array.from(byModel.values()).filter(item => item.total > 0)
    })

    const distributionRows = computed(() => {
      const source = filteredModelDistribution.value.length ? collapseUnknownModelRows(filteredModelDistribution.value) : fallbackDistribution.value
      const total = source.reduce((sum, row) => sum + toNumber(row.total), 0) || 1
      const sorted = source.slice().sort((a, b) => b.total - a.total).map(row => ({
        ...row,
        ratio: toNumber(row.total) / total,
      }))
      return withDistributionColors(sorted)
    })

    const donutGradient = computed(() => {
      let cursor = 0
      const parts = distributionRows.value.map(row => {
        const start = cursor
        const end = cursor + (row.ratio || 0) * 100
        cursor = end
        return `${row.color} ${start}% ${end}%`
      })
      return parts.length ? `conic-gradient(${parts.join(', ')})` : 'conic-gradient(var(--accent) 0 100%)'
    })

    const yTicks = computed(() => {
      const max = usageMax.value
      return [1, 0.8, 0.6, 0.4, 0.2, 0].map(rate => {
        const value = max * rate
        return { value, y: yFor(value, max) }
      })
    })

    const xLabels = computed(() => {
      const days = filteredUsageDays.value
      const count = days.length
      const step = count > 14 ? 2 : 1
      return days.map((day, index) => ({
        label: formatChartDate(day.date),
        x: count <= 1 ? chart.left : chart.left + (index / (count - 1)) * (chart.right - chart.left),
      })).filter((_, index) => index === 0 || index === count - 1 || index % step === 0)
    })

    const hasDetailedTrend = computed(() => filteredUsageDays.value.some(day => day.input || day.output || day.cacheCreation || day.cacheRead))
    const hasCacheHitRate = computed(() => filteredUsageDays.value.some(day => day.cacheRead || day.input))
    const trendLines = computed<TrendLine[]>(() => {
      const keys = hasDetailedTrend.value
        ? [
            { key: 'input', label: 'Input', color: trendColors.input, fill: 'rgba(79, 124, 243, 0.12)' },
            { key: 'output', label: 'Output', color: trendColors.output },
            { key: 'cacheCreation', label: 'Cache Creation', color: trendColors.cacheCreation },
            { key: 'cacheRead', label: 'Cache Read', color: trendColors.cacheRead, fill: 'rgba(88, 188, 216, 0.12)' },
          ]
        : [{ key: 'total', label: 'Total Token', color: trendColors.input, fill: 'rgba(79, 124, 243, 0.12)' }]
      const lines = keys
        .map(line => ({ ...line, points: buildPoints(line.key), path: buildSmoothPath(buildPoints(line.key)) }))
        .filter(line => line.key === 'total' || line.points.some(point => point.value > 0))
      return lines
    })
    const inputAreaPath = computed(() => areaFromPoints(buildPoints(hasDetailedTrend.value ? 'input' : 'total'), chart.bottom))
    const cacheReadAreaPath = computed(() => hasDetailedTrend.value ? areaFromPoints(buildPoints('cacheRead'), chart.bottom) : '')

    return {
      keys, editing, editValue, saving, keyMsg, editKey, saveKey,
      providerDialogOpen, providerDraft, providerMsg, savingProvider, openProviderDialog, closeProviderDialog,
      addProviderModel, removeProviderModel, saveProvider,
      usageDays, filteredUsageDays, usageProviders, loadingUsage, loadUsage, usageTotal,
      usageRange, selectedUsageDate, usageMinDate, usageMaxDate, rangePresets, rangeLabel, setUsageRange,
      chart, yTicks, xLabels, trendLines, inputAreaPath, cacheReadAreaPath, hasCacheHitRate,
      distributionRows, donutGradient,
      formatTokens, formatNumber, formatPercent, dayTotal,
    }
  }
}
</script>

<style scoped>
.api-toolbar {
  display: flex;
  justify-content: flex-end;
  margin: -8px 0 12px;
}

.icon-btn {
  width: 34px;
  height: 34px;
  display: inline-grid;
  place-items: center;
  border: 1px solid color-mix(in srgb, var(--accent) 42%, var(--border));
  border-radius: 8px;
  background: color-mix(in srgb, var(--accent) 18%, var(--card2));
  color: var(--text);
  font: inherit;
  font-size: 18px;
  font-weight: 850;
  line-height: 1;
  cursor: pointer;
  transition: transform .16s ease, border-color .16s ease, background .16s ease, opacity .16s ease;
}

.icon-btn:hover:not(:disabled) {
  transform: translateY(-1px);
  border-color: var(--accent);
}

.icon-btn:disabled {
  cursor: not-allowed;
  opacity: .45;
}

.icon-btn.ghost {
  background: color-mix(in srgb, var(--card2) 80%, transparent);
  color: var(--text2);
}

.icon-btn.danger {
  border-color: color-mix(in srgb, var(--danger, #ef4444) 62%, var(--border));
  background: color-mix(in srgb, var(--danger, #ef4444) 14%, var(--card2));
  color: var(--danger, #ef4444);
}

.source-pill {
  display: inline-flex;
  align-items: center;
  min-height: 18px;
  margin-left: 6px;
  padding: 0 6px;
  border-radius: 6px;
  background: color-mix(in srgb, var(--accent) 16%, transparent);
  color: var(--accent);
  font-size: 11px;
  font-weight: 800;
}

.modal-backdrop {
  position: fixed;
  inset: 0;
  z-index: 2000;
  display: grid;
  place-items: center;
  padding: 20px;
  background: rgba(0,0,0,.48);
}

.modal-panel {
  width: min(720px, 100%);
  max-height: min(760px, calc(100vh - 40px));
  overflow: auto;
  border: 1px solid color-mix(in srgb, var(--border) 72%, transparent);
  border-radius: 8px;
  background: var(--card);
  padding: 20px;
  box-shadow: 0 24px 80px rgba(0,0,0,.32);
}

.modal-head,
.editor-title,
.priority-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.modal-head h2,
.priority-head h2 {
  margin: 0;
}

.provider-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
  margin-top: 16px;
}

.provider-grid label,
.model-row,
.check-label {
  min-width: 0;
}

.provider-grid label {
  display: grid;
  gap: 6px;
  color: var(--text2);
  font-size: 12px;
  font-weight: 760;
}

.provider-grid .wide {
  grid-column: 1 / -1;
}

.provider-grid input,
.model-row input,
.priority-fields input,
.priority-fields select {
  width: 100%;
  min-height: 36px;
  min-width: 0;
  border: 1px solid color-mix(in srgb, var(--border) 70%, transparent);
  border-radius: 8px;
  background: var(--input, var(--card2));
  color: var(--text);
  padding: 7px 10px;
  font: inherit;
}

.model-editor {
  margin-top: 16px;
}

.model-row {
  display: grid;
  grid-template-columns: minmax(120px, 1fr) minmax(110px, 1fr) auto auto;
  gap: 8px;
  align-items: center;
  margin-top: 8px;
}

.check-label {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: var(--text2);
  font-size: 13px;
}

.modal-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 16px;
}

.muted-btn {
  background: var(--border);
  color: var(--text2);
}

.priority-dashboard {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 16px;
  margin-bottom: 20px;
}

.priority-card {
  min-width: 0;
  padding: 18px;
}

.priority-subtitle {
  color: var(--text3);
  font-size: 12px;
  margin-top: 4px;
}

.priority-list {
  display: grid;
  gap: 8px;
  margin-top: 14px;
}

.priority-item {
  display: grid;
  grid-template-columns: 34px 30px minmax(0, 1fr) auto;
  gap: 8px;
  align-items: center;
  min-width: 0;
  border: 1px solid color-mix(in srgb, var(--border) 72%, transparent);
  border-radius: 8px;
  background: color-mix(in srgb, var(--card2) 86%, transparent);
  padding: 8px;
  transition: transform .18s ease, box-shadow .18s ease, opacity .18s ease, border-color .18s ease;
}

.priority-item.dragging {
  opacity: .72;
  transform: scale(.985);
  border-color: color-mix(in srgb, var(--accent) 64%, var(--border));
  box-shadow: 0 14px 32px rgba(0,0,0,.18);
}

.drag-handle {
  width: 34px;
  height: 34px;
  border: 1px solid color-mix(in srgb, var(--border) 70%, transparent);
  border-radius: 8px;
  background: var(--card);
  color: var(--text2);
  cursor: grab;
}

.drag-handle:active {
  cursor: grabbing;
}

.priority-rank {
  display: grid;
  place-items: center;
  width: 30px;
  height: 30px;
  border-radius: 50%;
  background: color-mix(in srgb, var(--accent) 18%, transparent);
  color: var(--accent);
  font-size: 13px;
  font-weight: 850;
}

.priority-fields {
  display: grid;
  grid-template-columns: minmax(90px, 1fr) minmax(110px, 1fr);
  gap: 8px;
  min-width: 0;
}

.priority-fields input {
  grid-column: 1 / -1;
}

.priority-actions {
  display: flex;
  gap: 4px;
}

.add-step {
  margin-top: 10px;
}

.priority-move,
.priority-enter-active,
.priority-leave-active {
  transition: all .2s ease;
}

.priority-enter-from,
.priority-leave-to {
  opacity: 0;
  transform: translateY(8px);
}

.priority-leave-active {
  position: absolute;
}

.token-dashboard {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  gap: 20px;
  margin-bottom: 20px;
}

.token-card {
  min-height: 360px;
  margin-bottom: 0;
  padding: 24px;
}

.token-card-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 14px;
  margin-bottom: 14px;
}

.token-card-head h2 {
  margin: 0;
  color: var(--text);
  font-size: 18px;
  font-weight: 850;
}

.token-subtitle {
  color: var(--text3);
  font-size: 12px;
  font-weight: 700;
}

.token-refresh {
  min-width: 64px;
  border-radius: 8px;
}

.token-range-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  margin-bottom: 20px;
}

.range-chip {
  border: 1px solid color-mix(in srgb, var(--border) 70%, transparent);
  background: color-mix(in srgb, var(--card2) 82%, transparent);
  color: var(--text2);
  border-radius: 8px;
  min-height: 32px;
  padding: 0 12px;
  font-size: 13px;
  font-weight: 780;
  cursor: pointer;
}

.range-chip.active {
  color: var(--text);
  border-color: color-mix(in srgb, var(--accent) 68%, white 12%);
  background: color-mix(in srgb, var(--accent) 22%, var(--card2));
  box-shadow: 0 8px 18px color-mix(in srgb, var(--accent) 18%, transparent);
}

.date-jump {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: var(--text3);
  font-size: 12px;
  font-weight: 760;
}

.date-jump input {
  min-height: 32px;
  width: 138px;
  border-radius: 8px;
  border: 1px solid color-mix(in srgb, var(--border) 70%, transparent);
  background: color-mix(in srgb, var(--card2) 86%, transparent);
  color: var(--text);
  padding: 0 8px;
  font: inherit;
}

.distribution-layout {
  display: grid;
  grid-template-columns: 180px minmax(0, 1fr);
  gap: 16px;
  align-items: center;
}

.donut-wrap {
  width: min(180px, 100%);
  aspect-ratio: 1;
  border-radius: 50%;
  background: var(--donut-gradient);
  display: grid;
  place-items: center;
  box-shadow: 0 18px 46px rgba(79, 124, 243, 0.22);
  justify-self: center;
}

.donut-hole {
  width: 44%;
  aspect-ratio: 1;
  border-radius: 50%;
  background: color-mix(in srgb, var(--card) 92%, white 8%);
  border: 1px solid color-mix(in srgb, var(--border) 70%, transparent);
  display: grid;
  place-items: center;
  align-content: center;
  gap: 2px;
  color: var(--text);
  box-shadow: inset 0 1px 0 rgba(255,255,255,0.18);
}

.donut-hole strong {
  font-size: clamp(14px, 1.6vw, 20px);
  line-height: 1;
}

.donut-hole span {
  color: var(--text3);
  font-size: 11px;
  font-weight: 800;
}

.distribution-table-wrap {
  min-width: 0;
  max-height: 260px;
  overflow: auto;
  padding-right: 2px;
}

.distribution-table {
  width: 100%;
  border-collapse: collapse;
  color: var(--text2);
  font-size: 13px;
}

.distribution-table th,
.distribution-table td {
  padding: 10px 7px;
  border-bottom: 1px solid color-mix(in srgb, var(--border) 42%, transparent);
  text-align: right;
  white-space: nowrap;
}

.distribution-table th:first-child,
.distribution-table td:first-child {
  text-align: left;
}

.distribution-table th {
  color: var(--text3);
  font-weight: 850;
}

.model-name {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  color: var(--text);
  font-weight: 760;
  max-width: 142px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.model-dot {
  width: 9px;
  height: 9px;
  border-radius: 50%;
  flex: 0 0 9px;
}

.trend-legend {
  display: flex;
  justify-content: flex-end;
  gap: 16px;
  flex-wrap: wrap;
  margin: -10px 0 6px;
}

.trend-legend-item {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: var(--text2);
  font-size: 13px;
  font-weight: 760;
}

.legend-ring {
  width: 16px;
  height: 16px;
  border: 2px solid var(--accent);
  border-radius: 50%;
}

.trend-chart {
  width: 100%;
  overflow: hidden;
}

.trend-chart svg {
  display: block;
  width: 100%;
  min-height: 250px;
}

.chart-grid line {
  stroke: color-mix(in srgb, var(--border) 58%, transparent);
  stroke-width: 1;
}

.chart-axis text {
  fill: var(--text3);
  font-size: 13px;
  font-weight: 720;
}

.area-path {
  pointer-events: none;
}

.input-area {
  fill: rgba(79, 124, 243, 0.14);
}

.cache-read-area {
  fill: rgba(88, 188, 216, 0.14);
}

.trend-line {
  stroke-width: 4;
  stroke-linecap: round;
  stroke-linejoin: round;
  filter: drop-shadow(0 8px 12px rgba(0,0,0,0.10));
}

.trend-point {
  fill: color-mix(in srgb, var(--card) 92%, white 8%);
  stroke-width: 3;
}

.cache-hit-line {
  stroke: #8b6cff;
  stroke-width: 2;
  stroke-dasharray: 6 8;
}

.cache-hit-label {
  fill: #8b6cff;
  font-size: 12px;
  font-weight: 800;
}

.token-empty {
  min-height: 250px;
  display: grid;
  place-items: center;
  color: var(--text3);
  font-size: 14px;
}

@media (max-width: 1180px) {
  .token-dashboard {
    grid-template-columns: 1fr;
  }
}

@media (max-width: 760px) {
  .token-card {
    padding: 18px;
    min-height: 0;
  }

  .token-card-head {
    flex-direction: column;
  }

  .distribution-layout {
    grid-template-columns: 1fr;
  }

  .donut-wrap {
    max-width: 220px;
  }

  .model-name {
    max-width: 180px;
  }

  .trend-legend {
    justify-content: flex-start;
  }

  .distribution-table {
    font-size: 13px;
  }
}
</style>
