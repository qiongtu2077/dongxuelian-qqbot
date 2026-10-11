<template>
  <div ref="pickerRoot" class="range-picker" @keydown.esc="open = false">
    <button class="range-trigger" type="button" :title="label" :aria-expanded="open" aria-controls="usage-date-popover" @click="openPicker">
      <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><rect x="3" y="5" width="18" height="16" rx="3"/><path d="M7 3v5m10-5v5M3 11h18"/></svg>
      <span class="range-label">{{ label }}</span> <span aria-hidden="true">⌄</span>
    </button>
    <Teleport to="body">
      <div v-if="open" id="usage-date-popover" ref="popoverRoot" class="range-popover" :style="popoverPosition" role="dialog" aria-label="用量日期区间" @keydown.esc="open = false">
        <div class="presets">
          <button v-for="item in presets" :key="item.id" type="button" :class="{ selected: preset === item.id }" @click="choosePreset(item.id)">{{ item.label }}</button>
        </div>
        <p class="timezone">北京时间 · 按整天统计，包含起止当天</p>
        <div class="range-editor">
          <div class="date-fields">
            <label :class="['date-field', { active: activeField === 'startDate' }]">
              <span>开始日期</span>
              <input v-model="draft.startDate" type="date" min="0001-01-01" max="9999-12-31" aria-label="用量开始日期" @focus="focusField('startDate')" @input="focusField('startDate'); error = ''" />
            </label>
            <label :class="['date-field', { active: activeField === 'endDate' }]">
              <span>结束日期</span>
              <input v-model="draft.endDate" type="date" min="0001-01-01" max="9999-12-31" aria-label="用量结束日期" @focus="focusField('endDate')" @input="focusField('endDate'); error = ''" />
            </label>
            <p v-if="error" class="range-error" role="alert">{{ error }}</p>
            <div class="actions"><button type="button" @click="open = false">取消</button><button class="apply" type="button" @click="applyRange">确定</button></div>
          </div>
          <div class="calendar">
            <div class="calendar-head"><button type="button" aria-label="上个月" :disabled="month === '0001-01'" @click="month = shiftUsageMonth(month, -1)">‹</button><strong>{{ Number(month.slice(0, 4)) }}年{{ Number(month.slice(5)) }}月</strong><button type="button" aria-label="下个月" :disabled="month === '9999-12'" @click="month = shiftUsageMonth(month, 1)">›</button></div>
            <div class="calendar-grid">
              <span v-for="day in ['日', '一', '二', '三', '四', '五', '六']" :key="day" class="weekday">{{ day }}</span>
              <button v-for="date in calendar" :key="date" type="button" :aria-label="`选择 ${date}`" :aria-pressed="date === draft.startDate || date === draft.endDate" :class="{ outside: date.slice(0, 7) !== month, inside: date > draft.startDate && date < draft.endDate, endpoint: date === draft.startDate || date === draft.endDate }" @click="pickDate(date)">{{ Number(date.slice(8)) }}</button>
            </div>
          </div>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onDeactivated, onMounted, reactive, ref } from 'vue'
import type { UsageDateRange } from '../services/ai-model-api-model'
import { resolveUsagePreset, shiftUsageMonth, todayUsageDate, usageCalendarDays, validateUsageRange } from '../services/usage-range-model'
import type { UsagePreset } from '../services/usage-range-model'

const props = defineProps<{ preset: UsagePreset; range: UsageDateRange }>()
const emit = defineEmits<{ apply: [preset: UsagePreset, range: UsageDateRange] }>()
const presets: Array<{ id: UsagePreset; label: string }> = [
  { id: 'today', label: '当天' }, { id: 'yesterday', label: '昨天' }, { id: '7d', label: '近 7 天' },
  { id: '14d', label: '近 14 天' }, { id: '30d', label: '近 30 天' }, { id: 'all', label: '全部' },
]
const open = ref(false)
const pickerRoot = ref<HTMLElement | null>(null)
const popoverRoot = ref<HTMLElement | null>(null)
const popoverPosition = reactive({ left: '16px', top: '16px' })
const draft = reactive({ ...props.range })
const activeField = ref<'startDate' | 'endDate'>('startDate')
const month = ref(todayUsageDate().slice(0, 7))
const error = ref('')
const calendar = computed(() => usageCalendarDays(month.value))
const label = computed(() => props.preset === 'custom' ? `${props.range.startDate.replaceAll('-', '/')} — ${props.range.endDate.replaceAll('-', '/')}` : presets.find(item => item.id === props.preset)?.label || '选择日期')

// 打开时复制已应用的区间，取消或关闭不会改变实际查询。
function openPicker(): void {
  if (open.value) { open.value = false; return }
  Object.assign(draft, props.range)
  activeField.value = 'startDate'
  month.value = props.range.startDate.slice(0, 7)
  error.value = ''
  open.value = true
  void nextTick(positionPopover)
}

// 根据视口和触发按钮定位浮层，避免窄屏溢出和卡片的裁切、透明背景干扰。
function positionPopover(): void {
  if (!open.value || !pickerRoot.value || !popoverRoot.value) return
  const rect = pickerRoot.value.getBoundingClientRect()
  const width = Math.min(580, window.innerWidth - 32)
  const left = Math.max(16, Math.min(rect.right - width, window.innerWidth - width - 16))
  const top = Math.max(16, Math.min(rect.bottom + 8, window.innerHeight - popoverRoot.value.offsetHeight - 16))
  Object.assign(popoverPosition, { left: left + 'px', top: top + 'px' })
}

