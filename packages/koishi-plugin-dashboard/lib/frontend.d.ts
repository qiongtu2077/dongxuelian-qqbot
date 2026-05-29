interface FrontendBuildOptions {
    feDir?: string;
    distDir?: string;
    backupDir?: string;
    log?: (message: string) => void;
    updateStatus?: (status: Record<string, unknown>) => void;
}
type FrontendBuildCallback = (err: Error | null) => void;
declare function getFrontendDistAssetRefs(distDir?: any): string[];
declare function hasFrontendDistAssets(distDir?: any): boolean;
declare function assertFrontendDistReady(distDir?: any): void;
declare function assertFrontendBuildSourceReady(feDir?: any): void;
declare function rollbackFrontendDist(distDir: any, backupDir: any): string;
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
