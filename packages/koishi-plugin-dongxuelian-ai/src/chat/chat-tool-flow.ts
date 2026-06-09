/**
 * MODULE: chat-tool-flow
 * 职责: 处理 chat.js 模型返回的 tool_calls、提醒/文件变体 fallback 与文件证据补偿。
 * 边界: 不调发送层、不保存 conversation、不拥有模型调用；模型调用由调用方注入。
 * 状态: 无。
 */
const { handleChatToolCalls, executeChatTool } = require('./chat-tools') as typeof import('./chat-tools')
const {
  toolCallsIncludeAnalyzeFile,
  toolResultsIncludeFileEvidence,
  selectFileEvidenceResult,
  resolveUnguardedFileFollowup,
  buildFileEvidenceReply,
} = require('./file-followup-evidence') as typeof import('./file-followup-evidence')
const { parseReminderActionRequest, parseScheduledTaskRequest, isReminderToolName } = require('../routing/reminder-route') as typeof import('../routing/reminder-route')
const {
  parseUploadedFileVariantRequest,
  isUploadedFileVariantCapabilityRefusal,
  formatUploadedFileVariantFallback,
} = require('../routing/uploaded-file-action-route') as typeof import('../routing/uploaded-file-action-route')
const { externalToolsDenied, buildExternalToolPolicyHint } = require('../routing/external-tool-policy') as typeof import('../routing/external-tool-policy')

const FILE_EVIDENCE_ANSWER_HINT = '上面是刚才文件的实际读取结果。请回答原始用户问题；只能依据这个结果回答。如果结果显示下载失败、无法提取或证据不足，就直接说明不能确认，绝对不要按文件名或印象猜内容。'

interface ToolCallLike {
  id?: string
  function?: {
    name?: string
    arguments?: string
  }
}

interface ToolResultLike {
  tool_call_id?: string
  role?: string
  content?: unknown
}

interface ToolCallReply {
  type?: string
  tool_calls?: ToolCallLike[]
  message?: { content?: string | null }
  content?: string
}

interface ChatMessage {
  role?: string
  content?: string | null
  tool_calls?: ToolCallLike[]
  tool_call_id?: string
}

interface SessionLike {
  guildId?: string
  channelId?: string
  isDirect?: boolean
}

interface ChatToolFlowOptions {
  randomTriggered?: boolean
  userText?: string
  currentText?: string
  [key: string]: unknown
}

interface ChatToolFlowContext {
  userId?: string
  channelKey?: string
  groupId?: string
  isDirect?: boolean
  channel: string
  randomTriggered: boolean
  maxToolCalls?: number
  userText: string
  [key: string]: unknown
}

interface ChatToolFlowInput {
  reply?: string | ToolCallReply
  messages?: ChatMessage[]
  options?: ChatToolFlowOptions
  cleanInput?: string
  session?: SessionLike
  currentUserId?: string
  channelKey?: string
  activeFileContext?: Record<string, unknown>
  fileFollowupState?: Record<string, unknown>
  chatTools?: unknown
  callModel?: (messages: ChatMessage[], randomTriggered?: boolean, extra?: Record<string, unknown>, tools?: unknown) => Promise<string | ToolCallReply>
}

interface ChatToolFlowResult {
  reply: string | ToolCallReply | unknown
  usedAnalyzeFileTool: boolean
  hasFileToolEvidence: boolean
  usedReminderActionTool: boolean
  usedUploadedFileVariantTool: boolean
  heavyToolsRequested: Array<{ name?: string; args: Record<string, unknown> }> | null
}

function isToolCallReply(value: unknown): value is ToolCallReply {
  return !!(value && typeof value === 'object' && (value as ToolCallReply).type === 'tool_calls')
}

function parseToolArguments(text?: string): Record<string, unknown> {
  try {
    return JSON.parse(text || '{}')
  } catch {
    /* non-critical: invalid model tool JSON is represented as empty args for routing */
    return {}
  }
}

function getFlowErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error || '')
}

