interface ListFilesParams {
    path?: unknown;
    recursive?: unknown;
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
                recursive: {
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
    execute(params?: ListFilesParams): Promise<string>;
    dangerous: boolean;
    defaultChannels: string[];
};
export = _default;
