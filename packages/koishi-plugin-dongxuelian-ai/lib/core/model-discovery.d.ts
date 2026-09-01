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
declare class ModelDiscoveryError extends Error {
    code: string;
    status: number;
    constructor(message: string, code: string, status?: number);
}
declare function parseOpenAiModelList(providerId: string, payload: unknown): DiscoveredModel[];
declare function parseAnthropicModelList(payload: unknown): DiscoveredModel[];
declare function parseGeminiModelList(payload: unknown): DiscoveredModel[];
declare function discoverProviderModels(providerId: string, apiKey: string, options?: DiscoveryOptions): Promise<DiscoveredModel[]>;
declare const _default: {
    ModelDiscoveryError: typeof ModelDiscoveryError;
    parseOpenAiModelList: typeof parseOpenAiModelList;
    parseAnthropicModelList: typeof parseAnthropicModelList;
    parseGeminiModelList: typeof parseGeminiModelList;
    discoverProviderModels: typeof discoverProviderModels;
};
export = _default;
