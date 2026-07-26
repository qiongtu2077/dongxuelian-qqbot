/**
 * MODULE: S5 模式策略。
 * 职责: 根据当前模式和命令类型给出入口动作。
 * 边界: 不发送消息，不调用 AI，不写任务队列。
 */
type BotModeAction = 'pass' | 'queue_daily' | 'status_only' | 'resource_notice' | 'silent_drop' | 'reject' | 'defer';
type BotCommandType = 'daily_command' | 'status_command' | 'agent_command' | 'normal_chat' | 'interactive_chat' | 'media_event';
interface BotModeSnapshotLike {
    botMode?: unknown;
    resourceState?: unknown;
}
interface ModePolicyDecision {
    action: BotModeAction;
    reason: string;
}
declare function decideModePolicy(commandType: BotCommandType, snapshot: BotModeSnapshotLike | null | undefined): ModePolicyDecision;
declare const _default: {
    decideModePolicy: typeof decideModePolicy;
};
export = _default;
