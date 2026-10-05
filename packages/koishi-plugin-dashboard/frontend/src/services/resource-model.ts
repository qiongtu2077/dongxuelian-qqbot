import { asRecord, type JsonRecord } from '../types'

export interface WorkerProgressDisplay {
  label: string
  level: 'ok' | 'warn' | 'danger' | 'off'
  title: string
}

export interface ResourceWorkerState {
  media: JsonRecord
  status: JsonRecord
  tasks: JsonRecord[]
}

export interface ReadableStatusDisplay {
  label: string
  detail: string
  level: 'ok' | 'info' | 'warn' | 'danger' | 'off'
}

export interface ReadableWorkerDisplay extends ReadableStatusDisplay {
  name: string
  backlogText: string
  lastContactText: string
  pauseReasons: string[]
}

export interface ReadableMediaQueueDisplay extends ReadableStatusDisplay {
  name: string
  queueTotal: number
  queueLimit: number
  readyCount: number
  deferredCount: number
  runningCount: number
}

const WORKER_ZOMBIE_STAGNATION_MS = 15 * 60 * 1000
const WORKER_HEARTBEAT_FRESH_MS = 10000
const DAILY_WORKER_KINDS = ['daily_report', 'daily_summary', 'emotion_render']
const AGENT_WORKER_KINDS = ['agent_task', 'dashboard_agent', 'agent_memory', 'agent_memory_compaction', 'conversation_summary', 'sensitive_cache_analysis']
const MEDIA_WORKER_KINDS = ['media_image_analysis', 'media_file_analysis', 'media_voice_transcription']

const BOT_MODE_DISPLAY: Record<string, ReadableStatusDisplay> = {
  normal: { label: '正常', detail: '可正常响应消息。', level: 'ok' },
  busy: { label: '正在忙碌', detail: '当前有独占任务正在运行。', level: 'info' },
  report_silent: { label: '日报生成中', detail: '正在生成日报，部分交互会暂时等待。', level: 'info' },
  critical: { label: '资源紧张', detail: '资源保护已生效，请等待资源恢复。', level: 'danger' },
  maintenance: { label: '维护中', detail: '智能回复和后台任务已暂停。', level: 'warn' },
}

const PAUSE_REASON_LABELS: Record<string, string> = {
  maintenance: '维护模式',
  resource_critical: '资源不足',
  browser_active: '浏览器自动操作占用',
  daily_render_active: '日报图片生成占用',
}

const TASK_KIND_LABELS: Record<string, string> = {
  agent_task: '智能助手任务',
  dashboard_agent: '控制台智能助手任务',
  agent_memory: '智能助手记忆任务',
  agent_memory_compaction: '记忆整理任务',
  conversation_summary: '对话总结任务',
  sensitive_cache_analysis: '敏感内容缓存分析',
  daily_report: '日报任务',
  daily_summary: '日报预计算任务',
  emotion_render: '情绪图片生成任务',
  media_image_analysis: '图片分析任务',
  media_file_analysis: '文件分析任务',
  media_voice_transcription: '语音转写任务',
  external_video_download: '视频下载任务',
}

const TASK_STATUS_DISPLAY: Record<string, ReadableStatusDisplay> = {
  pending: { label: '排队中', detail: '', level: 'info' },
  claiming: { label: '准备执行', detail: '', level: 'info' },
  running: { label: '处理中', detail: '', level: 'info' },
  deferred: { label: '暂缓处理', detail: '', level: 'warn' },
  done: { label: '已完成', detail: '', level: 'ok' },
  failed: { label: '失败', detail: '', level: 'danger' },
  cancelled: { label: '已取消', detail: '', level: 'off' },
}

