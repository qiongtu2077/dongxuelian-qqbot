/**
 * MODULE: Agent 计划状态机。
 * 职责: 创建、更新、完成、放弃和查询多步骤计划。
 * 边界: 不调用模型、不执行工具、不直接发送消息。
 * 状态: 无模块级可变状态，持久化委托 plan-store。
 */
const store = require('./plan-store')

function normalizeTaskList(tasks) {
  if (Array.isArray(tasks)) return tasks
  const text = String(tasks || '')
  return text.split(/\r?\n/)
    .map(line => line.replace(/^\s*(?:[-*]|\d+[.、])\s*/, '').trim())
    .filter(Boolean)
    .map(desc => ({ desc }))
}

async function createPlan({ title, tasks, channel = 'unknown', channelKey = 'unknown', userId = 'unknown', userName = '' } = {}) {
  const taskList = normalizeTaskList(tasks)
  if (!taskList.length) throw new Error('计划至少需要一个任务')
  const plan = await store.savePlan({
    title: String(title || taskList[0]?.desc || 'Agent 计划').trim(),
    state: 'executing',
    channel,
    channelKey,
    userId,
    userName,
    tasks: taskList.map((task, index) => ({
      id: task.id || `t${index + 1}`,
      desc: task.desc || task.description || String(task),
      state: index === 0 ? 'in_progress' : 'todo',
      outcome: task.outcome || null,
      toolCallCount: task.toolCallCount || 0,
    })),
  })
  return plan
}

async function updateTaskStatus({ planId, taskId, state, outcome = null, toolCallCount } = {}) {
  const plan = await store.loadPlan(planId)
  if (!plan) throw new Error('计划不存在')
  const nextState = ['todo', 'in_progress', 'done', 'abandoned', 'failed'].includes(state) ? state : ''
  if (!nextState) throw new Error('任务状态无效')
  const task = plan.tasks.find(item => item.id === taskId)
  if (!task) throw new Error('任务不存在')
  task.state = nextState
  task.outcome = outcome === null || outcome === undefined ? task.outcome : String(outcome).slice(0, 2000)
  if (toolCallCount !== undefined) task.toolCallCount = Math.max(0, parseInt(toolCallCount, 10) || 0)
  task.updatedAt = Date.now()
  if (nextState === 'done') {
    const next = plan.tasks.find(item => item.state === 'todo')
    if (next) {
      next.state = 'in_progress'
      next.updatedAt = Date.now()
    }
  }
  if (plan.tasks.every(item => item.state === 'done' || item.state === 'abandoned')) {
    plan.state = plan.tasks.every(item => item.state === 'done') ? 'done' : 'abandoned'
  } else if (plan.state === 'todo') {
    plan.state = 'executing'
  }
  return store.savePlan(plan)
}

async function checkPlanStatus(planId) {
  if (planId) {
    const plan = await store.loadPlan(planId)
    if (!plan) throw new Error('计划不存在')
    return plan
  }
  const active = await store.listActivePlans()
  return { active, recent: await store.listPlans(20) }
}

async function finishPlan({ planId, summary = '' } = {}) {
  const plan = await store.loadPlan(planId)
  if (!plan) throw new Error('计划不存在')
  plan.state = 'done'
  plan.summary = String(summary || plan.summary || '').slice(0, 4000)
  plan.tasks = plan.tasks.map(task => task.state === 'todo' || task.state === 'in_progress'
    ? { ...task, state: 'done', updatedAt: Date.now() }
    : task)
  return store.savePlan(plan)
}

async function abandonPlan({ planId, reason = '' } = {}) {
  const plan = await store.loadPlan(planId)
  if (!plan) throw new Error('计划不存在')
  plan.state = 'abandoned'
  plan.summary = String(reason || plan.summary || '用户放弃计划').slice(0, 4000)
  plan.tasks = plan.tasks.map(task => task.state === 'todo' || task.state === 'in_progress'
    ? { ...task, state: 'abandoned', outcome: task.outcome || plan.summary, updatedAt: Date.now() }
    : task)
  return store.savePlan(plan)
}

function formatPlan(plan) {
  if (!plan) return '计划不存在。'
  if (Array.isArray(plan.active)) {
    if (!plan.active.length) return '当前没有执行中的计划。'
    return plan.active.map(formatPlan).join('\n\n')
  }
  const stateLabel = { executing: '执行中', todo: '待执行', done: '已完成', abandoned: '已放弃', failed: '失败' }[plan.state] || plan.state
  const lines = [`${plan.title}（${stateLabel}，ID: ${plan.id}）`]
  for (const task of plan.tasks) {
    const label = { todo: '待办', in_progress: '进行中', done: '完成', abandoned: '放弃', failed: '失败' }[task.state] || task.state
    lines.push(`- [${label}] ${task.id}: ${task.desc}${task.outcome ? ` -> ${task.outcome}` : ''}`)
  }
  if (plan.summary) lines.push(`总结：${plan.summary}`)
  return lines.join('\n')
}

module.exports = {
  createPlan,
  updateTaskStatus,
  checkPlanStatus,
  finishPlan,
  abandonPlan,
  formatPlan,
}
