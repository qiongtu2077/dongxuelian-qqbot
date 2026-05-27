/**
 * MODULE: 图片事实摘要净化。
 * 职责: 把视觉模型输出约束成客观、短、可入库的图片事实描述。
 * 边界: 不调用模型、不读写文件、不发送消息。
 */
declare function looksLikePersonaImageReply(text?: string): boolean;
declare function sanitizeImageAnalysis(text?: string): string;
declare const _default: {
    sanitizeImageAnalysis: typeof sanitizeImageAnalysis;
    looksLikePersonaImageReply: typeof looksLikePersonaImageReply;
};
export = _default;
