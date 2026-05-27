/**
 * MODULE: Agent 工具配置。
 * 职责: 读写工具开关、按渠道暴露策略、工作区根目录。
 * 边界: 不执行工具、不调用 AI API。
 * 状态: configCache (object|null)。
 */
const fs = require('fs')
const fsp = require('fs/promises')
const path = require('path')
const { TOOL_CONFIG_FILE } = require('../core/constants') as typeof import('../core/constants')

type ChannelName = 'qq' | 'dashboard'

interface ChannelConfigInput {
  enabled?: unknown
  tools?: Record<string, unknown>
}

interface AgentConfigInput {
  version?: unknown
  channels?: Partial<Record<ChannelName, ChannelConfigInput>>
  dangerousPolicy?: unknown
  readFileRoots?: unknown
  autoRoute?: {
    qq?: { enabled?: unknown }
    dashboard?: { enabled?: unknown }
  }
  enabledSkills?: unknown
  persona?: {
    dashboardPersona?: unknown
    qqInheritChatPersona?: unknown
  }
  queue?: {
    maxGlobal?: unknown
    maxPerChannel?: unknown
    maxPendingPerUser?: unknown
    timeoutMs?: unknown
  }
  planMode?: {
    enabled?: unknown
    autoCreate?: unknown
  }
  push?: {
    enabled?: unknown
    dailyLimit?: unknown
  }
  cron?: {
    enabled?: unknown
    onceEnabled?: unknown
  }
  memory?: {
    enabled?: unknown
    adminOnly?: unknown
  }
  mcp?: {
    enabled?: unknown
    allowWriteWorkspace?: unknown
    allowRunLocal?: unknown
    exposeDangerousActions?: unknown
  }
}

interface ChannelConfig {
  enabled: boolean
  tools: Record<string, boolean>
}

interface AgentConfig {
  version: number
  channels: Record<ChannelName, ChannelConfig>
  dangerousPolicy: 'auto' | 'confirm' | 'block'
  autoRoute: {
    qq: { enabled: boolean }
    dashboard: { enabled: boolean }
  }
  enabledSkills: string[]
  persona: {
    dashboardPersona: string
    qqInheritChatPersona: boolean
  }
  readFileRoots: string[]
  queue: {
    maxGlobal: number
    maxPerChannel: number
    maxPendingPerUser: number
    timeoutMs: number
  }
  planMode: {
    enabled: boolean
    autoCreate: boolean
  }
  push: {
    enabled: boolean
    dailyLimit: number
  }
  cron: {
    enabled: boolean
    onceEnabled: boolean
  }
  memory: {
    enabled: boolean
    adminOnly: boolean
  }
  mcp: {
    enabled: boolean
    allowWriteWorkspace: boolean
    allowRunLocal: boolean
    exposeDangerousActions: boolean
  }
}

