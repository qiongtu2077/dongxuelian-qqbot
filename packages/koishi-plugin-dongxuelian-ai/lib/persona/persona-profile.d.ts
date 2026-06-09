type ProfileRecord = Record<string, unknown>;
type ProfileCounts = Record<string, number>;
interface PersonaProfileEvidence {
    source?: string;
    ts?: number;
    quoteHash?: string;
    shortQuote?: string;
    messageIdHash?: string;
    channelHash?: string;
    text?: string;
    messageId?: string;
    channelKey?: string;
    createdAt?: number;
    updatedAt?: number;
}
interface PersonaProfileBlock extends ProfileRecord {
    id?: string;
    block?: string;
    category?: string;
    text?: string;
    sensitivity?: string;
    confidence?: number;
    evidence?: PersonaProfileEvidence[];
    source?: string;
    status?: string;
    createdAt?: number;
    updatedAt?: number;
    lastAccessedAt?: number;
    reinforceCount?: number;
    expiresAt?: number;
    effectiveConfidence?: number;
}
interface PersonaProfile {
    version?: number;
    user?: {
        id?: string;
        idHash?: string;
        names?: string[];
    };
    channel?: {
        hash?: string;
    };
    blocks?: PersonaProfileBlock[];
    diagnostics?: Array<ProfileRecord>;
    sourceStats?: ProfileRecord;
    summary?: ProfileRecord;
}
interface PersonaProfileOptions extends ProfileRecord {
    now?: number;
    userId?: string;
    channelKey?: string;
    rootDir?: string;
    includeRecentMessages?: boolean;
    includeAgentMemory?: boolean;
    maxRecentMessages?: number;
    agentMemoryLimit?: number;
    agentMemoryReader?: (options: {
        userId: string;
        limit: number;
    }) => Promise<Array<ProfileRecord>>;
    selection?: ProfileRecord;
    selectedRanks?: Map<string, number>;
    minEffectiveConfidence?: number;
    allowedStatuses?: string[];
    includeSensitive?: boolean;
    decayPerDay?: number;
    adminSources?: string[];
    adminMinConfidence?: number;
    increment?: number;
    maxEvidence?: number;
    file?: string;
}
declare function hashPersonaProfileValue(value?: unknown, length?: number): string;
declare function normalizePersonaProfileText(value?: unknown, maxLength?: number): string;
declare function getPersonaProfileShadowLogFile(ts?: unknown, rootDir?: string): string;
declare function buildPersonaProfileEvidence(input?: PersonaProfileEvidence & ProfileRecord): PersonaProfileEvidence;
declare function buildPersonaProfileBlock(input?: PersonaProfileBlock & {
    maxTextLength?: number;
    now?: number;
}): PersonaProfileBlock | null;
declare function reinforcePersonaProfileBlock(existing?: PersonaProfileBlock, incoming?: PersonaProfileBlock, options?: PersonaProfileOptions): {
    matched: boolean;
    reason: string;
    block: PersonaProfileBlock | null;
} | {
    matched: boolean;
    reason: string;
    block: {
        confidence: number;
        reinforceCount: number;
        lastAccessedAt: number;
        updatedAt: number;
        evidence: PersonaProfileEvidence[];
        id?: string;
        block?: string;
        category?: string;
        text?: string;
        sensitivity?: string;
        source?: string;
        status?: string;
        createdAt?: number;
        expiresAt?: number;
        effectiveConfidence?: number;
    };
};
declare function buildPersonaProfileReinforcementShadow(blocks?: PersonaProfileBlock[], options?: PersonaProfileOptions): {
    version: number;
    now: number;
    originalCount: number;
    dedupedCount: number;
    reinforcedCount: number;
    invalidCount: number;
    reasonCounts: ProfileCounts;
    blocks: PersonaProfileBlock[];
};
declare function formatPersonaProfileReinforcementShadowDiagnostic(shadow?: ProfileRecord): string;
declare function computePersonaProfileEffectiveConfidence(block?: PersonaProfileBlock, options?: PersonaProfileOptions): number;
declare function selectPersonaProfileBlocksByEffectiveConfidence(blocks?: PersonaProfileBlock[], options?: PersonaProfileOptions): {
    version: number;
    now: number;
    considered: number;
    selected: PersonaProfileBlock[];
    candidates: PersonaProfileBlock[];
    skipped: ProfileCounts;
    minEffectiveConfidence: number;
    limit: number;
};
declare function buildPersonaProfileSelectionDiagnostic(profile?: PersonaProfile, options?: PersonaProfileOptions): {
    version: number;
    userHash: string;
    channelHash: string;
    total: number;
    considered: number;
    selected: number;
    top: {
        idHash: string;
        block: string;
        category: string;
        status: string;
        sensitivity: string;
        effectiveConfidence: number;
        reinforceCount: number;
    }[];
    skipped: ProfileCounts;
    reasons: string[];
};
declare function formatPersonaProfileSelectionDiagnostic(diagnostic?: ProfileRecord): string;
declare function buildPersonaProfileReinforceDiagnostic(input?: ProfileRecord): {
    version: number;
    matched: boolean;
    reason: string;
    factHash: string;
    oldConfidence: number;
    newConfidence: number;
    effectiveConfidence: number;
    reinforceCount: number;
    quoteHash: string;
    selectedTopN: boolean;
};
declare function formatPersonaProfileReinforceDiagnostic(diagnostic?: ProfileRecord): string;
declare function buildPersonaProfileBlocksFromLegacyData(data?: ProfileRecord, options?: PersonaProfileOptions): PersonaProfile;
declare function buildPersonaProfileBlocks(options?: PersonaProfileOptions): Promise<PersonaProfile>;
declare function summarizePersonaProfileBlocks(profile?: PersonaProfile): {
    version: number;
    userHash: string;
    channelHash: string;
    total: number;
    byBlock: ProfileCounts;
    byStatus: ProfileCounts;
    diagnostics: {
        level: {};
        code: {};
        source: {};
    }[];
};
declare function buildPersonaProfileSourceDiagnostic(profile?: PersonaProfile, options?: PersonaProfileOptions): {
    version: number;
    userHash: string;
    channelHash: string;
    memory: number;
    confirmedMemory: number;
    unconfirmedMemory: number;
    messages: number;
    recentMessageWindow: number;
    recentMessageBlocks: number;
    agentMemory: number;
    includeRecentMessages: boolean;
    includeAgentMemory: boolean;
    totalBlocks: number;
    reasons: string[];
};
declare function formatPersonaProfileSourceDiagnostic(diagnostic?: ProfileRecord): string;
declare function buildPersonaProfileShadowPreview(profile?: PersonaProfile, options?: PersonaProfileOptions): ProfileRecord;
declare function buildPersonaProfileShadowLogEvent(preview?: ProfileRecord, options?: PersonaProfileOptions): ProfileRecord;
declare function formatPersonaProfileShadowLearningDiagnostic(preview?: ProfileRecord): string;
declare function formatPersonaProfileShadowPromptPreviewDiagnostic(preview?: ProfileRecord): string;
declare function appendPersonaProfileShadowLog(preview?: ProfileRecord, options?: PersonaProfileOptions): Promise<unknown>;
declare function formatPersonaProfileSummary(profile?: PersonaProfile): string;
declare const _default: {
    PERSONA_PROFILE_VERSION: number;
    PROFILE_BLOCK_TYPES: readonly string[];
    PROFILE_STATUSES: readonly string[];
    PROFILE_SENSITIVITY: readonly string[];
    PROFILE_CATEGORIES: readonly string[];
    hashPersonaProfileValue: typeof hashPersonaProfileValue;
    sanitizePersonaProfileKey: (value?: unknown) => string;
    normalizePersonaProfileText: typeof normalizePersonaProfileText;
    buildPersonaProfileEvidence: typeof buildPersonaProfileEvidence;
    buildPersonaProfileBlock: typeof buildPersonaProfileBlock;
    reinforcePersonaProfileBlock: typeof reinforcePersonaProfileBlock;
    buildPersonaProfileReinforcementShadow: typeof buildPersonaProfileReinforcementShadow;
    formatPersonaProfileReinforcementShadowDiagnostic: typeof formatPersonaProfileReinforcementShadowDiagnostic;
    computePersonaProfileEffectiveConfidence: typeof computePersonaProfileEffectiveConfidence;
    selectPersonaProfileBlocksByEffectiveConfidence: typeof selectPersonaProfileBlocksByEffectiveConfidence;
    buildPersonaProfileSelectionDiagnostic: typeof buildPersonaProfileSelectionDiagnostic;
    formatPersonaProfileSelectionDiagnostic: typeof formatPersonaProfileSelectionDiagnostic;
    buildPersonaProfileReinforceDiagnostic: typeof buildPersonaProfileReinforceDiagnostic;
    formatPersonaProfileReinforceDiagnostic: typeof formatPersonaProfileReinforceDiagnostic;
    buildPersonaProfileBlocksFromLegacyData: typeof buildPersonaProfileBlocksFromLegacyData;
    buildPersonaProfileSourceDiagnostic: typeof buildPersonaProfileSourceDiagnostic;
    formatPersonaProfileSourceDiagnostic: typeof formatPersonaProfileSourceDiagnostic;
    getPersonaProfileShadowLogFile: typeof getPersonaProfileShadowLogFile;
    buildPersonaProfileShadowPreview: typeof buildPersonaProfileShadowPreview;
    buildPersonaProfileShadowLogEvent: typeof buildPersonaProfileShadowLogEvent;
    appendPersonaProfileShadowLog: typeof appendPersonaProfileShadowLog;
    formatPersonaProfileShadowLearningDiagnostic: typeof formatPersonaProfileShadowLearningDiagnostic;
    formatPersonaProfileShadowPromptPreviewDiagnostic: typeof formatPersonaProfileShadowPromptPreviewDiagnostic;
    safePersonaProfileFile: (userId: string, channelKey: string, rootDir?: string) => string;
    readLegacyPersonaProfileData: ({ userId, channelKey, rootDir }?: {
        userId?: string;
        channelKey?: string;
        rootDir?: string;
    }) => Promise<{
        [x: string]: unknown;
    } | null>;
    buildPersonaProfileBlocks: typeof buildPersonaProfileBlocks;
    summarizePersonaProfileBlocks: typeof summarizePersonaProfileBlocks;
    formatPersonaProfileSummary: typeof formatPersonaProfileSummary;
};
export = _default;
