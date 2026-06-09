/**
 * MODULE: S1 任务预算定义。
 * 职责: 将业务入口提交的任务需求归一为资源预算。
 * 边界: 不读取系统状态，不做准入决策。
 */
const { RESOURCE_TASK_KIND } = require('../resource-common/resource-task-kinds') as typeof import('../resource-common/resource-task-kinds')

type KnownResourceTaskKind = typeof RESOURCE_TASK_KIND[keyof typeof RESOURCE_TASK_KIND]
type ResourceTaskKind = KnownResourceTaskKind | string

interface TaskBudgetInput {
  taskId?: string
  kind?: ResourceTaskKind
  source?: string
  channelKey?: string
  userId?: string
  exclusive?: boolean
  priority?: number
  minMemMb?: number
  criticalMemMb?: number
  degradable?: boolean
  deferable?: boolean
  fallbacks?: string[]
  queueTimeoutMs?: number
  runTimeoutMs?: number
}

interface TaskBudget extends TaskBudgetInput {
  taskId: string
  source: string
  channelKey: string
  userId: string
  exclusive: boolean
  priority: number
  minMemMb: number
  criticalMemMb: number
  degradable: boolean
  deferable: boolean
  fallbacks: string[]
  queueTimeoutMs: number
  runTimeoutMs: number
}

const DEFAULT_BUDGETS: Record<string, Partial<TaskBudget>> = {
  [RESOURCE_TASK_KIND.DAILY_REPORT]: {
    exclusive: true,
    priority: 20,
    minMemMb: 600,
    criticalMemMb: 300,
    degradable: true,
    deferable: true,
    fallbacks: ['daily_report_text', 'daily_report_summary'],
    queueTimeoutMs: 600000,
    runTimeoutMs: 600000,
  },
  [RESOURCE_TASK_KIND.DAILY_REPORT_RENDER]: {
    exclusive: true,
    priority: 20,
    minMemMb: 600,
    criticalMemMb: 300,
    degradable: true,
    deferable: true,
    fallbacks: ['daily_report_text', 'daily_report_summary'],
    queueTimeoutMs: 600000,
    runTimeoutMs: 600000,
  },
  [RESOURCE_TASK_KIND.DAILY_SUMMARY]: {
    exclusive: false,
    priority: 70,
    minMemMb: 300,
    criticalMemMb: 300,
    degradable: false,
    deferable: true,
    fallbacks: [],
    queueTimeoutMs: 300000,
    runTimeoutMs: 120000,
  },
  [RESOURCE_TASK_KIND.AGENT_TASK]: {
    exclusive: true,
    priority: 40,
    minMemMb: 600,
    criticalMemMb: 300,
    degradable: false,
    deferable: true,
    fallbacks: [],
    queueTimeoutMs: 600000,
    runTimeoutMs: 600000,
  },
  [RESOURCE_TASK_KIND.DASHBOARD_AGENT]: {
    exclusive: true,
    priority: 45,
    minMemMb: 600,
    criticalMemMb: 300,
    degradable: false,
    deferable: true,
    fallbacks: [],
    queueTimeoutMs: 600000,
    runTimeoutMs: 600000,
  },
  [RESOURCE_TASK_KIND.AGENT_MEMORY]: {
    exclusive: true,
    priority: 95,
    minMemMb: 600,
    criticalMemMb: 300,
    degradable: false,
    deferable: true,
    fallbacks: [],
    queueTimeoutMs: 120000,
    runTimeoutMs: 120000,
  },
  [RESOURCE_TASK_KIND.AGENT_MEMORY_COMPACTION]: {
    exclusive: true,
    priority: 96,
    minMemMb: 600,
    criticalMemMb: 300,
    degradable: false,
    deferable: true,
    fallbacks: [],
    queueTimeoutMs: 180000,
    runTimeoutMs: 180000,
  },
  [RESOURCE_TASK_KIND.EXPRESSION_HARVEST]: {
    exclusive: true,
    priority: 97,
    minMemMb: 600,
    criticalMemMb: 300,
    degradable: false,
    deferable: true,
    fallbacks: [],
    queueTimeoutMs: 180000,
    runTimeoutMs: 180000,
  },
  [RESOURCE_TASK_KIND.CONVERSATION_SUMMARY]: {
    exclusive: true,
    priority: 98,
    minMemMb: 600,
    criticalMemMb: 300,
    degradable: false,
    deferable: true,
    fallbacks: [],
    queueTimeoutMs: 120000,
    runTimeoutMs: 120000,
  },
  [RESOURCE_TASK_KIND.SENSITIVE_CACHE_ANALYSIS]: {
    exclusive: true,
    priority: 60,
    minMemMb: 600,
    criticalMemMb: 300,
    degradable: false,
    deferable: true,
    fallbacks: [],
    queueTimeoutMs: 120000,
    runTimeoutMs: 120000,
  },
  [RESOURCE_TASK_KIND.EMOTION_RENDER]: {
    exclusive: true,
    priority: 55,
    minMemMb: 600,
    criticalMemMb: 300,
    degradable: true,
    deferable: true,
    fallbacks: ['emotion_text'],
    queueTimeoutMs: 300000,
    runTimeoutMs: 180000,
  },
  [RESOURCE_TASK_KIND.BROWSER_ACTION]: {
    exclusive: true,
    priority: 50,
    minMemMb: 900,
    criticalMemMb: 600,
    degradable: false,
    deferable: true,
    fallbacks: [],
    queueTimeoutMs: 300000,
    runTimeoutMs: 300000,
  },
  [RESOURCE_TASK_KIND.VOICE_TTS_GENERATION]: {
    exclusive: true,
    priority: 65,
    minMemMb: 600,
    criticalMemMb: 300,
    degradable: false,
    deferable: false,
    fallbacks: [],
    queueTimeoutMs: 5000,
    runTimeoutMs: 60000,
  },
  [RESOURCE_TASK_KIND.DIAGNOSTIC_PROBE]: {
    exclusive: true,
    priority: 30,
    minMemMb: 600,
    criticalMemMb: 300,
    degradable: false,
    deferable: false,
    fallbacks: [],
    queueTimeoutMs: 5000,
    runTimeoutMs: 120000,
  },
  [RESOURCE_TASK_KIND.MCP_LOCAL_CHECK]: {
    exclusive: true,
    priority: 35,
    minMemMb: 600,
    criticalMemMb: 300,
    degradable: false,
    deferable: false,
    fallbacks: [],
    queueTimeoutMs: 5000,
    runTimeoutMs: 120000,
  },
  [RESOURCE_TASK_KIND.EXTERNAL_VIDEO_DOWNLOAD]: {
    exclusive: true,
    priority: 75,
    minMemMb: 600,
    criticalMemMb: 300,
    degradable: false,
    deferable: false,
    fallbacks: [],
    queueTimeoutMs: 5000,
    runTimeoutMs: 900000,
  },
  [RESOURCE_TASK_KIND.PET_BRIDGE_CHAT]: {
    exclusive: true,
    priority: 70,
    minMemMb: 600,
    criticalMemMb: 300,
    degradable: false,
    deferable: false,
    fallbacks: [],
    queueTimeoutMs: 5000,
    runTimeoutMs: 120000,
  },
  [RESOURCE_TASK_KIND.MEDIA_IMAGE_ANALYSIS]: {
    exclusive: false,
    priority: 80,
    minMemMb: 600,
    criticalMemMb: 300,
    degradable: false,
    deferable: true,
    fallbacks: [],
    queueTimeoutMs: 300000,
    runTimeoutMs: 180000,
  },
  [RESOURCE_TASK_KIND.MEDIA_FILE_ANALYSIS]: {
    exclusive: false,
    priority: 85,
    minMemMb: 600,
    criticalMemMb: 300,
    degradable: false,
    deferable: true,
    fallbacks: [],
    queueTimeoutMs: 300000,
    runTimeoutMs: 180000,
  },
  [RESOURCE_TASK_KIND.MEDIA_VOICE_TRANSCRIPTION]: {
    exclusive: false,
    priority: 88,
    minMemMb: 600,
    criticalMemMb: 300,
    degradable: false,
    deferable: true,
    fallbacks: [],
    queueTimeoutMs: 300000,
    runTimeoutMs: 180000,
  },
  [RESOURCE_TASK_KIND.NORMAL_CHAT]: {
    exclusive: false,
    priority: 90,
    minMemMb: 300,
    criticalMemMb: 300,
    degradable: false,
    deferable: false,
    fallbacks: [],
    queueTimeoutMs: 0,
    runTimeoutMs: 60000,
  },
  [RESOURCE_TASK_KIND.STATUS_QUERY]: {
    exclusive: false,
    priority: 1,
    minMemMb: 0,
    criticalMemMb: 0,
    degradable: false,
    deferable: false,
    fallbacks: [],
    queueTimeoutMs: 0,
    runTimeoutMs: 10000,
  },
}

