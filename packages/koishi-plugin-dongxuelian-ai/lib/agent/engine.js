/**
 * MODULE: Agent ReAct 引擎。
 * 职责: 构建 Agent 消息、调用 LLM + tools、循环推理-执行。
 * 边界: 不使用 chat.js 的 system prompt 构建逻辑；不写 conversation.js。
 * 状态: 无模块级状态（每次 run() 新建循环局部变量）。
 */
const { requestChatCompletions } = require('../api')
const { loadConfig } = require('../runtime-config')
const { getToolDefinitions, executeTool, toolRegistry } = require('./tools/registry')
const { estimateTokens, externalizeToolResult, compactWithLLM } = require('./context')
const { recordCall } = require('./stats')
const safety = require('./safety')
const pending = require('./pending')
const { isChannelEnabled, getEnabledSkills } = require('./config')
const { buildAgentSkillSummary } = require('./skills')
const { buildAgentMessages } = require('./messages')
const { buildAgentPersonaContext, mergeAgentSystemExtra } = require('./persona-context')
const { buildAgentWorkspaceContext } = require('./workspace-context')
const { getAgentPathAllowedRoots } = require('./path-guard')
const { recordAgentSession } = require('./sessions')
const { onAgentReplyComplete } = require('./auto-memory')
const { MAX_TOOL_ROUNDS } = require('../constants')

const MAX_ROUNDS = MAX_TOOL_ROUNDS
const MAX_TOOLS_PER_ROUND = 3
const MAX_WEB_SEARCH_CALLS = 3

