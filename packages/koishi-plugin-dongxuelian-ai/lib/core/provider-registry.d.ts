interface ProviderModel {
    id: string;
    name?: string;
    vision?: boolean;
}
interface ProviderDefinitionLike {
    name: string;
    baseURL: string;
    models: ProviderModel[];
}
interface CustomProviderRecord {
    id: string;
    name: string;
    baseURL: string;
    keyFile?: string;
    models: ProviderModel[];
}
interface ResolvedProviderDefinition extends ProviderDefinitionLike {
    id: string;
    keyFile?: string;
    custom: boolean;
}
type ProviderRegistryMap = Record<string, ResolvedProviderDefinition>;
interface ResolveProviderKeyOptions {
    allowFallback?: boolean;
}
declare function readCustomProviders(): Promise<CustomProviderRecord[]>;
declare function readCustomProvidersSync(): CustomProviderRecord[];
declare function getMergedProviderMap(): Promise<ProviderRegistryMap>;
declare function getMergedProviderMapSync(): ProviderRegistryMap;
declare function getBuiltinProviderKeyFile(providerId: string): string;
declare function resolveProviderKeyFile(file: string): string;
declare function resolveProviderDefinition(providerId: string): Promise<ResolvedProviderDefinition | null>;
declare function resolveProviderDefinitionSync(providerId: string): ResolvedProviderDefinition | null;
declare function resolveProviderApiKey(providerId: string, fallbackKey: string, options?: ResolveProviderKeyOptions): Promise<string>;
declare function resolveProviderApiKeySync(providerId: string, fallbackKey: string, options?: ResolveProviderKeyOptions): string;
declare const _default: {
    readCustomProviders: typeof readCustomProviders;
    readCustomProvidersSync: typeof readCustomProvidersSync;
    getMergedProviderMap: typeof getMergedProviderMap;
    getMergedProviderMapSync: typeof getMergedProviderMapSync;
    resolveProviderDefinition: typeof resolveProviderDefinition;
    resolveProviderDefinitionSync: typeof resolveProviderDefinitionSync;
    resolveProviderApiKey: typeof resolveProviderApiKey;
    resolveProviderApiKeySync: typeof resolveProviderApiKeySync;
    resolveProviderKeyFile: typeof resolveProviderKeyFile;
    getBuiltinProviderKeyFile: typeof getBuiltinProviderKeyFile;
};
export = _default;