const TASK_CONTENT_LABELS: Record<string, string> = {
  agent_task: '执行智能助手请求',
  dashboard_agent: '执行控制台助手请求',
  agent_memory: '更新智能助手记忆',
  agent_memory_compaction: '整理智能助手记忆',
  conversation_summary: '总结对话内容',
  sensitive_cache_analysis: '分析敏感内容缓存',
  daily_report: '生成群聊日报',
  daily_summary: '预计算日报摘要',
  emotion_render: '生成情绪图片',
  media_image_analysis: '分析图片内容',
  media_file_analysis: '分析文件内容',
  media_voice_transcription: '将语音转为文字',
  external_video_download: '下载 B 站视频',
}

const TASK_STEP_LABELS: Record<string, string> = {
  starting: '启动处理',
  waiting_lock: '等待其他任务释放资源',
  video_prepare: '准备视频',
  video_cached_send: '发送缓存视频',
  video_probe: '读取视频信息',
  video_preview: '生成视频预览',
  video_download: '下载视频',
  video_send: '发送视频',
  analyzing_media: '分析媒体内容',
}

const TASK_REASON_LABELS: Record<string, string> = {
  resource_busy: '等待其他任务释放资源',
  restart_discarded: '服务重启时中断',
  'available memory is below task min memory budget': '等待可用内存恢复',
  'media drain paused during daily report': '等待日报生成结束',
  'daily report already running': '等待当前日报完成',
  'exclusive task waits for current report': '等待当前日报释放资源',
  'resource state red defers business task': '等待可用资源恢复',
  'exclusive slot is busy': '等待其他任务释放资源',
  'media waits for exclusive slot to clear': '等待其他任务释放资源',
}

const RESOURCE_EVENT_LABELS: Record<string, string> = {
  ticket_created: '任务已申请资源', dead_ticket_reclaimed: '已清理失效的资源申请',
  lock_acquired: '任务已获得资源位置', lock_released: '任务已释放资源位置',
  lock_stale_reclaimed: '已清理失效的资源占用', lock_wait_failed: '等待资源失败',
  admission_decided: '任务资源检查完成',
  task_created: '后台任务已创建', task_claimed: '后台任务已领取', task_running: '后台任务开始处理',
  task_step: '后台任务进度更新', task_done: '后台任务已完成', task_failed: '后台任务失败',
  task_deferred: '后台任务暂缓处理', task_requeued: '后台任务重新排队', task_cancelled: '后台任务已取消',
  task_notify_updated: '任务结果通知已更新', task_cleanup: '历史任务清理完成',
  task_id_conflict_discarded: '编号冲突的旧任务已归档',
  task_discarded_on_startup: '重启时已结束旧任务', startup_runtime_discarded: '重启时已整理旧运行状态',
  worker_process_started: '后台处理器已启动', worker_process_start_failed: '后台处理器启动失败',
  worker_process_suspected_blocked: '后台处理器长时间未推进', worker_process_zombie_recovered: '已处理失去响应的后台处理器',
  worker_stale_recovered: '已结束失联处理器的任务', claiming_stale_recovered: '已结束未启动的孤儿任务',
  task_timeout_recovered: '已结束运行超时的任务', task_timeout_recovery_failed: '超时任务清理失败',
  daily_worker_pipeline_started: '日报处理开始', daily_worker_pipeline_finished: '日报处理结束',
  precompute_index_appended: '日报预计算记录已更新',
  daily_final_input_written: '日报汇总输入已保存', daily_slot_retry_restored: '日报分段重试已恢复',
  daily_slot_tasks_planned: '日报预计算任务已安排', daily_slot_written: '日报预计算分段已保存',
  deferred_tasks_audited: '暂缓任务检查完成',
  media_task_created: '媒体分析任务已创建', media_task_claimed: '媒体分析任务已领取',
  media_task_requeued: '媒体分析任务重新排队', media_task_done: '媒体分析任务已完成',
  media_task_failed: '媒体分析任务失败', media_task_expired: '媒体分析任务已过期',
  media_task_dropped: '媒体分析任务已舍弃', media_task_deduped: '重复媒体任务已合并',
  media_task_discarded_on_startup: '重启时已结束旧媒体任务', media_task_timed_out: '媒体分析任务运行超时',
  media_cache_reused: '已复用媒体分析缓存', media_retention_completed: '媒体历史记录整理完成',
  process_tree_terminated: '任务进程已清理', process_metrics: '进程资源用量已采样',
  process_cleanup: '任务进程清理完成', process_tree_not_running: '任务进程已经退出',
  process_tree_terminate_skipped: '任务进程清理已跳过', recorded_process_cleanup_skipped: '记录的子进程清理已跳过',
  resource_history_retention_completed: '资源历史记录整理完成', stale_suspected: '资源占用长时间未更新',
  worker_idle_exit: '空闲后台处理器已退出', worker_memory_limit_exceeded: '后台处理器内存超限',
  worker_should_exit: '后台处理器已收到退出指令', worker_tick_failed: '后台处理器本轮执行失败',
}

