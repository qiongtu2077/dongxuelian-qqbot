interface LocateSnapshotEntry {
    ts: number;
    messageId: string;
}
interface LocateSnapshotSource {
    ts?: unknown;
    messageId?: unknown;
}
/** 记录一次「谁艾特我」的展示顺序；entries 应与卡片编号一一对应（索引 0 为第 1 条）。 */
declare function saveLocateSnapshot(channelKey: unknown, userId: unknown, entries?: LocateSnapshotSource[], now?: number): void;
/** 读取未过期的快照；没有快照或已过期时返回 null，调用方据此提示先查询。 */
declare function getLocateSnapshot(channelKey: unknown, userId: unknown, now?: number): LocateSnapshotEntry[] | null;
/** dispose 时由调用方显式清理，避免插件重载后残留旧快照。 */
declare function clearLocateSnapshots(): void;
declare const _default: {
    LOCATE_SNAPSHOT_TTL_MS: number;
    saveLocateSnapshot: typeof saveLocateSnapshot;
    getLocateSnapshot: typeof getLocateSnapshot;
    clearLocateSnapshots: typeof clearLocateSnapshots;
};
export = _default;
