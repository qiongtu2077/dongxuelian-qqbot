interface FrontendBuildStatus {
    state: string;
    message: string;
    detail: string;
    startedAt: number;
    finishedAt: number;
}
interface FrontendBuildOptions {
    feDir?: string;
    distDir?: string;
    backupDir?: string;
    log?: (message: string) => void;
    updateStatus?: (status: FrontendBuildStatus) => void;
}
type FrontendBuildCallback = (err: Error | null) => void;
declare function getFrontendDistAssetRefs(distDir?: string): string[];
declare function hasFrontendDistAssets(distDir?: string): boolean;
declare function assertFrontendDistReady(distDir?: string): void;
declare function assertFrontendBuildSourceReady(feDir?: string): void;
declare function rollbackFrontendDist(distDir: string, backupDir: string): string;
declare function buildFrontendDist(options?: FrontendBuildOptions, callback?: FrontendBuildCallback): boolean;
declare const _default: {
    getFrontendDistAssetRefs: typeof getFrontendDistAssetRefs;
    hasFrontendDistAssets: typeof hasFrontendDistAssets;
    assertFrontendDistReady: typeof assertFrontendDistReady;
    assertFrontendBuildSourceReady: typeof assertFrontendBuildSourceReady;
    rollbackFrontendDist: typeof rollbackFrontendDist;
    buildFrontendDist: typeof buildFrontendDist;
};
export = _default;
