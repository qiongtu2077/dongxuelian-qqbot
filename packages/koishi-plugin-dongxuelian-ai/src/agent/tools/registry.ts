/**
 * MODULE: Agent 工具注册器。
 * 职责: 聚合工具定义、按渠道过滤、executeTool 分发。
 * 边界: 不调 AI API、不读配置、不存用户状态。
 * 状态: toolRegistry (module-level const)。
 */
const getTimeTool = require('./get-time') as typeof import('./get-time') & AgentTool
const calculatorTool = require('./calculator') as typeof import('./calculator') & AgentTool
const webSearchTool = require('./web-search') as typeof import('./web-search') & AgentTool
const webFetchTool = require('./web-fetch') as typeof import('./web-fetch') & AgentTool
const readAgentSkillTool = require('./read-agent-skill') as typeof import('./read-agent-skill') & AgentTool
const readFileTool = require('./read-file') as typeof import('./read-file') & AgentTool
const listFilesTool = require('./list-files') as typeof import('./list-files') & AgentTool
const findFilesTool = require('./find-files') as typeof import('./find-files') & AgentTool
const writeFileTool = require('./write-file') as typeof import('./write-file') & AgentTool
const editFileTool = require('./edit-file') as typeof import('./edit-file') & AgentTool
const shellTool = require('./shell') as typeof import('./shell') & AgentTool
const browserActionTool = require('./browser-action') as typeof import('./browser-action') & AgentTool
const appendFileTool = require('./append-file') as typeof import('./append-file') & AgentTool
const grepSearchTool = require('./grep-search') as typeof import('./grep-search') & AgentTool
const executeJavascriptTool = require('./execute-javascript') as typeof import('./execute-javascript') & AgentTool
const sendFileToUserTool = require('./send-file-to-user') as typeof import('./send-file-to-user') & AgentTool
const createUploadedFileVariantTool = require('./create-uploaded-file-variant') as typeof import('./create-uploaded-file-variant') & AgentTool
const getTokenUsageTool = require('./get-token-usage') as typeof import('./get-token-usage') & AgentTool
const setUserTimezoneTool = require('./set-user-timezone') as typeof import('./set-user-timezone') & AgentTool
const queryLogsTool = require('./query-logs') as typeof import('./query-logs') & AgentTool
const reminderTools = require('./reminder-tools') as typeof import('./reminder-tools') & ToolGroup
const scheduledTaskTools = require('./scheduled-task-tools') as typeof import('./scheduled-task-tools') & ToolGroup
const readImageUrlsTool = require('./read-image-urls') as typeof import('./read-image-urls') & AgentTool
const analyzeImageTool = require('./analyze-image') as typeof import('./analyze-image') & AgentTool
const analyzeFileTool = require('./analyze-file') as typeof import('./analyze-file') & AgentTool
const planTools = require('../plan/plan-tools') as typeof import('../plan/plan-tools')
const memoryTools = require('./memory-tools') as typeof import('./memory-tools') & ToolGroup
const { getAgentConfig } = require('../config') as typeof import('../config')

interface AgentToolDefinition {
  name: string
  description?: string
}

interface AgentTool {
  definition: AgentToolDefinition
  execute: (params?: Record<string, unknown>, context?: Record<string, unknown>) => Promise<unknown> | unknown
  dangerous?: boolean
  defaultChannels?: string[]
}

interface ToolGroup {
  tools: AgentTool[]
}

interface AgentChannelConfig {
  enabled?: boolean
  tools?: Record<string, boolean>
}

interface AgentToolsConfig {
  channels: Record<string, AgentChannelConfig>
}

interface ToolExecuteResult {
  ok: boolean
  text: string
  error?: string
  fallbackTool?: unknown
}

interface ToolSummary {
  name: string
  description: string
  dangerous: boolean
  readOnly: boolean
  write: boolean
  external: boolean
  defaultChannels: string[]
  channels: Record<string, boolean>
  enabled?: boolean
}

interface ToolObjectResult {
  ok?: boolean
  text?: unknown
  error?: unknown
  fallbackTool?: unknown
  [key: string]: unknown
}

type RegistryChannelName = 'qq' | 'dashboard'

const tools: AgentTool[] = [getTimeTool, calculatorTool, webSearchTool, webFetchTool, readAgentSkillTool, readFileTool, listFilesTool, findFilesTool, writeFileTool, editFileTool, shellTool, browserActionTool, appendFileTool, grepSearchTool, executeJavascriptTool, sendFileToUserTool, createUploadedFileVariantTool, getTokenUsageTool, setUserTimezoneTool, queryLogsTool, ...reminderTools.tools, ...scheduledTaskTools.tools, readImageUrlsTool, analyzeImageTool, analyzeFileTool, ...planTools.tools as AgentTool[], ...memoryTools.tools]

