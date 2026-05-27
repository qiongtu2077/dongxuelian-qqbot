interface AgentConfigLike {
    persona?: {
        dashboardPersona?: unknown;
        qqInheritChatPersona?: unknown;
    };
}
interface PersonaRuntimePlanLike {
    name?: unknown;
    prompt?: {
        body?: unknown;
    };
    lore?: {
        primary?: unknown;
    };
}
interface AgentSystemMessage {
    role: 'system';
    content: string;
}
interface BuildAgentPersonaSystemMessageOptions {
    personaName?: unknown;
    personaContent?: unknown;
    source?: unknown;
    channel?: unknown;
    plan?: PersonaRuntimePlanLike | null;
}
interface BuildAgentPersonaContextOptions {
    channel?: unknown;
    agentMode?: unknown;
    config?: AgentConfigLike;
    dashboardPersona?: unknown;
    channelKey?: string;
    userId?: string;
}
interface AgentPersonaConsoleEntry {
    name: string;
    description: string;
    file: string;
    lore: string;
}
declare function buildAgentPersonaSystemMessage({ personaName, personaContent, source, channel, plan }?: BuildAgentPersonaSystemMessageOptions): string;
declare function buildAgentPersonaContext(options?: BuildAgentPersonaContextOptions): AgentSystemMessage[];
declare function mergeAgentSystemExtra(...groups: unknown[]): AgentSystemMessage[];
declare function listAgentPersonasForConsole(): AgentPersonaConsoleEntry[];
declare const _default: {
    AGENT_GUARD_PROMPT: string;
    buildAgentPersonaContext: typeof buildAgentPersonaContext;
    buildAgentPersonaSystemMessage: typeof buildAgentPersonaSystemMessage;
    mergeAgentSystemExtra: typeof mergeAgentSystemExtra;
    listAgentPersonasForConsole: typeof listAgentPersonasForConsole;
};
export = _default;