function normalizeToolCall(toolName, args = {}) {
  return {
    id: `tool_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    type: 'function',
    function: { name: toolName, arguments: JSON.stringify(args || {}) },
  }
}

async function executeAgentToolCall({ tc, messages, allowedToolNames, channel, channelKey, userId, userName, userMessage, toolCount, bot }) {
  let args = {}
  try { args = JSON.parse(tc.function.arguments || '{}') } catch {}
  const toolName = tc.function.name

  if (!allowedToolNames.has(toolName)) {
    return {
      status: 'done',
      result: `工具 '${toolName}' 当前渠道未启用，拒绝执行。请在 Dashboard 的 Agent 工具开关里启用 ${toolName}。`,
      toolCount,
    }
  }

  const safeResult = safety.check(toolName)
  if (!safeResult.allowed) {
    if (safeResult.action === 'confirm' && userId && channelKey) {
      const resume = {
        messages: messages.slice(-24),
        toolCallId: tc.id,
        userMessage,
        userName,
        toolCount,
      }
      const pendingId = pending.setPendingTool(channelKey, userId, { toolName, args, channel, resume })
      const argsSummary = pending.summarizePendingArgs ? pending.summarizePendingArgs(toolName, args) : toolName
      const replyText = `工具 '${toolName}' 需要确认（ID: ${pendingId}）。参数：${argsSummary}\n请回复“确认工具 ${pendingId}”来执行。`
      return { status: 'pending', reply: replyText, pendingId, toolCount }
    }
    return { status: 'done', result: safeResult.error, toolCount }
  }

  try {
    const startedAt = Date.now()
    const execResult = await executeTool(toolName, args, { channel, channelKey, userId, userName, userMessage, bot })
    let nextToolCount = toolCount
    recordCall(toolName, channel, { ok: execResult.ok, durationMs: Date.now() - startedAt, tokens: estimateTokens([{ role: 'tool', content: execResult.text }]) })
    if (execResult.ok) nextToolCount++
    if (execResult.fallbackTool && execResult.fallbackTool.name) {
      return {
        status: 'fallback',
        result: execResult.text,
        fallbackCall: normalizeToolCall(execResult.fallbackTool.name, execResult.fallbackTool.args || {}),
        toolCount: nextToolCount,
      }
    }
    return { status: 'done', result: execResult.text, toolCount: nextToolCount }
  } catch (error) {
    return { status: 'done', result: `工具 '${toolName}' 执行失败: ${error.message || error}`, toolCount }
  }
}

const COMPRESS_TOOL_RESULT_THRESHOLD = 1500

function compressOldToolResults(messages, currentRound) {
  let toolMsgCount = 0
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role !== 'tool') continue
    toolMsgCount++
    const totalToolMsgs = messages.filter(m => m.role === 'tool').length
    if (toolMsgCount >= totalToolMsgs - 1) break
    const content = messages[i].content || ''
    if (content.length > COMPRESS_TOOL_RESULT_THRESHOLD) {
      messages[i] = { ...messages[i], content: content.slice(0, 400) + '\n...[已截断旧工具结果]...' }
    }
  }
}

async function continueAgent({ messages, config, tools, allowedToolNames, channel, channelKey, userId, userName, userMessage, toolCount = 0, toolResults = [], onProgress, bot, enableThinking = false }) {
  let reply = ''
  const rounds = []
  for (let round = 0; round < MAX_ROUNDS; round++) {
    let response
    try {
      response = await requestChatCompletions(messages, config, { _thinkingEnabled: enableThinking }, tools)
    } catch (error) {
      reply = `Agent 调用模型失败：${error.message || error}`
      break
    }

    if (typeof response === 'string') { reply = response; break }

    if (response.type === 'text') {
      reply = response.content || ''
      rounds.push({ round, reasoning: enableThinking ? (response.reasoning || '') : '', toolCalls: [], toolResults: [] })
      break
    }

    const { tool_calls, message: assistantMsg } = response
    if (!tool_calls || tool_calls.length === 0) {
      reply = assistantMsg?.content || ''
      rounds.push({ round, reasoning: enableThinking ? (response.reasoning || '') : '', toolCalls: [], toolResults: [] })
      break
    }

    const activeToolCalls = tool_calls.slice(0, MAX_TOOLS_PER_ROUND)
    messages.push({
      role: 'assistant',
      content: assistantMsg?.content || null,
      tool_calls: activeToolCalls.map(tc => ({
        id: tc.id, type: 'function',
        function: { name: tc.function.name, arguments: tc.function.arguments },
      })),
    })

    const roundToolCalls = activeToolCalls.map(tc => ({
      id: tc.id,
      name: tc.function.name,
      args: (() => { try { return JSON.parse(tc.function.arguments || '{}') } catch { return {} } })(),
    }))
    const roundToolResults = []

    for (const tc of activeToolCalls) {
      let currentCall = tc
      let fallbackDepth = 0

      // 多轮搜索限制：preExecuteTools + 循环中的 web_search 总次数超过上限时，阻止继续搜索
      if (tc.function.name === 'web_search') {
        const webSearchTotal = toolResults.filter(t => t.name === 'web_search').length + 1
        if (webSearchTotal > MAX_WEB_SEARCH_CALLS) {
          const blockMsg = `web_search 已调用 ${webSearchTotal - 1} 次。请基于现有搜索结果给出最佳回答，不要再调用搜索。`
          roundToolResults.push({ name: 'web_search', result: blockMsg, status: 'done' })
          messages.push({ role: 'tool', tool_call_id: tc.id, content: externalizeToolResult(blockMsg, 'web_search') })
          continue
        }
      }
      while (currentCall && fallbackDepth < 2) {
        const outcome = await executeAgentToolCall({ tc: currentCall, messages, allowedToolNames, channel, channelKey, userId, userName, userMessage, toolCount, bot })
        toolCount = outcome.toolCount
        if (outcome.status === 'pending') {
          rounds.push({ round, reasoning: response.reasoning || '', toolCalls: roundToolCalls, toolResults: roundToolResults })
          recordAgentSession({ channel, channelKey, userId, userName, userMessage, reply: outcome.reply, toolCalls: toolCount, pendingId: outcome.pendingId })
          return { reply: outcome.reply, toolCalls: toolCount, pendingId: outcome.pendingId, toolResults, rounds }
        }
        const resultText = String(outcome.result || '').slice(0, 8000)
        toolResults.push({ name: currentCall.function.name, result: resultText })
        roundToolResults.push({ name: currentCall.function.name, result: resultText, status: outcome.status })
        messages.push({ role: 'tool', tool_call_id: currentCall.id, content: externalizeToolResult(outcome.result, currentCall.function.name) })
        if (outcome.status !== 'fallback' || !outcome.fallbackCall) break
        currentCall = outcome.fallbackCall
        messages.push({
          role: 'assistant',
          content: null,
          tool_calls: [{
            id: currentCall.id,
            type: currentCall.type,
            function: { name: currentCall.function.name, arguments: currentCall.function.arguments },
          }],
        })
        fallbackDepth++
      }
    }

    rounds.push({ round, reasoning: response.reasoning || '', toolCalls: roundToolCalls, toolResults: roundToolResults })

    if (round >= 2) compressOldToolResults(messages, round)

    let estimated = estimateTokens(messages)
    if (estimated > 60000) {
      messages.splice(0, messages.length, ...await compactWithLLM(messages, config, requestChatCompletions))
      estimated = estimateTokens(messages)
    }
    if (estimated > 80000) { reply = '(上下文过大，Agent 已中止)'; break }
    if (onProgress) onProgress({ type: 'round', round, toolCount, estimatedTokens: estimated }, round)
  }

  if (!reply) reply = '(Agent 未获取到有效回复)'
  recordAgentSession({ channel, channelKey, userId, userName, userMessage, reply, toolCalls: toolCount, pendingId: null })
  return { reply, toolCalls: toolCount, pendingId: null, toolResults, rounds }
}

/**
 * @param {object} opts
 * @param {string} opts.userMessage - 用户输入文本
 * @param {string} opts.userName - 用户名称
 * @param {string} opts.userId - 用户 ID（用于 pending 隔离）
 * @param {string} opts.channelKey - 频道 key（用于 pending 隔离）
 * @param {string} [opts.channel='qq'] - 渠道: 'qq' | 'dashboard'
 * @param {object} [opts.systemExtra=[]] - 额外 system 消息
 * @param {Array} [opts.history=[]] - 额外对话历史
 * @param {object} [opts.onProgress] - 每轮回调
 * @param {object} [opts.bot] - 可选 Koishi bot，用于计划完成/cron 等主动推送
 * @returns {{ reply: string, toolCalls: number, pendingId: string|null }}
 */
function ensureToolDefinition(tools, toolName) {
  if (!toolRegistry[toolName] || tools.some(item => item.function && item.function.name === toolName)) return tools
  return [...tools, { type: 'function', function: toolRegistry[toolName].definition }]
}

function getForceToolSet(forceTools) {
  return new Set((Array.isArray(forceTools) ? forceTools : []).filter(name => toolRegistry[name]))
}

async function runAgent({ userMessage, userName, userId, channelKey, channel = 'qq', systemExtra = [], history = [], forceTools = [], preExecuteTools = [], onProgress, bot, enableThinking = false, agentMode = false }) {
  if (!isChannelEnabled(channel)) return { reply: '(Agent 已关闭)', toolCalls: 0, pendingId: null }
  let tools = getToolDefinitions(channel)
  const forceToolSet = getForceToolSet(forceTools)
  for (const toolName of forceToolSet) tools = ensureToolDefinition(tools, toolName)
  const allowedToolNames = new Set(tools.map(item => item.function && item.function.name).filter(Boolean))
  const config = await loadConfig()
  const roots = channel === 'dashboard' ? await getAgentPathAllowedRoots() : []
  const skillSummary = buildAgentSkillSummary(getEnabledSkills(), { query: userMessage })
  const personaExtra = buildAgentPersonaContext({ channel, channelKey, userId, agentMode })
  const workspaceExtra = await buildAgentWorkspaceContext({ userMessage, channel, roots })
  const allSystemExtra = mergeAgentSystemExtra(personaExtra, workspaceExtra, systemExtra, skillSummary ? [{ role: 'system', content: skillSummary }] : [])
  const messages = buildAgentMessages({ userMessage, userName, tools, systemExtra: allSystemExtra, history, agentMode })
  const toolResults = []
  for (const item of Array.isArray(preExecuteTools) ? preExecuteTools : []) {
    if (!item || !item.name) continue
    if (forceToolSet.has(item.name)) allowedToolNames.add(item.name)
    const call = normalizeToolCall(item.name, item.args || {})
    messages.push({
      role: 'assistant',
      content: null,
      tool_calls: [{ id: call.id, type: call.type, function: call.function }],
    })
    const outcome = await executeAgentToolCall({ tc: call, messages, allowedToolNames, channel, channelKey, userId, userName, userMessage, toolCount: 0, bot })
    if (outcome.status === 'pending') {
      recordAgentSession({ channel, channelKey, userId, userName, userMessage, reply: outcome.reply, toolCalls: 0, pendingId: outcome.pendingId })
      return { reply: outcome.reply, toolCalls: 0, pendingId: outcome.pendingId, toolResults }
    }
    toolResults.push({ name: call.function.name, result: String(outcome.result || '').slice(0, 8000) })
    messages.push({ role: 'tool', tool_call_id: call.id, content: externalizeToolResult(outcome.result, call.function.name) })
  }
  const agentResult = await continueAgent({ messages, config, tools, allowedToolNames, channel, channelKey, userId, userName, userMessage, toolResults, onProgress, bot, enableThinking })
  onAgentReplyComplete({ userId, channel, messages }).catch(() => {})
  return agentResult
}

async function resumePending({ channelKey, userId, channel = 'qq', expectedId = '', onProgress, bot }) {
  const executed = await pending.executePendingTool(channelKey, userId, channel, expectedId)
  if (!executed.pending) return executed
  const p = executed.pending
  const config = await loadConfig()
  const tools = getToolDefinitions(channel)
  const allowedToolNames = new Set(tools.map(item => item.function && item.function.name).filter(Boolean))
  const resume = p.resume || {}
  const messages = Array.isArray(resume.messages) ? resume.messages.slice() : []
  messages.push({ role: 'tool', tool_call_id: resume.toolCallId || p.id, content: externalizeToolResult(executed.result || executed.message || '', p.toolName) })
  if (executed.ok) {
    recordCall(p.toolName, channel, { ok: true, tokens: estimateTokens([{ role: 'tool', content: executed.result || '' }]) })
  }
  return continueAgent({
    messages,
    config,
    tools,
    allowedToolNames,
    channel,
    channelKey,
    userId,
    userName: resume.userName || userId,
    userMessage: resume.userMessage || '',
    toolCount: (resume.toolCount || 0) + (executed.ok ? 1 : 0),
    toolResults: [{ name: p.toolName, result: String(executed.result || executed.message || '').slice(0, 8000) }],
    onProgress,
    bot,
  })
}

module.exports = { run: runAgent, resumePending }
