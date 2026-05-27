interface SessionLike {
    guildId?: string;
    channelId?: string;
    isDirect?: boolean;
    userId?: string;
    username?: string;
    messageId?: string;
    selfId?: string;
    author?: {
        id?: string;
    };
    bot?: {
        selfId?: string;
    };
    quote?: QuoteLike;
}
interface SegmentLike {
    type?: string;
    data?: {
        text?: string;
        name?: string;
        qq?: string | number;
        id?: string | number;
        _transcribedText?: string;
    };
}
interface QuoteLike {
    userId?: string;
    user_id?: string;
    user?: {
        id?: string;
    };
    author?: string | {
        id?: string;
        nick?: string;
        name?: string;
    };
    authorId?: string;
    sender?: {
        userId?: string;
        id?: string;
        nickname?: string;
        card?: string;
        name?: string;
    };
    nickname?: string;
    nick?: string;
    id?: string;
    messageId?: string;
    message_id?: string;
    message?: {
        id?: string;
    };
    content?: string | SegmentLike[];
    raw_message?: string;
    text?: string;
}
interface ConversationMessage {
    role?: string;
    content?: string;
    userId?: string;
    speakerName?: string;
    personaName?: string;
    messageId?: string;
    replyToId?: string;
    mentionUserIds?: string[];
    hasMessageRecordCue?: boolean;
    hasAudio?: boolean;
    ts?: number;
    createdAt?: number;
    meta?: {
        messageId?: string;
        [key: string]: unknown;
    };
}
interface ConversationDiskData {
    summary?: string;
    summaryTotal?: number;
    totalCount?: number;
    messages: ConversationMessage[];
}
interface ReplyFingerprintEntry {
    content: string;
    createdAt: number;
}
interface SharedChannelEntry extends ConversationMessage {
    userId: string;
    role: string;
    speakerName: string;
    personaName: string;
    content: string;
    messageId: string;
    replyToId: string;
    mentionUserIds: string[];
    hasMessageRecordCue: boolean;
    hasAudio: boolean;
    ts: number;
}
interface TodayCacheMessage {
    time: string;
    ts: number;
    user: string;
    userId: string;
    content: string;
    messageId: string;
    mentionUserIds: string[];
}
interface TodayCache {
    date: string;
    messages: TodayCacheMessage[];
    updatedAt?: number;
    lastDiskWrite?: number;
}
interface SharedTurnMetadata {
    mentionUserIds?: Array<string | number>;
    personaName?: string;
    messageId?: string | number;
    replyToId?: string | number;
    hasMessageRecordCue?: boolean;
    hasAudio?: boolean;
    fromSummary?: boolean;
}
interface SharedContextOptions extends SharedTurnMetadata {
    currentText?: string;
    directAt?: boolean;
    nameMentioned?: boolean;
    isDirect?: boolean;
    randomTriggered?: boolean;
}
interface MemoryTimerData {
    intervalHours?: number;
    lastClearTs?: number;
}
interface QuoteInfo {
    content: string;
    authorName: string;
    authorId: string;
    messageId: string;
    isSelf: boolean;
    matchedMessage: SharedChannelEntry | null;
}
declare function setLastForwardSummaryCache(channelKey: string, text: string, ts?: number): void;
declare function trimChannelRuntimeCaches(now?: number): void;
declare function trimConversationRuntimeCaches(now?: number): void;
declare function getChannelKey(session: SessionLike): string;
declare function getConversationKey(session: SessionLike): string;
declare function touchConversation(session: SessionLike): void;
declare function touchConversationAccess(session: SessionLike): void;
declare function readConversationDisk(key: string): ConversationDiskData | null;
declare function writeConversationDisk(key: string, data: ConversationDiskData): void;
declare function replaceImagePlaceholderInConversation(key: string, messageId: string, analysis: string): Promise<boolean>;
declare function getConversationHistory(session: SessionLike): ConversationMessage[];
declare function mergeConversationMessages(diskMessages?: ConversationMessage[], cachedMessages?: ConversationMessage[]): ConversationMessage[];
declare function saveConversationTurn(session: SessionLike, userText: string, replyText: string): void;
declare function generateConversationSummary(key: string): Promise<void>;
declare function clearConversationHistory(): void;
declare function clearUserConversationHistory(session: SessionLike): void;
declare function getReplyFingerprintHistory(session: SessionLike): ReplyFingerprintEntry[];
declare function saveReplyFingerprint(session: SessionLike, replyText: string): void;
declare function getRecentAssistantReplies(session: SessionLike, limit?: number): string[];
declare function parseUserMessageEnvelope(content?: string): {
    nickname: string;
    content: string;
    wrapped: boolean;
};
declare function getUserMessageContent(content?: string): string;
declare function normalizeUserMessageForPrompt(message: ConversationMessage): ConversationMessage;
declare function getRecentUserMessages(session: SessionLike, limit?: number): string[];
declare function getRecentUserMessageRecords(session: SessionLike, limit?: number): ConversationMessage[];
declare function flushTodayCacheToDisk(channelKey: string): void;
declare function saveSharedChannelTurn(session: SessionLike, speakerName: string, content: string, role?: string, metadata?: SharedTurnMetadata): void;
declare function cleanupDailyStatsFiles(): Promise<{
    removed: number;
    compacted: number;
}>;
declare function saveUserProfile(userId: string, name: string, content: string, channelKey: string): Promise<void>;
declare function writeMemory(userId: string, name: string, channelKey: string, text: string): Promise<void>;
declare function deleteMemory(userId: string, channelKey: string, text: string): Promise<void>;
declare function clearUserMemory(userId: string, channelKey: string): Promise<void>;
declare function clearGroupMemory(channelKey: string): Promise<void>;
declare function getMemorySummary(userId: string, channelKey: string): Promise<string>;
declare function findChannelMessageById(channelKey: string, messageId?: string): SharedChannelEntry | null;
declare function collectReplyChain(channelKey: string, replyToId?: string): SharedChannelEntry[];
declare function getQuoteContentText(session: SessionLike): string;
declare function getQuoteInfo(session: SessionLike, options?: SharedContextOptions): QuoteInfo;
declare function getQuotedMessageNote(session: SessionLike, options?: SharedContextOptions): string;
declare function getSharedContextNote(session: SessionLike, currentUserId?: string, options?: SharedContextOptions): string;
declare function saveSensitiveCache(channelKey: string, value: string, speakerName: string, userId: string): void;
declare function analyzeChannelSensitive(channelKey: string): Promise<void>;
declare function readMemoryTimer(channelKey: string): MemoryTimerData | null;
declare function checkMemoryTimerExpired(channelKey: string): boolean;
declare const _default: {
    conversationCache: Map<string, ConversationMessage[]>;
    replyFingerprintCache: Map<string, ReplyFingerprintEntry[]>;
    conversationLastActiveAt: Map<string, number>;
    conversationCacheAccessAt: Map<string, number>;
    channelSharedCache: Map<string, SharedChannelEntry[]>;
    lastForwardSummaryCache: Map<string, string>;
    setLastForwardSummaryCache: typeof setLastForwardSummaryCache;
    pendingSensitiveAlert: Map<string, {
        flagged?: boolean;
        ts: number;
    }>;
    channelTodayCache: Map<string, TodayCache>;
    getConversationKey: typeof getConversationKey;
    getChannelKey: typeof getChannelKey;
    touchConversation: typeof touchConversation;
    touchConversationAccess: typeof touchConversationAccess;
    readConversationDisk: typeof readConversationDisk;
    writeConversationDisk: typeof writeConversationDisk;
    replaceImagePlaceholderInConversation: typeof replaceImagePlaceholderInConversation;
    getConversationHistory: typeof getConversationHistory;
    saveConversationTurn: typeof saveConversationTurn;
    mergeConversationMessages: typeof mergeConversationMessages;
    generateConversationSummary: typeof generateConversationSummary;
    clearConversationHistory: typeof clearConversationHistory;
    clearUserConversationHistory: typeof clearUserConversationHistory;
    getReplyFingerprintHistory: typeof getReplyFingerprintHistory;
    saveReplyFingerprint: typeof saveReplyFingerprint;
    getRecentAssistantReplies: typeof getRecentAssistantReplies;
    getRecentUserMessages: typeof getRecentUserMessages;
    getRecentUserMessageRecords: typeof getRecentUserMessageRecords;
    parseUserMessageEnvelope: typeof parseUserMessageEnvelope;
    getUserMessageContent: typeof getUserMessageContent;
    normalizeUserMessageForPrompt: typeof normalizeUserMessageForPrompt;
    saveSharedChannelTurn: typeof saveSharedChannelTurn;
    findChannelMessageById: typeof findChannelMessageById;
    collectReplyChain: typeof collectReplyChain;
    getQuoteContentText: typeof getQuoteContentText;
    getQuoteInfo: typeof getQuoteInfo;
    getQuotedMessageNote: typeof getQuotedMessageNote;
    getSharedContextNote: typeof getSharedContextNote;
    saveUserProfile: typeof saveUserProfile;
    saveSensitiveCache: typeof saveSensitiveCache;
    analyzeChannelSensitive: typeof analyzeChannelSensitive;
    writeMemory: typeof writeMemory;
    deleteMemory: typeof deleteMemory;
    clearUserMemory: typeof clearUserMemory;
    clearGroupMemory: typeof clearGroupMemory;
    getMemorySummary: typeof getMemorySummary;
    readMemoryTimer: typeof readMemoryTimer;
    checkMemoryTimerExpired: typeof checkMemoryTimerExpired;
    flushTodayCacheToDisk: typeof flushTodayCacheToDisk;
    trimChannelRuntimeCaches: typeof trimChannelRuntimeCaches;
    trimConversationRuntimeCaches: typeof trimConversationRuntimeCaches;
    cleanupDailyStatsFiles: typeof cleanupDailyStatsFiles;
};
export = _default;
