/**
 * MODULE: Agent 提醒工具。
 * 职责: 基于现有 cron 模块创建、查看、取消一次性提醒。
 * 边界: 不新建调度器，不绕过 cron/push 权限。
 */
interface ReminderToolParams {
    runAt?: unknown;
    dueAt?: unknown;
    delayMinutes?: unknown;
    delaySeconds?: unknown;
    text?: unknown;
    message?: unknown;
    limit?: unknown;
    id?: unknown;
    reminderId?: unknown;
    keyword?: unknown;
    latest?: unknown;
}
interface ReminderToolContext {
    channelKey?: string;
    userId?: string;
    channel?: string;
    randomTriggered?: boolean;
}
declare function resolveRunAt(params?: ReminderToolParams, now?: number): number;
declare function executeCreateReminder(params?: ReminderToolParams, context?: ReminderToolContext): Promise<string>;
declare function executeListReminders(params?: ReminderToolParams, context?: ReminderToolContext): Promise<string>;
declare function executeCancelReminder(params?: ReminderToolParams, context?: ReminderToolContext): Promise<string>;
declare const _default: {
    createReminderTool: {
        definition: {
            name: string;
            description: string;
            parameters: {
                type: string;
                properties: {
                    delayMinutes: {
                        type: string;
                        description: string;
                    };
                    delaySeconds: {
                        type: string;
                        description: string;
                    };
                    dueAt: {
                        type: string;
                        description: string;
                    };
                    text: {
                        type: string;
                        description: string;
                    };
                };
                required: string[];
            };
        };
        execute: typeof executeCreateReminder;
        resolveRunAt: typeof resolveRunAt;
        dangerous: boolean;
        defaultChannels: string[];
    };
    listRemindersTool: {
        definition: {
            name: string;
            description: string;
            parameters: {
                type: string;
                properties: {
                    limit: {
                        type: string;
                        description: string;
                    };
                };
                required: string[];
            };
        };
        execute: typeof executeListReminders;
        dangerous: boolean;
        defaultChannels: string[];
    };
    cancelReminderTool: {
        definition: {
            name: string;
            description: string;
            parameters: {
                type: string;
                properties: {
                    id: {
                        type: string;
                        description: string;
                    };
                    keyword: {
                        type: string;
                        description: string;
                    };
                    latest: {
                        type: string;
                        description: string;
                    };
                };
                required: string[];
            };
        };
        execute: typeof executeCancelReminder;
        dangerous: boolean;
        defaultChannels: string[];
    };
    tools: ({
        definition: {
            name: string;
            description: string;
            parameters: {
                type: string;
                properties: {
                    delayMinutes: {
                        type: string;
                        description: string;
                    };
                    delaySeconds: {
                        type: string;
                        description: string;
                    };
                    dueAt: {
                        type: string;
                        description: string;
                    };
                    text: {
                        type: string;
                        description: string;
                    };
                };
                required: string[];
            };
        };
        execute: typeof executeCreateReminder;
        resolveRunAt: typeof resolveRunAt;
        dangerous: boolean;
        defaultChannels: string[];
    } | {
        definition: {
            name: string;
            description: string;
            parameters: {
                type: string;
                properties: {
                    limit: {
                        type: string;
                        description: string;
                    };
                };
                required: string[];
            };
        };
        execute: typeof executeListReminders;
        dangerous: boolean;
        defaultChannels: string[];
    } | {
        definition: {
            name: string;
            description: string;
            parameters: {
                type: string;
                properties: {
                    id: {
                        type: string;
                        description: string;
                    };
                    keyword: {
                        type: string;
                        description: string;
                    };
                    latest: {
                        type: string;
                        description: string;
                    };
                };
                required: string[];
            };
        };
        execute: typeof executeCancelReminder;
        dangerous: boolean;
        defaultChannels: string[];
    })[];
    executeCreateReminder: typeof executeCreateReminder;
    executeListReminders: typeof executeListReminders;
    executeCancelReminder: typeof executeCancelReminder;
    resolveRunAt: typeof resolveRunAt;
};
export = _default;
