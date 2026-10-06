<template>
  <section class="report-analysis-detail" aria-label="日报分析详情">
    <h3>日报分析详情</h3>
    <p v-if="loading" role="status">正在读取分析进度…</p>
    <p v-else-if="error" role="alert">{{ error }}</p>
    <template v-else-if="payload">
      <p v-if="payload.state !== 'available'">{{ payload.message || '尚未保存分析进度' }}</p>
      <dl v-if="payload.state === 'not_started' && payload.reportPeriod" class="report-analysis-grid">
        <div><dt>所属报告日期</dt><dd>{{ period.reportDate }}</dd></div>
        <div><dt>业务窗口（北京时间）</dt><dd>{{ time(period.periodStartMs) }} 至 {{ time(period.periodEndMs) }}（终点不含）</dd></div>
        <div><dt>消息截止（北京时间）</dt><dd>{{ time(period.cutoffMs) }}</dd></div>
        <div><dt>分析数量与覆盖</dt><dd>尚未计算</dd></div>
      </dl>
      <template v-if="payload.state === 'available'">
        <dl class="report-analysis-grid">
          <div><dt>分析状态</dt><dd>{{ stateLabel(analysis.analysisState) }}</dd></div>
          <div><dt>所属报告日期</dt><dd>{{ period.reportDate || '未记录' }}</dd></div>
          <div><dt>业务窗口（北京时间）</dt><dd>{{ time(period.periodStartMs) }} 至 {{ time(period.periodEndMs) }}（终点不含）</dd></div>
          <div><dt>消息截止（北京时间）</dt><dd>{{ time(period.cutoffMs) }}</dd></div>
          <div v-if="analysis.periodBackfilled"><dt>时间来源</dt><dd>旧任务按创建时间补齐报告窗口</dd></div>
          <div v-for="row in countRows" :key="row.key"><dt>{{ row.label }}</dt><dd>{{ numeric(analysis[row.key]) }}</dd></div>
          <div><dt>话题输入覆盖率</dt><dd>{{ analysis.coverageRate === null ? '无可分析消息' : numeric(analysis.coverageRate) + '%' }}</dd></div>
          <div><dt>原始正文完整性</dt><dd>{{ completenessLabel(analysis.sourceCompleteness) }}</dd></div>
          <div><dt>摘要阶段</dt><dd>{{ stateLabel(stages.compression) }}</dd></div>
          <div><dt>话题阶段</dt><dd>{{ stateLabel(stages.basic) }}</dd></div>
          <div><dt>详细分析阶段</dt><dd>{{ stateLabel(stages.full) }}</dd></div>
          <div><dt>模型用量可读性</dt><dd>{{ usageLabel }}</dd></div>
          <div v-if="Number(analysis.usageReadableRequests) > 0"><dt>已读输入 / 输出 / 总用量</dt><dd>{{ numeric(usage.promptTokens) }} / {{ numeric(usage.completionTokens) }} / {{ numeric(usage.totalTokens) }}</dd></div>
          <div v-for="row in durations" :key="row.key"><dt>{{ stageLabel(row.key) }}耗时</dt><dd>{{ row.seconds }} 秒</dd></div>
        </dl>
        <p class="report-analysis-hint">覆盖率表示入选消息进入话题分析请求的比例；结果是否完整成功以分析状态为准。</p>
        <div v-if="analysis.failureKind" class="report-analysis-error">
          <b>{{ analysis.failureKind === 'total_timeout' ? '实际运行总时限耗尽' : '必要分析未完成，日报生成失败' }}</b>
          <p>失败阶段：{{ stageLabel(analysis.failureStage) }}</p>
          <pre>{{ analysis.error }}</pre>
        </div>
        <div v-for="unit in failedUnits" :key="String(unit.id)" class="report-analysis-error">
          <b>失败处理单元：{{ unit.id }} · {{ stageLabel(unit.stage) }}</b>
          <p>来源序号 {{ numeric(unit.firstSourceId) }}—{{ numeric(unit.lastSourceId) }}；已尝试 {{ numeric(unit.attempts) }} 次</p>
          <p>北京时间：{{ time(unit.firstTimestamp) }} 至 {{ time(unit.lastTimestamp) }}</p>
          <pre>{{ unit.error }}</pre>
        </div>
        <p v-for="(warning, index) in warnings" :key="index">{{ warning }}</p>
      </template>
      <dl class="report-analysis-grid" v-if="payload.notification">
        <div><dt>通知状态</dt><dd>{{ notificationLabel(notification.status) }}</dd></div>
        <div v-if="notification.delivery"><dt>已确认发送分段</dt><dd>{{ numeric(delivery.confirmedSegments) }} / {{ numeric(delivery.totalSegments) }}</dd></div>
        <div v-if="delivery.state === 'unknown'"><dt>送达确认</dt><dd>发送结果未知；重试仅从未确认段继续，无法保证未知段只送达一次</dd></div>
      </dl>
      <pre v-if="notification.error">{{ notification.error }}</pre>
    </template>
  </section>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { asArray, asRecord, type JsonRecord } from '../types'
