/**
 * MODULE: Agent 长期记忆命令。
 * 边界: 只处理 QQ 命令匹配、权限校验和 agent/memory 调用；不写 conversation，不调聊天模型。
 * 状态: 无自有 Map/Cache；记忆存储和配置状态由 agent/memory 与 agent/config 管理。
 */
interface MemorySessionLike {
    userId?: string;
    selfId?: string;
    author?: {
        id?: string;
    };
    event?: {
        user?: {
            id?: string;
        };
    };
}
interface MemoryCommandState {
    plain: string;
    channelKey: string;
    currentUserId: string;
}
declare function handleMemoryCommand(session: MemorySessionLike, state: MemoryCommandState): Promise<{
    matched: true;
    response?: unknown;
} | {
    matched: false;
}>;
declare const _default: {
    handleMemoryCommand: typeof handleMemoryCommand;
};
export = _default;
