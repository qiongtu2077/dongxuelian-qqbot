/**
 * MODULE: Agent 计划模式命令。
 * 边界: 只处理 QQ 计划命令匹配、任务拆分和 plan/queue/runner 调用；不写 conversation，不直接调聊天 API。
 * 状态: 无自有 Map/Cache；计划持久化、队列和执行状态由 agent/plan 与 agent/queue 管理。
 */

const { hasAdminPermission, sanitizeUserName } = require('../core/utils') as typeof import('../core/utils')
const { handled, notHandled } = require('./command-result') as typeof import('./command-result')
const { submitAgentWorkerTask } = require('../agent/worker-submission') as typeof import('../agent/worker-submission')
const { createAgentRunWorkerPayload } = require('../resource-workers/agent-payload') as typeof import('../resource-workers/agent-payload')

interface CommandLogger {
  warn: (message: string) => void
}

interface CommandContextLike {
  logger: (name: string) => CommandLogger
}

interface PlanSessionLike {
  userId?: string
  selfId?: string
  username?: string
  author?: {
    id?: string
    nick?: string
    name?: string
  }
  event?: {
    user?: {
      id?: string
    }
  }
  bot?: unknown
}

interface PlanCommandState {
  plain: string
  channelKey: string
  currentUserId: string
}

interface UnknownErrorLike {
  code?: unknown
  message?: unknown
}

interface PlanAgentResultLike {
  reply?: string
  message?: string
}

interface PlanOwnerLike {
  userId?: string
}

function getPlanCommandErrorMessage(error: unknown, fallback: string = ''): string {
  return error instanceof Error ? error.message : String((error as UnknownErrorLike | null)?.message || fallback)
}

function hasPlanCommandQueueCode(error: unknown): boolean {
  const code = (error as UnknownErrorLike | null)?.code
  return code === 'AGENT_QUEUE_FULL' || code === 'AGENT_QUEUE_REJECTED'
}

function asPlanAgentResult(value: unknown): PlanAgentResultLike {
  return value && typeof value === 'object' ? value as PlanAgentResultLike : {}
}

function asPlanOwner(value: unknown): PlanOwnerLike {
  return value && typeof value === 'object' ? value as PlanOwnerLike : {}
}

