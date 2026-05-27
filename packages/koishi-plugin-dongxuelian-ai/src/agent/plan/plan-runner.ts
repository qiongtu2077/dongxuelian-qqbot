/**
 * MODULE: Agent 计划恢复执行。
 * 职责: 将已持久化的计划包装为 Agent 队列任务，用于重启后或手动继续推进。
 * 边界: 不创建计划、不直接发送 QQ 消息、不修改 index.js 主流程。
 * 状态: 无模块级可变状态，队列与计划状态分别委托 queue / plan-store。
 */
const engine = require('../engine') as typeof import('../engine')
const queue = require('../queue') as typeof import('../queue')
const { getAgentConfig } = require('../config') as typeof import('../config')
const planEngine = require('./plan-engine') as typeof import('./plan-engine')
const planPrompts = require('./plan-prompts') as typeof import('./plan-prompts')

interface RunnerPlanTask {
  id?: string
  desc?: string
  state?: string
}

interface RunnerPlan {
  id: string
  title?: string
  state?: string
  channel?: string
  channelKey?: string
  userId?: string
  userName?: string
  tasks?: RunnerPlanTask[]
}

interface RunnerPlanStatus {
  active?: RunnerPlan[]
  recent?: RunnerPlan[]
}

interface ResolvePlanFilters {
  userId?: string
  channelKey?: string
}

interface ResumePlanOptions {
  planId?: string
  channelKey?: string
  userId?: string
  userName?: string
  channel?: string
  bot?: unknown
  isAdmin?: boolean
}

function getActiveTask(plan: RunnerPlan): RunnerPlanTask | null {
  return (plan.tasks || []).find(task => task.state === 'in_progress')
    || (plan.tasks || []).find(task => task.state === 'todo')
    || null
}

function isRunnerPlan(value: unknown): value is RunnerPlan {
  return !!value && typeof value === 'object' && typeof (value as { id?: unknown }).id === 'string'
}

function isRunnerPlanStatus(value: unknown): value is RunnerPlanStatus {
  return !!value && typeof value === 'object' && Array.isArray((value as RunnerPlanStatus).active)
}

async function resolvePlan(planId: string = '', filters: ResolvePlanFilters = {}): Promise<RunnerPlan | null> {
  if (planId) {
    const plan = await planEngine.checkPlanStatus(planId)
    return isRunnerPlan(plan) ? plan : null
  }
  const status = await planEngine.checkPlanStatus('')
  const active = isRunnerPlanStatus(status) && Array.isArray(status.active) ? status.active : []
  const matched = active.find((plan: RunnerPlan) => {
    if (filters.userId && plan.userId !== filters.userId) return false
    if (filters.channelKey && plan.channelKey !== filters.channelKey) return false
    return true
  })
  return matched || active[0] || null
}

async function resumePlan({ planId = '', channelKey, userId, userName = '', channel = '', bot, isAdmin = false }: ResumePlanOptions = {}): Promise<unknown> {
  const plan = await resolvePlan(planId)
  if (!plan) throw new Error('当前没有可继续的执行中计划。')
  if (!['executing', 'todo'].includes(plan.state)) throw new Error('该计划已结束，不能继续执行。')
  const activeTask = getActiveTask(plan)
  if (!activeTask) throw new Error('该计划没有待执行任务。')
  const agentConfig = getAgentConfig()
  if (!agentConfig.planMode?.enabled) throw new Error('计划模式当前未开启。')
  queue.configureAgentQueue(agentConfig.queue || {})
  return queue.enqueueAgentTask({
    channelKey: channelKey || plan.channelKey,
    userId: userId || plan.userId,
    timeoutMs: agentConfig.queue?.timeoutMs,
    fn: () => engine.run({
      userMessage: `继续执行计划 ${plan.id}：${activeTask.desc}`,
      userName: userName || plan.userName || 'Plan',
      userId: userId || plan.userId,
      channelKey: channelKey || plan.channelKey,
      channel: channel === 'dashboard' || plan.channel === 'dashboard' ? 'dashboard' : 'qq',
      bot,
      isAdmin,
      systemExtra: [
        { role: 'system', content: planPrompts.buildPlanSystemPrompt(plan) },
      ],
      forceTools: ['check_plan_status', 'update_task_status', 'finish_plan'],
      preExecuteTools: [{ name: 'check_plan_status', args: { planId: plan.id } }],
    }),
  })
}

export = {
  resumePlan,
  resolvePlan,
  getActiveTask,
}
