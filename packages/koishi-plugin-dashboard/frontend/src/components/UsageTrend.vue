<template>
  <div class="usage-trend">
    <div class="trend-head"><h4>使用趋势</h4><span>{{ range.startDate }} — {{ range.endDate }} · {{ trend.bucketDays === 1 ? '按天统计' : `每 ${trend.bucketDays} 天汇总` }}</span></div>
    <div class="trend-legend">
      <button v-for="item in series" :key="item.key" type="button" :aria-pressed="!hidden.has(item.key)" :class="{ muted: hidden.has(item.key) }" @click="toggleSeries(item.key)"><i :style="{ background: item.color }" />{{ item.label }}</button>
    </div>
    <svg class="trend-svg" viewBox="0 0 900 238" role="img" aria-label="所选日期区间的每日 Token 用量趋势，可在下方查看每日明细" @pointermove="inspectPoint" @pointerleave="activeIndex = null">
      <g v-for="tick in [0, 1, 2, 3, 4]" :key="tick">
        <line x1="62" x2="880" :y1="20 + tick * 44" :y2="20 + tick * 44" class="grid-line" />
        <text x="52" :y="24 + tick * 44" text-anchor="end" class="axis-label">{{ compactNumber(maximum * (4 - tick) / 4) }}</text>
      </g>
      <g v-for="item in visibleSeries" :key="item.key">
        <polyline :points="linePoints(item.key)" fill="none" :stroke="item.color" :stroke-width="item.key === 'total' ? 2.5 : 1.7" stroke-linejoin="round" stroke-linecap="round" />
        <circle v-if="trend.points.length === 1" cx="471" :cy="pointY(trend.points[0][item.key])" r="3" :fill="item.color" />
      </g>
      <line v-if="activeIndex !== null" :x1="pointX(activeIndex)" :x2="pointX(activeIndex)" y1="20" y2="196" class="active-line" />
      <text v-for="index in axisIndices" :key="index" :x="pointX(index)" y="223" text-anchor="middle" class="axis-label">{{ trend.points[index].date.slice(5).replace('-', '/') }}</text>
    </svg>
    <div class="trend-detail" aria-live="polite">
      <strong>{{ inspected.date }}{{ trend.bucketDays > 1 ? ` 起 ${trend.bucketDays} 天` : '' }}</strong>
      <span>{{ inspected.requests.toLocaleString('zh-CN') }} 次请求</span>
      <span v-for="item in visibleSeries" :key="item.key"><i :style="{ background: item.color }" />{{ item.label }} {{ inspected[item.key].toLocaleString('zh-CN') }}</span>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import type { CapabilityUsageDay, UsageDateRange } from '../services/ai-model-api-model'
import { buildUsageTrend } from '../services/usage-range-model'

type SeriesKey = 'total' | 'input' | 'output' | 'cacheCreation' | 'cacheRead'
const props = defineProps<{ days: CapabilityUsageDay[]; range: UsageDateRange }>()
const series: Array<{ key: SeriesKey; label: string; color: string }> = [
  { key: 'total', label: 'Token 总量', color: 'color-mix(in srgb, var(--accent) 55%, var(--text))' },
  { key: 'input', label: '输入', color: '#579dff' }, { key: 'output', label: '输出', color: '#28c69a' },
  { key: 'cacheCreation', label: '缓存创建', color: '#f29a49' }, { key: 'cacheRead', label: '缓存命中', color: '#b28aff' },
]
const hidden = ref(new Set<SeriesKey>())
const activeIndex = ref<number | null>(null)
const trend = computed(() => buildUsageTrend(props.days, props.range))
const visibleSeries = computed(() => series.filter(item => !hidden.value.has(item.key)))
const maximum = computed(() => Math.max(1, ...trend.value.points.map(point => Math.max(0, ...visibleSeries.value.map(item => point[item.key])))))
const axisIndices = computed(() => {
  const count = Math.min(6, trend.value.points.length)
  return [...new Set(Array.from({ length: count }, (_, index) => Math.round(index * (trend.value.points.length - 1) / Math.max(1, count - 1))))]
})
const inspected = computed(() => trend.value.points[Math.min(activeIndex.value ?? trend.value.points.length - 1, trend.value.points.length - 1)])

// 切换图例系列，单一坐标轴始终使用当前可见的 Token 字段。
function toggleSeries(key: SeriesKey): void {
  const next = new Set(hidden.value)
  if (next.has(key)) next.delete(key)
  else next.add(key)
  hidden.value = next
}

// 把日期桶序号映射到绘图区横坐标。
function pointX(index: number): number {
  return trend.value.points.length === 1 ? 471 : 62 + index / (trend.value.points.length - 1) * 818
}

// 把 Token 数量映射到共用的线性纵轴。
function pointY(value: number): number {
  return 196 - value / maximum.value * 176
}

// 按真实日期桶顺序绘制折线，无记录的日期显示为零。
function linePoints(key: SeriesKey): string {
  return trend.value.points.map((point, index) => `${pointX(index)},${pointY(point[key])}`).join(' ')
}

// 将鼠标位置对齐到最近的日期桶，展示全部可见系列的精确数值。
function inspectPoint(event: PointerEvent): void {
  const rect = (event.currentTarget as SVGSVGElement).getBoundingClientRect()
  const x = (event.clientX - rect.left) / rect.width * 900
  activeIndex.value = Math.max(0, Math.min(trend.value.points.length - 1, Math.round((x - 62) / 818 * (trend.value.points.length - 1))))
}

// 将坐标轴数字压缩为中文万、亿单位。
function compactNumber(value: number): string {
  return new Intl.NumberFormat('zh-CN', { notation: 'compact', maximumFractionDigits: 1 }).format(value)
}
</script>

<style scoped>
.usage-trend { padding: 18px; margin-top: 20px; border: 1px solid var(--border); border-radius: 10px; background: var(--hoverLight); min-width: 0; }
.trend-head { display: flex; justify-content: space-between; align-items: center; gap: 10px; flex-wrap: wrap; }
h4 { color: var(--text); margin: 0; }
.trend-head > span { color: var(--text3); font-size: 12px; }
.trend-legend { display: flex; flex-wrap: wrap; gap: 12px; margin: 16px 0 8px; }
.trend-legend button { display: inline-flex; gap: 6px; align-items: center; padding: 3px 0; border: 0; background: transparent; color: var(--text2); cursor: pointer; font: inherit; font-size: 12px; }
.trend-legend .muted { opacity: .4; text-decoration: line-through; }
i { display: inline-block; width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
.trend-svg { display: block; width: 100%; overflow: visible; margin-top: 10px; }
.grid-line { stroke: var(--border); stroke-dasharray: 3 5; }
.axis-label { fill: var(--text3); font-size: 11px; font-family: inherit; }
.active-line { stroke: var(--text3); stroke-dasharray: 3 4; }
.trend-detail { display: flex; flex-wrap: wrap; align-items: center; gap: 7px 14px; min-height: 36px; padding-top: 8px; font-size: 12px; color: var(--text2); }
.trend-detail strong { color: var(--text); }
.trend-detail span { display: inline-flex; align-items: center; gap: 5px; }
@media (max-width: 540px) { .usage-trend { padding: 12px; } .trend-svg { min-height: 180px; } }
</style>
