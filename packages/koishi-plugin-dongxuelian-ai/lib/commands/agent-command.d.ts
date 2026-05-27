/**
 * MODULE: Agent QQ 命令路由。
 * 边界: 只处理工具管理、显式 Agent 对话和待确认命令；不写 conversation，不直接调聊天 API。
 * 状态: 无自有 Map/Cache；工具、队列、统计和 pending 状态由 agent/* 模块管理。
 */
interface CommandLogger {
    warn: (message: string) => void;
}
interface CommandContextLike {
    logger: (name: string) => CommandLogger;
}
interface AgentSessionLike {
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
interface AgentCommandState {
    plain: string;
    channelKey: string;
    currentUserId: string;
    adminCommandMatched?: boolean;
}
interface AgentCommandOptions {
    mode?: 'all' | 'runtime' | 'management';
}
declare function handleAgentCommand(session: AgentSessionLike, ctx: CommandContextLike, state: AgentCommandState, options?: AgentCommandOptions): Promise<{
    matched: true;
    response?: unknown;
} | {
    matched: false;
}>;
declare const _default: {
    handleAgentCommand: typeof handleAgentCommand;
};
export = _default;
