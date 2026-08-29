interface ReleaseFile {
    path: string;
    size: number;
    sha256: string;
}
interface ReleaseIdentity {
    schemaVersion: 1;
    releaseId: string;
    version: string;
    commit: string;
    builtAt: string;
    files: ReleaseFile[];
    contentHash: string;
    manifestHash: string;
}
interface GitSourceState {
    hostname: string;
    repoRoot: string;
    commit: string;
    clean: boolean;
    changes: string[];
}
interface RemoteProbe {
    hostname: string;
    appDir: string;
    availableBytes: number;
    release: ReleaseIdentity | null;
    releaseError: string;
    lock: {
        present: boolean;
        owner: string;
    };
}
interface ReleaseChangeSummary {
    added: number;
    modified: number;
    removed: number;
    unchanged: number;
    totalFiles: number;
    totalBytes: number;
}
interface PreviewRelease {
    releaseDir: string;
    releaseId: string;
    commit: string;
    manifestHash: string;
    contentHash: string;
    files: ReleaseFile[];
    totalBytes: number;
}
interface RemoteReleasePreview {
    schemaVersion: 1;
    previewId: string;
    createdAt: number;
    expiresAt: number;
    startedAt: number;
    source: GitSourceState;
    target: {
        server: string;
        requestedAppDir: string;
        hostname: string;
        appDir: string;
        availableBytes: number;
        release: ReleaseIdentity | null;
        releaseError: string;
        lock: {
            present: boolean;
            owner: string;
        };
    };
    release: PreviewRelease | null;
    requiredBytes: number;
    changes: ReleaseChangeSummary;
    blockers: string[];
}
interface CreatePreviewOptions {
    repoRoot: string;
    releasesRoot: string;
    previewsDir: string;
    server: unknown;
    appDir: unknown;
}
interface ValidatePreviewOptions {
    repoRoot: string;
    releasesRoot: string;
    previewsDir: string;
    previewId: unknown;
    confirmed: unknown;
}
interface FrozenBuildResult {
    release: PreviewRelease | null;
    changes: string[];
}
declare function inspectGitSource(repoRoot: string): GitSourceState;
declare function isAllowedBuildChange(statusLine: string): boolean;
declare function buildFrozenRelease(repoRoot: string, worktreeRoot: string, releasesRoot: string, commit: string): FrozenBuildResult;
declare function describeRemoteProbeFailure(value: unknown): string;
declare function summarizeReleaseChanges(nextFiles: ReleaseFile[], currentFiles: ReleaseFile[]): ReleaseChangeSummary;
declare function isSelfDeploy(sourceHostname: string, server: string, targetHostname: string): boolean;
declare function collectPreviewBlockers(source: GitSourceState, server: string, requestedAppDir: string, target: RemoteProbe | null, release: PreviewRelease | null, remoteError?: string): string[];
declare function isPreviewReleaseDirectory(releasesRoot: string, releaseDir: string, releaseId: string): boolean;
declare function cleanupExpiredPreviews(previewsDir: string, releasesRoot: string, now?: number): void;
declare function createRemoteReleasePreview(options: CreatePreviewOptions): RemoteReleasePreview;
declare function readRemoteReleasePreview(previewsDir: string, previewId: unknown): RemoteReleasePreview;
declare function compareRemoteBaseline(preview: RemoteReleasePreview, target: RemoteProbe): string[];
declare function assertPreviewCanStart(preview: RemoteReleasePreview, confirmed: unknown, now?: number): void;
declare function validateRemoteReleasePreview(options: ValidatePreviewOptions): RemoteReleasePreview;
declare function toPublicRemoteReleasePreview(preview: RemoteReleasePreview): Record<string, unknown>;
declare const _default: {
    PREVIEW_TTL_MS: number;
    DISK_SAFETY_BYTES: number;
    inspectGitSource: typeof inspectGitSource;
    isAllowedBuildChange: typeof isAllowedBuildChange;
    buildFrozenRelease: typeof buildFrozenRelease;
    describeRemoteProbeFailure: typeof describeRemoteProbeFailure;
    summarizeReleaseChanges: typeof summarizeReleaseChanges;
    isSelfDeploy: typeof isSelfDeploy;
    collectPreviewBlockers: typeof collectPreviewBlockers;
    compareRemoteBaseline: typeof compareRemoteBaseline;
    assertPreviewCanStart: typeof assertPreviewCanStart;
    createRemoteReleasePreview: typeof createRemoteReleasePreview;
    readRemoteReleasePreview: typeof readRemoteReleasePreview;
    validateRemoteReleasePreview: typeof validateRemoteReleasePreview;
    toPublicRemoteReleasePreview: typeof toPublicRemoteReleasePreview;
    cleanupExpiredPreviews: typeof cleanupExpiredPreviews;
    isPreviewReleaseDirectory: typeof isPreviewReleaseDirectory;
};
export = _default;
