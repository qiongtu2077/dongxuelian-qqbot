/**
 * MODULE: QQ Agent retell guard.
 * Keeps Agent output routed through chat persona while preventing failed tool
 * reports from being retold as fabricated success.
 */
interface AgentToolResult {
    name?: string;
    result?: unknown;
}
interface AgentRetellResult {
    reply?: unknown;
    toolResults?: AgentToolResult[];
}
interface GuardOptions {
    searchFailureFallback?: string;
}
declare function collectAgentMaterial(agentResult?: AgentRetellResult): string;
declare function hasSearchFailureMaterial(agentResult?: AgentRetellResult): boolean;
declare function replyAcknowledgesSearchFailure(reply?: string): boolean;
declare function buildSearchFailureRetellFallback(fallback?: string): string;
declare function shouldFilterAgentMaterialLine(line?: string): boolean;
declare function redactAgentMaterial(text?: string): string;
declare function guardAgentRetellReply(reply?: string, agentResult?: AgentRetellResult, options?: GuardOptions): string;
declare const _default: {
    collectAgentMaterial: typeof collectAgentMaterial;
    hasSearchFailureMaterial: typeof hasSearchFailureMaterial;
    replyAcknowledgesSearchFailure: typeof replyAcknowledgesSearchFailure;
    buildSearchFailureRetellFallback: typeof buildSearchFailureRetellFallback;
    shouldFilterAgentMaterialLine: typeof shouldFilterAgentMaterialLine;
    redactAgentMaterial: typeof redactAgentMaterial;
    guardAgentRetellReply: typeof guardAgentRetellReply;
};
export = _default;