const RESOURCE_SOURCE_LABELS: Record<string, string> = {
  S0: '资源占用', S1: '资源检查', S2: '后台任务', S3: '日报预计算',
  S6: '媒体处理', S8: '系统保护',
}

const WORKER_NAMES: Record<string, string> = {
  agent: '智能助手后台处理器',
  media: '媒体分析处理器',
  daily: '日报处理器',
}

const MEDIA_KIND_NAMES: Record<string, string> = {
  image: '图片',
  file: '文件',
  voice: '语音',
}

const MEDIA_RISK_DISPLAY: Record<string, ReadableStatusDisplay> = {
  idle: { label: '当前空闲', detail: '当前没有等待任务。', level: 'ok' },
  queued: { label: '正常排队', detail: '队列仍在安全范围内。', level: 'info' },
  near_limit: { label: '接近上限', detail: '队列已达到容量的 80%，请关注后续增长。', level: 'warn' },
  at_limit: { label: '已达上限', detail: '新任务可能触发队列保护并舍弃低优先级任务。', level: 'danger' },
}

// --- 资源中心可读状态 --- //

// Maps the backend bot mode code to a stable Chinese service conclusion.
export function botModeDisplay(value: unknown): ReadableStatusDisplay {
  return BOT_MODE_DISPLAY[String(value || '')] || { label: '状态未知', detail: '后端返回了未识别的服务状态。', level: 'off' }
}

// Maps resource availability and handles unavailable memory as a separate state.
export function resourceStateDisplay(value: unknown, memAvailableMb: unknown, memTotalMb: unknown): ReadableStatusDisplay {
  if (typeof memAvailableMb !== 'number' || !Number.isFinite(memAvailableMb)) {
    return { label: '资源数据暂不可用', detail: '请检查服务器运行环境和内存信息读取权限。', level: 'warn' }
  }
  const total = typeof memTotalMb === 'number' && Number.isFinite(memTotalMb) ? memTotalMb : null
  const memory = total === null
    ? `可用内存 ${Math.round(memAvailableMb)} MB。`
    : `可用内存 ${Math.round(memAvailableMb)} / ${Math.round(total)} MB（${Math.round((memAvailableMb / Math.max(1, total)) * 100)}%）。`
  if (value === 'green') return { label: '充足', detail: memory, level: 'ok' }
  if (value === 'red') return { label: '紧张', detail: memory, level: 'danger' }
  return { label: '注意', detail: memory, level: 'warn' }
}

// Maps the configured resource policy without presenting it as detected hardware.
export function serverModeDisplay(value: unknown): ReadableStatusDisplay {
  if (String(value || '') === 'small') {
    return { label: '小内存策略', detail: '避免浏览器自动操作与日报图片生成并行。', level: 'warn' }
  }
  return { label: '大内存策略', detail: '允许资源许可范围内的后台任务并行。', level: 'ok' }
}

// Translates every backend pause reason code while preserving simultaneous reasons.
export function pauseReasonLabels(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.map(item => PAUSE_REASON_LABELS[String(item || '')] || '其他系统保护原因')
}

