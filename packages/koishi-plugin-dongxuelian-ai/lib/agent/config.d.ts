type ChannelName = 'qq' | 'dashboard';
interface ChannelConfigInput {
    enabled?: unknown;
    tools?: Record<string, unknown>;
}
interface AgentConfigInput {
    version?: unknown;
    channels?: Partial<Record<ChannelName, ChannelConfigInput>>;
    dangerousPolicy?: unknown;
    readFileRoots?: unknown;
    autoRoute?: {
        qq?: {
            enabled?: unknown;
        };
        dashboard?: {
            enabled?: unknown;
        };
    };
    enabledSkills?: unknown;
    persona?: {
        dashboardPersona?: unknown;
        qqInheritChatPersona?: unknown;
    };
    queue?: {
        maxGlobal?: unknown;
        maxPerChannel?: unknown;
        maxPendingPerUser?: unknown;
        timeoutMs?: unknown;
    };
    planMode?: {
        enabled?: unknown;
        autoCreate?: unknown;
    };
    push?: {
        enabled?: unknown;
        dailyLimit?: unknown;
    };
    cron?: {
        enabled?: unknown;
        onceEnabled?: unknown;
    };
    memory?: {
        enabled?: unknown;
        adminOnly?: unknown;
    };
    mcp?: {
        enabled?: unknown;
        allowWriteWorkspace?: unknown;
        allowRunLocal?: unknown;
        exposeDangerousActions?: unknown;
    };
}
interface ChannelConfig {
    enabled: boolean;
    tools: Record<string, boolean>;
}
interface AgentConfig {
    version: number;
    channels: Record<ChannelName, ChannelConfig>;
    dangerousPolicy: 'auto' | 'confirm' | 'block';
    autoRoute: {
        qq: {
            enabled: boolean;
        };
        dashboard: {
            enabled: boolean;
        };
    };
    enabledSkills: string[];
    persona: {
        dashboardPersona: string;
        qqInheritChatPersona: boolean;
    };
    readFileRoots: string[];
    queue: {
        maxGlobal: number;
        maxPerChannel: number;
        maxPendingPerUser: number;
        timeoutMs: number;
    };
    planMode: {
        enabled: boolean;
        autoCreate: boolean;
    };
    push: {
        enabled: boolean;
        dailyLimit: number;
    };
    cron: {
        enabled: boolean;
        onceEnabled: boolean;
    };
    memory: {
        enabled: boolean;
        adminOnly: boolean;
    };
    mcp: {
        enabled: boolean;
        allowWriteWorkspace: boolean;
        allowRunLocal: boolean;
        exposeDangerousActions: boolean;
    };
}
declare function getAgentConfig(force?: boolean): AgentConfig;
declare function saveAgentConfig(nextConfig: AgentConfigInput): Promise<AgentConfig>;
declare function patchAgentConfig(patch?: AgentConfigInput): Promise<AgentConfig>;
declare function setChannelEnabled(channel: string, enabled: unknown): Promise<AgentConfig>;
declare function setToolEnabled(channel: string, toolName: unknown, enabled: unknown): Promise<AgentConfig>;
declare function isChannelEnabled(channel: string): boolean;
declare function isToolEnabled(channel: string, toolName: string): boolean;
declare function getReadFileRoots(): string[];
declare function getDangerousPolicy(): AgentConfig['dangerousPolicy'];
declare function isAutoRouteEnabled(channel?: ChannelName): boolean;
declare function getEnabledSkills(): string[];
declare function getAgentPersonaConfig(): AgentConfig['persona'];
declare function resetAgentConfigCache(): void;
declare const _default: {
    DEFAULT_CONFIG: AgentConfig;
    getAgentConfig: typeof getAgentConfig;
    saveAgentConfig: typeof saveAgentConfig;
    patchAgentConfig: typeof patchAgentConfig;
    setChannelEnabled: typeof setChannelEnabled;
    setToolEnabled: typeof setToolEnabled;
    isChannelEnabled: typeof isChannelEnabled;
    isToolEnabled: typeof isToolEnabled;
    getReadFileRoots: typeof getReadFileRoots;
    getDangerousPolicy: typeof getDangerousPolicy;
    isAutoRouteEnabled: typeof isAutoRouteEnabled;
    getEnabledSkills: typeof getEnabledSkills;
    getAgentPersonaConfig: typeof getAgentPersonaConfig;
    resetAgentConfigCache: typeof resetAgentConfigCache;
};
export = _default;
