interface ReadImageHistoryParams {
    limit?: unknown;
}
interface ReadImageHistoryContext {
    channelKey?: string;
}
declare const _default: {
    definition: {
        name: string;
        description: string;
        parameters: {
            type: string;
            properties: {
                limit: {
                    type: string;
                    description: string;
                };
            };
            required: string[];
        };
    };
    execute(params?: ReadImageHistoryParams, context?: ReadImageHistoryContext): Promise<string>;
    dangerous: boolean;
    defaultChannels: string[];
};
export = _default;
