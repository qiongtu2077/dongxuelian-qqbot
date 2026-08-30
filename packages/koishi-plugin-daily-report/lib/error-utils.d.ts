/**
 * MODULE: daily-report error helpers.
 * 职责: 将 unknown 异常转换为日志和用户提示使用的稳定文本。
 * 边界: 不记录日志、不决定 HTTP 或消息状态。
 */
export declare function getErrorMessage(error: unknown, nullishFallback?: string): string;