async function handlePlanCommand(session: PlanSessionLike, ctx: CommandContextLike, state: PlanCommandState) {
  const { plain, channelKey, currentUserId } = state
  const adminSession = session as Parameters<typeof hasAdminPermission>[0]

  const planMatch = plain.match(/^(?:\/plan|莲莲计划)\s+(.+)/i)
  if (planMatch) {
    const query = planMatch[1].trim()
    const planEngine = require('../agent/plan/plan-engine') as typeof import('../agent/plan/plan-engine')
    const planPrompts = require('../agent/plan/plan-prompts') as typeof import('../agent/plan/plan-prompts')
    const agentConfig = (require('../agent/config') as typeof import('../agent/config')).getAgentConfig()
    if (!agentConfig.planMode?.enabled) return handled('计划模式当前未开启。')
    const userName = sanitizeUserName(session.author?.nick || session.author?.name || session.username || '群友')
    const tasks = query
      .split(/(?:；|;|\n|，然后|然后|再)/)
      .map(item => item.trim())
      .filter(Boolean)
      .slice(0, 8)
    const fallbackTasks = tasks.length >= 2 ? tasks : [
      `理解目标：${query}`,
      '收集必要信息并执行可用工具',
      '整理结果并汇报完成状态',
    ]
    try {
      const plan = await planEngine.createPlan({ title: query.slice(0, 80), tasks: fallbackTasks.map(desc => ({ desc })), channel: 'qq', channelKey, userId: currentUserId, userName })
      const agentRunInput = {
        userMessage: query,
        userName,
        userId: currentUserId,
        channelKey,
        channel: 'qq',
        isAdmin: hasAdminPermission(adminSession),
        systemExtra: [
          { role: 'system', content: planPrompts.buildPlanSystemPrompt(plan) },
          { role: 'system', content: planPrompts.buildPlanCreatePrompt(query) },
        ],
        forceTools: ['check_plan_status', 'update_task_status', 'finish_plan'],
        preExecuteTools: [{ name: 'check_plan_status', args: { planId: plan.id } }],
      }
      const submission = submitAgentWorkerTask({
        channel: 'qq',
        channelKey,
        userId: currentUserId,
        timeoutMs: agentConfig.queue?.timeoutMs,
        maxActivePerUser: agentConfig.queue?.maxPendingPerUser,
        payload: { entry: 'qq-plan-command', planId: plan.id, agentWorker: createAgentRunWorkerPayload('qq-plan-command', agentRunInput) },
      })
      return handled([planEngine.formatPlan(plan), '', submission.message || '计划已创建，正在后台执行。'].join('\n'))
    } catch (err) {
      if (hasPlanCommandQueueCode(err)) return handled(getPlanCommandErrorMessage(err))
      ctx.logger('dongxuelian-ai').warn(`plan mode failed: ${getPlanCommandErrorMessage(err)}`)
      return handled('计划模式暂时不可用。')
    }
  }

  const planStatusMatch = plain.match(/^(?:计划查看|\/plans?)(?:\s+(plan_[a-zA-Z0-9_-]+))?$/i)
  if (planStatusMatch) {
    try {
      const planEngine = require('../agent/plan/plan-engine') as typeof import('../agent/plan/plan-engine')
      const isAdmin = hasAdminPermission(adminSession)
      const result = await planEngine.checkPlanStatus(planStatusMatch[1] || '', { userId: currentUserId, channelKey, isAdmin })
      return handled(planEngine.formatPlan(result))
    } catch (err) {
      return handled(getPlanCommandErrorMessage(err, '计划查询失败。'))
    }
  }

  const planResumeMatch = plain.match(/^(?:计划继续|\/plan-resume)(?:\s+(plan_[a-zA-Z0-9_-]+))?$/i)
  if (planResumeMatch) {
    try {
      const planEngine = require('../agent/plan/plan-engine') as typeof import('../agent/plan/plan-engine')
      const planRunner = require('../agent/plan/plan-runner') as typeof import('../agent/plan/plan-runner')
      const plan = await planRunner.resolvePlan(planResumeMatch[1] || '', { userId: currentUserId, channelKey })
      if (!plan) return handled('当前没有可继续的执行中计划。')
      if (plan.userId !== currentUserId && !hasAdminPermission(adminSession)) return handled('只能继续自己的计划，或由 bot 管理员操作。')
      const userName = sanitizeUserName(session.author?.nick || session.author?.name || session.username || plan.userName || '群友')
      const result = await planRunner.resumePlan({ planId: plan.id, channelKey, userId: currentUserId, userName, channel: 'qq', isAdmin: hasAdminPermission(adminSession) })
      return handled([planEngine.formatPlan(plan), '', asPlanAgentResult(result).reply || asPlanAgentResult(result).message || '计划已提交后台继续执行。'].join('\n'))
    } catch (err) {
      if (hasPlanCommandQueueCode(err)) return handled(getPlanCommandErrorMessage(err))
      ctx.logger('dongxuelian-ai').warn(`plan resume failed: ${getPlanCommandErrorMessage(err)}`)
      return handled(getPlanCommandErrorMessage(err, '计划继续失败。'))
    }
  }

  const planAbandonMatch = plain.match(/^(?:计划放弃|\/plan-abandon)\s+(plan_[a-zA-Z0-9_-]+)(?:\s+(.+))?$/i)
  if (planAbandonMatch) {
    try {
      const planEngine = require('../agent/plan/plan-engine') as typeof import('../agent/plan/plan-engine')
      const plan = await planEngine.checkPlanStatus(planAbandonMatch[1])
      if (asPlanOwner(plan).userId !== currentUserId && !hasAdminPermission(adminSession)) return handled('只能放弃自己的计划，或由 bot 管理员操作。')
      const abandoned = await planEngine.abandonPlan({ planId: planAbandonMatch[1], reason: planAbandonMatch[2] || '用户放弃计划' })
      return handled(planEngine.formatPlan(abandoned))
    } catch (err) {
      return handled(getPlanCommandErrorMessage(err, '计划放弃失败。'))
    }
  }

  return notHandled()
}

export = {
  handlePlanCommand,
}
