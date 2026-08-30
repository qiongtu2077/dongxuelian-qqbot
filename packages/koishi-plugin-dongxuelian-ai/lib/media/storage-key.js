"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getSafeMediaStorageKey = getSafeMediaStorageKey;
exports.getLegacyUnsafeMediaStorageKey = getLegacyUnsafeMediaStorageKey;
exports.getMediaHistoryFilePath = getMediaHistoryFilePath;
exports.getLegacyMediaHistoryFilePath = getLegacyMediaHistoryFilePath;
/**
 * MODULE: 媒体存储键工具。
 * 职责: 为文件、图片和语音存储生成统一的安全键，并识别旧版未哈希键。
 * 边界: 不读写媒体历史或缓存文件。
 */
const path = require('path');
const { safeChannelKey } = require('../core/utils');
// 生成媒体历史和缓存文件共用的安全键。
function getSafeMediaStorageKey(channelKey) {
    const key = String(channelKey || '');
    return key ? safeChannelKey(key) : '';
}
// 生成旧版文件和图片历史使用的未哈希键，仅供懒迁移定位旧文件。
function getLegacyUnsafeMediaStorageKey(channelKey) {
    return String(channelKey || '').replace(/[^a-zA-Z0-9.:_-]/g, '_');
}
// 返回指定媒体历史目录中的当前安全文件路径。
function getMediaHistoryFilePath(historyDir, channelKey) {
    return path.join(historyDir, getSafeMediaStorageKey(channelKey) + '.json');
}
// 返回需要懒迁移的旧版历史文件路径；新旧键一致时不触发迁移。
function getLegacyMediaHistoryFilePath(historyDir, channelKey) {
    const legacyKey = getLegacyUnsafeMediaStorageKey(channelKey);
    const safeKey = getSafeMediaStorageKey(channelKey);
    return legacyKey && legacyKey !== safeKey ? path.join(historyDir, legacyKey + '.json') : '';
}
