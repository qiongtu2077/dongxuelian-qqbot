/**
 * MODULE: 统一敏感文本脱敏。
 * 职责: 对日志、shell 输出、Agent 材料等用户可见文本做低成本脱敏。
 * 边界: 不判断权限、不解析业务结构。
 */
declare function redactSensitiveText(text?: string): string;
declare const _default: {
    redactSensitiveText: typeof redactSensitiveText;
};
export = _default;
