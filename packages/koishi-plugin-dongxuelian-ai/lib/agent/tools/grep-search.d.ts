interface GrepSearchParams {
    query?: unknown;
    path?: unknown;
    glob?: unknown;
    ignoreCase?: unknown;
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
                path: {
                    type: string;
                    description: string;
                };
                glob: {
                    type: string;
                    description: string;
                };
                ignoreCase: {
                    type: string;
                    description: string;
                };
                limit: {
                    type: string;
                    description: string;
                };
            };
            required: string[];
        };
    };
    execute(params?: GrepSearchParams): Promise<string>;
    dangerous: boolean;
    defaultChannels: string[];
};
export = _default;
