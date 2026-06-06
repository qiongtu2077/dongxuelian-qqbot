interface PendingRandomEntry {
    timer?: NodeJS.Timeout;
    [key: string]: unknown;
}
interface RandomSendContext {
    randomTriggered?: boolean;
    channelKey?: string;
    triggerMessageVersion?: number;
    explicitVersion?: number;
    triggerAt?: number;
    highRisk?: boolean;
    triggerMessageId?: string;
    delayed?: boolean;
    currentMessageVersion?: number;
}
interface RandomFreshness {
    channelKey: string;
    triggerMessageVersion: number;
    explicitVersion: number;
    triggerAt: number;
}
interface RandomSendOptions {
    randomFreshness?: RandomFreshness;
    forceQuote?: boolean;
    quoteMessageId?: string | number;
    [key: string]: unknown;
}
declare function getRandomMissCount(channelKey: string): number;
declare function setRandomMissCount(channelKey: string, count: number): number;
declare function incrementRandomMiss(channelKey: string): number;
declare function resetRandomMiss(channelKey: string): number;
declare function getRandomTriggerRate(channelKey: string, getBaseRate: number | ((channelKey: string) => number)): number;
declare function isRandomCooldownActive(channelKey: string, now?: number, cooldownMs?: number): boolean;
declare function markRandomReplySent(channelKey: string, now?: number): void;
declare function getRandomMuteRemaining(channelKey: string, now?: number): number;
declare function muteRandomChannel(channelKey: string, durationMs?: number, now?: number): boolean;
declare function isRandomMuted(channelKey: string, now?: number): boolean;
declare function getChannelMessageVersion(channelKey: string): number;
declare function bumpChannelMessageVersion(channelKey: string): number;
declare function getExplicitInteractionVersion(channelKey: string): number;
declare function bumpExplicitInteractionVersion(channelKey: string): number;
declare function trimRandomChannelState(): void;
declare function getPendingRandom(channelKey: string): PendingRandomEntry | null;
declare function setPendingRandom(channelKey: string, entry: PendingRandomEntry): boolean;
declare function takePendingRandom(channelKey: string): PendingRandomEntry | null;
declare function cancelPendingRandom(channelKey: string, reason?: string): boolean;
declare function clearRandomPendingState(): void;
declare function buildRandomSendOptions(context?: RandomSendContext): RandomSendOptions;
declare function isRandomReplyFresh(options?: RandomSendOptions, now?: number): boolean;
declare function isSafeSendReplyFresh(isRandom?: boolean, sendOptions?: RandomSendOptions): boolean;
declare const _default: {
    channelMissCount: Map<string, number>;
    getRandomMissCount: typeof getRandomMissCount;
    setRandomMissCount: typeof setRandomMissCount;
    incrementRandomMiss: typeof incrementRandomMiss;
    resetRandomMiss: typeof resetRandomMiss;
    getRandomTriggerRate: typeof getRandomTriggerRate;
    isRandomCooldownActive: typeof isRandomCooldownActive;
    markRandomReplySent: typeof markRandomReplySent;
    getRandomMuteRemaining: typeof getRandomMuteRemaining;
    muteRandomChannel: typeof muteRandomChannel;
    isRandomMuted: typeof isRandomMuted;
    getChannelMessageVersion: typeof getChannelMessageVersion;
    bumpChannelMessageVersion: typeof bumpChannelMessageVersion;
    getExplicitInteractionVersion: typeof getExplicitInteractionVersion;
    bumpExplicitInteractionVersion: typeof bumpExplicitInteractionVersion;
    trimRandomChannelState: typeof trimRandomChannelState;
    getPendingRandom: typeof getPendingRandom;
    setPendingRandom: typeof setPendingRandom;
    takePendingRandom: typeof takePendingRandom;
    cancelPendingRandom: typeof cancelPendingRandom;
    clearRandomPendingState: typeof clearRandomPendingState;
    buildRandomSendOptions: typeof buildRandomSendOptions;
    isRandomReplyFresh: typeof isRandomReplyFresh;
    isSafeSendReplyFresh: typeof isSafeSendReplyFresh;
};
export = _default;
