"use strict";
const reminderTools = require('./reminder-tools');
const createReminderTool = reminderTools.createReminderTool;
const executeCreateReminder = reminderTools.executeCreateReminder;
const resolveRunAt = reminderTools.resolveRunAt;
const execute = executeCreateReminder;
module.exports = {
    definition: createReminderTool.definition,
    execute,
    resolveRunAt,
    dangerous: createReminderTool.dangerous,
    defaultChannels: createReminderTool.defaultChannels,
};