function updateChatToolUsageState(toolCalls: ToolCallLike[] = [], results: ToolResultLike[] = []) {
  return {
    usedAnalyzeFile: toolCallsIncludeAnalyzeFile(toolCalls),
    hasFileEvidence: toolResultsIncludeFileEvidence(results, toolCalls),
    usedReminderAction: (toolCalls || []).some(tc => isReminderToolName(tc?.function?.name)),
    usedUploadedFileVariant: (toolCalls || []).some(tc => tc?.function?.name === 'create_uploaded_file_variant'),
  }
}

function buildQqChatToolContext({ session, currentUserId, channelKey, options = {}, activeFileContext = {}, randomTriggered }: {
  session?: SessionLike
  currentUserId?: string
  channelKey?: string
  options?: ChatToolFlowOptions
  activeFileContext?: Record<string, unknown>
  randomTriggered?: boolean
} = {}): ChatToolFlowContext {
  return {
    userId: currentUserId,
    channelKey,
    groupId: session?.guildId || session?.channelId || '',
    isDirect: !!session?.isDirect,
    channel: 'qq',
    randomTriggered: randomTriggered !== undefined ? !!randomTriggered : !!options.randomTriggered,
    maxToolCalls: options.randomTriggered ? 1 : undefined,
    userText: String(options.userText || options.currentText || ''),
    ...activeFileContext,
  }
}

