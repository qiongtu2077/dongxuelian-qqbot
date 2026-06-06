interface ShadowEntry {
    id?: string;
    situation?: string;
    style?: string;
    count?: number;
    status?: string;
    lastUsedAt?: number;
    lastMergedAt?: number;
    createdAt?: number;
    contributors?: string[];
}
interface ExpressionShadowInput {
    channelKey?: string;
    personaName?: string;
    recentSpeakerIds?: Array<string | number>;
    sensitiveTopicActive?: boolean;
    now?: number;
}
interface ExpressionShadowOptions {
    loadPool?: (channelKey: string) => {
        entries?: ShadowEntry[];
    };
}
interface ExpressionShadowDiagnostic {
    version: number;
    decision: string;
    channelHash: string;
    personaHash: string;
    injectionMode: string;
    poolSize: number;
    candidatesConsidered: number;
    candidatesPicked: number;
    pickedHashes: string[];
    skipped: Record<string, number>;
    reasons: string[];
}
interface SensitiveTopicMessage {
    content?: string;
    ts?: number;
    timestamp?: number;
}
declare function resolveExpressionInjectionMode(personaName: string): string;
declare function detectExpressionSensitiveTopicActive(messages?: SensitiveTopicMessage[], now?: number, windowMs?: number): boolean;
declare function buildExpressionShadowPlan(input?: ExpressionShadowInput, options?: ExpressionShadowOptions): ExpressionShadowDiagnostic;
declare function formatExpressionShadowDiagnostic(diagnostic?: Partial<ExpressionShadowDiagnostic>): string;
declare const _default: {
    EXPRESSION_SHADOW_VERSION: number;
    EXPRESSION_SHADOW_SKIP_REASONS: Readonly<{
        injectionOff: "injectionOff";
        poolEmpty: "poolEmpty";
        coldStart: "coldStart";
        lowCount: "lowCount";
        cooldownPerEntry: "cooldownPerEntry";
        contributorActive: "contributorActive";
        freshCandidate: "freshCandidate";
        sensitiveTopicWindow: "sensitiveTopicWindow";
    }>;
    EXPRESSION_SHADOW_COLD_START_MIN_POOL: number;
    EXPRESSION_SHADOW_PER_ENTRY_COOLDOWN_MS: number;
    EXPRESSION_SHADOW_FRESH_CANDIDATE_MS: number;
    EXPRESSION_SHADOW_RECENT_SPEAKER_WINDOW_MS: number;
    EXPRESSION_SHADOW_MAX_PICKS: number;
    EXPRESSION_SHADOW_PERSONA_DEFAULT_POLICY: Readonly<Record<string, string>>;
    resolveExpressionInjectionMode: typeof resolveExpressionInjectionMode;
    detectExpressionSensitiveTopicActive: typeof detectExpressionSensitiveTopicActive;
    buildExpressionShadowPlan: typeof buildExpressionShadowPlan;
    formatExpressionShadowDiagnostic: typeof formatExpressionShadowDiagnostic;
};
export = _default;
