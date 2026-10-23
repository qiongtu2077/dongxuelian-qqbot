interface AnalyzeImageParams {
    url?: unknown;
    messageId?: unknown;
    question?: unknown;
    force?: unknown;
}
interface AnalyzeImageContext {
    channelKey?: string;
    userId?: string;
    source?: 'history-tool' | 'explicit-image' | 'random-image';
    entry?: string;
    randomAuthorization?: unknown;
}
declare const _default: {
    definition: {
        name: string;
        description: string;
        parameters: {
            type: string;
            properties: {
                url: {
                    type: string;
                    description: string;
                };
                messageId: {
                    type: string;
                    description: string;
                };
                question: {
                    type: string;
                    description: string;
                };
                force: {
                    type: string;
                    description: string;
                };
            };
            required: string[];
        };
    };
    execute(params?: AnalyzeImageParams, context?: AnalyzeImageContext): Promise<string>;
    dangerous: boolean;
    defaultChannels: string[];
};
export = _default;
