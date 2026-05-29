interface UninstallItemOptions {
    action?: string;
    kind?: string;
    defaultKeep?: boolean;
}
interface LocalUninstallOptions {
    deleteUserDataKeys?: unknown[];
}
declare function projectDisplayPath(filePath: any): any;
declare function safeLstat(filePath: any): any;
declare function summarizePath(filePath: any, limit?: number): {
    exists: boolean;
    size: number;
    count: number;
    truncated: boolean;
    directory?: undefined;
    symlink?: undefined;
} | {
    exists: boolean;
    size: number;
    count: number;
    truncated: boolean;
    directory: any;
    symlink: any;
};
declare function uniqueTargets(targets: any): any;
declare function createUninstallItem(key: any, label: any, reason: any, paths: any, options?: UninstallItemOptions): {
    key: any;
    label: any;
    action: string;
    kind: string;
    reason: any;
    defaultKeep: boolean;
    size: any;
    count: any;
    truncated: any;
    paths: any;
    targets: any;
};
declare function pushUninstallItem(list: any, item: any): void;
declare function projectTarget(rel: any): {
    fullPath: any;
    path: any;
    scope: string;
};
declare function existingProjectTarget(rel: any): {
    fullPath: any;
    path: any;
    scope: string;
};
declare function listExistingDataChildren(excludedRels: any): any[];
declare function listReleaseArtifacts(): {
    fullPath: any;
    path: any;
    scope: string;
}[];
declare function listExistingProjectChildren(parentRel: any, matcher: any): {
    fullPath: any;
    path: any;
    scope: string;
}[];
declare function listPackagedWorkspaceResourceTargets(): {
    fullPath: any;
    path: any;
    scope: string;
}[];
declare function isBlockedDeletePath(filePath: any): "" | "不能删除磁盘根目录" | "不能删除系统目录或用户主目录根";
declare function assertSafeProjectDeletePath(filePath: any): void;
declare function assertSafeExternalNapcatDeletePath(filePath: any): void;
declare function assertSafeUninstallTarget(target: any): void;
declare function buildLocalUninstallPreview(): {
    ok: boolean;
    deleteItems: any[];
    userDataItems: any[];
    keepItems: any[];
    warnings: any[];
    stats: {
        deleteSize: any;
        userDataSize: any;
        deleteCount: any;
        userDataCount: any;
    };
    systemTools: {
        node: any;
        npm: any;
    };
    projectDir: any;
};
declare function stopLocalDeployProcessesForUninstall(): {
    type: string;
    message: string;
}[];
declare function removeTarget(target: any): {
    path: any;
    size: number;
    count: number;
    status: string;
};
declare function pruneEmptyProjectDirs(removeWorkspaceRoot?: boolean): void;
declare function runLocalUninstall(options?: LocalUninstallOptions): {
    ok: boolean;
    deleted: any[];
    kept: any[];
    warnings: any[];
    errors: any[];
    message: string;
};
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
