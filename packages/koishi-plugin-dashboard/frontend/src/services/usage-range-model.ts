import type { CapabilityUsageDay, UsageDateRange } from './ai-model-api-model'

export type UsagePreset = 'today' | 'yesterday' | '7d' | '14d' | '30d' | 'all' | 'custom'
const DAY_MS = 86400000

// --- 北京时间日期与日历 ---

// 用与统计记录一致的北京时间计算今天，浏览器时区不影响查询边界。
export function todayUsageDate(now = Date.now()): string {
  return new Date(now + 8 * 60 * 60 * 1000).toISOString().slice(0, 10)
}

// 按公历日移动日期，跨月、跨年和闰年均由 UTC 日期运算处理。
export function shiftUsageDate(date: string, days: number): string {
  return new Date(Date.parse(date + 'T00:00:00Z') + days * DAY_MS).toISOString().slice(0, 10)
}

// 校验输入日期及闭区间顺序，不把无效的日期自动进位到下个月。
export function validateUsageRange(range: UsageDateRange): string {
  for (const date of [range.startDate, range.endDate]) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date.startsWith('0000')) return '请选择有效的起止日期'
    const value = new Date(date + 'T00:00:00Z')
    if (!Number.isFinite(value.getTime()) || value.toISOString().slice(0, 10) !== date) return '请选择有效的起止日期'
  }
  return range.startDate > range.endDate ? '开始日期不能晚于结束日期' : ''
}

// 将快捷日期转换成包含起止当天的查询区间；全部数据由服务端返回实际范围。
export function resolveUsagePreset(preset: UsagePreset, custom: UsageDateRange, now = Date.now()): UsageDateRange | undefined {
  if (preset === 'all') return undefined
  if (preset === 'custom') return { ...custom }
  const today = todayUsageDate(now)
  if (preset === 'yesterday') return { startDate: shiftUsageDate(today, -1), endDate: shiftUsageDate(today, -1) }
  const count = preset === 'today' ? 1 : Number(preset.slice(0, -1))
  return { startDate: shiftUsageDate(today, 1 - count), endDate: today }
}

// 生成以周日开始的六周日历网格，支持点击相邻月份的日期。
export function usageCalendarDays(month: string): string[] {
  const first = month + '-01'
  const start = shiftUsageDate(first, -new Date(first + 'T00:00:00Z').getUTCDay())
  return Array.from({ length: 42 }, (_, index) => shiftUsageDate(start, index))
}

// 切换日历月份，不依赖浏览器本地时区。
export function shiftUsageMonth(month: string, offset: number): string {
  const date = new Date(month + '-01T00:00:00Z')
  date.setUTCMonth(date.getUTCMonth() + offset)
  return date.toISOString().slice(0, 7)
}

// --- 图表数据 ---

// 将稀疏每日记录补零并按区间长度分桶，任意跨度最多生成 366 个绘图点。
export function buildUsageTrend(days: CapabilityUsageDay[], range: UsageDateRange) {
  const start = Date.parse(range.startDate + 'T00:00:00Z')
  const end = Date.parse(range.endDate + 'T00:00:00Z')
  const count = Math.floor((end - start) / DAY_MS) + 1
  const bucketDays = Math.max(1, Math.ceil(count / 366))
  const points = Array.from({ length: Math.ceil(count / bucketDays) }, (_, index) => ({
    date: shiftUsageDate(range.startDate, index * bucketDays),
    total: 0, requests: 0, input: 0, output: 0, cacheCreation: 0, cacheRead: 0,
  }))
  for (const day of days) {
    const index = Math.floor((Date.parse(day.date + 'T00:00:00Z') - start) / (DAY_MS * bucketDays))
    const point = points[index]
    if (!point || day.date < range.startDate || day.date > range.endDate) continue
    for (const field of ['total', 'requests', 'input', 'output', 'cacheCreation', 'cacheRead'] as const) point[field] += day[field]
  }
  return { bucketDays, points }
}