const KNOWN_CHANNELS = new Set<ChannelName>(['qq', 'dashboard'])
const MAX_TOOL_CONFIG_BYTES = 512 * 1024
const DEFAULT_CONFIG: AgentConfig = Object.freeze({
  version: 2,
  channels: {
    qq: {
      enabled: true,
      tools: {
        get_current_time: true,
        calculate: true,
        web_search: true,
        web_fetch: true,
        read_agent_skill: true,
        read_file: false,
        list_files: false,
        find_files: false,
        write_file: false,
        edit_file: false,
        execute_shell: false,
        browser_action: false,
        append_file: false,
        grep_search: false,
        execute_javascript: false,
        send_file_to_user: false,
        create_uploaded_file_variant: true,
        get_token_usage: true,
        set_user_timezone: false,
        query_logs: false,
        create_reminder: true,
        list_reminders: true,
        cancel_reminder: true,
        create_scheduled_task: true,
        list_scheduled_tasks: true,
        get_scheduled_task: true,
        pause_scheduled_task: true,
        resume_scheduled_task: true,
        delete_scheduled_task: true,
        run_scheduled_task_now: true,
        create_plan: true,
        update_task_status: true,
        check_plan_status: true,
        finish_plan: true,
        abandon_plan: true,
        read_image_history: true,
        analyze_historical_image: true,
        read_group_context: true,
        remember_memory: false,
        search_memory: false,
        forget_memory: false,
        list_memory: false,
        analyze_file: true,
      },
    },
    dashboard: {
      enabled: true,
      tools: {
        get_current_time: true,
        calculate: true,
        web_search: true,
        web_fetch: true,
        read_agent_skill: true,
        read_file: true,
        list_files: true,
        find_files: true,
        write_file: true,
        edit_file: true,
        execute_shell: true,
        browser_action: true,
        append_file: true,
        grep_search: true,
        execute_javascript: true,
        send_file_to_user: false,
        create_uploaded_file_variant: false,
        get_token_usage: true,
        set_user_timezone: true,
        query_logs: true,
        create_reminder: true,
        list_reminders: true,
        cancel_reminder: true,
        create_scheduled_task: true,
        list_scheduled_tasks: true,
        get_scheduled_task: true,
        pause_scheduled_task: true,
        resume_scheduled_task: true,
        delete_scheduled_task: true,
        run_scheduled_task_now: true,
        create_plan: true,
        update_task_status: true,
        check_plan_status: true,
        finish_plan: true,
        abandon_plan: true,
        read_image_history: true,
        analyze_historical_image: true,
        read_group_context: true,
        remember_memory: true,
        search_memory: true,
        forget_memory: true,
        list_memory: true,
        analyze_file: true,
      },
    },
  },
  dangerousPolicy: 'confirm',
  autoRoute: {
    qq: { enabled: false },
    dashboard: { enabled: false },
  },
  enabledSkills: [],
  persona: {
    dashboardPersona: '',
    qqInheritChatPersona: true,
  },
  readFileRoots: [],
  queue: {
    maxGlobal: 3,
    maxPerChannel: 3,
    maxPendingPerUser: 1,
    timeoutMs: 90000,
  },
  planMode: {
    enabled: true,
    autoCreate: false,
  },
  push: {
    enabled: false,
    dailyLimit: 5,
  },
  cron: {
    enabled: false,
    onceEnabled: true,
  },
  memory: {
    enabled: true,
    adminOnly: true,
  },
  mcp: {
    enabled: false,
    allowWriteWorkspace: false,
    allowRunLocal: false,
    exposeDangerousActions: false,
  },
}) as AgentConfig

let configCache: AgentConfig | null = null

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function isConfigRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function normalizeToolMap(value: unknown, defaults: Record<string, boolean>): Record<string, boolean> {
  const result = { ...defaults }
  if (!isConfigRecord(value)) return result
  for (const [name, enabled] of Object.entries(value)) {
    if (enabled === undefined) continue
    result[name] = !!enabled
  }
  return result
}

function normalizeChannelConfig(value: ChannelConfigInput | undefined, defaults: ChannelConfig): ChannelConfig {
  const src = isConfigRecord(value) ? value : {}
  return {
    enabled: src.enabled === undefined ? defaults.enabled : !!src.enabled,
    tools: normalizeToolMap(src.tools, defaults.tools),
  }
}

function normalizeRoot(root: unknown): string {
  const value = String(root || '').trim()
  if (!value) return ''
  return path.resolve(value)
}