async function handleChatToolFlow({
  reply,
  messages = [],
  options = {},
  cleanInput = '',
  session,
  currentUserId = '',
  channelKey = '',
  activeFileContext = {},
  fileFollowupState = {},
  chatTools = null,
  callModel,
}: ChatToolFlowInput = {}): Promise<ChatToolFlowResult> {
  if (typeof callModel !== 'function') throw new TypeError('callModel is required')

  let usedAnalyzeFileTool = false
  let hasFileToolEvidence = false
  let usedReminderActionTool = false
  let usedUploadedFileVariantTool = false

  if (isToolCallReply(reply)) {
    usedAnalyzeFileTool = toolCallsIncludeAnalyzeFile(reply.tool_calls)
    usedReminderActionTool = (reply.tool_calls || []).some(tc => isReminderToolName(tc?.function?.name))
    usedUploadedFileVariantTool = (reply.tool_calls || []).some(tc => tc?.function?.name === 'create_uploaded_file_variant')
    const toolContext = buildQqChatToolContext({
      session,
      currentUserId,
      channelKey,
      options,
      activeFileContext,
    })
    toolContext.userText = cleanInput
    const { results, heavyTools } = await handleChatToolCalls(reply.tool_calls, toolContext)
    hasFileToolEvidence = toolResultsIncludeFileEvidence(results, reply.tool_calls)
    const targetFile = fileFollowupState.targetFile as Parameters<typeof buildFileEvidenceReply>[1]
    const fileToolEvidenceReply = hasFileToolEvidence
      ? buildFileEvidenceReply(selectFileEvidenceResult(results, reply.tool_calls), targetFile)
      : ''

    if (heavyTools.length > 0) {
      if (externalToolsDenied(cleanInput)) {
        messages.push({ role: 'assistant', content: reply.message?.content || '' })
        messages.push({ role: 'system', content: buildExternalToolPolicyHint(cleanInput) })
        reply = await callModel(messages, options.randomTriggered)
        if (isToolCallReply(reply)) reply = reply.message?.content || ''
      } else {
        const heavyToolsRequested = heavyTools.map(tc => {
          const args = parseToolArguments(tc.function?.arguments)
          return { name: tc.function?.name, args }
        })
        messages.push({ role: 'assistant', content: null, tool_calls: reply.tool_calls })
        for (const r of results) messages.push(r)
        for (const ht of heavyTools) {
          messages.push({ role: 'tool', tool_call_id: ht.id, content: '该工具需要更多时间处理，稍后会给出结果。' })
        }
        const followUp = await callModel(messages, options.randomTriggered)
        let followUpText = typeof followUp === 'string' ? followUp : (followUp?.content || '我查一下，稍等。')
        if (/搜索[:：]|query[:：]|关键词[:：]|正在搜索/i.test(followUpText) || followUpText.length > 100) {
          followUpText = '让我看看…'
        }
        return {
          reply: followUpText,
          usedAnalyzeFileTool,
          hasFileToolEvidence,
          usedReminderActionTool,
          usedUploadedFileVariantTool,
          heavyToolsRequested,
        }
      }
    } else if (results.length > 0) {
      messages.push({ role: 'assistant', content: null, tool_calls: reply.tool_calls })
      for (const r of results) messages.push(r)
      if (fileToolEvidenceReply) {
        reply = fileToolEvidenceReply
      } else if (hasFileToolEvidence) {
        messages.push({ role: 'system', content: FILE_EVIDENCE_ANSWER_HINT })
        reply = await callModel(messages, options.randomTriggered)
        if (isToolCallReply(reply)) reply = reply.message?.content || ''
      } else if (options.randomTriggered) {
        reply = await callModel(messages, options.randomTriggered)
      } else {
        let loopCount = 0
        const MAX_CHAT_TOOL_ROUNDS = 3
        while (loopCount < MAX_CHAT_TOOL_ROUNDS) {
          loopCount++
          reply = await callModel(messages, options.randomTriggered, {}, chatTools)
          if (!isToolCallReply(reply)) break
          const nextUsage = updateChatToolUsageState(reply.tool_calls, [])
          usedAnalyzeFileTool = usedAnalyzeFileTool || nextUsage.usedAnalyzeFile
          usedReminderActionTool = usedReminderActionTool || nextUsage.usedReminderAction
          usedUploadedFileVariantTool = usedUploadedFileVariantTool || nextUsage.usedUploadedFileVariant
          const nextToolContext = { ...toolContext }
          const { results: nextResults, heavyTools: nextHeavy } = await handleChatToolCalls(reply.tool_calls, nextToolContext)
          hasFileToolEvidence = hasFileToolEvidence || toolResultsIncludeFileEvidence(nextResults, reply.tool_calls)
          if (nextHeavy.length > 0) {
            const heavyToolsRequested = nextHeavy.map(tc => {
              const args = parseToolArguments(tc.function?.arguments)
              return { name: tc.function?.name, args }
            })
            messages.push({ role: 'assistant', content: null, tool_calls: reply.tool_calls })
            for (const r of nextResults) messages.push(r)
            return {
              reply: reply.message?.content || '让我看看…',
              usedAnalyzeFileTool,
              hasFileToolEvidence,
              usedReminderActionTool,
              usedUploadedFileVariantTool,
              heavyToolsRequested,
            }
          }
          if (nextResults.length === 0) {
            reply = reply.message?.content || ''
            break
          }
          messages.push({ role: 'assistant', content: null, tool_calls: reply.tool_calls })
          for (const r of nextResults) messages.push(r)
          const nextFileEvidence = selectFileEvidenceResult(nextResults, reply.tool_calls)
          const nextFileEvidenceReply = buildFileEvidenceReply(nextFileEvidence)
          if (nextFileEvidenceReply) {
            reply = nextFileEvidenceReply
            break
          }
          if (toolResultsIncludeFileEvidence(nextResults, reply.tool_calls)) {
            messages.push({ role: 'system', content: FILE_EVIDENCE_ANSWER_HINT })
            reply = await callModel(messages, options.randomTriggered)
            if (isToolCallReply(reply)) reply = reply.message?.content || ''
            break
          }
        }
        if (isToolCallReply(reply)) {
          reply = reply.message?.content || ''
        }
      }
    } else {
      reply = reply.message?.content || ''
    }
  }

  const explicitReminderAction = !options.randomTriggered ? (parseScheduledTaskRequest(cleanInput) || parseReminderActionRequest(cleanInput)) : null
  if (!usedReminderActionTool && explicitReminderAction) {
    const reminderResult = await executeChatTool({
      function: {
        name: explicitReminderAction.name,
        arguments: JSON.stringify(explicitReminderAction.args),
      },
    }, buildQqChatToolContext({
      session,
      currentUserId,
      channelKey,
      options,
      randomTriggered: false,
      activeFileContext: { allowParsedReminderAction: true, userText: cleanInput },
    }))
    reply = String(reminderResult || '提醒已创建。')
    usedReminderActionTool = true
  }

  if (!usedUploadedFileVariantTool && !options.randomTriggered && isUploadedFileVariantCapabilityRefusal(typeof reply === 'string' ? reply : '', cleanInput)) {
    const variantArgs = parseUploadedFileVariantRequest(cleanInput)
    if (variantArgs) {
      messages.push({ role: 'assistant', content: typeof reply === 'string' ? reply : '' })
      messages.push({
        role: 'system',
        content: [
          '刚才你拒绝了一个本来可以由工具完成的近期上传文件操作。',
          '如果用户是在要求基于当前会话最近上传的文件创建安全副本、改名或发回，请调用 create_uploaded_file_variant。',
          '不要声称自己不能改文件或不能发文件；如果没有可处理的近期文件，工具会返回失败原因。',
        ].join('\n'),
      })
      const retry = await callModel(messages, options.randomTriggered, {}, chatTools)
      if (isToolCallReply(retry)) {
        usedUploadedFileVariantTool = (retry.tool_calls || []).some(tc => tc?.function?.name === 'create_uploaded_file_variant')
        const retryToolContext = buildQqChatToolContext({
          session,
          currentUserId,
          channelKey,
          options,
          activeFileContext,
          randomTriggered: false,
        })
        retryToolContext.userText = cleanInput
        const { results, heavyTools } = await handleChatToolCalls(retry.tool_calls, retryToolContext)
        if (heavyTools.length > 0) {
          reply = retry.message?.content || ''
        } else if (results.length > 0) {
          messages.push({ role: 'assistant', content: null, tool_calls: retry.tool_calls })
          for (const r of results) messages.push(r)
          reply = await callModel(messages, options.randomTriggered)
          if (isToolCallReply(reply)) reply = reply.message?.content || ''
        } else {
          reply = retry.message?.content || ''
        }
      } else {
        reply = retry
      }

      if (!usedUploadedFileVariantTool && isUploadedFileVariantCapabilityRefusal(typeof reply === 'string' ? reply : '', cleanInput)) {
        try {
          const variantResult = await executeChatTool({
            function: {
              name: 'create_uploaded_file_variant',
              arguments: JSON.stringify(variantArgs),
            },
          }, buildQqChatToolContext({
            session,
            currentUserId,
            channelKey,
            options,
            randomTriggered: false,
          }))
          reply = formatUploadedFileVariantFallback(String(variantResult || ''))
          usedUploadedFileVariantTool = true
        } catch (error) {
          reply = formatUploadedFileVariantFallback(getFlowErrorMessage(error))
        }
      }
    }
  }

  const fileEvidence = await resolveUnguardedFileFollowup({
    ...fileFollowupState,
    usedAnalyzeFile: usedAnalyzeFileTool,
    hasFileEvidence: hasFileToolEvidence,
  }, buildQqChatToolContext({
    session,
    currentUserId,
    channelKey,
    options,
  }))
  if (fileEvidence) {
    hasFileToolEvidence = true
    const targetFile = fileFollowupState.targetFile as Parameters<typeof buildFileEvidenceReply>[1]
    const evidenceReply = buildFileEvidenceReply(String(fileEvidence as unknown), targetFile)
    if (evidenceReply) {
      reply = evidenceReply
    } else {
      messages.push({ role: 'assistant', content: typeof reply === 'string' ? reply : '' })
      messages.push({ role: 'system', content: `【文件读取结果】\n${String(fileEvidence || '')}` })
      messages.push({ role: 'system', content: FILE_EVIDENCE_ANSWER_HINT })
      reply = await callModel(messages, options.randomTriggered)
      if (isToolCallReply(reply)) reply = reply.message?.content || ''
    }
  }

  return {
    reply,
    usedAnalyzeFileTool,
    hasFileToolEvidence,
    usedReminderActionTool,
    usedUploadedFileVariantTool,
    heavyToolsRequested: null,
  }
}

export = {
  updateChatToolUsageState,
  buildQqChatToolContext,
  handleChatToolFlow,
}
