interface PersonaRuntimeDiagnostic {
    level: 'error' | 'warning' | 'info';
    code: string;
    message: string;
    [key: string]: unknown;
}
interface PersonaResolution {
    source?: string;
    name?: string | null;
}
interface CompilePersonaRuntimePlanOptions {
    personaName?: string;
    source?: string;
    type?: string;
    personaContent?: string;
    file?: string;
}
interface ResolvePersonaRuntimePlanOptions extends CompilePersonaRuntimePlanOptions {
    resolution?: PersonaResolution;
    channelKey?: string;
    userId?: string;
}
interface PersonaRuntimePlan {
    name?: string | null;
    lore?: {
        primary?: string;
        refs?: string[];
    };
    random?: {
        will?: number;
    };
    safety?: {
        nsfw?: string;
    };
    voice?: {
        rawId?: string;
        assetId?: string;
        style?: string;
    };
    prompt?: {
        body?: string;
    };
}
declare function normalizePersonaRuntimeText(value?: unknown, maxLength?: number): string;
declare function normalizePersonaRuntimeNsfw(value?: unknown): string;
declare function compilePersonaRuntimePlan(options?: CompilePersonaRuntimePlanOptions): {
    version: number;
    source: string;
    type: string;
    name: string;
    displayName: string;
    schemaVersion: number;
    hasFrontmatter: boolean;
    prompt: {
        body: string;
        hasBody: boolean;
        budget: number;
        styleFingerprint: string;
        memoryPolicy: string;
    };
    lore: {
        primary: string;
        refs: string[];
    };
    random: {
        will: number;
    };
    voice: {
        id: string;
        rawId: string;
        assetId: string;
        style: string;
    };
    safety: {
        nsfw: string;
        hostileCapable: boolean;
    };
    diagnostics: PersonaRuntimeDiagnostic[];
};
declare function resolvePersonaRuntimePlan(options?: ResolvePersonaRuntimePlanOptions): {
    version: number;
    source: string;
    type: string;
    name: string;
    displayName: string;
    schemaVersion: number;
    hasFrontmatter: boolean;
    prompt: {
        body: string;
        hasBody: boolean;
        budget: number;
        styleFingerprint: string;
        memoryPolicy: string;
    };
    lore: {
        primary: string;
        refs: string[];
    };
    random: {
        will: number;
    };
    voice: {
        id: string;
        rawId: string;
        assetId: string;
        style: string;
    };
    safety: {
        nsfw: string;
        hostileCapable: boolean;
    };
    diagnostics: PersonaRuntimeDiagnostic[];
};
declare function getPersonaRuntimePlanLegacySnapshot(plan?: PersonaRuntimePlan): {
    personaName: string;
    lore: string;
    loreRefs: string[];
    will: number;
    nsfw: string;
    voiceId: string;
    voiceAssetId: string;
    voiceStyle: string;
    promptBody: string;
};
declare const _default: {
    PERSONA_RUNTIME_PLAN_VERSION: number;
    DEFAULT_PERSONA_RUNTIME_NAME: string;
    DEFAULT_PERSONA_RUNTIME_VOICE: string;
    NEUTRAL_PERSONA_RUNTIME_VOICE_STYLE: string;
    DEFAULT_PERSONA_WILL: number;
    LEGACY_PERSONA_WILL: Readonly<Record<string, number>>;
    normalizePersonaRuntimeText: typeof normalizePersonaRuntimeText;
    normalizePersonaRuntimeNsfw: typeof normalizePersonaRuntimeNsfw;
    compilePersonaRuntimePlan: typeof compilePersonaRuntimePlan;
    resolvePersonaRuntimePlan: typeof resolvePersonaRuntimePlan;
    getPersonaRuntimePlanLegacySnapshot: typeof getPersonaRuntimePlanLegacySnapshot;
};
export = _default;
