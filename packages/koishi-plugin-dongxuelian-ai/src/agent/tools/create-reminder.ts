interface CreateReminderToolShape {
  definition: Record<string, unknown>
  dangerous: boolean
  defaultChannels: string[]
}

const reminderTools = require('./reminder-tools') as typeof import('./reminder-tools')
const createReminderTool = reminderTools.createReminderTool as CreateReminderToolShape
const executeCreateReminder = reminderTools.executeCreateReminder as (params?: Record<string, unknown>, context?: Record<string, unknown>) => Promise<string>
const resolveRunAt = reminderTools.resolveRunAt as (params?: Record<string, unknown>, now?: number) => number

const execute = executeCreateReminder as (params?: Record<string, unknown>, context?: Record<string, unknown>) => Promise<string>

export = {
  definition: createReminderTool.definition,
  execute,
  resolveRunAt,
  dangerous: createReminderTool.dangerous,
  defaultChannels: createReminderTool.defaultChannels,
}
