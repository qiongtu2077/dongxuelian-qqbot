/**
 * MODULE: External tool policy.
 * 职责: 判断当前用户消息是否明确禁止联网/检索/读链接。
 * 边界: 只做无状态文本判断，不执行工具、不读写文件。
 * 状态: 无。
 */
interface ToolDefinitionLike {
    function?: {
        name?: string;
    };
}
declare function externalToolsDenied(text?: string): boolean;
declare function filterExternalToolDefinitions<T extends ToolDefinitionLike>(tools?: T[], text?: string): T[];
declare function buildExternalToolPolicyHint(text?: string): string;
declare const _default: {
    externalToolsDenied: typeof externalToolsDenied;
    filterExternalToolDefinitions: typeof filterExternalToolDefinitions;
    buildExternalToolPolicyHint: typeof buildExternalToolPolicyHint;
};
export = _default;
