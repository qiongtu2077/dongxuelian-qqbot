interface AppendFileParams {
    path?: unknown;
    content?: unknown;
    createDirectories?: unknown;
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
                content: {
                    type: string;
                    description: string;
                };
                createDirectories: {
                    type: string;
                    description: string;
                };
            };
            required: string[];
        };
    };
    execute(params?: AppendFileParams): Promise<string>;
    dangerous: boolean;
    defaultChannels: string[];
};
export = _default;
