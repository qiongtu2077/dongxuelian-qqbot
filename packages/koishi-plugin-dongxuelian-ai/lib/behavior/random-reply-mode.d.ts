/**
 * MODULE: 随机回复内部模式。
 * 职责: 解析随机主动回复的内部 mode 协议，避免 JSON/工具计划/乱码直接发到群里。
 * 边界: 不调用 AI API、不发送消息；只返回发送决策。
 */
type RandomReplyMode = 'anchored_reply' | 'context_lookup' | 'ambient_water' | 'no_send';
interface RandomReplyDecision {
    shouldSend: boolean;
    mode: RandomReplyMode;
    reply: string;
    reason: string;
}
interface AmbientWaterSendOptions {
    [key: string]: unknown;
}
declare function stripCodeFence(text?: string): string;
declare function looksLikeRawInternalProtocol(text?: string): boolean;
declare function normalizeRandomReplyMode(mode?: unknown): RandomReplyMode;
declare function parseRandomReplyDecision(rawReply?: string): RandomReplyDecision;
declare function buildRandomModePrompt(): string;
declare function buildAmbientWaterSendOptions(baseOptions?: AmbientWaterSendOptions): AmbientWaterSendOptions;
declare const _default: {
    RANDOM_REPLY_MODES: Set<string>;
    stripCodeFence: typeof stripCodeFence;
    looksLikeRawInternalProtocol: typeof looksLikeRawInternalProtocol;
    normalizeRandomReplyMode: typeof normalizeRandomReplyMode;
    parseRandomReplyDecision: typeof parseRandomReplyDecision;
    buildRandomModePrompt: typeof buildRandomModePrompt;
    buildAmbientWaterSendOptions: typeof buildAmbientWaterSendOptions;
};
export = _default;
