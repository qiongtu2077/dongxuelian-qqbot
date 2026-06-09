type PetBridgeChatReply = string | {
    type: 'tool_calls';
    tool_calls: unknown[];
    message: Record<string, unknown>;
    reasoning: string;
} | {
    type: 'text';
    content: string;
    reasoning: string;
};
interface PetBridgeChatInput {
    text: string;
    persona?: string;
    userId?: string;
    channelKey?: string;
}
interface PetBridgeChatResult {
    ok: boolean;
    reply?: PetBridgeChatReply;
    error?: string;
    reason?: string;
}
interface OneBotResponse {
    status?: string;
    [key: string]: unknown;
}
interface PetBridgeWhitelistResult {
    ok: boolean;
    whitelist?: string[];
    error?: string;
}
declare function getPetBridgeStatus(): Promise<Record<string, unknown>>;
declare function listPetBridgePersonas(): unknown[];
declare function getPetBridgeMemorySummary(userId: string, channelKey?: string): Promise<string>;
declare function listPetBridgeSummaryGroups(): string[];
declare function switchPetBridgeModel(provider?: string, model?: string): Promise<Record<string, unknown>>;
declare function setPetBridgeSearchEnabled(enabled: boolean): Record<string, unknown>;
declare function setPetBridgeThinkingEnabled(enabled: boolean): Record<string, unknown>;
declare function setPetBridgeMaintenanceEnabled(enabled: boolean): Record<string, unknown>;
declare function getPetBridgeMaintenanceMessage(): string | null;
declare function sendPetBridgeGroupMessage(groupId: string | number, text: string): Promise<OneBotResponse | null>;
declare function managePetBridgeRandomWhitelist(action?: string, groupId?: string | number): PetBridgeWhitelistResult;
declare function switchPetBridgePersona(name: string): PetBridgeWhitelistResult;
declare function getCurrentPetBridgePersona(): string;
declare function generatePetBridgeChatReply(input: PetBridgeChatInput): Promise<PetBridgeChatResult>;
declare const _default: {
    getPetBridgeStatus: typeof getPetBridgeStatus;
    listPetBridgePersonas: typeof listPetBridgePersonas;
    getPetBridgeMemorySummary: typeof getPetBridgeMemorySummary;
    listPetBridgeSummaryGroups: typeof listPetBridgeSummaryGroups;
    switchPetBridgeModel: typeof switchPetBridgeModel;
    setPetBridgeSearchEnabled: typeof setPetBridgeSearchEnabled;
    setPetBridgeThinkingEnabled: typeof setPetBridgeThinkingEnabled;
    setPetBridgeMaintenanceEnabled: typeof setPetBridgeMaintenanceEnabled;
    getPetBridgeMaintenanceMessage: typeof getPetBridgeMaintenanceMessage;
    sendPetBridgeGroupMessage: typeof sendPetBridgeGroupMessage;
    managePetBridgeRandomWhitelist: typeof managePetBridgeRandomWhitelist;
    switchPetBridgePersona: typeof switchPetBridgePersona;
    getCurrentPetBridgePersona: typeof getCurrentPetBridgePersona;
    generatePetBridgeChatReply: typeof generatePetBridgeChatReply;
};
export = _default;
