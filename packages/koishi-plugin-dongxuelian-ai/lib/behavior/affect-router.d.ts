interface AffectPolicy {
    allowVoice: boolean;
    allowEmoji: boolean;
    allowVoiceOnly: boolean;
    maxPlayfulStrength: number;
    seriousMode: string;
    blockedMoods: string[];
}
interface AffectPlan {
    name?: string;
    affect?: Partial<AffectPolicy>;
}
interface AffectInput {
    plan?: AffectPlan;
    personaName?: string;
    policy?: Partial<AffectPolicy>;
    replyText?: string;
    reply?: string;
    userText?: string;
    risk?: string;
    voiceCandidate?: boolean;
    randomVoiceRate?: number;
    voiceCooldownActive?: boolean;
    voiceAssetMissing?: boolean;
    randomTriggered?: boolean;
    agentRetell?: boolean;
}
interface AffectOutputState {
    allowed: boolean;
    reasons: string[];
}
interface AffectDiagnostic {
    version: number;
    mood: string;
    recommendedMode: string;
    persona: {
        name: string;
        hash: string;
    };
    policy: AffectPolicy;
    outputs: Record<string, AffectOutputState>;
    blockers: string[];
    reasons: string[];
    context: Record<string, unknown>;
}
declare function hashAffectValue(value?: string, length?: number): string;
declare function normalizeAffectText(value?: unknown, maxLength?: number): string;
declare function normalizeAffectPolicy(input?: Partial<AffectPolicy>): AffectPolicy;
declare function resolveAffectPolicy(plan?: AffectPlan, options?: {
    personaName?: string;
    policy?: Partial<AffectPolicy>;
}): AffectPolicy;
declare function classifyAffectMood(input?: AffectInput): string;
declare function buildAffectRouterDiagnostic(input?: AffectInput): AffectDiagnostic;
declare function formatAffectRouterDiagnostic(diagnostic?: Partial<AffectDiagnostic>): string;
declare const _default: {
    AFFECT_ROUTER_VERSION: number;
    DEFAULT_AFFECT_POLICY: Readonly<AffectPolicy>;
    PERSONA_AFFECT_PRESETS: Readonly<Record<string, Partial<AffectPolicy>>>;
    hashAffectValue: typeof hashAffectValue;
    normalizeAffectText: typeof normalizeAffectText;
    normalizeAffectPolicy: typeof normalizeAffectPolicy;
    resolveAffectPolicy: typeof resolveAffectPolicy;
    classifyAffectMood: typeof classifyAffectMood;
    buildAffectRouterDiagnostic: typeof buildAffectRouterDiagnostic;
    formatAffectRouterDiagnostic: typeof formatAffectRouterDiagnostic;
};
export = _default;
