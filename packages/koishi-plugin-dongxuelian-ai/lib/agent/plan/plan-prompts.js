/**
 * MODULE: Agent 计划提示词模板。
 * 职责: 提供计划模式的 system prompt 与任务拆解约束。
 * 边界: 不调用模型、不解析模型输出、不写计划文件。
 * 状态: 无。
 */

function buildPlanSystemPrompt(plan) {
  const lines = [
    '你正在执行一个持久化 Agent 计划。每次只推进当前进行中的任务，完成任务后调用 update_task_status 记录 outcome。',
    '遇到危险工具必须等待确认，不要绕过工具安全策略。计划状态、文件路径、pendingId 和下一步必须写清楚。',
  ]
  if (plan) {
    lines.push(`计划 ID：${plan.id}`)
    lines.push(`计划标题：${plan.title}`)
    lines.push('任务列表：')
    for (const task of plan.tasks || []) lines.push(`- ${task.id} [${task.state}] ${task.desc}`)
  }
  return lines.join('\n')
}

function buildPlanCreatePrompt(userMessage = '') {
  return [
    '用户显式请求计划模式。请先创建 2-8 个可执行任务。',
    '任务要短、可验证、按依赖顺序排列。创建后推进第一个任务。',
    '',
    `用户请求：${String(userMessage || '').slice(0, 2000)}`,
  ].join('\n')
}

module.exports = { buildPlanSystemPrompt, buildPlanCreatePrompt }
