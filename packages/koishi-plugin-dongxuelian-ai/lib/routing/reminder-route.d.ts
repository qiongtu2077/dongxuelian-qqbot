/**
 * MODULE: 提醒请求兜底解析。
 * 职责: 在模型漏调提醒工具时，从明确短句中提取创建/查看/取消参数。
 * 边界: 不调度任务、不发消息；真正执行由现有 cron 提醒工具完成。
 */
interface ReminderCreateArgs {
    runAt: number;
    delayMinutes: number;
    text: string;
}
interface ReminderListArgs {
    limit: number;
}
interface ReminderCancelArgs {
    latest?: boolean;
    keyword?: string;
}
type ReminderActionRequest = {
    name: 'cancel_reminder';
    args: ReminderCancelArgs;
} | {
    name: 'list_reminders';
    args: ReminderListArgs;
} | {
    name: 'create_reminder';
    args: ReminderCreateArgs;
};
interface ScheduledTaskRequest {
    name: 'create_scheduled_task';
    args: {
        mode: 'cron';
        type: 'agent' | 'text';
        schedule: string;
        scheduleText: string;
        title: string;
        prompt: string;
    };
}
declare function parseReminderRequest(text?: string, now?: number): ReminderCreateArgs | null;
declare function parseReminderListRequest(text?: string): ReminderListArgs | null;
declare function parseReminderCancelRequest(text?: string): ReminderCancelArgs | null;
declare function parseReminderActionRequest(text?: string, now?: number): ReminderActionRequest | null;
declare function isReminderToolName(name?: string): boolean;
declare function parseScheduledTaskRequest(text?: string): ScheduledTaskRequest | null;
declare function isReminderCapabilityRefusal(reply?: string): boolean;
declare function isReminderUnbackedPromise(reply?: string, userText?: string): boolean;
declare const _default: {
    parseReminderRequest: typeof parseReminderRequest;
    parseReminderListRequest: typeof parseReminderListRequest;
    parseReminderCancelRequest: typeof parseReminderCancelRequest;
    parseReminderActionRequest: typeof parseReminderActionRequest;
    parseScheduledTaskRequest: typeof parseScheduledTaskRequest;
    isReminderToolName: typeof isReminderToolName;
    isReminderCapabilityRefusal: typeof isReminderCapabilityRefusal;
    isReminderUnbackedPromise: typeof isReminderUnbackedPromise;
};
export = _default;