function normalizeConfig(raw: AgentConfigInput = {}): AgentConfig {
  const source = isConfigRecord(raw) ? raw as AgentConfigInput : {}
  const sourceVersion = Number(source.version || 0)
  const defaults = clone(DEFAULT_CONFIG)
  const channels: Record<ChannelName, ChannelConfig> = {
    qq: normalizeChannelConfig(source.channels?.qq, defaults.channels.qq),
    dashboard: normalizeChannelConfig(source.channels?.dashboard, defaults.channels.dashboard),
  }
  if (!Number.isFinite(sourceVersion) || sourceVersion < 2) {
    channels.qq.tools.web_fetch = true
    channels.dashboard.tools.web_fetch = true
  }
  const dangerousPolicy = ['auto', 'confirm', 'block'].includes(String(source.dangerousPolicy || '')) ? String(source.dangerousPolicy || '') as AgentConfig['dangerousPolicy'] : defaults.dangerousPolicy
  const readFileRoots = Array.isArray(source.readFileRoots)
    ? source.readFileRoots.map(normalizeRoot).filter(Boolean).slice(0, 16)
    : defaults.readFileRoots
  const autoRoute = {
    qq: { enabled: source.autoRoute?.qq?.enabled === undefined ? defaults.autoRoute.qq.enabled : !!source.autoRoute.qq.enabled },
    dashboard: { enabled: source.autoRoute?.dashboard?.enabled === undefined ? defaults.autoRoute.dashboard.enabled : !!source.autoRoute.dashboard.enabled },
  }
  const enabledSkills = Array.isArray(source.enabledSkills)
    ? source.enabledSkills.map(item => String(item || '').trim()).filter(Boolean).slice(0, 32)
    : defaults.enabledSkills
  const persona = normalizePersonaConfig(source.persona, defaults.persona)
  const queue = normalizeQueueConfig(source.queue, defaults.queue)
  const planMode = normalizePlanModeConfig(source.planMode, defaults.planMode)
  const push = normalizePushConfig(source.push, defaults.push)
  const cron = {
    enabled: source.cron?.enabled === undefined ? defaults.cron.enabled : !!source.cron.enabled,
    onceEnabled: source.cron?.onceEnabled === undefined ? defaults.cron.onceEnabled : !!source.cron.onceEnabled,
  }
  const memory = {
    enabled: source.memory?.enabled === undefined ? defaults.memory.enabled : !!source.memory.enabled,
    adminOnly: source.memory?.adminOnly === undefined ? defaults.memory.adminOnly : !!source.memory.adminOnly,
  }
  const mcp = normalizeMcpConfig(source.mcp, defaults.mcp)
  return { version: 2, channels, dangerousPolicy, autoRoute, enabledSkills, persona, readFileRoots, queue, planMode, push, cron, memory, mcp }
}

function normalizeInteger(value: unknown, min: number, max: number, fallback: number): number {
  const number = parseInt(value as string, 10)
  if (!Number.isFinite(number)) return fallback
  return Math.max(min, Math.min(max, number))
}

function normalizeQueueConfig(value: AgentConfigInput['queue'], defaults: AgentConfig['queue']): AgentConfig['queue'] {
  const src = isConfigRecord(value) ? value : {}
  return {
    maxGlobal: normalizeInteger(src.maxGlobal, 1, 12, defaults.maxGlobal),
    maxPerChannel: normalizeInteger(src.maxPerChannel, 1, 20, defaults.maxPerChannel),
    maxPendingPerUser: normalizeInteger(src.maxPendingPerUser, 0, 10, defaults.maxPendingPerUser),
    timeoutMs: normalizeInteger(src.timeoutMs, 5000, 10 * 60 * 1000, defaults.timeoutMs),
  }
}

function normalizePersonaConfig(value: AgentConfigInput['persona'], defaults: AgentConfig['persona']): AgentConfig['persona'] {
  const src = isConfigRecord(value) ? value : {}
  return {
    dashboardPersona: String(src.dashboardPersona || defaults.dashboardPersona || '').trim().slice(0, 120),
    qqInheritChatPersona: src.qqInheritChatPersona === undefined ? defaults.qqInheritChatPersona !== false : !!src.qqInheritChatPersona,
  }
}

function normalizePlanModeConfig(value: AgentConfigInput['planMode'], defaults: AgentConfig['planMode']): AgentConfig['planMode'] {
  const src = isConfigRecord(value) ? value : {}
  return {
    enabled: src.enabled === undefined ? defaults.enabled : !!src.enabled,
    autoCreate: src.autoCreate === undefined ? defaults.autoCreate : !!src.autoCreate,
  }
}

function normalizePushConfig(value: AgentConfigInput['push'], defaults: AgentConfig['push']): AgentConfig['push'] {
  const src = isConfigRecord(value) ? value : {}
  return {
    enabled: src.enabled === undefined ? defaults.enabled : !!src.enabled,
    dailyLimit: normalizeInteger(src.dailyLimit, 0, 100, defaults.dailyLimit),
  }
}

function normalizeMcpConfig(value: AgentConfigInput['mcp'], defaults: AgentConfig['mcp']): AgentConfig['mcp'] {
  const src = isConfigRecord(value) ? value : {}
  return {
    enabled: src.enabled === undefined ? defaults.enabled : !!src.enabled,
    allowWriteWorkspace: src.allowWriteWorkspace === undefined ? defaults.allowWriteWorkspace : !!src.allowWriteWorkspace,
    allowRunLocal: src.allowRunLocal === undefined ? defaults.allowRunLocal : !!src.allowRunLocal,
    exposeDangerousActions: src.exposeDangerousActions === undefined ? defaults.exposeDangerousActions : !!src.exposeDangerousActions,
  }
}

