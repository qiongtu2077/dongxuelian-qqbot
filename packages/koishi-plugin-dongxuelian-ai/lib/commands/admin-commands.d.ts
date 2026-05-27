interface AdminSessionLike {
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
interface ArmedEventDump {
    armedBy?: string;
    armedAt: number;
}
interface AdminInlineOptions {
    plain: string;
    inGuild: boolean;
    channelKey: string;
    isGroupAdmin: boolean;
    armEventDump: (session: AdminSessionLike) => void;
    getArmedEventDump: (channelKey: string) => ArmedEventDump | null | undefined;
    clearArmedEventDump: (channelKey: string) => void;
}
interface AdminCommandResult {
    matched: boolean;
    response?: string;
}
declare function handleAdminInlineCommands(session: AdminSessionLike, ctx: unknown, { plain, inGuild, channelKey, isGroupAdmin, armEventDump, getArmedEventDump, clearArmedEventDump, }: AdminInlineOptions): Promise<AdminCommandResult>;
declare const _default: {
    handleAdminInlineCommands: typeof handleAdminInlineCommands;
};
export = _default;