// Converts low-level activity leases into three human-readable protection facts.
export function activityLeaseDisplay(status: JsonRecord): { browser: string; render: string; background: string; reasons: string[] } {
  const reasons = pauseReasonLabels(status.backgroundPauseReasons)
  return {
    browser: status.tool_active ? '浏览器自动操作：正在使用' : '浏览器自动操作：空闲',
    render: status.render_active ? '日报图片生成：正在使用' : '日报图片生成：空闲',
    background: status.background_allowed === false
      ? `后台任务已暂停${reasons.length ? `：${reasons.join('、')}` : ''}`
      : '后台任务：允许执行',
    reasons,
  }
}

// Translates a stable task kind for first-screen and diagnostic summaries.
export function taskKindDisplay(value: unknown): string {
  return TASK_KIND_LABELS[String(value || '')] || '其他后台任务'
}

// --- 任务记录展示 --- //

// 将任务状态和已知等待原因转换为中文，不把任务完成误报为发送成功。
export function taskStatusDisplay(task: JsonRecord): ReadableStatusDisplay {
  const status = String(task.status || '')
  const base = TASK_STATUS_DISPLAY[status] || { label: '状态未知', detail: '', level: 'off' }
  const reason = String(status === 'deferred' ? task.error || task.requeueReason || '' : task.requeueReason || task.error || '')
  const detail = status === 'pending' || status === 'deferred'
    ? TASK_REASON_LABELS[reason] || (reason ? '具体等待原因见详情' : '')
    : status === 'running' ? TASK_STEP_LABELS[String(task.step || '')] || '' : ''
  return { ...base, detail }
}

// 使用短类别名称，保留其他资源面板现有的完整任务名称。
export function taskCategoryDisplay(value: unknown): string {
  if (value === 'daily_report') return '日报生成'
  return taskKindDisplay(value).replace(/任务$/, '')
}

// 从固定业务名称和后端允许公开的 BV 号构造内容，不解析内部任务 ID。
export function taskContentDisplay(task: JsonRecord): string {
  const title = TASK_CONTENT_LABELS[String(task.kind || '')] || '处理后台请求'
  const bvId = asRecord(task.displaySummary).bvId
  return task.kind === 'external_video_download' && bvId ? `${title} · ${String(bvId)}` : title
}

// 根据通知目标区分群聊和私聊，其他频道只展示实际记录的来源。
export function taskSourceDisplay(task: JsonRecord): string {
  const notify = asRecord(task.notify)
  const channel = String(notify.channelKey || task.channelKey || '')
  if (notify.target === 'qq-group' && channel) return `来源：群 ${channel}`
  if (notify.target === 'qq-private' && channel) return `来源：私聊 ${channel}`
  if (channel.startsWith('private:')) return `来源：私聊 ${channel.slice(8)}`
  if (channel === 'dashboard' || notify.target === 'dashboard') return '来源：控制台'
  if (channel === 'global') return '来源：系统后台'
  return channel ? `来源：频道 ${channel}` : '来源：未记录'
}

// 用北京时间展示更新时间；完整格式用于悬浮提示和任务详情。
export function taskTimeDisplay(value: unknown, full = false): string {
  const parsed = Date.parse(String(value || ''))
  if (!Number.isFinite(parsed)) return '未记录'
  const parts = new Date(parsed + 8 * 60 * 60 * 1000).toISOString()
  return `${parts.slice(full ? 0 : 5, 10)} ${parts.slice(11, 19)}${full ? '（北京时间）' : ''}`
}

// 翻译已知步骤，未知步骤的原始值留在详情中供排查。
export function taskStepDisplay(task: JsonRecord): string {
  return TASK_STEP_LABELS[String(task.step || '')] || taskStatusDisplay(task).label
}

