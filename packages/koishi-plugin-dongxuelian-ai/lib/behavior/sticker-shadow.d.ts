type StickerDict = Record<string, unknown>;
interface StickerSegment extends StickerDict {
    type?: string;
    attributes?: StickerDict;
    attrs?: StickerDict;
    data?: StickerDict;
    children?: StickerSegment[];
    elements?: StickerSegment[];
    content?: unknown;
}
interface StickerSession {
    content?: string;
    guildId?: string;
    channelId?: string;
    userId?: string;
    username?: string;
    selfId?: string;
    messageId?: string;
    author?: {
        id?: string;
    };
    bot?: {
        selfId?: string;
    };
}
interface StickerVisualInfo {
    kind: string;
    hasVisual: boolean;
    hasImage: boolean;
    hasMface: boolean;
    hasFace: boolean;
    hasVideo: boolean;
    hasUrl: boolean;
    hasFileRef: boolean;
    hasEmbed: boolean;
    hasFileMessage: boolean;
    isGif: boolean;
    stickerLike: boolean;
    ext: string;
    refHash: string;
    segmentTypes: string[];
}
interface StickerShadowInput extends StickerDict {
    session?: StickerSession;
    analyzed?: {
        hasVisual?: boolean;
        hasEmbed?: boolean;
        hasFile?: boolean;
    };
    content?: string;
    segments?: StickerSegment[];
    channelKey?: string;
    userId?: string;
    selfId?: string;
    messageId?: string;
    now?: number;
    minOccurrences?: number;
    minContributors?: number;
    personaName?: string;
    sendOptions?: {
        stickerShadowContext?: {
            personaName?: string;
            affectDiagnostic?: AffectDiagnostic;
        };
    };
    replyText?: string;
    reply?: string;
    isRandom?: boolean;
    affectDiagnostic?: AffectDiagnostic;
}
interface AffectDiagnostic {
    mood?: string;
    recommendedMode?: string;
    blockers?: string[];
    outputs?: {
        emoji?: {
            allowed?: boolean;
        };
    };
}
interface SeedIndexEntry {
    fileHash: string;
    labelHash: string;
    labelSample: string;
    ext: string;
    size: number;
}
interface SeedIndex {
    seedDirHash: string;
    seedCount: number;
    stickers: SeedIndexEntry[];
}
interface StickerShadowLogOptions {
    file?: string;
    rootDir?: string;
    loggedAt?: number;
    seedDir?: string;
    limit?: number;
}
declare function stickerShadowHashValue(value?: unknown, length?: number): string;
declare function stickerShadowSanitizeSample(value?: unknown, maxLength?: number): string;
declare function stickerShadowInferVisual(input?: StickerShadowInput): StickerVisualInfo;
declare function buildStickerShadowIngestPlan(input?: StickerShadowInput): StickerDict;
declare function formatStickerShadowIngestDiagnostic(plan?: StickerDict): string;
declare function loadStickerShadowSeedIndex(options?: StickerShadowLogOptions): Promise<SeedIndex>;
declare function buildStickerShadowSendPlan(input?: StickerShadowInput, options?: StickerShadowLogOptions): Promise<StickerDict>;
declare function formatStickerShadowSendDiagnostic(plan?: StickerDict): string;
declare function getStickerShadowLogFile(ts?: number, rootDir?: string): string;
declare function buildStickerShadowLogEvent(plan?: StickerDict, options?: StickerShadowLogOptions): StickerDict;
declare function appendStickerShadowLog(plan?: StickerDict, options?: StickerShadowLogOptions): Promise<unknown>;
declare const _default: {
    STICKER_SHADOW_VERSION: number;
    STICKER_SHADOW_LOG_DIR: string;
    STICKER_SHADOW_LOG_MAX_BYTES: number;
    STICKER_SHADOW_DECISIONS: Readonly<{
        skipNoVisual: "skip_no_visual";
        skipAssistant: "skip_assistant_message";
        skipBuiltinFace: "skip_builtin_face";
        skipGif: "skip_gif_until_vetter_policy";
        skipEmbed: "skip_embed_or_file";
        skipMissingRef: "skip_missing_image_ref";
        observePending: "observe_pending_if_enabled";
        sendSkipEmpty: "skip_empty_reply";
        sendNoCandidate: "no_seed_candidate";
        sendMarkerNoCandidate: "no_seed_candidate_for_marker";
        sendAffectBlocked: "would_pick_but_affect_blocks";
        sendExplicit: "would_send_seed_if_enabled";
        sendProbabilityGate: "would_enter_probability_gate_if_enabled";
    }>;
    stickerShadowHashValue: typeof stickerShadowHashValue;
    stickerShadowSanitizeSample: typeof stickerShadowSanitizeSample;
    stickerShadowInferVisual: typeof stickerShadowInferVisual;
    buildStickerShadowIngestPlan: typeof buildStickerShadowIngestPlan;
    formatStickerShadowIngestDiagnostic: typeof formatStickerShadowIngestDiagnostic;
    loadStickerShadowSeedIndex: typeof loadStickerShadowSeedIndex;
    buildStickerShadowSendPlan: typeof buildStickerShadowSendPlan;
    formatStickerShadowSendDiagnostic: typeof formatStickerShadowSendDiagnostic;
    getStickerShadowLogFile: typeof getStickerShadowLogFile;
    buildStickerShadowLogEvent: typeof buildStickerShadowLogEvent;
    appendStickerShadowLog: typeof appendStickerShadowLog;
};
export = _default;
