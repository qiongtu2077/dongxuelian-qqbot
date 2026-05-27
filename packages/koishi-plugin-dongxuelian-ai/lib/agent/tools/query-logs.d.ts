interface QueryLogsParams {
    query?: unknown;
    level?: unknown;
    since?: unknown;
    limit?: unknown;
}
declare const _default: {
    definition: {
        name: string;
        description: string;
        parameters: {
            type: string;
            properties: {
                query: {
                    type: string;
                    description: string;
                };
                level: {
                    type: string;
                    description: string;
                };
                since: {
                    type: string;
                    description: string;
                };
                limit: {
                    type: string;
                    description: string;
                };
            };
        };
    };
    execute(params?: QueryLogsParams): Promise<string>;
    dangerous: boolean;
    defaultChannels: string[];
};
export = _default;
