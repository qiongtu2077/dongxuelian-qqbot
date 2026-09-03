interface FetchResponseLike {
    ok: boolean;
    status: number;
    json(): Promise<unknown>;
}
type DiscoveryFetch = (input: string, init?: RequestInit) => Promise<FetchResponseLike>;
interface DiscoveredModel {
    id: string;
    name: string;
    capabilities: string[];
    importable: boolean;
    unavailableReason?: string;
}
interface DiscoveryOptions {
    fetchImpl?: DiscoveryFetch;
    timeoutMs?: number;
}
interface CustomDiscoveryOptions extends DiscoveryOptions {
    lookupImpl?: (hostname: string) => Promise<Array<{
        address: string;
        family: number;
    }> | Array<string>>;
    signal?: AbortSignal;
}
declare class ModelDiscoveryError extends Error {
    code: string;
    status: number;
    constructor(message: string, code: string, status?: number);
}
declare function buildCustomDiscoveryUrls(rawBaseURL: string): string[];
declare function isUnsafeAddress(address: string): boolean;
declare function validateCustomDiscoveryUrl(rawURL: string, lookupImpl?: CustomDiscoveryOptions['lookupImpl']): Promise<URL>;
declare function parseOpenAiModelList(providerId: string, payload: unknown): DiscoveredModel[];
declare function parseAnthropicModelList(payload: unknown): DiscoveredModel[];
declare function parseGeminiModelList(payload: unknown): DiscoveredModel[];
declare function parseCustomOpenAiModelList(payload: unknown, capability: string): DiscoveredModel[];
declare function discoverProviderModels(providerId: string, apiKey: string, options?: DiscoveryOptions): Promise<DiscoveredModel[]>;
declare function discoverCustomProviderModels(baseURL: string, capability: string, apiKey: string, options?: CustomDiscoveryOptions): Promise<DiscoveredModel[]>;
declare const _default: {
    ModelDiscoveryError: typeof ModelDiscoveryError;
    parseOpenAiModelList: typeof parseOpenAiModelList;
    parseAnthropicModelList: typeof parseAnthropicModelList;
    parseGeminiModelList: typeof parseGeminiModelList;
    parseCustomOpenAiModelList: typeof parseCustomOpenAiModelList;
    buildCustomDiscoveryUrls: typeof buildCustomDiscoveryUrls;
    validateCustomDiscoveryUrl: typeof validateCustomDiscoveryUrl;
    isUnsafeAddress: typeof isUnsafeAddress;
    discoverCustomProviderModels: typeof discoverCustomProviderModels;
    discoverProviderModels: typeof discoverProviderModels;
};
export = _default;
