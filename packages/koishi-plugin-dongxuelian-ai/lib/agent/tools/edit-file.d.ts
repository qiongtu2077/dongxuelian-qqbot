interface EditFileParams {
    path?: unknown;
    oldString?: unknown;
    newString?: unknown;
    replaceAll?: unknown;
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
                oldString: {
                    type: string;
                    description: string;
                };
                newString: {
                    type: string;
                    description: string;
                };
                replaceAll: {
                    type: string;
                    description: string;
                };
            };
            required: string[];
        };
    };
    execute(params?: EditFileParams): Promise<string>;
    dangerous: boolean;
    defaultChannels: string[];
};
export = _default;
