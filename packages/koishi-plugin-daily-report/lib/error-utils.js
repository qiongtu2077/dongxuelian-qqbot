"use strict";
/**
 * MODULE: daily-report error helpers.
 * 职责: 将 unknown 异常转换为日志和用户提示使用的稳定文本。
 * 边界: 不记录日志、不决定 HTTP 或消息状态。
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.getErrorMessage = getErrorMessage;
// 提取 Error.message；非 Error 保持原 String 语义，可显式指定空值回退。
function getErrorMessage(error, nullishFallback) {
    if (error instanceof Error)
        return error.message;
    if (error == null && nullishFallback !== undefined)
        return nullishFallback;
    return String(error);
}
