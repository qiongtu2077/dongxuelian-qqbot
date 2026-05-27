interface GetTimeParams {
    timezone?: unknown;
    userId?: unknown;
}
declare const _default: {
    definition: {
        name: string;
        description: string;
        parameters: {
            type: string;
            properties: {
                timezone: {
                    type: string;
                    description: string;
                };
                userId: {
                    type: string;
                    description: string;
                };
            };
        };
    };
    execute(params?: GetTimeParams): Promise<string>;
    dangerous: boolean;
    defaultChannels: string[];
};
export = _default;
