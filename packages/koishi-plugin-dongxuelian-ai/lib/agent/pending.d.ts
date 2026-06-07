interface PendingTool {
    id: string;
    toolName: string;
    args: unknown;
    userId: string;
    channelKey: string;
    channel: string;
    expireAt: number;
    resume: unknown;
}
interface SetPendingToolOptions {
    toolName?: unknown;
    args?: unknown;
    channel?: unknown;
    resume?: unknown;
}
interface PendingExecutionContext {
    userName?: unknown;
    userMessage?: unknown;
    bot?: unknown;
    isAdmin?: unknown;
    resourceTaskId?: unknown;
}
interface PendingListItem {
    id: string;
    toolName: string;
    userId: string;
    channelKey: string;
    channel: string;
    argsSummary: string;
    expireAt: number;
}
type PendingNotFoundResult = {
    ok: false;
    status: number;
    message: string;
    pending?: undefined;
    toolName?: undefined;
    result?: undefined;
    error?: undefined;
};
type PendingExecutedResult = {
    ok: boolean;
    pending: PendingTool;
    toolName: string;
    result: string;
    error: string;
    message: string;
};
type PendingExecuteResult = PendingNotFoundResult | PendingExecutedResult;
type PendingConfirmResult = PendingNotFoundResult | {
    ok: boolean;
    toolName: string;
    result: string;
    error: string;
    message: string;
};
/** @returns {{ id, toolName, args, userId, channelKey, channel, expireAt, resume } | null } */
declare function getPendingTool(channelKey: string, userId: string): PendingTool | null;
declare function setPendingTool(channelKey: string, userId: string, { toolName, args, channel, resume }: SetPendingToolOptions): string;
declare function clearPendingTool(channelKey: string, userId: string): void;
declare function clearPendingToolById(id: unknown): boolean;
/** 清理过期 */
declare function trimPendingTools(now?: number): void;
declare function findPendingToolById(id: unknown): PendingTool | null;
declare function getPendingToolById(id: unknown): PendingTool | null;
declare function summarizePendingArgs(toolName: string, args?: unknown): string;
declare function listPendingTools(): PendingListItem[];
declare function upsertPendingToolSnapshot(snapshot: unknown): PendingTool | null;
declare function executePendingTool(channelKey: string, userId: string, channel?: string, expectedId?: string, context?: PendingExecutionContext): Promise<PendingExecuteResult>;
declare function confirmPendingTool(channelKey: string, userId: string, channel?: string, expectedId?: string, context?: PendingExecutionContext): Promise<PendingConfirmResult>;
declare const _default: {
    getPendingTool: typeof getPendingTool;
    findPendingToolById: typeof findPendingToolById;
    getPendingToolById: typeof getPendingToolById;
    setPendingTool: typeof setPendingTool;
    clearPendingTool: typeof clearPendingTool;
    clearPendingToolById: typeof clearPendingToolById;
    trimPendingTools: typeof trimPendingTools;
    summarizePendingArgs: typeof summarizePendingArgs;
    listPendingTools: typeof listPendingTools;
    upsertPendingToolSnapshot: typeof upsertPendingToolSnapshot;
    executePendingTool: typeof executePendingTool;
    confirmPendingTool: typeof confirmPendingTool;
};
export = _default;
