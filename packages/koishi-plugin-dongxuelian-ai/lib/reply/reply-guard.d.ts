interface SessionLike {
    guildId?: string;
    channelId?: string;
    isDirect?: boolean;
    userId?: string;
    author?: {
        id?: string;
    };
}
interface SceneAnchorLike {
    type?: unknown;
}
interface SceneItemLike {
    anchors?: SceneAnchorLike[];
    content?: unknown;
}
interface OldMediaStickingInput {
    reply?: unknown;
    currentTurn?: SceneItemLike[];
    oldBackground?: SceneItemLike[];
    hotContext?: SceneItemLike[];
    hasCurrentMediaCue?: boolean;
}
declare function shouldRetryRepeatedReply(session: SessionLike, reply?: string): boolean;
declare function buildRepeatRetryPrompt(userText: string, recentReplies?: string[]): string;
declare function pickAbusiveFallbackReply(session: SessionLike): string;
declare function pickRepeatedFallbackReply(session: SessionLike): string;
declare function isConsecutiveUserRepeat(session: SessionLike, userText?: string): boolean;
declare function isUnsafeThinkingReply(reply?: string): boolean;
declare function stripStickerMarkersForGuard(reply?: string): string;
declare function hasInternalContextLeak(text?: string): boolean;
declare function detectOldMediaTopicSticking({ reply, currentTurn, oldBackground, hotContext, hasCurrentMediaCue }?: OldMediaStickingInput): boolean;
declare function buildOldMediaStickingRetryPrompt(): string;
declare const _default: {
    shouldRetryRepeatedReply: typeof shouldRetryRepeatedReply;
    buildRepeatRetryPrompt: typeof buildRepeatRetryPrompt;
    pickAbusiveFallbackReply: typeof pickAbusiveFallbackReply;
    pickRepeatedFallbackReply: typeof pickRepeatedFallbackReply;
    isConsecutiveUserRepeat: typeof isConsecutiveUserRepeat;
    isUnsafeThinkingReply: typeof isUnsafeThinkingReply;
    stripStickerMarkersForGuard: typeof stripStickerMarkersForGuard;
    hasInternalContextLeak: typeof hasInternalContextLeak;
    detectOldMediaTopicSticking: typeof detectOldMediaTopicSticking;
    buildOldMediaStickingRetryPrompt: typeof buildOldMediaStickingRetryPrompt;
};
export = _default;
