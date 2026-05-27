interface ReplyTimingInput {
    phase?: unknown;
    inGuild?: unknown;
    isPrivate?: unknown;
    directAt?: unknown;
    nameMentioned?: unknown;
    otherMentions?: unknown;
    inRandomWhitelist?: unknown;
    isRandomCandidate?: unknown;
    randomHit?: unknown;
    randomTriggered?: unknown;
    delayedRandomScheduled?: unknown;
    cooldownActive?: unknown;
    mutedActive?: unknown;
    highRisk?: unknown;
    explicitCanceled?: unknown;
    skipForRandomReply?: unknown;
    hasUsableText?: unknown;
    hasVisual?: unknown;
    hasLink?: unknown;
    hasFile?: unknown;
    hasEmbed?: unknown;
    baseRate?: unknown;
    willFactor?: unknown;
    effectiveRate?: unknown;
    missCount?: unknown;
    personaName?: unknown;
    personaSource?: unknown;
    groupPersonaName?: unknown;
    channelKey?: unknown;
}
interface ReplyTimingDiagnostic {
    version: number;
    kind: string;
    phase: string;
    decision: string;
    score: number;
    reasons: string[];
    blockers: string[];
    legacy: {
        candidate: boolean;
        randomHit: boolean;
        randomTriggered: boolean;
        delayedRandomScheduled: boolean;
        baseRate: number;
        effectiveRate: number;
        willFactor: number;
        missCount: number;
    };
    persona: {
        name: string;
        source: string;
        groupName: string;
        highRisk: boolean;
    };
    message: {
        channelHash: string;
        inGuild: boolean;
        isPrivate: boolean;
        directAt: boolean;
        otherMentions: boolean;
        nameMentioned: boolean;
        hasUsableText: boolean;
        hasLink: boolean;
        hasVisual: boolean;
        hasFile: boolean;
        hasEmbed: boolean;
        skipForRandomReply: boolean;
    };
}
declare function replyTimingHash(value?: unknown): string;
declare function buildReplyTimingDiagnostic(input?: ReplyTimingInput): ReplyTimingDiagnostic;
declare function formatReplyTimingDiagnostic(diagnostic?: Partial<ReplyTimingDiagnostic>): string;
declare const _default: {
    REPLY_TIMING_DIAGNOSTIC_VERSION: number;
    replyTimingHash: typeof replyTimingHash;
    buildReplyTimingDiagnostic: typeof buildReplyTimingDiagnostic;
    formatReplyTimingDiagnostic: typeof formatReplyTimingDiagnostic;
};
export = _default;
