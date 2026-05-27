interface SetUserTimezoneParams {
    userId?: unknown;
    timezone?: unknown;
}
declare const _default: {
    definition: {
        name: string;
        description: string;
        parameters: {
            type: string;
            properties: {
                userId: {
                    type: string;
                    description: string;
                };
                timezone: {
                    type: string;
                    description: string;
                };
            };
            required: string[];
        };
    };
    execute(params?: SetUserTimezoneParams): Promise<string>;
    dangerous: boolean;
    defaultChannels: string[];
};
export = _default;