function readConfigFile(): AgentConfigInput | null {
  try {
    const stat = fs.statSync(TOOL_CONFIG_FILE)
    if (!stat.isFile() || stat.size > MAX_TOOL_CONFIG_BYTES) return null
    const text = fs.readFileSync(TOOL_CONFIG_FILE, 'utf8').replace(/\uFEFF/g, '')
    return JSON.parse(text) as AgentConfigInput
  } catch {
    return null
  }
}

function getAgentConfig(force: boolean = false): AgentConfig {
  if (!force && configCache) return clone(configCache)
  configCache = normalizeConfig(readConfigFile() || DEFAULT_CONFIG)
  return clone(configCache)
}

async function saveAgentConfig(nextConfig: AgentConfigInput): Promise<AgentConfig> {
  const normalized = normalizeConfig(nextConfig)
  await fsp.mkdir(path.dirname(TOOL_CONFIG_FILE), { recursive: true })
  await fsp.writeFile(TOOL_CONFIG_FILE, JSON.stringify(normalized, null, 2), 'utf8')
  configCache = normalized
  return clone(normalized)
}

async function patchAgentConfig(patch: AgentConfigInput = {}): Promise<AgentConfig> {
  const current = getAgentConfig()
  const merged = {
    ...current,
    ...patch,
    channels: {
      ...current.channels,
      ...(patch.channels || {}),
    },
    persona: {
      ...current.persona,
      ...(patch.persona || {}),
    },
    mcp: {
      ...current.mcp,
      ...(patch.mcp || {}),
    },
  }
  return saveAgentConfig(merged)
}

async function setChannelEnabled(channel: string, enabled: unknown): Promise<AgentConfig> {
  if (!KNOWN_CHANNELS.has(channel as ChannelName)) throw new Error(`未知渠道：${channel}`)
  const current = getAgentConfig()
  current.channels[channel as ChannelName].enabled = !!enabled
  return saveAgentConfig(current)
}

async function setToolEnabled(channel: string, toolName: unknown, enabled: unknown): Promise<AgentConfig> {
  if (!KNOWN_CHANNELS.has(channel as ChannelName)) throw new Error(`未知渠道：${channel}`)
  const current = getAgentConfig()
  current.channels[channel as ChannelName].tools[String(toolName)] = !!enabled
  return saveAgentConfig(current)
}

function isChannelEnabled(channel: string): boolean {
  const config = getAgentConfig()
  return !!(config.channels[channel as ChannelName] && config.channels[channel as ChannelName].enabled)
}

function isToolEnabled(channel: string, toolName: string): boolean {
  const config = getAgentConfig()
  const channelConfig = config.channels[channel as ChannelName]
  if (!channelConfig || !channelConfig.enabled) return false
  return !!channelConfig.tools[toolName]
}

function getReadFileRoots(): string[] {
  return getAgentConfig().readFileRoots.map(normalizeRoot).filter(Boolean)
}

function getDangerousPolicy(): AgentConfig['dangerousPolicy'] {
  return getAgentConfig().dangerousPolicy
}

function isAutoRouteEnabled(channel: ChannelName = 'qq'): boolean {
  const config = getAgentConfig()
  return !!(config.autoRoute && config.autoRoute[channel] && config.autoRoute[channel].enabled)
}

function getEnabledSkills(): string[] {
  return getAgentConfig().enabledSkills.slice()
}

function getAgentPersonaConfig(): AgentConfig['persona'] {
  return getAgentConfig().persona
}

function resetAgentConfigCache(): void {
  configCache = null
}

export = {
  DEFAULT_CONFIG,
  getAgentConfig,
  saveAgentConfig,
  patchAgentConfig,
  setChannelEnabled,
  setToolEnabled,
  isChannelEnabled,
  isToolEnabled,
  getReadFileRoots,
  getDangerousPolicy,
  isAutoRouteEnabled,
  getEnabledSkills,
  getAgentPersonaConfig,
  resetAgentConfigCache,
}
