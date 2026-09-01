declare const AI_CAPABILITIES: readonly string[];
type AiCapability = (typeof AI_CAPABILITIES)[number];
type ProviderId = 'glm' | 'mimorium' | 'dashscope' | 'deepseek' | 'openai' | 'anthropic' | 'gemini' | 'opencode';
type DiscoveryProtocol = 'openai-models' | 'anthropic-models' | 'gemini-models' | 'blocked';
type ChatProtocol = 'openai-chat' | 'anthropic-messages' | 'gemini-content';
interface ProviderCatalogEntry {
    id: ProviderId;
    name: string;
    keyFile: string;
    baseURL: string;
    chatProtocol: ChatProtocol;
    discoveryProtocol: DiscoveryProtocol;
    discoveryURL?: string;
    discoveryReason?: string;
    documentationURL: string;
}
interface CapabilityModel {
    id: string;
    name: string;
    capabilities: AiCapability[];
}
interface CapabilityPriorityStep {
    provider: ProviderId;
    model: string;
}
interface ProviderModelPool {
    models: CapabilityModel[];
}
interface CapabilityConfig {
    version: number;
    providers: Record<ProviderId, ProviderModelPool>;
    priorities: Record<AiCapability, CapabilityPriorityStep[]>;
}
interface MigrationResult {
    config: CapabilityConfig;
    diagnostics: string[];
    migrated: boolean;
}
interface ReplaceModelsResult {
    config: CapabilityConfig;
    removedModels: number;
    removedSteps: number;
    emptyCapabilities: AiCapability[];
}
interface RuntimeCapabilityStep {
    capability: AiCapability;
    provider: ProviderId;
    providerName: string;
    model: string;
    apiKey: string;
    baseURL: string;
    chatProtocol: ChatProtocol;
    priorityIndex: number;
}
declare function isAiCapability(value: unknown): value is AiCapability;
declare function isProviderId(value: unknown): value is ProviderId;
declare function getVerifiedModelCapabilities(providerId: unknown, modelId: unknown): AiCapability[];
declare function createEmptyCapabilityConfig(): CapabilityConfig;
declare function normalizeCapabilityConfig(value: unknown): CapabilityConfig;
declare function normalizeDiscoveredModels(models: unknown): CapabilityModel[];
declare function isProviderKeyConfigured(providerId: ProviderId): boolean;
declare function getProviderKeyStatus(providerId: ProviderId): {
    configured: boolean;
    prefix: string;
};
declare function buildLegacyMigration(): MigrationResult;
declare function loadCapabilityConfigSync(): MigrationResult;
declare function serializeCapabilityConfig(config: CapabilityConfig): Buffer;
declare function replaceProviderModels(current: CapabilityConfig, providerId: unknown, discovered: unknown): ReplaceModelsResult;
declare function replaceCapabilityPriority(current: CapabilityConfig, capability: unknown, steps: unknown): CapabilityConfig;
declare function getPublicProviderCatalog(): Array<Record<string, unknown>>;
declare function getPublicCapabilityConfig(config: CapabilityConfig): Record<string, unknown>;
declare function resolveCapabilityRuntimeSteps(capability: unknown): RuntimeCapabilityStep[];
declare function getProviderCatalogEntry(providerId: unknown): ProviderCatalogEntry | null;
declare const _default: {
    AI_CAPABILITIES: readonly string[];
    CAPABILITY_CONFIG_FILE: string;
    PROVIDER_IDS: readonly ProviderId[];
    isAiCapability: typeof isAiCapability;
    isProviderId: typeof isProviderId;
    getVerifiedModelCapabilities: typeof getVerifiedModelCapabilities;
    createEmptyCapabilityConfig: typeof createEmptyCapabilityConfig;
    normalizeCapabilityConfig: typeof normalizeCapabilityConfig;
    normalizeDiscoveredModels: typeof normalizeDiscoveredModels;
    buildLegacyMigration: typeof buildLegacyMigration;
    loadCapabilityConfigSync: typeof loadCapabilityConfigSync;
    serializeCapabilityConfig: typeof serializeCapabilityConfig;
    replaceProviderModels: typeof replaceProviderModels;
    replaceCapabilityPriority: typeof replaceCapabilityPriority;
    getPublicProviderCatalog: typeof getPublicProviderCatalog;
    getPublicCapabilityConfig: typeof getPublicCapabilityConfig;
    getProviderCatalogEntry: typeof getProviderCatalogEntry;
    getProviderKeyStatus: typeof getProviderKeyStatus;
    isProviderKeyConfigured: typeof isProviderKeyConfigured;
    resolveCapabilityRuntimeSteps: typeof resolveCapabilityRuntimeSteps;
};
export = _default;