// 解释已知错误和等待原因；原始文本由独立展开项保留，未知原因不编造结论。
export function taskErrorDisplay(value: unknown): string {
  const error = String(value || '')
  if (error === 'worker heartbeat stale: local-video-sender-main') return '旧版监控未识别主进程中的视频执行器，误判为失联并标记失败。此记录无法证明视频是否已发送。'
  if (error.startsWith('worker heartbeat stale: ')) return '任务处理器长时间未更新运行状态，系统已将任务标记为失败。'
  if (error.startsWith('worker claiming stale: ')) return '任务已被领取，但处理器未能开始执行，系统已结束这条任务。'
  const timeout = error.match(/^resource worker task timed out after (\d+)ms$/)
  if (timeout) return `任务运行超过 ${Math.round(Number(timeout[1]) / 60000)} 分钟，系统已结束该任务。`
  if (error === 'task_id_conflict') return '旧版任务编号与历史记录重复，任务无法继续执行，已归档。请重新发送视频链接。'
  if (error === 'video_task_expired') return '视频请求已超过 15 分钟有效期，请重新发送视频链接。'
  if (error === 'restart_discarded') return '服务重启，原任务已中断；需要处理时请重新发起请求。'
  if (error === 'video_send_outcome_uncertain') return '未能确认视频是否发送成功，请先检查群内记录。'
  return TASK_REASON_LABELS[error] || '系统记录了处理原因，请展开查看原始记录。'
}

// 将资源事件代码转换为中文名称，未知代码留在原始事件中供排查。
export function resourceEventDisplay(value: unknown): string {
  return RESOURCE_EVENT_LABELS[String(value || '')] || '其他系统事件'
}

// 将资源模块代号转换为中文来源。
export function resourceEventSourceDisplay(value: unknown): string {
  return RESOURCE_SOURCE_LABELS[String(value || '')] || '系统事件'
}

// Formats a worker heartbeat lag using the user-facing “最后联系” vocabulary.
export function lastContactDisplay(value: unknown): string {
  const ms = Number(value)
  if (!Number.isFinite(ms)) return '最后联系：未记录'
  if (ms < 1000) return '最后联系：刚刚'
  return `最后联系：${formatInterval(ms)}前`
}

// Formats a persisted timestamp for user-facing diagnostic and history text.
export function dateTimeDisplay(value: unknown, fallback = '未记录'): string {
  const parsed = Date.parse(String(value || ''))
  return Number.isFinite(parsed) ? new Date(parsed).toLocaleString() : fallback
}

// Translates one backend worker health code without reproducing its decision tree.
export function workerDisplay(worker: JsonRecord): ReadableWorkerDisplay {
  const type = String(worker.workerType || workerKind(worker) || 'unknown')
  const name = WORKER_NAMES[type] || '后台处理器'
  const backlog = numberValue(worker.backlogTotal)
  const runningCount = Math.max(1, numberValue(worker.runningCount))
  const code = String(worker.workerHealthCode || '')
  const pauseReasons = pauseReasonLabels(worker.workerPauseReasons)
  const base = (() : ReadableStatusDisplay => {
    if (code === 'task_timeout') return { label: '任务运行超时', detail: '系统正在自动清理超时任务。', level: 'danger' }
    if (code === 'task_timeout_idle') return { label: '处理器空闲，上一个任务超时', detail: '系统正在自动清理超时任务。', level: 'danger' }
    if (code === 'running_unresponsive_backlog') return { label: `任务运行中，但处理器无响应；另有 ${backlog} 项任务等待处理`, detail: '需要检查处理器运行状态。', level: 'danger' }
    if (code === 'claiming_idle') return { label: '处理器空闲', detail: '任务尚未开始执行。', level: 'ok' }
    if (code === 'stopped_backlog') return { label: `处理器已停止，仍有 ${backlog} 项任务等待处理`, detail: '需要检查处理器运行状态。', level: 'danger' }
    if (code === 'stalled') return { label: '任务积压，处理器长时间未推进', detail: '处理器仍在线，但已超过进展观察窗口。', level: 'danger' }
    if (code === 'paused_auto_resume') return { label: '已暂停，将自动恢复', detail: pauseReasons.join('、') || '系统保护暂时阻止领取新任务。', level: 'off' }
    if (code === 'working') return { label: `正在处理 ${runningCount} 项任务`, detail: '处理器正在执行已领取任务。', level: 'info' }
    if (code === 'idle') return { label: '正常待命', detail: '处理器在线并可领取任务。', level: 'ok' }
    return { label: '已停止', detail: '当前没有运行中的处理器进程。', level: 'off' }
  })()
  return {
    ...base,
    name,
    backlogText: backlog > 0 ? `待处理任务：${backlog}` : '暂无待处理任务',
    lastContactText: lastContactDisplay(worker.heartbeatLagMs),
    pauseReasons,
  }
}

