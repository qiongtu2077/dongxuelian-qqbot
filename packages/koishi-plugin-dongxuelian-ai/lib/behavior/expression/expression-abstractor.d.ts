interface AbstractorModelRef {
    provider: string;
    model: string;
    keyFile: string | null;
}
interface AbstractorMessage {
    role: string;
    content: string;
}
interface AbstractorCandidate {
    situation: string;
    style: string;
}
interface HarvestMessage {
    content?: string;
    userId?: string;
}
interface HarvestOptions {
    now?: number;
    selfUserId?: string;
    botName?: string;
    requestChatCompletions?: RequestChatCompletions;
    models?: AbstractorModelRef[];
    filterMessages?: (messages: HarvestMessage[], options: Record<string, unknown>) => {
        kept?: HarvestMessage[];
    };
    callModel?: (messages: AbstractorMessage[], options: HarvestOptions) => Promise<string | {
        content?: string;
    }>;
    appendCandidate?: (channelKey: string, candidate: {
        situation: string;
        style: string;
        contributors: string[];
    }, options: {
        now?: number;
    }) => Promise<{
        mode?: string;
    }>;
    channels?: string[];
}
interface HarvestSummary {
    channelKey: string;
    totalInput: number;
    kept: number;
    abstractCalls: number;
    abstractOk: number;
    abstractFailed: number;
    created: number;
    merged: number;
    rejected: number;
    error: string;
}
interface HarvestAllSummary {
    channels: number;
    totalKept: number;
    abstractOk: number;
    abstractFailed: number;
    created: number;
    merged: number;
    rejected: number;
    perChannel: HarvestSummary[];
}
interface HarvestDiagnostic {
    version: number;
    channels: number;
    totalKept: number;
    abstractOk: number;
    abstractFailed: number;
    created: number;
    merged: number;
    rejected: number;
}
interface HarvestContext {
    bots?: Array<{
        selfId?: string;
        userId?: string;
    }>;
}
type RequestChatCompletions = (messages: AbstractorMessage[], config: Record<string, unknown>, options?: Record<string, unknown>) => Promise<string | {
    content?: string;
}>;
declare function abstractorBuildSystemPrompt(): string;
declare function abstractorBuildUserPayload(messages?: HarvestMessage[]): string;
declare function abstractorParseModelOutput(raw: string | {
    content?: string;
} | null | undefined): AbstractorCandidate[];
declare function runExpressionHarvestForChannel(ctx: HarvestContext | null, channelKey: string, options?: HarvestOptions): Promise<HarvestSummary>;
declare function runExpressionHarvestForAllChannels(ctx: HarvestContext | null, options?: HarvestOptions): Promise<HarvestAllSummary>;
declare function buildExpressionHarvestDiagnostic(summary?: Partial<HarvestAllSummary>): HarvestDiagnostic;
declare function formatExpressionHarvestDiagnostic(diagnostic?: Partial<HarvestAllSummary>): string;
declare const _default: {
    EXPRESSION_ABSTRACTOR_VERSION: number;
    EXPRESSION_ABSTRACTOR_MAX_BATCH: number;
    EXPRESSION_ABSTRACTOR_TIMEOUT_MS: number;
    EXPRESSION_ABSTRACTOR_FALLBACK_MODELS: readonly AbstractorModelRef[];
    abstractorBuildSystemPrompt: typeof abstractorBuildSystemPrompt;
    abstractorBuildUserPayload: typeof abstractorBuildUserPayload;
    abstractorParseModelOutput: typeof abstractorParseModelOutput;
    runExpressionHarvestForChannel: typeof runExpressionHarvestForChannel;
    runExpressionHarvestForAllChannels: typeof runExpressionHarvestForAllChannels;
    buildExpressionHarvestDiagnostic: typeof buildExpressionHarvestDiagnostic;
    formatExpressionHarvestDiagnostic: typeof formatExpressionHarvestDiagnostic;
    expressionAbstractorLastHarvestAt: Map<string, number>;
};
export = _default;