const TOOL_TIMEOUT_MS = 90000

/** 记忆相关工具：当 memory.enabled=false 时整体从工具定义中隐藏 */
const MEMORY_TOOL_NAMES: Set<string> = new Set(['remember_memory', 'search_memory', 'forget_memory', 'list_memory'])

const toolRegistry: Record<string, AgentTool> = {}
for (const tool of tools) {
  toolRegistry[tool.definition.name] = tool
}

function normalizeRegistryChannel(channel: string): RegistryChannelName | null {
  return channel === 'qq' || channel === 'dashboard' ? channel : null
}

/** 按渠道过滤，返回 OpenAI 标准格式的工具定义 */
function getToolDefinitions(channel: string = 'qq'): Array<{ type: 'function'; function: AgentToolDefinition }> {
  const config = getAgentConfig()
  const registryChannel = normalizeRegistryChannel(channel)
  const channelConfig = registryChannel ? config.channels[registryChannel] : null
  if (!channelConfig || !channelConfig.enabled) return []
  const memoryDisabled = config.memory?.enabled === false
  return tools
    .filter(t => {
      const name = t.definition.name
      if (memoryDisabled && MEMORY_TOOL_NAMES.has(name)) return false
      const channels = t.defaultChannels || ['dashboard', 'qq']
      return channels.includes(channel) && !!channelConfig.tools[name]
    })
    .map(t => ({ type: 'function', function: t.definition }))
}

/** 安全执行工具：超时 + 错误包裹 */
function getRegistryErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error || '')
}

async function executeTool(toolName: string, params: Record<string, unknown> = {}, context: Record<string, unknown> = {}): Promise<ToolExecuteResult> {
  const tool = toolRegistry[toolName]
  if (!tool) return { ok: false, text: `未知工具：${toolName}`, error: `未知工具：${toolName}` }

  let timeoutId = null
  const abortController = new AbortController()
  try {
    const timeoutPromise = new Promise((_, reject) => {
      timeoutId = setTimeout(() => {
        abortController.abort()
        reject(new Error('执行超时'))
      }, TOOL_TIMEOUT_MS)
    })
    const enrichedContext = { ...context, signal: abortController.signal }
    const result = await Promise.race([tool.execute(params, enrichedContext), timeoutPromise])

    if (result && typeof result === 'object' && !Array.isArray(result)) {
      const objectResult = result as ToolObjectResult
      const text = typeof objectResult.text === 'string' ? objectResult.text : JSON.stringify(objectResult, null, 2)
      return { ok: objectResult.ok !== false, text, error: String(objectResult.error || ''), fallbackTool: objectResult.fallbackTool || null }
    }
    const text = typeof result === 'string' ? result : JSON.stringify(result, null, 2)
    return { ok: true, text }
  } catch (err) {
    const errorMessage = getRegistryErrorMessage(err)
    const message = `工具 '${toolName}' 执行失败: ${errorMessage}`
    return { ok: false, text: message, error: errorMessage }
  } finally {
    if (timeoutId) clearTimeout(timeoutId)
    abortController.abort()
  }
}

function getToolCount() { return tools.length }

function getToolSummaries(channel: string = ''): ToolSummary[] {
  const config = getAgentConfig()
  const selectedChannel = normalizeRegistryChannel(channel)
  return tools.map(tool => {
    const name = tool.definition.name
    const defaultChannels = tool.defaultChannels || ['dashboard', 'qq']
    const channels: Record<string, boolean> = {}
    for (const key of Object.keys(config.channels || {}) as RegistryChannelName[]) channels[key] = !!config.channels[key]?.tools?.[name]
    const dangerous = !!tool.dangerous
    const external = name === 'web_search' || name === 'web_fetch' || name === 'browser_action'
    const write = dangerous || /write|edit|append|shell|javascript|remember|forget|create_plan|create_reminder|cancel_reminder|create_scheduled_task|create_uploaded_file_variant|send_file_to_user|update_task_status|finish_plan|abandon_plan/i.test(name)
    return {
      name,
      description: tool.definition.description || '',
      dangerous,
      readOnly: !dangerous && !write && !external,
      write,
      external,
      defaultChannels,
      channels,
      enabled: channel ? !!(selectedChannel && config.channels[selectedChannel]?.tools?.[name]) : undefined,
    }
  })
}

export = { getToolDefinitions, executeTool, toolRegistry, getToolCount, getToolSummaries }
