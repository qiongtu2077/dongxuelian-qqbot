"use strict";
/**
 * MODULE: daily-report configuration helpers.
 * 职责: 统一解析日报环境变量中的有界数值。
 * 边界: 不读取环境变量、不决定各调用方的默认值和范围。
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.parseBoundedInt = parseBoundedInt;
// 解析有界整数；无效值返回调用方给定的默认值。
function parseBoundedInt(value, fallback, min, max) {
    const parsed = parseInt(String(value), 10);
    if (!Number.isFinite(parsed))
        return fallback;
    return Math.max(min, Math.min(max, parsed));
}