// 快捷区间立即应用，起止日期始终使用北京时间。
function choosePreset(preset: UsagePreset): void {
  emit('apply', preset, resolveUsagePreset(preset, props.range) || props.range)
  open.value = false
}

// 将日历定位到当前正在编辑的日期字段。
function focusField(field: 'startDate' | 'endDate'): void {
  activeField.value = field
  const date = draft[field]
  if (date && !validateUsageRange({ startDate: date, endDate: date })) month.value = date.slice(0, 7)
}

// 先选开始日再选结束日，向前选择结束日时重新开始区间。
function pickDate(date: string): void {
  error.value = ''
  if (activeField.value === 'startDate' || date < draft.startDate) {
    draft.startDate = date
    if (date > draft.endDate) draft.endDate = date
    activeField.value = 'endDate'
  } else draft.endDate = date
  month.value = date.slice(0, 7)
}

// 验证自定义闭区间后再通知父组件请求数据。
function applyRange(): void {
  error.value = validateUsageRange(draft)
  if (error.value) return
  emit('apply', 'custom', { ...draft })
  open.value = false
}

// 点击选择器以外的位置时关闭草稿，组件卸载时移除全局监听。
function closeOutside(event: PointerEvent): void {
  if (open.value && !pickerRoot.value?.contains(event.target as Node) && !popoverRoot.value?.contains(event.target as Node)) open.value = false
}

onMounted(() => {
  document.addEventListener('pointerdown', closeOutside)
  window.addEventListener('resize', positionPopover)
  window.addEventListener('scroll', positionPopover, true)
})
onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', closeOutside)
  window.removeEventListener('resize', positionPopover)
  window.removeEventListener('scroll', positionPopover, true)
})
onDeactivated(() => { open.value = false })
</script>

<style scoped>
.range-picker { position: relative; min-width: 0; }
button, input { font: inherit; }
button { cursor: pointer; color: var(--text2); background: var(--card); border: 1px solid var(--border); border-radius: 7px; min-height: 34px; padding: 0 12px; }
button:focus-visible, input:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.range-trigger { display: flex; align-items: center; justify-content: center; gap: 8px; min-height: 38px; width: 100%; color: var(--text); border-color: color-mix(in srgb, var(--accent) 50%, var(--border)); white-space: nowrap; }
.range-label { overflow: hidden; text-overflow: ellipsis; min-width: 0; }
.range-trigger svg { flex-shrink: 0; }
.range-popover { position: fixed; z-index: 2000; width: min(580px, calc(100vw - 32px)); max-height: calc(100vh - 32px); overflow-y: auto; padding: 16px; border: 1px solid var(--border); border-radius: 12px; background: color-mix(in srgb, var(--bg) 95%, var(--text) 5%); box-shadow: 0 14px 50px #0007; }
.presets { display: flex; flex-wrap: wrap; gap: 6px; }
.presets button { min-height: 30px; padding: 0 9px; font-size: 12px; }
.presets .selected, .apply { color: var(--text); background: var(--accentDim); border-color: var(--accent); }
.timezone { color: var(--text3); font-size: 12px; margin: 12px 0; }
.range-editor { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1.2fr); gap: 14px; }
.date-fields { display: grid; align-content: start; gap: 10px; }
.date-field { min-width: 0; display: grid; gap: 8px; padding: 12px; border: 1px solid var(--border); border-radius: 8px; }
.date-field.active { border-color: var(--accent); background: var(--accentDim); }
.date-field span { font-size: 12px; color: var(--text3); }
.date-field input { min-width: 0; max-width: 100%; width: 100%; color: var(--text); color-scheme: dark; background: transparent; border: 0; }
:global([data-theme="light"] .range-popover input[type="date"]),
:global([data-theme="forest-green"] .range-popover input[type="date"]),
:global([data-theme="monet-purple"] .range-popover input[type="date"]),
:global([data-theme="sakura-pink"] .range-popover input[type="date"]),
:global([data-theme="ocean-cyan"] .range-popover input[type="date"]) { color-scheme: light; }
.actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 2px; }
.actions button { flex: 1; }
.range-error { color: var(--danger); font-size: 12px; }
.calendar-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; }
.calendar-head strong { color: var(--text); font-size: 13px; }
.calendar-head button { min-height: 30px; border: 0; font-size: 20px; }
.calendar-grid { display: grid; grid-template-columns: repeat(7, minmax(0, 1fr)); gap: 3px; }
.calendar-grid button { min-height: 30px; border: 0; padding: 0; font-size: 12px; }
.weekday { text-align: center; color: var(--text3); font-size: 12px; padding: 5px 0; }
.calendar-grid .outside { color: var(--text3); opacity: .45; }
.calendar-grid .inside { color: var(--text2); background: var(--accentDim); }
.calendar-grid .endpoint { color: var(--btnText, #111); background: var(--accent); font-weight: 800; opacity: 1; }
@media (max-width: 540px) {
  .range-editor { grid-template-columns: 1fr; }
  .date-fields { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .actions, .range-error { grid-column: 1 / -1; }
  .range-popover { padding: 12px; }
  .date-field { padding: 8px; }
}
</style>
