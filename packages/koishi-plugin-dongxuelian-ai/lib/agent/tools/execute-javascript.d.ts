interface ExecuteJavascriptParams {
    code?: unknown;
}
declare const _default: {
    definition: {
        name: string;
        description: string;
        parameters: {
            type: string;
            properties: {
                code: {
                    type: string;
                    description: string;
                };
            };
            required: string[];
        };
    };
    execute(params?: ExecuteJavascriptParams): Promise<string | undefined>;
    dangerous: boolean;
    defaultChannels: string[];
};
export = _default;
