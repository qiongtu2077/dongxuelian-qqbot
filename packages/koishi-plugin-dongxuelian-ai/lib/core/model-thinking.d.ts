/**
 * MODULE: 模型思考参数适配。
 * 职责: 按模型与调用协议生成思考参数，隔离主备模型的自动参数。
 * 边界: 不读写配置、不请求上游；未知模型跟随服务端默认设置。无运行时状态。
 */
interface ThinkingConfig {
    model?: string;
    chatProtocol?: string;
}
interface ModelThinkingArgs extends Record<string, unknown> {
    enable_thinking?: boolean;
    thinking?: {
        type: 'enabled' | 'disabled';
    };
    reasoning_effort?: 'low' | 'high' | 'max';
}
interface ThinkingOptions {
    enabled?: boolean;
    managed?: boolean;
    explicitKeys?: string[];
}
declare function supportsModelReasoningEffort(config: ThinkingConfig): boolean;
declare function buildModelThinkingArgs(config: ThinkingConfig, enabled?: boolean): ModelThinkingArgs;
declare function resolveModelThinkingFields(config: ThinkingConfig, fields: Record<string, unknown>, options: ThinkingOptions): Record<string, unknown>;
declare const _default: {
    buildModelThinkingArgs: typeof buildModelThinkingArgs;
    resolveModelThinkingFields: typeof resolveModelThinkingFields;
    supportsModelReasoningEffort: typeof supportsModelReasoningEffort;
};
export = _default;
