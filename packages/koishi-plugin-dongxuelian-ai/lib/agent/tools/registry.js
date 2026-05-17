/**
 * MODULE: Agent 工具注册器。
 * 职责: 聚合工具定义、按渠道过滤、executeTool 分发。
 * 边界: 不调 AI API、不读配置、不存用户状态。
 * 状态: toolRegistry (module-level const)。
 */
const getTimeTool = require('./get-time')
const calculatorTool = require('./calculator')
const webSearchTool = require('./web-search')
const readAgentSkillTool = require('./read-agent-skill')
const readFileTool = require('./read-file')
const listFilesTool = require('./list-files')
const findFilesTool = require('./find-files')
const writeFileTool = require('./write-file')
const editFileTool = require('./edit-file')
const shellTool = require('./shell')
const browserActionTool = require('./browser-action')
const appendFileTool = require('./append-file')
const grepSearchTool = require('./grep-search')
const executeJavascriptTool = require('./execute-javascript')
const sendFileToUserTool = require('./send-file-to-user')
const getTokenUsageTool = require('./get-token-usage')
const setUserTimezoneTool = require('./set-user-timezone')
const queryLogsTool = require('./query-logs')
const readImageUrlsTool = require('./read-image-urls')
const analyzeImageTool = require('./analyze-image')
const planTools = require('../plan/plan-tools')
const memoryTools = require('./memory-tools')
const { getAgentConfig } = require('../config')

const tools = [getTimeTool, calculatorTool, webSearchTool, readAgentSkillTool, readFileTool, listFilesTool, findFilesTool, writeFileTool, editFileTool, shellTool, browserActionTool, appendFileTool, grepSearchTool, executeJavascriptTool, sendFileToUserTool, getTokenUsageTool, setUserTimezoneTool, queryLogsTool, readImageUrlsTool, analyzeImageTool, ...planTools.tools, ...memoryTools.tools]

const TOOL_TIMEOUT_MS = 90000

const toolRegistry = {}
for (const tool of tools) {
  toolRegistry[tool.definition.name] = tool
}

/** 按渠道过滤，返回 OpenAI 标准格式的工具定义 */
function getToolDefinitions(channel = 'qq') {
  const config = getAgentConfig()
  const channelConfig = config.channels[channel]
  if (!channelConfig || !channelConfig.enabled) return []
  return tools
    .filter(t => {
      const name = t.definition.name
      const channels = t.defaultChannels || ['dashboard', 'qq']
      return channels.includes(channel) && !!channelConfig.tools[name]
    })
    .map(t => ({ type: 'function', function: t.definition }))
}

/** 安全执行工具：超时 + 错误包裹 */
async function executeTool(toolName, params = {}, context = {}) {
  const tool = toolRegistry[toolName]
  if (!tool) return { ok: false, text: `未知工具：${toolName}`, error: `未知工具：${toolName}` }

  let timeoutId = null
  try {
    const timeoutPromise = new Promise((_, reject) => {
      timeoutId = setTimeout(() => reject(new Error('执行超时')), TOOL_TIMEOUT_MS)
    })
    const result = await Promise.race([tool.execute(params, context), timeoutPromise])

    if (result && typeof result === 'object' && !Array.isArray(result)) {
      const text = typeof result.text === 'string' ? result.text : JSON.stringify(result, null, 2)
      return { ok: result.ok !== false, text, error: result.error || '', fallbackTool: result.fallbackTool || null }
    }
    const text = typeof result === 'string' ? result : JSON.stringify(result, null, 2)
    return { ok: true, text }
  } catch (err) {
    const message = `工具 '${toolName}' 执行失败: ${err.message}`
    return { ok: false, text: message, error: err.message }
  } finally {
    if (timeoutId) clearTimeout(timeoutId)
  }
}

function getToolCount() { return tools.length }

function getToolSummaries(channel = '') {
  const config = getAgentConfig()
  return tools.map(tool => {
    const name = tool.definition.name
    const defaultChannels = tool.defaultChannels || ['dashboard', 'qq']
    const channels = {}
    for (const key of Object.keys(config.channels || {})) channels[key] = !!config.channels[key]?.tools?.[name]
    return {
      name,
      description: tool.definition.description || '',
      dangerous: !!tool.dangerous,
      readOnly: !tool.dangerous && !/write|edit|append|shell|javascript|browser|cookie|memory|plan/i.test(name),
      write: /write|edit|append|shell|javascript|remember|forget|create_plan|update_task_status|finish_plan|abandon_plan/i.test(name),
      external: name === 'web_search' || name === 'browser_action',
      defaultChannels,
      channels,
      enabled: channel ? !!config.channels?.[channel]?.tools?.[name] : undefined,
    }
  })
}

module.exports = { getToolDefinitions, executeTool, toolRegistry, getToolCount, getToolSummaries }
