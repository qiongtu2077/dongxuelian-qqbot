/**
 * MODULE: Agent 计划模式命令。
 * 边界: 只处理 QQ 计划命令匹配、任务拆分和 plan/queue/runner 调用；不写 conversation，不直接调聊天 API。
 * 状态: 无自有 Map/Cache；计划持久化、队列和执行状态由 agent/plan 与 agent/queue 管理。
 */
interface CommandLogger {
    warn: (message: string) => void;
}
interface CommandContextLike {
    logger: (name: string) => CommandLogger;
}
interface PlanSessionLike {
    userId?: string;
    selfId?: string;
    username?: string;
    author?: {
        id?: string;
        nick?: string;
        name?: string;
    };
    event?: {
        user?: {
            id?: string;
        };
    };
    bot?: unknown;
}
interface PlanCommandState {
    plain: string;
    channelKey: string;
    currentUserId: string;
}
declare function handlePlanCommand(session: PlanSessionLike, ctx: CommandContextLike, state: PlanCommandState): Promise<{
    matched: true;
    response?: unknown;
} | {
    matched: false;
}>;
declare const _default: {
    handlePlanCommand: typeof handlePlanCommand;
};
export = _default;
