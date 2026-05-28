"use strict";
/**
 * MODULE: 用户黑名单缓存。
 * 职责: 读取和缓存用户黑名单文件。
 * 边界: 不决定命令路由，不回复消息，不处理管理员权限。
 * 状态: userBlacklistCache / userBlacklistFingerprint 为进程内缓存，重启后重建。
 */
const { USER_BLACKLIST_FILE } = require('./constants');
const { readJsonFile, getFileFingerprint } = require('./utils');
let userBlacklistCache = null;
let userBlacklistFingerprint = '';
async function loadUserBlacklist(force = false) {
    const fingerprint = await getFileFingerprint(USER_BLACKLIST_FILE);
    if (!force && userBlacklistCache !== null && fingerprint === userBlacklistFingerprint)
        return userBlacklistCache;
    const raw = await readJsonFile(USER_BLACKLIST_FILE, []);
    userBlacklistCache = new Set(Array.isArray(raw) ? raw.map(String) : []);
    userBlacklistFingerprint = fingerprint;
    return userBlacklistCache;
}
function setBlacklistFingerprint(value) {
    userBlacklistFingerprint = String(value || '');
}
module.exports = {
    loadUserBlacklist,
    setBlacklistFingerprint,
};
