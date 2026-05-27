interface AnalyzeFileParams {
    messageId?: unknown;
    keyword?: unknown;
}
interface AnalyzeFileContext {
    channelKey?: string;
    activeFileMessageId?: unknown;
    userId?: string;
    groupId?: string;
    isDirect?: boolean;
}
declare const _default: {
    definition: {
        name: string;
        description: string;
        parameters: {
            type: string;
            properties: {
                messageId: {
                    type: string;
                    description: string;
                };
                keyword: {
                    type: string;
                    description: string;
                };
            };
            required: string[];
        };
    };
    execute(params?: AnalyzeFileParams, context?: AnalyzeFileContext): Promise<string>;
    dangerous: boolean;
    defaultChannels: string[];
};
export = _default;