// 解析有限数字，缺省或非法时返回 fallback。
function finiteNumber(value: unknown, fallback: number): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

// 归一任务预算，所有入口都应先调用这个函数。
function normalizeTaskBudget(input: TaskBudgetInput): TaskBudget {
  const kind = String(input.kind || 'unknown')
  const defaults = DEFAULT_BUDGETS[kind] || {}
  return {
    taskId: String(input.taskId || ''),
    kind,
    source: String(input.source || defaults.source || 'unknown'),
    channelKey: String(input.channelKey || ''),
    userId: String(input.userId || ''),
    exclusive: input.exclusive === undefined ? defaults.exclusive !== false : !!input.exclusive,
    priority: finiteNumber(input.priority, finiteNumber(defaults.priority, 50)),
    minMemMb: finiteNumber(input.minMemMb, finiteNumber(defaults.minMemMb, 600)),
    criticalMemMb: finiteNumber(input.criticalMemMb, finiteNumber(defaults.criticalMemMb, 300)),
    degradable: input.degradable === undefined ? !!defaults.degradable : !!input.degradable,
    deferable: input.deferable === undefined ? !!defaults.deferable : !!input.deferable,
    fallbacks: Array.isArray(input.fallbacks) ? input.fallbacks.map(String) : Array.isArray(defaults.fallbacks) ? defaults.fallbacks.map(String) : [],
    queueTimeoutMs: finiteNumber(input.queueTimeoutMs, finiteNumber(defaults.queueTimeoutMs, 300000)),
    runTimeoutMs: finiteNumber(input.runTimeoutMs, finiteNumber(defaults.runTimeoutMs, 300000)),
  }
}

export = {
  DEFAULT_BUDGETS,
  normalizeTaskBudget,
}
