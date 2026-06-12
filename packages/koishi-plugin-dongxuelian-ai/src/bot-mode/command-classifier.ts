/**
 * MODULE: S5 命令分类器。
 * 职责: 将入站消息归类为日报、状态、Agent、普通聊天或媒体事件。
 * 边界: 不读取资源状态，不执行任何业务逻辑。
 */

type BotCommandType = 'daily_command' | 'status_command' | 'agent_command' | 'normal_chat' | 'interactive_chat' | 'media_event'

interface ClassifyCommandInput {
  plain?: string
  directAt?: boolean
  isPrivate?: boolean
  nameMentioned?: boolean
  quotedSelf?: boolean
  analyzed?: {
    hasVisual?: boolean
    hasFile?: boolean
    hasAudio?: boolean
    hasEmbed?: boolean
  }
}

// 判断消息是否是日报命令，必须放行给 daily-report 插件。
function isDailyCommand(plain: string): boolean {
  return plain === '群聊日报' || plain === '/群聊日报' || plain === '群聊详细日报' || plain === '/群聊详细日报'
}

// 判断消息是否是低成本状态查询命令。
function isStatusCommand(plain: string): boolean {
  return /^(?:资源状态|资源中心|日报队列|日报状态|队列状态|系统资源|resource status)$/i.test(plain)
}

// 判断消息是否是显式 Agent 命令。
function isAgentCommand(plain: string): boolean {
  return /^莲莲\s*(?:工具|agent)\s+.+/i.test(plain) || /^(?:确认工具|y|Y)(?:\s+pnd[0-9a-z]+)?$/i.test(plain)
}

// 判断消息是否携带后台媒体负载。
function isMediaEvent(analyzed: ClassifyCommandInput['analyzed']): boolean {
  return !!(analyzed && (analyzed.hasVisual || analyzed.hasFile || analyzed.hasAudio || analyzed.hasEmbed))
}

// 判断消息是否属于显式 Bot 交互，应该区别于随机闲聊。
function isInteractiveChat(input: ClassifyCommandInput): boolean {
  return !!(input.directAt || input.isPrivate || input.nameMentioned || input.quotedSelf)
}

// 将消息归类，顺序不能调整：日报命令优先透传，状态命令优先保留。
function classifyCommand(input: ClassifyCommandInput = {}): BotCommandType {
  const plain = String(input.plain || '').trim()
  if (isDailyCommand(plain)) return 'daily_command'
  if (isStatusCommand(plain)) return 'status_command'
  if (isAgentCommand(plain)) return 'agent_command'
  if (isMediaEvent(input.analyzed)) return 'media_event'
  if (isInteractiveChat(input)) return 'interactive_chat'
  return 'normal_chat'
}

export = {
  classifyCommand,
  isDailyCommand,
  isStatusCommand,
  isAgentCommand,
  isMediaEvent,
  isInteractiveChat,
}