// Translates one media queue and exposes every count required by the readable panel.
export function mediaQueueDisplay(kind: string, queue: JsonRecord, riskCode: unknown): ReadableMediaQueueDisplay {
  const risk = MEDIA_RISK_DISPLAY[String(riskCode || '')] || MEDIA_RISK_DISPLAY.idle
  return {
    ...risk,
    name: MEDIA_KIND_NAMES[kind] || '其他媒体',
    queueTotal: numberValue(queue.queueTotal),
    queueLimit: numberValue(queue.queueLimit),
    readyCount: numberValue(queue.readyCount),
    deferredCount: numberValue(queue.deferredCount),
    runningCount: numberValue(queue.runningCount),
  }
}

// Builds the overall media conclusion from the backend-provided worst risk and tied kinds.
export function mediaSummaryDisplay(media: JsonRecord): ReadableStatusDisplay {
  const risk = MEDIA_RISK_DISPLAY[String(media.mediaRiskCode || '')] || MEDIA_RISK_DISPLAY.idle
  const kinds = Array.isArray(media.mediaRiskKinds)
    ? media.mediaRiskKinds.map(kind => MEDIA_KIND_NAMES[String(kind || '')] || '其他媒体')
    : []
  if (String(media.mediaRiskCode || '') === 'idle') {
    return { ...risk, detail: '当前没有等待的媒体分析任务。' }
  }
  return { ...risk, detail: `${kinds.join('、') || '媒体'}队列${risk.label}。` }
}

// Translates a media diagnostic finish-reason code.
export function mediaFinishReasonDisplay(value: unknown): string {
  if (value === 'queue_limit') return '因队列超限舍弃'
  if (value === 'processing_failed') return '处理失败'
  if (value === 'restart_interrupted') return '服务重启时中断'
  return '历史原因未知'
}

// --- 通用展示格式 --- //

// Formats a truthy resource value for compact Chinese display.
export function boolText(value: unknown): string {
  return value ? '是' : '否'
}

// Compresses an unknown value into a bounded table cell.
export function display(value: unknown, fallback = '-'): string {
  if (value === null || value === undefined || value === '') return fallback
  if (typeof value === 'object') return JSON.stringify(value).slice(0, 120)
  return String(value)
}

// Formats one resource event and preserves partial process-tree termination semantics.
export function eventDetail(event: JsonRecord): string {
  if (String(event.event || '') === 'process_tree_terminated' && event.treeTerminationConfirmed === false) {
    return '根进程已终止，子进程树未确认'
  }
  if (event.error) return taskErrorDisplay(event.error)
  const reason = String(event.reason || '')
  if (!reason) return ''
  if (reason === 'resource budget accepted') return '资源满足要求，允许执行。'
  if (reason === 'external-video-finally') return '视频处理流程结束，已释放资源位置。'
  if (reason === 'queue_limit') return '队列达到容量上限，已舍弃该任务。'
  if (reason === 'worker_exited') return '处理器退出，未完成的任务已结束。'
  if (reason === 'task_timed_out') return '任务超过运行时限，系统已执行清理。'
  return taskErrorDisplay(reason)
}

