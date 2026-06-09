interface BasicSession {
    userId?: string;
    selfId?: string;
    content?: string;
    author?: {
        id?: string;
    };
    event?: {
        user?: {
            id?: string;
        };
        message?: unknown[] | {
            elements?: unknown[];
            content?: unknown[];
        };
    };
    bot?: {
        selfId?: string;
    };
}
interface ReadFileOptions {
    maxBytes?: number | string;
}
interface SearchConfig {
    provider?: string;
    model?: string;
    baseURL?: string;
    searchEnabled?: boolean;
}
interface ChannelMessageEntry {
    ts: number;
}
interface SegmentLike {
    data?: unknown;
    attrs?: unknown;
}
interface SplitReplyOptions {
    softChars?: number;
    maxParts?: number;
}
interface DnsAddress {
    address: string;
    family: number;
}
declare function normalizeText(text?: unknown): string;
declare function isRareProvocation(text?: string): boolean;
declare function isWideRareProvocation(text?: string): boolean;
declare function isHostileInput(text?: string): boolean;
declare function isJailbreakAttempt(plain?: string): boolean;
declare function pickJailbreakFallbackReply(): string;
declare function isReservedCommand(plain?: string): boolean;
declare function getSenderUserId(session: BasicSession): string;
declare function hasAdminPermission(session: BasicSession): boolean;
declare function stripMentions(text?: string): string;
declare function collapseRepeatedBotCalls(text?: string): string;
declare function sanitizeUserInput(text?: string): string;
declare function sanitizeUserName(name?: string): string;
declare function extractAtIds(text?: string): string[];
declare function countAtIdOccurrences(text?: string, targetId?: string): number;
declare function isDirectAtBot(session: BasicSession): boolean;
declare function getBotMentionCount(session: BasicSession): number;
declare function hasOtherMentions(session: BasicSession): boolean;
declare function formatPercent(rate?: number): string;
declare function readTextFile(file: string, options?: ReadFileOptions): Promise<string>;
declare function writeTextFile(file: string, value: unknown): Promise<void>;
declare function readJsonFile<T>(file: string, fallback: T, options?: ReadFileOptions): Promise<T>;
declare function writeJsonFile(file: string, value: unknown): Promise<void>;
declare function readJsonFileSync<T>(file: string, fallback: T, options?: ReadFileOptions): T;
declare function writeJsonFileSync(file: string, value: unknown): void;
declare function safeUnlink(file: string): Promise<boolean>;
declare function getFileFingerprint(filePath: string): Promise<string>;
declare function sleep(ms: number): Promise<void>;
declare function getRandomDelayMs(): number;
declare function shouldTriggerRandom(rate: number, randomFn?: () => number): boolean;
declare function parseEnabledText(value?: string): boolean;
declare function getBaseHostname(baseURL?: string): string;
declare function isDashScopeConfig(config?: SearchConfig): boolean;
declare function isOpenAIOfficialConfig(config?: SearchConfig): boolean;
declare function normalizeUrl(raw: string): string;
declare function normalizeHostname(hostname?: unknown): string;
declare function isPrivateHostname(hostname?: unknown): boolean;
declare function isPrivateIp(ip?: unknown): boolean;
declare function validatePublicHttpUrl(rawUrl: unknown): URL;
declare function resolveAndValidateHostname(url: string | URL): Promise<DnsAddress[]>;
declare function extractImageUrls(content?: string): string[];
declare function extractVoiceUrls(content?: string): string[];
declare function sanitizeFileToken(value?: string): string;
declare function safeChannelKey(value?: string): string;
declare function safeUserId(value?: string): string;
declare function legacySafeUserId(value?: string): string;
declare function truncateTextValue(value: string, maxLen: number): string;
declare function safeJsonStringify(value: unknown): string;
declare function normalizeReplyFingerprint(text?: string): string;
declare function longestCommonSubstringLength(a: string, b: string, threshold?: number): number;
declare function charSetJaccardOverlap(a: string, b: string): number;
declare function isReplyTooSimilar(left?: string, right?: string): boolean;
declare function isOverusedReply(reply?: string): boolean;
declare function hasBannedOutput(text: string): boolean;
declare function isThinkingLeak(text?: string): boolean;
declare function isEvaluationRequest(text?: string): boolean;
declare function getModelDisplayName(providerId: string, modelId: string): string;
declare function getSearchCapability(config?: SearchConfig): {
    supported: boolean;
    mode: string;
    label: string;
};
declare function formatSearchStatus(config?: SearchConfig): string;
declare function trimReply(text?: string, maxChars?: number): string;
declare function sanitizeReply(text?: string, userName?: string): string;
declare function calculateWillFactor(channelKey: string, personaName: string, channelSharedCache: Map<string, ChannelMessageEntry[]>, personaContent?: string): number;
declare function isSemanticProfile(text: string): boolean;
declare function getSegmentData(segment: SegmentLike | null | undefined): unknown;
declare function getSessionMessageSegments(session: BasicSession): unknown[];
declare function stripMarkdownForQQ(text: string): string;
declare function splitSentences(text: string): string[];
declare function splitReplyForQQBubbles(text: string, options?: SplitReplyOptions): string[];
declare function todayCst(date?: Date): string;
/** 上海时区 24 小时制 HH:mm:ss，供 today-cache 展示与兼容旧解析 */
declare function formatShanghaiTime24h(ts?: number): string;
/** 0–23，供 24 小时分布图 */
declare function getShanghaiHourFromTs(ts: number): number;
/** 上海日历上 todayYmd 往前 n 天（字符串 YYYY-MM-DD），用于情绪历史截断 */
declare function todayCstMinusDays(daysBack: number): string;
/** 从 catch 到的未知错误里安全取出文本消息（catch 变量在 strict 下是 unknown） */
declare function errorMessage(error: unknown): string;
/** 从 catch 到的未知错误里安全取出 Node errno code（如 EEXIST/EPERM） */
declare function errorCode(error: unknown): string;
declare function withTimeout<T>(fn: () => Promise<T> | T, timeoutMs: number, options?: {
    code?: string;
}): Promise<T>;
declare const _default: {
    isRareProvocation: typeof isRareProvocation;
    isWideRareProvocation: typeof isWideRareProvocation;
    isHostileInput: typeof isHostileInput;
    normalizeText: typeof normalizeText;
    isJailbreakAttempt: typeof isJailbreakAttempt;
    pickJailbreakFallbackReply: typeof pickJailbreakFallbackReply;
    isReservedCommand: typeof isReservedCommand;
    getSenderUserId: typeof getSenderUserId;
    hasAdminPermission: typeof hasAdminPermission;
    stripMentions: typeof stripMentions;
    collapseRepeatedBotCalls: typeof collapseRepeatedBotCalls;
    sanitizeUserInput: typeof sanitizeUserInput;
    sanitizeUserName: typeof sanitizeUserName;
    extractAtIds: typeof extractAtIds;
    countAtIdOccurrences: typeof countAtIdOccurrences;
    isDirectAtBot: typeof isDirectAtBot;
    getBotMentionCount: typeof getBotMentionCount;
    hasOtherMentions: typeof hasOtherMentions;
    formatPercent: typeof formatPercent;
    readTextFile: typeof readTextFile;
    writeTextFile: typeof writeTextFile;
    readJsonFile: typeof readJsonFile;
    writeJsonFile: typeof writeJsonFile;
    readJsonFileSync: typeof readJsonFileSync;
    writeJsonFileSync: typeof writeJsonFileSync;
    safeUnlink: typeof safeUnlink;
    getFileFingerprint: typeof getFileFingerprint;
    sleep: typeof sleep;
    getRandomDelayMs: typeof getRandomDelayMs;
    shouldTriggerRandom: typeof shouldTriggerRandom;
    parseEnabledText: typeof parseEnabledText;
    getBaseHostname: typeof getBaseHostname;
    isDashScopeConfig: typeof isDashScopeConfig;
    isOpenAIOfficialConfig: typeof isOpenAIOfficialConfig;
    normalizeUrl: typeof normalizeUrl;
    normalizeHostname: typeof normalizeHostname;
    isPrivateHostname: typeof isPrivateHostname;
    isPrivateIp: typeof isPrivateIp;
    validatePublicHttpUrl: typeof validatePublicHttpUrl;
    resolveAndValidateHostname: typeof resolveAndValidateHostname;
    extractImageUrls: typeof extractImageUrls;
    extractVoiceUrls: typeof extractVoiceUrls;
    sanitizeFileToken: typeof sanitizeFileToken;
    safeChannelKey: typeof safeChannelKey;
    safeUserId: typeof safeUserId;
    legacySafeUserId: typeof legacySafeUserId;
    truncateText: typeof truncateTextValue;
    safeJsonStringify: typeof safeJsonStringify;
    normalizeReplyFingerprint: typeof normalizeReplyFingerprint;
    longestCommonSubstringLength: typeof longestCommonSubstringLength;
    charSetJaccardOverlap: typeof charSetJaccardOverlap;
    isReplyTooSimilar: typeof isReplyTooSimilar;
    isOverusedReply: typeof isOverusedReply;
    hasBannedOutput: typeof hasBannedOutput;
    isThinkingLeak: typeof isThinkingLeak;
    isEvaluationRequest: typeof isEvaluationRequest;
    calculateWillFactor: typeof calculateWillFactor;
    isSemanticProfile: typeof isSemanticProfile;
    getSegmentData: typeof getSegmentData;
    getSessionMessageSegments: typeof getSessionMessageSegments;
    getModelDisplayName: typeof getModelDisplayName;
    getSearchCapability: typeof getSearchCapability;
    formatSearchStatus: typeof formatSearchStatus;
    trimReply: typeof trimReply;
    sanitizeReply: typeof sanitizeReply;
    stripMarkdownForQQ: typeof stripMarkdownForQQ;
    splitSentences: typeof splitSentences;
    splitReplyForQQBubbles: typeof splitReplyForQQBubbles;
    todayCst: typeof todayCst;
    formatShanghaiTime24h: typeof formatShanghaiTime24h;
    getShanghaiHourFromTs: typeof getShanghaiHourFromTs;
    todayCstMinusDays: typeof todayCstMinusDays;
    errorMessage: typeof errorMessage;
    errorCode: typeof errorCode;
    withTimeout: typeof withTimeout;
};
export = _default;
