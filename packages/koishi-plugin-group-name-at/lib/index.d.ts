interface LoggerLike {
    info(...args: unknown[]): void;
    warn(...args: unknown[]): void;
}
interface CommandLike {
    action(handler: (argv: {
        session: GroupNameSessionLike;
    }) => unknown): CommandLike;
}
interface ContextLike {
    on(event: 'ready', handler: () => unknown): unknown;
    command(name: string, desc: string): CommandLike;
    middleware(handler: (session: GroupNameSessionLike, next: () => unknown) => unknown): unknown;
    logger(name: string): LoggerLike;
}
interface GroupNameSessionLike {
    content?: string;
    sent?: string[];
    userId?: string | number;
    guildId?: string | number;
    channelId?: string | number;
    isDirect?: boolean;
    author?: {
        id?: string | number;
        name?: string;
        nick?: string;
    };
    username?: string;
    event?: {
        sender?: {
            role?: string;
            userId?: string | number;
            id?: string | number;
        };
        member?: {
            role?: string;
            nick?: string;
            name?: string;
            user?: {
                id?: string | number;
            };
        };
        user?: {
            id?: string | number;
        };
        message?: unknown[];
    };
    bot?: {
        internal?: {
            getGroupMemberInfo?(guildId: string | number | undefined, userId: string, noCache: boolean): Promise<MemberInfoLike>;
            get_group_member_info?(params: {
                group_id: string | number | undefined;
                user_id: string;
                no_cache: boolean;
            }): Promise<MemberInfoLike>;
        };
        getGuildMember?(guildId: string | number | undefined, userId: string): Promise<MemberInfoLike>;
        getGroupMember?(guildId: string | number | undefined, userId: string): Promise<MemberInfoLike>;
        getUser?(userId: string): Promise<MemberInfoLike>;
    };
    send(message: string): Promise<unknown>;
}
interface MemberInfoLike {
    card?: string;
    nick?: string;
    nickname?: string;
    name?: string;
    username?: string;
    user?: {
        name?: string;
    };
}
interface DisabledGroupsCache {
    fingerprint: string;
    groups: Set<string>;
}
interface NicknameBlacklistCommand {
    action: 'view' | 'add' | 'delete';
    groupId?: string;
}
declare function safeSendText(ctx: ContextLike, session: GroupNameSessionLike, text: string): Promise<boolean>;
declare function loadDisabledGroups(force?: boolean): DisabledGroupsCache;
declare function parseNicknameBlacklistCommand(content?: string): NicknameBlacklistCommand | null;
declare function handleNicknameBlacklistCommand(session: GroupNameSessionLike, command: NicknameBlacklistCommand): Promise<string>;
declare function trimPendingConfirms(now?: number): void;
declare function apply(ctx: ContextLike): void;
declare const _default: {
    name: string;
    apply: typeof apply;
    _test: {
        DATA_FILE: any;
        DISABLED_GROUPS_FILE: any;
        ADMIN_IDS_FILE: any;
        pendingConfirms: Map<string, number>;
        trimPendingConfirms: typeof trimPendingConfirms;
        loadDisabledGroups: typeof loadDisabledGroups;
        parseNicknameBlacklistCommand: typeof parseNicknameBlacklistCommand;
        handleNicknameBlacklistCommand: typeof handleNicknameBlacklistCommand;
        safeSendText: typeof safeSendText;
    };
};
export = _default;
