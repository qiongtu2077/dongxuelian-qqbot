export interface ApiEnvelope {
  ok?: boolean
  code?: string
  message?: string
}

export type ApiResult<T extends ApiEnvelope> = {
  ok: boolean
  data: T | null
  code?: string
  message?: string
}

export type SafetyMode = 'auto' | 'confirm' | 'block' | 'config' | string

export type AgentChannel = 'qq' | 'dashboard'

export interface AgentPersonaConfig {
  dashboardPersona?: string
  qqInheritChatPersona?: boolean
}

export interface AgentChannelConfig {
  enabled?: boolean
  tools?: Record<string, boolean>
}

export interface AgentRuntimeConfig {
  version?: string | number
  channels: Record<AgentChannel, AgentChannelConfig>
  dangerousPolicy?: string
  autoRoute: Record<AgentChannel, { enabled?: boolean }>
  enabledSkills: string[]
  persona: AgentPersonaConfig
  readFileRoots?: string[]
  queue: {
    maxGlobal: number
    maxPerChannel: number
    maxPendingPerUser: number
    timeoutMs: number
  }
  planMode: { enabled?: boolean; autoCreate?: boolean }
  push: { enabled?: boolean; dailyLimit: number }
  cron: { enabled?: boolean; onceEnabled?: boolean }
  memory: { enabled?: boolean; adminOnly?: boolean }
  mcp?: {
    enabled?: boolean
    allowWriteWorkspace?: boolean
    allowRunLocal?: boolean
    exposeDangerousActions?: boolean
  }
}

export interface AgentToolSummary {
  name: string
  description?: string
  dangerous?: boolean
  external?: boolean
  write?: boolean
  readOnly?: boolean
}

export interface AgentSkillSummary {
  name: string
  description?: string
  kind?: string
  references?: unknown[]
}

export interface AgentPersonaEntry {
  name: string
  description?: string
  lore?: string
}

export interface AgentToolDetailStats {
  total: number
}

export interface AgentStats {
  total?: number
  successRate?: number
  avgDurationMs?: number
  totalTokens?: number
  byToolDetail?: Record<string, AgentToolDetailStats>
}

export interface AgentQueueStats {
  activeCount?: number
  waitingCount?: number
  timeoutCount?: number
}

export interface AgentConfigResponse extends ApiEnvelope {
  config: AgentRuntimeConfig
  mode: SafetyMode
  stats?: AgentStats
  tools: AgentToolSummary[]
  skills: AgentSkillSummary[]
  personas: AgentPersonaEntry[]
  effectiveReadRoots: string[]
}

export interface SaveAgentConfigPayload {
  config: AgentRuntimeConfig
  mode?: SafetyMode
}

export interface SaveAgentConfigResponse extends ApiEnvelope {
  config: AgentRuntimeConfig
  mode: SafetyMode
}

export interface AgentPersonasResponse extends ApiEnvelope {
  personas: AgentPersonaEntry[]
  persona: AgentPersonaConfig
}

export interface SaveAgentPersonaResponse extends ApiEnvelope {
  persona: AgentPersonaConfig
}

export interface ChatHistoryItem {
  role: 'user' | 'assistant' | 'system'
  content: string
}

export interface AgentRoundRecord {
  reasoning: string | null
  toolCalls: Array<{ name: string; args: Record<string, unknown> }>
  toolResults?: Array<{ name: string; result: string; ok: boolean }>
}

export interface AgentChatResponse extends ApiEnvelope {
  async?: boolean
  taskId?: string
  status?: string
  reply?: string
  result?: string
  pendingId?: string
  rounds?: AgentRoundRecord[]
  toolName?: string
}

export interface PendingToolListItem {
  id: string
  toolName: string
  channel?: string
  channelKey?: string
  userId?: string
  argsSummary?: string
}

export interface PendingToolsResponse extends ApiEnvelope {
  pending: PendingToolListItem[]
}

export interface AgentSessionSummary {
  id: string
  title?: string
  toolCalls?: number
}

export interface AgentSessionsResponse extends ApiEnvelope {
  sessions: AgentSessionSummary[]
}

export interface AgentStatsResponse extends ApiEnvelope {
  stats: AgentStats
}

export interface AgentQueueResponse extends ApiEnvelope {
  queue: AgentQueueStats
}

export interface AgentWorkspaceFileItem {
  path: string
  rel?: string
  name?: string
  type: 'dir' | 'file' | 'other'
  size?: number
  mtimeMs: number
  injectable?: boolean
}

export interface AgentWorkspaceFilePreview extends AgentWorkspaceFileItem {
  binary?: boolean
  content?: string
  truncated?: boolean
}

export interface AgentFilesResponse extends ApiEnvelope {
  root: string
  files: AgentWorkspaceFileItem[]
}

export interface AgentFilePreviewResponse extends ApiEnvelope {
  file: AgentWorkspaceFilePreview
}

export interface AgentFileUploadPayload {
  root?: string
  name: string
  content: string
}

export interface AgentFileUploadResponse extends ApiEnvelope {
  file?: {
    path: string
    name: string
    size: number
  }
}

export interface AgentPlanTask {
  id: string
  state: string
}

export interface AgentPlan {
  id: string
  title?: string
  state?: string
  channel?: string
  channelKey?: string
  tasks: AgentPlanTask[]
}

export interface AgentPlanResponse extends ApiEnvelope {
  plan?: AgentPlan
  reply?: string
}

export interface AgentPlansResponse extends ApiEnvelope {
  plans: AgentPlan[]
}

export interface AgentCronDraft {
  id: string
  schedule: string
  type: string
  prompt: string
  targetChannel: string
  enabled: boolean
}

export interface AgentCronEntry extends AgentCronDraft {
  lastRunAt?: number
  nextRunAt?: number
}

export interface AgentCronHistoryEntry {
  id: string
  ok?: boolean
  result?: string
  at?: number
}

export interface AgentCronsResponse extends ApiEnvelope {
  crons: AgentCronEntry[]
  history: AgentCronHistoryEntry[]
}

export interface AgentPushLogEntry {
  ok?: boolean
  reason?: string
  channelKey?: string
  at: number
  preview?: string
  error?: string
}

export interface AgentPushLogResponse extends ApiEnvelope {
  log: AgentPushLogEntry[]
}

export interface AgentEnvFileStatus {
  name: string
  configured?: boolean
  size?: number
}

export interface AgentRuntimeSummary {
  provider?: string
  model?: string
  apiKeyConfigured?: boolean
  searchEnabled?: boolean
}

export interface AgentEnvResponse extends ApiEnvelope {
  env: AgentEnvFileStatus[]
  runtime: AgentRuntimeSummary
}

export interface ShellGuardCategoryInfo {
  category: string
  label?: string
  description?: string
  count?: number
}

export interface AgentShellGuardResponse extends ApiEnvelope {
  enabled?: boolean
  ruleCount?: number
  categories: ShellGuardCategoryInfo[]
}

export interface AdminVerifyResponse extends ApiEnvelope {
  token?: string
  accessToken?: string
}
