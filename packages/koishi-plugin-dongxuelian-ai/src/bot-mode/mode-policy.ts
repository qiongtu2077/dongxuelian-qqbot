/**
 * MODULE: S5 模式策略。
 * 职责: 根据当前模式和命令类型给出入口动作。
 * 边界: 不发送消息，不调用 AI，不写任务队列。
 */

type BotModeAction = 'pass' | 'queue_daily' | 'status_only' | 'resource_notice' | 'silent_drop' | 'reject' | 'defer'
type BotCommandType = 'daily_command' | 'status_command' | 'agent_command' | 'normal_chat' | 'interactive_chat' | 'media_event'

interface BotModeSnapshotLike {
  botMode?: unknown
  resourceState?: unknown
}

interface ModePolicyDecision {
  action: BotModeAction
  reason: string
}

// 返回模式策略动作；日报命令在 AI 插件里不吞，交给 daily-report 插件处理。
function decideModePolicy(commandType: BotCommandType, snapshot: BotModeSnapshotLike | null | undefined): ModePolicyDecision {
  const mode = String(snapshot?.botMode || 'normal')
  const resourceState = String(snapshot?.resourceState || 'yellow')
  const isChatLike = commandType === 'normal_chat' || commandType === 'interactive_chat'

  if (commandType === 'status_command') return { action: 'status_only', reason: 'status command is low cost' }
  if (commandType === 'daily_command') return { action: mode === 'maintenance' ? 'reject' : 'queue_daily', reason: 'daily command is handled by daily-report' }

  if (mode === 'maintenance') {
    if (isChatLike || commandType === 'media_event') return { action: 'silent_drop', reason: 'maintenance mode' }
    return { action: 'reject', reason: 'maintenance mode' }
  }

  if (mode === 'report_silent') {
    if (commandType === 'media_event') return { action: 'defer', reason: 'daily report is running' }
    if (commandType === 'agent_command') return { action: 'pass', reason: 'explicit agent entry defers to downstream admission during daily report' }
    if (commandType === 'interactive_chat') return { action: 'pass', reason: 'explicit chat stays available during daily report' }
    return { action: 'silent_drop', reason: 'daily report is running' }
  }

  if (mode === 'critical' || resourceState === 'red' || resourceState === 'black') {
    if (commandType === 'media_event') return { action: 'defer', reason: 'resource state is critical' }
    if (commandType === 'agent_command') return { action: 'resource_notice', reason: 'agent is blocked in critical mode' }
    if (commandType === 'interactive_chat') return { action: 'resource_notice', reason: 'resource state is critical' }
    if (commandType === 'normal_chat') return { action: 'silent_drop', reason: 'resource state is critical' }
    return { action: 'silent_drop', reason: 'resource state is critical' }
  }

  if (mode === 'busy') {
    if (commandType === 'media_event') return { action: 'defer', reason: 'media waits while exclusive task is busy' }
    if (commandType === 'agent_command') return { action: 'pass', reason: 'agent entry may queue' }
    if (commandType === 'interactive_chat') return { action: 'pass', reason: 'explicit chat stays available while exclusive task is busy' }
    return { action: 'silent_drop', reason: 'busy mode silences normal chat' }
  }

  return { action: 'pass', reason: 'normal mode' }
}

export = {
  decideModePolicy,
}
