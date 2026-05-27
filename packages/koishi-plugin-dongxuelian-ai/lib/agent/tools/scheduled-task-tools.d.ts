interface ScheduledTaskParams {
    id?: unknown;
    taskId?: unknown;
    mode?: unknown;
    recurring?: unknown;
    schedule?: unknown;
    type?: unknown;
    taskType?: unknown;
    runAt?: unknown;
    dueAt?: unknown;
    delayMinutes?: unknown;
    delaySeconds?: unknown;
    prompt?: unknown;
    text?: unknown;
    message?: unknown;
    title?: unknown;
    description?: unknown;
    timezone?: unknown;
    scheduleText?: unknown;
    timeText?: unknown;
    silentOnNoResult?: unknown;
    contextPolicy?: unknown;
    runPolicy?: unknown;
    taskKind?: unknown;
    status?: unknown;
    limit?: unknown;
}
interface ScheduledTaskContext {
    channelKey?: string;
    userId?: string;
    channel?: string;
    isDirect?: boolean;
    randomTriggered?: boolean;
}
declare function resolveTarget(context?: ScheduledTaskContext): string;
declare function resolveRunAt(params?: ScheduledTaskParams, now?: number): number;
declare function executeCreateScheduledTask(params?: ScheduledTaskParams, context?: ScheduledTaskContext): Promise<string>;
declare function executeListScheduledTasks(params?: ScheduledTaskParams, context?: ScheduledTaskContext): Promise<string>;
declare function executeGetScheduledTask(params?: ScheduledTaskParams, context?: ScheduledTaskContext): Promise<string>;
declare function executePauseScheduledTask(params?: ScheduledTaskParams, context?: ScheduledTaskContext): Promise<string>;
declare function executeResumeScheduledTask(params?: ScheduledTaskParams, context?: ScheduledTaskContext): Promise<string>;
declare function executeDeleteScheduledTask(params?: ScheduledTaskParams, context?: ScheduledTaskContext): Promise<string>;
declare function executeRunScheduledTaskNow(params?: ScheduledTaskParams, context?: ScheduledTaskContext): Promise<string>;
interface SimpleScheduledTool {
    definition: {
        name: string;
        description: string;
        parameters: Record<string, unknown>;
    };
    execute: (params?: ScheduledTaskParams, context?: ScheduledTaskContext) => Promise<string>;
    dangerous: boolean;
    defaultChannels: string[];
}
declare const _default: {
    createScheduledTaskTool: {
        definition: {
            name: string;
            description: string;
            parameters: {
                type: string;
                properties: {
                    mode: {
                        type: string;
                        enum: string[];
                        description: string;
                    };
                    type: {
                        type: string;
                        enum: string[];
                        description: string;
                    };
                    schedule: {
                        type: string;
                        description: string;
                    };
                    runAt: {
                        type: string;
                        description: string;
                    };
                    delayMinutes: {
                        type: string;
                        description: string;
                    };
                    title: {
                        type: string;
                        description: string;
                    };
                    prompt: {
                        type: string;
                        description: string;
                    };
                    scheduleText: {
                        type: string;
                        description: string;
                    };
                };
                required: string[];
            };
        };
        execute: typeof executeCreateScheduledTask;
        dangerous: boolean;
        defaultChannels: string[];
    };
    listScheduledTasksTool: SimpleScheduledTool;
    getScheduledTaskTool: SimpleScheduledTool;
    pauseScheduledTaskTool: SimpleScheduledTool;
    resumeScheduledTaskTool: SimpleScheduledTool;
    deleteScheduledTaskTool: SimpleScheduledTool;
    runScheduledTaskNowTool: SimpleScheduledTool;
    tools: ({
        definition: {
            name: string;
            description: string;
            parameters: {
                type: string;
                properties: {
                    mode: {
                        type: string;
                        enum: string[];
                        description: string;
                    };
                    type: {
                        type: string;
                        enum: string[];
                        description: string;
                    };
                    schedule: {
                        type: string;
                        description: string;
                    };
                    runAt: {
                        type: string;
                        description: string;
                    };
                    delayMinutes: {
                        type: string;
                        description: string;
                    };
                    title: {
                        type: string;
                        description: string;
                    };
                    prompt: {
                        type: string;
                        description: string;
                    };
                    scheduleText: {
                        type: string;
                        description: string;
                    };
                };
                required: string[];
            };
        };
        execute: typeof executeCreateScheduledTask;
        dangerous: boolean;
        defaultChannels: string[];
    } | SimpleScheduledTool)[];
    executeCreateScheduledTask: typeof executeCreateScheduledTask;
    executeListScheduledTasks: typeof executeListScheduledTasks;
    executeGetScheduledTask: typeof executeGetScheduledTask;
    executePauseScheduledTask: typeof executePauseScheduledTask;
    executeResumeScheduledTask: typeof executeResumeScheduledTask;
    executeDeleteScheduledTask: typeof executeDeleteScheduledTask;
    executeRunScheduledTaskNow: typeof executeRunScheduledTaskNow;
    resolveRunAt: typeof resolveRunAt;
    resolveTarget: typeof resolveTarget;
};
export = _default;
