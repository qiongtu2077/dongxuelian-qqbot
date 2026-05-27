/**
 * MODULE: Agent 记忆工具。
 * 职责: 将显式长期记忆读写能力暴露给 Agent。
 * 边界: 不自动写入聊天、不越过 Agent 工具渠道/权限配置。
 * 状态: 无。
 */
interface MemoryToolContext {
    userId?: string;
    channelKey?: string;
    channel?: string;
    isAdmin?: boolean;
}
interface MemoryToolParams {
    text?: unknown;
    tags?: unknown;
    query?: unknown;
    limit?: unknown;
    memoryId?: unknown;
}
declare const _default: {
    rememberMemoryTool: {
        definition: {
            name: string;
            description: string;
            parameters: {
                type: string;
                properties: {
                    text: {
                        type: string;
                        description: string;
                    };
                    tags: {
                        type: string;
                        items: {
                            type: string;
                        };
                        description: string;
                    };
                };
                required: string[];
            };
        };
        execute(params?: MemoryToolParams, context?: MemoryToolContext): Promise<string>;
        dangerous: boolean;
        defaultChannels: string[];
    };
    searchMemoryTool: {
        definition: {
            name: string;
            description: string;
            parameters: {
                type: string;
                properties: {
                    query: {
                        type: string;
                    };
                    limit: {
                        type: string;
                    };
                };
            };
        };
        execute(params?: MemoryToolParams, context?: MemoryToolContext): Promise<string>;
        dangerous: boolean;
        defaultChannels: string[];
    };
    forgetMemoryTool: {
        definition: {
            name: string;
            description: string;
            parameters: {
                type: string;
                properties: {
                    memoryId: {
                        type: string;
                    };
                };
                required: string[];
            };
        };
        execute(params?: MemoryToolParams, context?: MemoryToolContext): Promise<string>;
        dangerous: boolean;
        defaultChannels: string[];
    };
    listMemoryTool: {
        definition: {
            name: string;
            description: string;
            parameters: {
                type: string;
                properties: {
                    limit: {
                        type: string;
                    };
                };
            };
        };
        execute(params?: MemoryToolParams, context?: MemoryToolContext): Promise<string>;
        dangerous: boolean;
        defaultChannels: string[];
    };
    tools: ({
        definition: {
            name: string;
            description: string;
            parameters: {
                type: string;
                properties: {
                    text: {
                        type: string;
                        description: string;
                    };
                    tags: {
                        type: string;
                        items: {
                            type: string;
                        };
                        description: string;
                    };
                };
                required: string[];
            };
        };
        execute(params?: MemoryToolParams, context?: MemoryToolContext): Promise<string>;
        dangerous: boolean;
        defaultChannels: string[];
    } | {
        definition: {
            name: string;
            description: string;
            parameters: {
                type: string;
                properties: {
                    memoryId: {
                        type: string;
                    };
                };
                required: string[];
            };
        };
        execute(params?: MemoryToolParams, context?: MemoryToolContext): Promise<string>;
        dangerous: boolean;
        defaultChannels: string[];
    } | {
        definition: {
            name: string;
            description: string;
            parameters: {
                type: string;
                properties: {
                    limit: {
                        type: string;
                    };
                };
            };
        };
        execute(params?: MemoryToolParams, context?: MemoryToolContext): Promise<string>;
        dangerous: boolean;
        defaultChannels: string[];
    })[];
};
export = _default;
