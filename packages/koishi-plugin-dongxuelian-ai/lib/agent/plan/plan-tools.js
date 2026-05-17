/**
 * MODULE: Agent 计划工具定义。
 * 职责: 将计划状态机暴露为 Agent tools。
 * 边界: 不调用模型、不发送消息、不访问计划目录外文件。
 * 状态: 无。
 */
const engine = require('./plan-engine')

function toToolResult(planOrStatus) {
  return engine.formatPlan(planOrStatus)
}

const createPlanTool = {
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
      title: params.title,
      tasks: params.tasks,
      channel: context.channel,
      channelKey: context.channelKey,
      userId: context.userId,
      userName: context.userName,
    })
    return toToolResult(plan)
  },
  dangerous: false,
  defaultChannels: ['dashboard', 'qq'],
}

const updateTaskStatusTool = {
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
    return toToolResult(await engine.updateTaskStatus(params))
  },
  dangerous: false,
  defaultChannels: ['dashboard', 'qq'],
}

const checkPlanStatusTool = {
  definition: {
    name: 'check_plan_status',
    description: '查询一个计划或当前活跃计划列表。',
    parameters: {
      type: 'object',
      properties: { planId: { type: 'string' } },
    },
  },
  async execute(params = {}) {
    return toToolResult(await engine.checkPlanStatus(params.planId))
  },
  dangerous: false,
  defaultChannels: ['dashboard', 'qq'],
}

const finishPlanTool = {
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
    const plan = await engine.finishPlan(params)
    if (context.bot && plan.channelKey) {
      require('../push').taskComplete({
        planId: plan.id,
        channelKey: plan.channelKey,
        summary: plan.summary || `计划 ${plan.title} 已完成。`,
        bot: context.bot,
      }).catch(() => {})
    }
    return toToolResult(plan)
  },
  dangerous: false,
  defaultChannels: ['dashboard', 'qq'],
}

const abandonPlanTool = {
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
    return toToolResult(await engine.abandonPlan(params))
  },
  dangerous: false,
  defaultChannels: ['dashboard', 'qq'],
}

module.exports = {
  createPlanTool,
  updateTaskStatusTool,
  checkPlanStatusTool,
  finishPlanTool,
  abandonPlanTool,
  tools: [createPlanTool, updateTaskStatusTool, checkPlanStatusTool, finishPlanTool, abandonPlanTool],
}
