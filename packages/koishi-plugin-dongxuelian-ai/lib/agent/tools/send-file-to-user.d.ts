interface SendFileParams {
    path?: unknown;
    groupId?: unknown;
    userId?: unknown;
    name?: unknown;
}
interface SendFileContext {
    channelKey?: string;
    userId?: string;
    groupId?: unknown;
    callOneBot?: (action: string, params: Record<string, unknown>) => Promise<OneBotResult>;
}
interface OneBotResult {
    ok: boolean;
    message?: string;
    data?: unknown;
}
declare const _default: {
    definition: {
        name: string;
        description: string;
        parameters: {
            type: string;
            properties: {
                path: {
                    type: string;
                    description: string;
                };
                groupId: {
                    type: string;
                    description: string;
                };
                userId: {
                    type: string;
                    description: string;
                };
                name: {
                    type: string;
                    description: string;
                };
            };
            required: string[];
        };
    };
    execute(params?: SendFileParams, context?: SendFileContext): Promise<string>;
    dangerous: boolean;
    defaultChannels: string[];
};
export = _default;
