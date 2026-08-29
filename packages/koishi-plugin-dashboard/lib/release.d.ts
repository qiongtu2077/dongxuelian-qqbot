interface ReleaseFile {
    path: string;
    size: number;
    sha256: string;
}
interface ReleaseManifest {
    schemaVersion: 1;
    releaseId: string;
    version: string;
    commit: string;
    builtAt: string;
    files: ReleaseFile[];
    contentHash: string;
    manifestHash: string;
}
interface BuildReleaseResult {
    releaseDir: string;
    manifestPath: string;
    manifest: ReleaseManifest;
}
declare function buildDashboardRelease(repoRoot: string, outputRoot: string): BuildReleaseResult;
declare function verifyBrowserAssets(releaseRoot: string, manifest: ReleaseManifest): void;
declare function verifyReleaseManifest(releaseRoot: string): ReleaseManifest;
declare const _default: {
    MANIFEST_NAME: string;
    RELEASE_PACKAGES: string[];
    buildDashboardRelease: typeof buildDashboardRelease;
    verifyReleaseManifest: typeof verifyReleaseManifest;
    verifyBrowserAssets: typeof verifyBrowserAssets;
};
export = _default;
