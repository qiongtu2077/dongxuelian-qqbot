const { createReminderTool, executeCreateReminder, resolveRunAt } = require('./reminder-tools')

module.exports = {
  definition: createReminderTool.definition,
  execute: executeCreateReminder,
  resolveRunAt,
  dangerous: createReminderTool.dangerous,
  defaultChannels: createReminderTool.defaultChannels,
}