// Converts an unknown numeric field into a finite display value.
export function numberValue(value: unknown): number {
  const parsed = Number(value || 0)
  return Number.isFinite(parsed) ? parsed : 0
}

// Returns the length of an API list and zero for non-arrays.
export function arrayLength(value: unknown): number {
  return Array.isArray(value) ? value.length : 0
}

// Formats worker heartbeat lag.
export function lagLabel(value: unknown): string {
  const ms = Number(value)
  if (!Number.isFinite(ms)) return '无心跳'
  if (ms < 1000) return `${ms}ms`
  return `${Math.round(ms / 1000)}s`
}

// Formats a fractional coverage value as a percentage.
export function percentLabel(value: unknown): string {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return '-'
  return `${Math.round(parsed * 1000) / 10}%`
}

// Formats a memory value in megabytes.
export function mbLabel(value: unknown): string {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? `${Math.round(parsed)} MB` : '-'
}

// Resolves used memory from either the current field or the legacy total-minus-available shape.
export function memoryUsedValue(point: JsonRecord): number {
  const direct = Number(point.memUsedMb)
  if (Number.isFinite(direct)) return Math.max(0, direct)
  const total = Number(point.memTotalMb)
  const available = Number(point.memAvailableMb)
  if (Number.isFinite(total) && Number.isFinite(available)) return Math.max(0, total - available)
  return Number.NaN
}

// Formats disk capacity with an automatic MB/GB unit.
export function sizeMbLabel(value: unknown): string {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return '-'
  if (Math.abs(parsed) >= 1024) return `${Math.round((parsed / 1024) * 10) / 10} GB`
  return `${Math.round(parsed)} MB`
}

// Formats a millisecond interval for resource diagnostics.
export function formatInterval(value: unknown): string {
  const ms = Number(value)
  if (!Number.isFinite(ms) || ms <= 0) return '-'
  if (ms < 1000) return `${ms}ms`
  if (ms < 60000) return `${Math.round(ms / 100) / 10}s`
  if (ms < 3600000) return `${Math.round(ms / 6000) / 10}m`
  return `${Math.round(ms / 360000) / 10}h`
}

// Formats an ISO timestamp as elapsed time relative to now.
export function elapsedLabel(iso: unknown, now = Date.now()): string {
  const ts = Date.parse(String(iso || ''))
  if (!Number.isFinite(ts)) return '无认领'
  return `${formatInterval(now - ts)}前`
}

// Resolves the normalized worker kind from either kind or legacy name.
export function workerKind(worker: JsonRecord): string {
  const explicit = String(worker.kind || '').trim().toLowerCase()
  if (explicit) return explicit
  const name = String(worker.name || '').trim().toLowerCase()
  return name.endsWith('-worker') ? name.slice(0, -'-worker'.length) : name
}

// Resolves resource task kinds owned by one worker.
export function workerTaskKinds(worker: JsonRecord): string[] {
  const kind = workerKind(worker)
  if (kind === 'daily') return DAILY_WORKER_KINDS
  if (kind === 'agent') return AGENT_WORKER_KINDS
  if (kind === 'media') return MEDIA_WORKER_KINDS
  return []
}

// Counts pending work attributable to one worker.
export function workerBacklogCount(worker: JsonRecord, state: ResourceWorkerState): number {
  if (workerKind(worker) === 'media') {
    return numberValue(state.media.imagePending) + numberValue(state.media.filePending) + numberValue(state.media.voicePending)
  }
  const kinds = new Set(workerTaskKinds(worker))
  if (!kinds.size) return numberValue(state.status.queueLength)
  return state.tasks.filter(task => String(task.status || '') === 'pending' && kinds.has(String(task.kind || ''))).length
}