import { taskTimeDisplay } from '../services/resource-model'

const props = defineProps<{ payload: JsonRecord | null; loading: boolean; error: string }>()
const analysis = computed(() => asRecord(props.payload?.analysis))
const period = computed(() => asRecord(analysis.value.reportPeriod || props.payload?.reportPeriod))
const stages = computed(() => asRecord(analysis.value.stages))
const usage = computed(() => asRecord(analysis.value.tokenUsage))
const notification = computed(() => asRecord(props.payload?.notification))
const delivery = computed(() => asRecord(notification.value.delivery))
const failedUnits = computed(() => asArray<JsonRecord>(analysis.value.failedBatches))
const warnings = computed(() => asArray<string>(analysis.value.warnings))
const countRows = [
  { key: 'windowMessageCount', label: '窗口实际收录消息' }, { key: 'selectedMessageCount', label: '入选分析消息' },
  { key: 'excludedByLimitCount', label: '因条数上限未选入' }, { key: 'submittedMessageCount', label: '已提交摘要请求' },
  { key: 'summarizedMessageCount', label: '完整摘要成功' }, { key: 'topicInputMessageCount', label: '进入话题输入' },
  { key: 'omittedMessageCount', label: '入选后未完整覆盖' }, { key: 'unprocessedCount', label: '尚未处理' },
  { key: 'batchCount', label: '摘要批次数' }, { key: 'mergeLevels', label: '摘要合并层数' },
  { key: 'reportCallCount', label: '日报层调用次数' }, { key: 'requestCount', label: '供应商实际请求次数' },
  { key: 'retryCount', label: '日报层重试次数' },
]
const durations = computed(() => Object.entries(asRecord(analysis.value.stageDurationsMs)).map(([key, value]) => ({ key, seconds: typeof value === 'number' ? (value / 1000).toFixed(2) : '未知' })))
const usageLabel = computed(() => {
  const readable = Number(analysis.value.usageReadableRequests)
  const total = Number(analysis.value.requestCount)
  if (!readable) return '未知：未取得可读用量'
  return `${readable}/${total} 次请求有可读用量${readable < total ? '（仅统计已读部分）' : ''}`
})

// 零值保留；缺少记录与非法值统一显示未知。
function numeric(value: unknown): string { return typeof value === 'number' && Number.isFinite(value) ? String(value) : '未知' }
// 数值时间戳明确转ISO后复用北京时间格式，不采用浏览器本地时区。
function time(value: unknown): string { return typeof value === 'number' && Number.isFinite(value) && value > 0 ? taskTimeDisplay(new Date(value).toISOString(), true) : '未记录' }
// 显示共享契约的中文分析阶段状态。
function stateLabel(value: unknown): string {
  const labels: Record<string, string> = { not_started: '尚未开始', pending: '尚未开始', processing: '处理中', complete: '完整成功', failed: '生成失败', total_timeout: '总时限超时', not_requested: '本次无需执行' }
  return labels[String(value)] || '未记录'
}
// 区分新格式完整性与旧版本未记录，不能按正文长度推测。
function completenessLabel(value: unknown): string { return ({ complete: '已记录完整', incomplete: '已知不完整', legacy_unknown: '旧版本未记录正文完整性' } as Record<string, string>)[String(value)] || '未记录' }
// 失败阶段与阶段耗时使用相同的中文名称。
function stageLabel(value: unknown): string {
  const labels: Record<string, string> = { collecting: '收集消息', compression: '分批摘要', merge: '摘要合并', summary_and_merge: '摘要及合并', basic: '话题分析', full: '详细分析', analysis: '必要分析', rendering: '图片渲染', saving: '结果保存', runtime: '整体运行', worker: '执行器' }
  return labels[String(value)] || '其他处理阶段'
}
// 通知失败与分析失败分别展示。
function notificationLabel(value: unknown): string { return ({ pending: '待发送', sent: '已确认送达', failed: '发送失败', skipped: '无需发送' } as Record<string, string>)[String(value)] || '未记录' }
</script>

<style scoped>
.report-analysis-detail { margin-top: 16px; padding-top: 12px; border-top: 1px solid var(--border); user-select: text; }
.report-analysis-detail h3 { margin: 0 0 12px; font-size: 15px; }
.report-analysis-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 8px 18px; }
.report-analysis-grid div { display: flex; gap: 12px; }
.report-analysis-grid dt { flex: 0 0 145px; color: var(--text-secondary); }
.report-analysis-grid dd { margin: 0; overflow-wrap: anywhere; }
.report-analysis-detail pre { white-space: pre-wrap; overflow-wrap: anywhere; font-size: 12px; }
.report-analysis-hint { color: var(--text-secondary); font-size: 12px; }
.report-analysis-error { margin: 12px 0; padding: 8px; background: var(--input); border-radius: 8px; }
</style>
