/**
 * MODULE: Agent 计划工具定义。
 * 职责: 将计划状态机暴露为 Agent tools。
 * 边界: 不调用模型、不发送消息、不访问计划目录外文件。
 * 状态: 无。
 */
const engine = require('./plan-engine') as typeof import('./plan-engine')

interface ToolDefinition {
  name: string
  description: string
  parameters: Record<string, unknown>
}

interface ToolContext {
  channel?: string
  channelKey?: string
  userId?: string
  userName?: string
  bot?: unknown
}

interface AgentTool {
  definition: ToolDefinition
  execute: (params?: Record<string, unknown>, context?: ToolContext) => Promise<string>
  dangerous: boolean
  defaultChannels: string[]
}

function toToolResult(planOrStatus: Parameters<typeof engine.formatPlan>[0]): string {
  return engine.formatPlan(planOrStatus)
}

function readPlanToolStringParam(params: Record<string, unknown>, key: string): string | undefined {
  const value = params[key]
  if (value === undefined || value === null) return undefined
  return String(value)
}

const createPlanTool: AgentTool = {
  definition: {
    name: 'create_plan',
    description: '创建一个持久化多步骤计划。适合 /plan 或明确的多步骤任务。',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: '计划标题' },
        tasks: { type: 'array', items: { type: 'object', properties: { desc: { type: 'string' } } }, description: '任务列表，每项包含 desc' },
      },
      required: ['title', 'tasks'],
    },
  },
  async execute(params = {}, context = {}) {
    const plan = await engine.createPlan({
      title: readPlanToolStringParam(params, 'title'),
      tasks: params.tasks,
      channel: context.channel,
      channelKey: context.channelKey,
      userId: context.userId,
      userName: context.userName,
    })
    return toToolResult(plan)
  },
  dangerous: true,
  defaultChannels: ['dashboard', 'qq'],
}

const updateTaskStatusTool: AgentTool = {
  definition: {
    name: 'update_task_status',
    description: '更新计划中单个任务的状态和结果。',
    parameters: {
      type: 'object',
      properties: {
        planId: { type: 'string' },
        taskId: { type: 'string' },
        state: { type: 'string', enum: ['todo', 'in_progress', 'done', 'abandoned', 'failed'] },
        outcome: { type: 'string' },
        toolCallCount: { type: 'number' },
      },
      required: ['planId', 'taskId', 'state'],
    },
  },
  async execute(params = {}) {
    return toToolResult(await engine.updateTaskStatus({
      planId: readPlanToolStringParam(params, 'planId'),
      taskId: readPlanToolStringParam(params, 'taskId'),
      state: readPlanToolStringParam(params, 'state'),
      outcome: params.outcome,
      toolCallCount: params.toolCallCount,
    }))
  },
  dangerous: true,
  defaultChannels: ['dashboard', 'qq'],
}

const checkPlanStatusTool: AgentTool = {
  definition: {
    name: 'check_plan_status',
    description: '查询一个计划或当前活跃计划列表。',
    parameters: {
      type: 'object',
      properties: { planId: { type: 'string' } },
    },
  },
  async execute(params = {}, context = {}) {
    return toToolResult(await engine.checkPlanStatus(readPlanToolStringParam(params, 'planId'), {
      userId: context.userId,
      channelKey: context.channelKey,
      isAdmin: context.channel === 'dashboard',
    }))
  },
  dangerous: false,
  defaultChannels: ['dashboard', 'qq'],
}

const finishPlanTool: AgentTool = {
  definition: {
    name: 'finish_plan',
    description: '将计划标记为完成并写入总结。',
    parameters: {
      type: 'object',
      properties: {
        planId: { type: 'string' },
        summary: { type: 'string' },
      },
      required: ['planId'],
    },
  },
  async execute(params = {}, context = {}) {
    const plan = await engine.finishPlan({
      planId: readPlanToolStringParam(params, 'planId'),
      summary: params.summary,
    })
    if (context.bot && plan.channelKey) {
      const push = require('../push') as typeof import('../push')
      push.taskComplete({
        planId: plan.id,
        channelKey: plan.channelKey,
        summary: plan.summary || `计划 ${plan.title} 已完成。`,
        bot: context.bot,
      }).catch(() => {
        /* non-critical: plan completion notification should not fail the tool result */
      })
    }
    return toToolResult(plan)
  },
  dangerous: true,
  defaultChannels: ['dashboard', 'qq'],
}

const abandonPlanTool: AgentTool = {
  definition: {
    name: 'abandon_plan',
    description: '放弃计划并记录原因。',
    parameters: {
      type: 'object',
      properties: {
        planId: { type: 'string' },
        reason: { type: 'string' },
      },
      required: ['planId'],
    },
  },
  async execute(params = {}) {
    return toToolResult(await engine.abandonPlan({
      planId: readPlanToolStringParam(params, 'planId'),
      reason: params.reason,
    }))
  },
  dangerous: true,
  defaultChannels: ['dashboard', 'qq'],
}

export = {
  createPlanTool,
  updateTaskStatusTool,
  checkPlanStatusTool,
  finishPlanTool,
  abandonPlanTool,
  tools: [createPlanTool, updateTaskStatusTool, checkPlanStatusTool, finishPlanTool, abandonPlanTool],
}
