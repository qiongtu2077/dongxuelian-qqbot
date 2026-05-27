declare function executeGetTokenUsage(): Promise<string>;
declare const _default: {
    definition: {
        name: string;
        description: string;
        parameters: {
            type: string;
            properties: {};
        };
    };
    execute: typeof executeGetTokenUsage;
    dangerous: boolean;
    defaultChannels: string[];
};
export = _default;
