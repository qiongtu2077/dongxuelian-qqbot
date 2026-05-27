interface FindFilesParams {
    pattern?: unknown;
    root?: unknown;
}
declare const _default: {
    definition: {
        name: string;
        description: string;
        parameters: {
            type: string;
            properties: {
                pattern: {
                    type: string;
                    description: string;
                };
                root: {
                    type: string;
                    description: string;
                };
            };
        };
    };
    execute(params?: FindFilesParams): Promise<string>;
    dangerous: boolean;
    defaultChannels: string[];
};
export = _default;
