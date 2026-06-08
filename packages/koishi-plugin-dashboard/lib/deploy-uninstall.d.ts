type FsStats = import('fs').Stats;
type FsDirent = import('fs').Dirent;
type UninstallTargetScope = 'project' | 'externalNapcat';
type UninstallItemKind = 'environment' | 'userData' | 'systemTool';
interface PathSummaryMissing {
    exists: false;
    size: number;
    count: number;
    truncated: boolean;
}
interface PathSummaryExisting {
    exists: true;
    size: number;
    count: number;
    truncated: boolean;
    directory: boolean;
    symlink: boolean;
}
type PathSummary = PathSummaryMissing | PathSummaryExisting;
interface UninstallTargetInput {
    fullPath: string;
    path?: string;
    scope?: UninstallTargetScope;
}
interface UninstallTarget {
    path: string;
    fullPath: string;
    scope: UninstallTargetScope;
    size: number;
    count: number;
    truncated: boolean;
    directory: boolean;
    symlink: boolean;
}
interface UninstallPathPreview {
    path: string;
    size: number;
    count: number;
    truncated: boolean;
    directory: boolean;
    symlink: boolean;
}
interface UninstallItemOptions {
    action?: string;
    kind?: UninstallItemKind;
    defaultKeep?: boolean;
}
interface UninstallItem {
    key: string;
    label: string;
    action: string;
    kind: UninstallItemKind;
    reason: string;
    defaultKeep: boolean;
    size: number;
    count: number;
    truncated: boolean;
    paths: UninstallPathPreview[];
    targets: UninstallTarget[];
}
interface KeepItem {
    action: 'keep';
    kind: 'systemTool';
    label: string;
    path: string;
    reason: string;
    version: string;
}
interface UninstallWarning {
    key?: string;
    path?: string;
    type?: 'info' | 'warning';
    message?: string;
    reason?: string | undefined;
}
interface CommandInfo {
    found: boolean;
    version: string;
    source: 'runtime/node' | 'PATH';
    sourcePath: string;
    ownedByProject: boolean;
    ok: boolean;
    reason: string;
}
interface LocalUninstallPreview {
    ok: true;
    deleteItems: UninstallItem[];
    userDataItems: UninstallItem[];
    keepItems: KeepItem[];
    warnings: UninstallWarning[];
    stats: {
        deleteSize: number;
        userDataSize: number;
        deleteCount: number;
        userDataCount: number;
    };
    systemTools: {
        node: CommandInfo;
        npm: CommandInfo;
    };
    projectDir: string;
}
interface RemovedTargetResult {
    path: string;
    size: number;
    count: number;
    status: 'ok';
}
interface DeletedTargetResult extends RemovedTargetResult {
    item: string;
    label: string;
}
interface UninstallError {
    path: string;
    item: string;
    label: string;
    reason: string | undefined;
}
interface LocalUninstallResult {
    ok: boolean;
    deleted: DeletedTargetResult[];
    kept: (KeepItem | UninstallItem)[];
    warnings: UninstallWarning[];
    errors: UninstallError[];
    message: string;
}
interface LocalUninstallOptions {
    deleteUserDataKeys?: unknown[];
}
declare function projectDisplayPath(filePath: string): string;
declare function safeLstat(filePath: string): FsStats | null;
declare function summarizePath(filePath: string, limit?: number): PathSummary;
declare function uniqueTargets(targets: Array<UninstallTarget | null>): UninstallTarget[];
declare function createUninstallItem(key: string, label: string, reason: string, paths: Array<string | UninstallTargetInput>, options?: UninstallItemOptions): UninstallItem | null;
declare function pushUninstallItem(list: UninstallItem[], item: UninstallItem | null): void;
declare function projectTarget(rel: string): UninstallTargetInput;
declare function existingProjectTarget(rel: string): UninstallTargetInput | null;
declare function listExistingDataChildren(excludedRels: Set<string>): UninstallTargetInput[];
declare function listReleaseArtifacts(): UninstallTargetInput[];
declare function listExistingProjectChildren(parentRel: string, matcher: (name: string, entry: FsDirent) => boolean): UninstallTargetInput[];
declare function listPackagedWorkspaceResourceTargets(): UninstallTargetInput[];
declare function isBlockedDeletePath(filePath: string): '' | '不能删除磁盘根目录' | '不能删除系统目录或用户主目录根';
declare function assertSafeProjectDeletePath(filePath: string): void;
declare function assertSafeExternalNapcatDeletePath(filePath: string): void;
declare function assertSafeUninstallTarget(target: UninstallTarget): void;
declare function buildLocalUninstallPreview(): LocalUninstallPreview;
declare function stopLocalDeployProcessesForUninstall(): UninstallWarning[];
declare function removeTarget(target: UninstallTarget): RemovedTargetResult;
declare function pruneEmptyProjectDirs(removeWorkspaceRoot?: boolean): void;
declare function runLocalUninstall(options?: LocalUninstallOptions): LocalUninstallResult;
declare const _default: {
    projectDisplayPath: typeof projectDisplayPath;
    safeLstat: typeof safeLstat;
    summarizePath: typeof summarizePath;
    uniqueTargets: typeof uniqueTargets;
    createUninstallItem: typeof createUninstallItem;
    pushUninstallItem: typeof pushUninstallItem;
    projectTarget: typeof projectTarget;
    existingProjectTarget: typeof existingProjectTarget;
    listExistingDataChildren: typeof listExistingDataChildren;
    listReleaseArtifacts: typeof listReleaseArtifacts;
    listExistingProjectChildren: typeof listExistingProjectChildren;
    listPackagedWorkspaceResourceTargets: typeof listPackagedWorkspaceResourceTargets;
    isBlockedDeletePath: typeof isBlockedDeletePath;
    assertSafeProjectDeletePath: typeof assertSafeProjectDeletePath;
    assertSafeExternalNapcatDeletePath: typeof assertSafeExternalNapcatDeletePath;
    assertSafeUninstallTarget: typeof assertSafeUninstallTarget;
    buildLocalUninstallPreview: typeof buildLocalUninstallPreview;
    stopLocalDeployProcessesForUninstall: typeof stopLocalDeployProcessesForUninstall;
    removeTarget: typeof removeTarget;
    pruneEmptyProjectDirs: typeof pruneEmptyProjectDirs;
    runLocalUninstall: typeof runLocalUninstall;
};
export = _default;