// Finds the running resource task claimed by one worker.
export function findRunningTaskForWorker(worker: JsonRecord, tasks: JsonRecord[]): JsonRecord | null {
  const currentTaskId = String(worker.currentTaskId || '').trim()
  if (!currentTaskId) return null
  return tasks.find(task => String(task.id || '') === currentTaskId && String(task.status || '') === 'running') || null
}

// Checks whether a claimed worker task remains inside its declared timeout.
export function isWorkerRunningWithinTimeout(worker: JsonRecord, tasks: JsonRecord[], now = Date.now()): boolean {
  const currentTaskId = String(worker.currentTaskId || '').trim()
  if (!currentTaskId) return false
  const task = findRunningTaskForWorker(worker, tasks)
  if (!task) return false
  const timeoutMs = Number(task.timeoutMs || 0)
  const startedAt = Date.parse(String(worker.currentTaskStartedAt || task.startedAt || ''))
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || !Number.isFinite(startedAt)) return false
  return now - startedAt < timeoutMs
}

// Builds the worker progress metadata line.
export function workerProgressMeta(worker: JsonRecord, state: ResourceWorkerState, now = Date.now()): string {
  const loops = Number(worker.loopIterations)
  const loopLabel = Number.isFinite(loops) ? `loop ${loops}` : 'loop -'
  return `${loopLabel} · 认领 ${elapsedLabel(worker.lastClaimAttemptAt, now)} · backlog ${workerBacklogCount(worker, state)}`
}

// Classifies worker progress using heartbeat, claim progress, backlog and task timeout.
export function workerProgressStatus(worker: JsonRecord, state: ResourceWorkerState, now = Date.now()): WorkerProgressDisplay {
  if (!worker.alive) return { label: '离线', level: 'off', title: 'worker 心跳已失效或进程不可用' }
  if (worker.parked === true) return { label: '已停放', level: 'off', title: `worker 正按后台指令休眠 ${formatInterval(worker.parkSleepMs)}` }
  if (isWorkerRunningWithinTimeout(worker, state.tasks, now)) return { label: '运行中', level: 'ok', title: `当前任务 ${display(worker.currentTaskId)}` }

  const heartbeatLagMs = Number(worker.heartbeatLagMs)
  const progressAt = Date.parse(String(worker.lastClaimAttemptAt || worker.loopChangedAt || worker.heartbeatAt || ''))
  const progressLagMs = Number.isFinite(progressAt) ? now - progressAt : Number.MAX_SAFE_INTEGER
  const backlog = workerBacklogCount(worker, state)
  if (Number.isFinite(heartbeatLagMs) && heartbeatLagMs <= WORKER_HEARTBEAT_FRESH_MS && progressLagMs > WORKER_ZOMBIE_STAGNATION_MS && backlog > 0) {
    return { label: '疑似僵尸', level: 'danger', title: '心跳仍新鲜，但认领进度长时间未推进且仍有待处理任务' }
  }
  if (backlog > 0 && progressLagMs > WORKER_ZOMBIE_STAGNATION_MS) {
    return { label: '进度停滞', level: 'warn', title: '该 worker 有积压任务，但最近认领时间已超过观察窗口' }
  }
  return { label: '推进中', level: 'ok', title: 'worker 心跳和认领进度未显示异常' }
}

// Rounds an SVG coordinate to one decimal place.
export function round(value: number): number {
  return Math.round(value * 10) / 10
}

// Builds a stable coverage-row key.
export function coverageKey(item: JsonRecord): string {
  return `${display(item.date)}:${display(item.channelKey)}:${display(item.updatedAt)}`
}

// Builds a stable resource-event key.
export function eventKey(item: JsonRecord): string {
  return `${display(item.source)}:${display(item.event)}:${display(item.createdAt)}:${display(item.taskId)}`
}

// Reports whether a resource task can be cancelled from the dashboard.
export function canCancel(task: JsonRecord): boolean {
  return ['pending', 'deferred'].includes(String(task.status || ''))
}
