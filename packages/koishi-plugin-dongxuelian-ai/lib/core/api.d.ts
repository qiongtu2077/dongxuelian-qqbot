interface ChatMessage {
    role?: string;
    content?: unknown;
    tool_call_id?: string;
    tool_calls?: unknown[];
}
interface ApiConfig {
    apiKey: string;
    model: string;
    baseURL: string;
    provider?: string;
    capability?: string;
    chatProtocol?: string;
    priorityIndex?: number;
    searchEnabled?: boolean;
}
interface RequestExtraBody {
    _timeoutMs?: number | string;
    _thinkingEnabled?: boolean;
    _thinkingManaged?: boolean;
    _explicitThinkingKeys?: string[];
    signal?: AbortSignal;
    [key: string]: unknown;
}
interface ToolDefinition {
    [key: string]: unknown;
}
type ChatCompletionResult = {
    type: 'tool_calls';
    tool_calls: unknown[];
    message: Record<string, unknown>;
    reasoning: string;
} | {
    type: 'text';
    content: string;
    reasoning: string;
};
interface UsageDetails {
    total_tokens?: number;
    totalTokens?: number;
    prompt_tokens?: number;
    input_tokens?: number;
    inputTokens?: number;
    completion_tokens?: number;
    output_tokens?: number;
    completionTokens?: number;
    outputTokens?: number;
    cache_read_tokens?: number;
    cache_read_input_tokens?: number;
    cached_tokens?: number;
    cache_creation_tokens?: number;
    cache_creation_input_tokens?: number;
    prompt_tokens_details?: {
        cached_tokens?: number;
        cache_creation_tokens?: number;
    };
    input_tokens_details?: {
        cached_tokens?: number;
        cache_creation_tokens?: number;
    };
}
interface FallbackStep {
    model: string;
    provider: string;
    capability?: string;
    chatProtocol?: string;
    priorityIndex?: number;
}
interface SessionLike {
    content?: string;
    event?: {
        message?: Array<{
            type?: string;
            data?: {
                file?: string;
            };
        }>;
    };
}
declare function recordTokenUsage(provider: string, tokens: number, details?: {
    capability?: unknown;
    model?: string;
    usage?: UsageDetails;
    readable?: boolean;
}): void;
declare function flushTokenUsage(): void;
declare function buildResponsesInput(messages?: ChatMessage[]): Array<{
    role: string;
    content: Array<{
        type: string;
        text: string;
    }>;
}>;
declare function extractResponsesText(data?: {
    output_text?: string;
    output?: Array<{
        type?: string;
        content?: Array<{
            type?: string;
            text?: string;
        }>;
    }>;
}): string;
declare function normalizeMessagesForProvider(messages?: ChatMessage[], config?: Partial<ApiConfig>): ChatMessage[];
declare function requestChatCompletions(messages: ChatMessage[], config: ApiConfig, extraBody?: RequestExtraBody, tools?: ToolDefinition[] | null): Promise<ChatCompletionResult>;
declare function requestOpenAIResponsesWithSearch(messages: ChatMessage[], config: ApiConfig): Promise<string>;
declare function buildFallbackConfig(config: ApiConfig, step: number, fallbackSet: string): Promise<ApiConfig | null>;
declare function getFallbackSteps(): Record<string, FallbackStep[]>;
declare function callGetImage(fileName: string): Promise<Record<string, unknown> | null>;
declare function callGetFile(fileId: string): Promise<Record<string, unknown> | null>;
declare function callGetRecord(fileName: string): Promise<Record<string, unknown> | null>;
declare function callGetForwardMsg(forwardId: string): Promise<unknown[] | unknown | null>;
declare function sendForwardMsg(groupId: string | number, nodes: unknown[], timeoutMs?: number): Promise<Record<string, unknown> | null>;
declare function getGroupMemberInfo(groupId: string | number, userId: string | number, timeoutMs?: number): Promise<Record<string, unknown> | null>;
declare function getGroupInfo(groupId: string | number, timeoutMs?: number): Promise<Record<string, unknown> | null>;
declare function readImageAsBase64(filePath: string): Promise<string | null>;
declare function extractImageFileFromElements(session: SessionLike): string | null;
declare function downloadImageAsBase64(url: string, timeoutMs?: number): Promise<string | null>;
declare function isVisionModel(provider: string, modelId: string): boolean;
declare const _default: {
    requestChatCompletions: typeof requestChatCompletions;
    normalizeMessagesForProvider: typeof normalizeMessagesForProvider;
    buildResponsesInput: typeof buildResponsesInput;
    extractResponsesText: typeof extractResponsesText;
    requestOpenAIResponsesWithSearch: typeof requestOpenAIResponsesWithSearch;
    buildFallbackConfig: typeof buildFallbackConfig;
    getFallbackSteps: typeof getFallbackSteps;
    callGetImage: typeof callGetImage;
    callGetFile: typeof callGetFile;
    callGetRecord: typeof callGetRecord;
    callGetForwardMsg: typeof callGetForwardMsg;
    sendForwardMsg: typeof sendForwardMsg;
    getGroupMemberInfo: typeof getGroupMemberInfo;
    getGroupInfo: typeof getGroupInfo;
    readImageAsBase64: typeof readImageAsBase64;
    extractImageFileFromElements: typeof extractImageFileFromElements;
    downloadImageAsBase64: typeof downloadImageAsBase64;
    isVisionModel: typeof isVisionModel;
    recordTokenUsage: typeof recordTokenUsage;
    flushTokenUsage: typeof flushTokenUsage;
};
export = _default;
