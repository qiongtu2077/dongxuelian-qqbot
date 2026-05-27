#!/usr/bin/env node
interface ToolInputSchema {
    type: string;
    properties?: Record<string, unknown>;
    required?: string[];
    [key: string]: unknown;
}
interface McpConfig {
    enabled?: boolean;
    allowWriteWorkspace?: boolean;
    allowRunLocal?: boolean;
    exposeDangerousActions?: boolean;
}
interface AgentConfigLike {
    mcp?: McpConfig;
    channels?: Record<string, {
        enabled?: boolean;
        tools?: Record<string, boolean>;
    }>;
    dangerousPolicy?: string;
    autoRoute?: unknown;
    queue?: unknown;
}
interface McpHealth {
    ok: boolean;
    server: {
        name: string;
        version: string;
    };
    workspaceRoot: string;
    dataDir: string;
    mcp: {
        enabled: boolean;
        allowWriteWorkspace: boolean;
        allowRunLocal: boolean;
        exposeDangerousActions: boolean;
    };
    agent: {
        qqEnabled: boolean;
        dashboardEnabled: boolean;
        dangerousPolicy: string;
    };
    allowedRoots: string[];
    tools: number;
}
type LocalCheckCommand = [string, string[]];
declare function getMcpToolDefinitions(): Array<{
    name: string;
    description: string;
    inputSchema: ToolInputSchema;
}>;
declare function buildHealth(config: AgentConfigLike, roots: string[]): McpHealth;
declare function parseLocalCheckCommand(command?: unknown): LocalCheckCommand;
declare const _default: {
    SERVER_NAME: string;
    SERVER_VERSION: string;
    getToolDefinitions: typeof getMcpToolDefinitions;
    parseLocalCheckCommand: typeof parseLocalCheckCommand;
    buildHealth: typeof buildHealth;
};
export = _default;
