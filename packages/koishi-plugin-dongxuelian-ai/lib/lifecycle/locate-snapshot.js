"use strict";
/* ==========================================================================
 * MODULE: locate-snapshot
 * 职责：保存最近一次「谁艾特我」的编号列表，供「定位消息 N」按同一份列表解析目标，避免缓存新增消息导致编号漂移。
 * 边界：不读 today-cache 文件、不发送消息、不调 AI、不改 conversation；只做内存快照的写入与过期读取。
 * 状态：模块级 Map，键为 `<群号>:<用户ID>`，TTL 10 分钟；过期即视为没有快照。
 * ========================================================================== */
const LOCATE_SNAPSHOT_TTL_MS = 10 * 60 * 1000;
const LOCATE_SNAPSHOT_MAX_KEYS = 500;
const locateSnapshots = new Map();
function buildLocateSnapshotKey(channelKey, userId) {
    const channel = String(channelKey || '');
    const user = String(userId || '');
    if (!channel || !user)
        return '';
    return `${channel}:${user}`;
}
/** 记录一次「谁艾特我」的展示顺序；entries 应与卡片编号一一对应（索引 0 为第 1 条）。 */
function saveLocateSnapshot(channelKey, userId, entries = [], now = Date.now()) {
    const key = buildLocateSnapshotKey(channelKey, userId);
    if (!key)
        return;
    const normalized = [];
    for (const entry of Array.isArray(entries) ? entries : []) {
        const ts = Number(entry && entry.ts);
        if (!Number.isFinite(ts) || ts <= 0)
            continue;
        normalized.push({ ts, messageId: String((entry && entry.messageId) || '') });
    }
    if (!normalized.length) {
        locateSnapshots.delete(key);
        return;
    }
    pruneLocateSnapshots(now);
    locateSnapshots.set(key, { entries: normalized, savedAt: now });
}
/** 读取未过期的快照；没有快照或已过期时返回 null，调用方据此提示先查询。 */
function getLocateSnapshot(channelKey, userId, now = Date.now()) {
    const key = buildLocateSnapshotKey(channelKey, userId);
    if (!key)
        return null;
    const snapshot = locateSnapshots.get(key);
    if (!snapshot)
        return null;
    if (now - snapshot.savedAt > LOCATE_SNAPSHOT_TTL_MS) {
        locateSnapshots.delete(key);
        return null;
    }
    return snapshot.entries;
}
/** 清理过期快照，并在键数量超限时按保存时间淘汰最旧的一条。 */
function pruneLocateSnapshots(now = Date.now()) {
    for (const [key, snapshot] of locateSnapshots.entries()) {
        if (now - snapshot.savedAt > LOCATE_SNAPSHOT_TTL_MS)
            locateSnapshots.delete(key);
    }
    if (locateSnapshots.size < LOCATE_SNAPSHOT_MAX_KEYS)
        return;
    const entries = [];
    for (const [key, snapshot] of locateSnapshots.entries())
        entries.push([key, snapshot.savedAt]);
    entries.sort((a, b) => a[1] - b[1]);
    for (let i = 0; i <= entries.length - LOCATE_SNAPSHOT_MAX_KEYS; i += 1)
        locateSnapshots.delete(entries[i][0]);
}
/** dispose 时由调用方显式清理，避免插件重载后残留旧快照。 */
function clearLocateSnapshots() {
    locateSnapshots.clear();
}
module.exports = {
    LOCATE_SNAPSHOT_TTL_MS,
    saveLocateSnapshot,
    getLocateSnapshot,
    clearLocateSnapshots,
};
