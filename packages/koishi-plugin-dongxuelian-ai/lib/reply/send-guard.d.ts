type MemberMuteQuery = (groupId: string | number, userId: string | number) => Promise<unknown> | unknown;
type GroupMuteQuery = (groupId: string | number) => Promise<unknown> | unknown;
interface SendSessionLike {
    guildId?: string | number;
    channelId?: string | number;
    isDirect?: boolean;
    selfId?: string | number;
    bot?: {
        selfId?: string | number;
        internal?: Record<string, unknown>;
    };
    event?: {
        selfId?: string | number;
    };
}
interface SendErrorClassification {
    type: 'muted' | 'rate-limit' | 'other';
    retcode: number;
    message: string;
    reason: string;
}
interface PlatformMuteCacheEntry {
    until: number;
    reason: string;
    source: string;
}
interface PlatformMuteStatus extends Partial<PlatformMuteCacheEntry> {
    muted: boolean;
    skipped?: boolean;
    uncertain?: boolean;
}
interface MarkPlatformMuteInfo {
    until?: number | string;
    durationMs?: number | string;
    reason?: string;
    source?: string;
}
interface MuteQueryOptions {
    now?: number;
    getGroupMemberInfo?: MemberMuteQuery;
    getGroupInfo?: GroupMuteQuery;
}
declare function getSendChannelKey(session: SendSessionLike): string;
declare function classifySendError(error: unknown): SendErrorClassification;
declare function sanitizeForRateLimit(text?: string): string;
declare function computeBackoffMs(attempt?: number): number;
declare function sleepForRateLimitRetry(ctx: {
    setTimeout?: typeof setTimeout;
} | null | undefined, attempt?: number): Promise<void>;
declare function getCachedPlatformMuteStatus(session: SendSessionLike, now?: number): PlatformMuteStatus;
declare function markPlatformMute(session: SendSessionLike, info?: MarkPlatformMuteInfo, now?: number): PlatformMuteStatus;
declare function clearPlatformMute(session: SendSessionLike): void;
declare function checkPlatformMuteStatus(session: SendSessionLike, options?: MuteQueryOptions): Promise<PlatformMuteStatus>;
declare const _default: {
    classifySendError: typeof classifySendError;
    sanitizeForRateLimit: typeof sanitizeForRateLimit;
    computeBackoffMs: typeof computeBackoffMs;
    sleepForRateLimitRetry: typeof sleepForRateLimitRetry;
    getSendChannelKey: typeof getSendChannelKey;
    getCachedPlatformMuteStatus: typeof getCachedPlatformMuteStatus;
    markPlatformMute: typeof markPlatformMute;
    clearPlatformMute: typeof clearPlatformMute;
    checkPlatformMuteStatus: typeof checkPlatformMuteStatus;
};
export = _default;
