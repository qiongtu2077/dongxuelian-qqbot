/** 日报专用四点业务日契约；不改变聊天系统其他功能的自然日。 */
export interface ReportPeriod {
  reportPolicyVersion: 2
  reportDate: string
  periodStartMs: number
  periodEndMs: number
  cutoffMs: number
}

const DAY_MS = 24 * 60 * 60 * 1000
const CST_OFFSET_MS = 8 * 60 * 60 * 1000
const SWITCH_OFFSET_MS = 4 * 60 * 60 * 1000

// 根据任务发起时刻固定北京时间四点报告窗口。
export function createReportPeriod(submittedAtMs: number): ReportPeriod {
  if (!Number.isSafeInteger(submittedAtMs) || submittedAtMs <= 0) throw new Error('日报发起时间无效')
  const reportDate = new Date(submittedAtMs + CST_OFFSET_MS - SWITCH_OFFSET_MS).toISOString().slice(0, 10)
  const periodStartMs = Date.parse(`${reportDate}T04:00:00.000+08:00`)
  return { reportPolicyVersion: 2, reportDate, periodStartMs, periodEndMs: periodStartMs + DAY_MS, cutoffMs: submittedAtMs }
}

// 校验新任务的完整窗口；旧任务只按已保存的创建时间补齐，绝不使用执行时刻。
export function resolveReportPeriod(payload: Record<string, unknown>, createdAt: string): ReportPeriod & { periodBackfilled: boolean } {
  if (payload.reportPolicyVersion === undefined) {
    const period = createReportPeriod(Date.parse(createdAt))
    return { ...period, periodBackfilled: true }
  }
  if (payload.reportPolicyVersion !== 2 || typeof payload.cutoffMs !== 'number') throw new Error('日报时间规则版本或截止时间无效')
  const expected = createReportPeriod(payload.cutoffMs)
  for (const key of ['reportDate', 'periodStartMs', 'periodEndMs'] as const) {
    if (payload[key] !== expected[key]) throw new Error(`日报提交窗口字段不一致：${key}`)
  }
  return { ...expected, periodBackfilled: false }
}

// 按闭合提交截止与开放报告日终点判断记录是否属于本次输入。
export function isTimestampInReportPeriod(timestamp: number, period: ReportPeriod): boolean {
  return Number.isSafeInteger(timestamp) && timestamp >= period.periodStartMs && timestamp <= period.cutoffMs && timestamp < period.periodEndMs
}

// 返回业务日跨越的两个自然日，保持已有原始索引的文件布局。
export function getReportIndexDates(period: ReportPeriod): string[] {
  return [period.reportDate, new Date(period.periodEndMs + CST_OFFSET_MS).toISOString().slice(0, 10)]
}

// 业务窗口次日四点结束后再保留八小时，统一到次日中午到期。
export function getReportRecordExpiryMs(timestamp: number): number {
  return createReportPeriod(timestamp).periodEndMs + 8 * 60 * 60 * 1000
}
