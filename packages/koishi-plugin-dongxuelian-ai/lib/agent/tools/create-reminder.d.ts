declare const _default: {
    definition: Record<string, unknown>;
    execute: (params?: Record<string, unknown>, context?: Record<string, unknown>) => Promise<string>;
    resolveRunAt: (params?: Record<string, unknown>, now?: number) => number;
    dangerous: boolean;
    defaultChannels: string[];
};
export = _default;
