interface ReadFileParams {
    path?: unknown;
    offset?: unknown;
    limit?: unknown;
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
                offset: {
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
    execute(params?: ReadFileParams): Promise<string>;
    dangerous: boolean;
    defaultChannels: string[];
};
export = _default;
