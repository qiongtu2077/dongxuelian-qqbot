/**
 * MODULE: Agent 计划恢复执行。
 * 职责: 将已持久化的计划包装为 Agent 队列任务，用于重启后或手动继续推进。
 * 边界: 不创建计划、不直接发送 QQ 消息、不修改 index.js 主流程。
 * 状态: 无模块级可变状态，队列与计划状态分别委托 queue / plan-store。
 */
const engine = require('../engine')
const queue = require('../queue')
const { getAgentConfig } = require('../config')
const planEngine = require('./plan-engine')
const planPrompts = require('./plan-prompts')

function getActiveTask(plan) {
  return (plan.tasks || []).find(task => task.state === 'in_progress')
    || (plan.tasks || []).find(task => task.state === 'todo')
    || null
}

async function resolvePlan(planId = '', filters = {}) {
  if (planId) return planEngine.checkPlanStatus(planId)
  const status = await planEngine.checkPlanStatus('')
  const active = Array.isArray(status.active) ? status.active : []
  const matched = active.find(plan => {
    if (filters.userId && plan.userId !== filters.userId) return false
    if (filters.channelKey && plan.channelKey !== filters.channelKey) return false
    return true
  })
  return matched || active[0] || null
}

async function resumePlan({ planId = '', channelKey, userId, userName = '', channel = '', bot } = {}) {
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
      systemExtra: [
        { role: 'system', content: planPrompts.buildPlanSystemPrompt(plan) },
      ],
      forceTools: ['check_plan_status', 'update_task_status', 'finish_plan'],
      preExecuteTools: [{ name: 'check_plan_status', args: { planId: plan.id } }],
    }),
  })
}

module.exports = {
  resumePlan,
  resolvePlan,
  getActiveTask,
}
