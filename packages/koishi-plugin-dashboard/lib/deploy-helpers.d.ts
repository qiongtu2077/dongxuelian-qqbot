interface ScpOptions {
    recursive?: boolean;
}
interface DeployFingerprintExtra {
    deployedAt?: number;
    deployFingerprint?: string;
    [key: string]: unknown;
}
interface CopyWorkspaceResourceOptions {
    replace?: boolean;
}
interface RuntimeLayoutOptions {
    includeNapcat?: boolean;
    includeNodeModules?: boolean;
}
interface DownloadOptions {
    redirects?: number;
    minBytes?: number;
    expectedExt?: string;
    expectedContentType?: string;
    preferredName?: string;
    [key: string]: unknown;
}
type DownloadCallback = (err: Error | null, filePath?: string, detail?: unknown) => void;
interface RunNpmOptions {
    env?: Record<string, string>;
    cwd?: string;
    timeout?: number;
}
interface NpmProxyDiagnosis {
    shouldBypass?: boolean;
    reason?: string;
    [key: string]: unknown;
}
interface NpmRepairState {
    forced?: boolean;
    automatic?: boolean;
    envClearedForRetry?: boolean;
    reason?: string;
    actions?: unknown[];
}
interface NpmDiagnostics {
    env?: Record<string, unknown>;
    config?: {
        proxy?: unknown;
        httpsProxy?: unknown;
        registry?: unknown;
    };
    proxy?: NpmProxyDiagnosis;
    repair?: NpmRepairState;
    [key: string]: unknown;
}
interface LocalDeployManifestFile {
    path: string;
    action?: string;
    kind?: string;
    reason?: string;
    size?: number;
    deleteByDefault?: boolean;
    sensitive?: boolean;
    sha256?: string;
    [key: string]: unknown;
}
interface LocalDeployManifest {
    version?: number;
    files?: LocalDeployManifestFile[];
    [key: string]: unknown;
}
interface PrepareNpmInstallOptions {
    forceRepair?: boolean;
}
interface GithubReleaseAsset {
    name?: string;
    browser_download_url?: string;
}
interface GithubRelease {
    assets?: GithubReleaseAsset[];
}
type InstallCallback = (err: Error | null, detail?: Record<string, unknown>) => void;
declare function validateDeployServer(server: any): string;
declare function validateDeployAppDir(appDir: any): string;
declare function validateDeployTarget(cfg: any): any;
declare function remoteJoin(base: any, ...parts: any[]): string;
declare function sshCommand(server: any, remoteCmd: any): string;
declare function scpRemoteTarget(server: any, remotePath: any): string;
declare function scpCommand(source: any, target: any, options?: ScpOptions): string;
declare function hashFile(hash: any, repoRoot: any, filePath: any): void;
declare function computeFingerprint(): any;
declare function writeDeployFingerprint(file: any, extra?: DeployFingerprintExtra): string;
declare function isBlockedDownloadHost(hostname: any): boolean;
declare function getLocalWorkDirSafety(): {
    ok: boolean;
    isTempRuntime: boolean;
    reasons: any[];
    projectDir: any;
    runtimeDir: any;
    workspaceRoot: any;
    resourceRoot: string;
    packaged: boolean;
};
declare function getLocalDeployTarget(): {
    kind: string;
    scope: string;
    platform: NodeJS.Platform;
    arch: NodeJS.Architecture;
    hostname: any;
    projectDir: any;
    runtimeDir: any;
    workspace: {
        ok: boolean;
        isTempRuntime: boolean;
        reasons: any[];
        projectDir: any;
        runtimeDir: any;
        workspaceRoot: any;
        resourceRoot: string;
        packaged: boolean;
    };
    isWindowsBackend: boolean;
    isLocalDeployer: any;
    canRunWindowsLocalDeploy: boolean;
    blocked: boolean;
    blockedReason: string;
    guidance: string;
};
declare function requireWindowsLocalDeployTarget(req: any, res: any): boolean;
declare function ensureWritableDir(dir: any): void;
declare function copyWorkspaceResource(sourceRoot: any, targetRoot: any, relativePath: any, options?: CopyWorkspaceResourceOptions): boolean;
declare function ensurePackagedWorkspace(options?: RuntimeLayoutOptions): {
    ok: boolean;
    skipped: boolean;
    workspaceRoot: any;
    resourceRoot: any;
    version?: undefined;
} | {
    ok: boolean;
    skipped: boolean;
    workspaceRoot: any;
    resourceRoot: any;
    version: string;
};
declare function writeRuntimeLayout(options?: RuntimeLayoutOptions): void;
declare function testChinesePathWrite(dir: any): {
    ok: boolean;
    message?: undefined;
} | {
    ok: boolean;
    message: any;
};
declare function inspectChinesePathWrite(dir: any): {
    ok: boolean;
    message?: undefined;
} | {
    ok: boolean;
    message: any;
};
declare function safeDecodeURIComponent(value: any): any;
declare function sanitizeDownloadName(name: any, fallback?: string): any;
declare function getContentDispositionFileName(header: any): any;
declare function ensureExtension(name: any, ext: any): any;
declare function hasZipMagic(filePath: any): boolean;
declare function validateDownloadedFile(filePath: any, options?: DownloadOptions): {
    path: any;
    size: any;
    name: any;
};
declare function getDownloadFileName(parsed: any, response: any, options?: DownloadOptions): any;
declare function downloadToRuntime(url: any, options: DownloadOptions | DownloadCallback, callback?: DownloadCallback): void;
declare function psCommandArg(value: any): string;
declare function formatLocalNpmCommand(args?: any[]): string;
declare function getNoProxyEnvOverrides(): {
    [k: string]: any;
};
declare function runNpmConfigGet(name: any): any;
declare function runNpmCommand(args: any, options?: RunNpmOptions): any;
declare function collectNpmInstallDiagnostics(force?: boolean): any;
declare function collectNpmProxyCandidates(diagnostics?: NpmDiagnostics): any[];
declare function diagnoseNpmProxy(diagnostics?: NpmDiagnostics): {
    candidates: any[];
    loopback: any[];
    staleLoopback: any[];
    shouldBypass: boolean;
    reason: string;
};
declare function repairNpmProxyConfig(env?: Record<string, string>): any[];
declare function commandListForNpmProxyFix(hasNpmProxy: any, hasEnvProxy: any): any[];
declare function buildNpmInstallFailureGuide(logLines?: any[], diagnostics?: NpmDiagnostics | null): {
    code: string;
    title: string;
    summary: string;
    fixSteps: string[];
    commands: any[];
    diagnostics: any;
};
declare function getBlockedLocalTaskStatus(key: any, extra?: Record<string, unknown>): any;
declare function fileSha256(filePath: any): any;
declare function readLocalDeployManifest(): LocalDeployManifest;
declare function backupLocalDeployFile(filePath: any, rel: any, timestamp: any): any;
declare function writeTrackedLocalFile(rel: any, content: any, options: Partial<LocalDeployManifestFile>, timestamp: any): {
    path: any;
    action: string;
    backup: any;
    beforeHash: any;
    sha256: any;
    deleteByDefault: boolean;
    sensitive: boolean;
    kind: string;
};
declare function writeLocalDeployManifest(manifest: any): void;
declare function getProjectDependencyStatus(): {
    ready: boolean;
    nodeModules: {
        exists: any;
        path: any;
    };
    packageLock: {
        exists: any;
        path: any;
    };
    packages: {
        [k: string]: any;
    };
    missing: string[];
    reason: string;
};
declare function getAiKeyStatus(providerInput?: string): {
    provider: string;
    configured: boolean;
    path: any;
    reason: string;
};
declare function getNapcatLoginHint(): {
    status: string;
    reason: string;
};
declare function getLocalNapcatDeployStatus(): any;
declare function getLocalKoishiDeployStatus(): any;
declare function getLocalNpmInstallStatus(): any;
declare function buildLocalReadyCheck(): {
    ok: boolean;
    blocked: boolean;
    localDeployTarget: {
        kind: string;
        scope: string;
        platform: NodeJS.Platform;
        arch: NodeJS.Architecture;
        hostname: any;
        projectDir: any;
        runtimeDir: any;
        workspace: {
            ok: boolean;
            isTempRuntime: boolean;
            reasons: any[];
            projectDir: any;
            runtimeDir: any;
            workspaceRoot: any;
            resourceRoot: string;
            packaged: boolean;
        };
        isWindowsBackend: boolean;
        isLocalDeployer: any;
        canRunWindowsLocalDeploy: boolean;
        blocked: boolean;
        blockedReason: string;
        guidance: string;
    };
    basicReady: boolean;
    fullyReady: boolean;
    checks: {
        node: boolean;
        npm: boolean;
        dependencies: boolean;
        localConfig: boolean;
        napcatInstalled: boolean;
        napcatStarted: boolean;
        onebotPort: boolean;
        koishiStarted: boolean;
        aiKey: boolean;
    };
    node: {
        ok: boolean;
        reason: string;
    };
    npm: {
        found: boolean;
        reason: string;
    };
    dependencies: {
        ready: boolean;
        reason: string;
    };
    localConfig: {
        ok: boolean;
        files: any[];
        protected: any[];
    };
    napcat: any;
    koishi: any;
    aiKey: {
        provider: string;
        configured: boolean;
        path: any;
        reason: string;
    };
    dashboardUrl: string;
    koishiUrl: string;
    napcatUrl: string;
    message: string;
} | {
    ok: boolean;
    blocked: boolean;
    localDeployTarget: {
        kind: string;
        scope: string;
        platform: NodeJS.Platform;
        arch: NodeJS.Architecture;
        hostname: any;
        projectDir: any;
        runtimeDir: any;
        workspace: {
            ok: boolean;
            isTempRuntime: boolean;
            reasons: any[];
            projectDir: any;
            runtimeDir: any;
            workspaceRoot: any;
            resourceRoot: string;
            packaged: boolean;
        };
        isWindowsBackend: boolean;
        isLocalDeployer: any;
        canRunWindowsLocalDeploy: boolean;
        blocked: boolean;
        blockedReason: string;
        guidance: string;
    };
    basicReady: any;
    fullyReady: boolean;
    checks: {
        node: any;
        npm: any;
        dependencies: boolean;
        localConfig: boolean;
        napcatInstalled: any;
        napcatStarted: any;
        onebotPort: boolean;
        koishiStarted: any;
        aiKey: boolean;
    };
    node: any;
    npm: any;
    dependencies: {
        ready: boolean;
        nodeModules: {
            exists: any;
            path: any;
        };
        packageLock: {
            exists: any;
            path: any;
        };
        packages: {
            [k: string]: any;
        };
        missing: string[];
        reason: string;
    };
    localConfig: {
        ok: boolean;
        files: any[];
        protected: {
            path: string;
            action: string;
            reason: string;
        }[];
        manifest: {
            exists: any;
            path: any;
        };
    };
    napcat: any;
    koishi: any;
    aiKey: {
        provider: string;
        configured: boolean;
        path: any;
        reason: string;
    };
    dashboardUrl: string;
    koishiUrl: string;
    napcatUrl: string;
    message: string;
};
declare function buildLocalConfigPreview(): {
    ok: boolean;
    files: any[];
    protected: {
        path: string;
        action: string;
        reason: string;
    }[];
    manifest: {
        exists: any;
        path: any;
    };
};
declare function deleteLocalConfigFiles(): {
    ok: boolean;
    deleted: any[];
    kept: any[];
    errors: any[];
};
declare function psQuote(value: any): string;
declare function validateNapcatInstallDir(input: any): any;
declare function httpsGetJson(url: any, callback: (err: Error | null, data?: unknown) => void, redirects?: number): void;
declare function pickNapcatWindowsAsset(release?: GithubRelease): GithubReleaseAsset;
declare function findFilesRecursive(root: any, matcher: any, maxDepth?: number, maxCount?: number): any[];
declare function cleanupRuntimeInstallStaging(prefix: any): void;
declare function extractZipArchive(archivePath: any, destinationDir: any): {
    method: string;
    attempts: any[];
    archivePath: any;
    destinationDir: any;
    size: any;
};
declare function runNapcatInstallerIfPresent(stagingDir: any): {
    ran: boolean;
    ok: boolean;
    reason: string;
    path?: undefined;
} | {
    ran: boolean;
    ok: boolean;
    path: any;
    reason: string;
};
declare function findNapcatCopyRoot(stagingDir: any): any;
declare function buildNapcatManualSteps(archivePath: any, installDir: any): string[];
declare function downloadNapcatWindowsRelease(installDir: any, callback: InstallCallback): void;
declare function pickNodeWindowsRelease(releases: any): {
    version: any;
    arch: string;
    fileName: string;
    url: string;
};
declare function findExtractedNodeRoot(stagingDir: any): any;
declare function installPortableNodeWindows(callback: InstallCallback): void;
declare function getNapcatStartEntry(): any;
declare function prepareNpmInstallRun(options?: PrepareNpmInstallOptions): {
    env: {
        [k: string]: any;
    };
    diagnostics: any;
    repair: {
        forced: boolean;
        automatic: any;
        envClearedForRetry: any;
        reason: any;
        actions: any[];
    };
};
declare const _default: {
    MAX_DOWNLOAD_BYTES: any;
    MAX_DEPLOY_TASK_LOG_BYTES: any;
    MAX_DEPLOY_UPLOAD_BYTES: any;
    MAX_DOWNLOAD_REDIRECTS: any;
    MAX_JSON_RESPONSE_BYTES: any;
    HASH_CHUNK_BYTES: number;
    validateDeployServer: typeof validateDeployServer;
    validateDeployAppDir: typeof validateDeployAppDir;
    validateDeployTarget: typeof validateDeployTarget;
    remoteJoin: typeof remoteJoin;
    sshCommand: typeof sshCommand;
    scpRemoteTarget: typeof scpRemoteTarget;
    scpCommand: typeof scpCommand;
    hashFile: typeof hashFile;
    computeFingerprint: typeof computeFingerprint;
    writeDeployFingerprint: typeof writeDeployFingerprint;
    isBlockedDownloadHost: typeof isBlockedDownloadHost;
    getLocalWorkDirSafety: typeof getLocalWorkDirSafety;
    getLocalDeployTarget: typeof getLocalDeployTarget;
    requireWindowsLocalDeployTarget: typeof requireWindowsLocalDeployTarget;
    ensureWritableDir: typeof ensureWritableDir;
    copyWorkspaceResource: typeof copyWorkspaceResource;
    ensurePackagedWorkspace: typeof ensurePackagedWorkspace;
    writeRuntimeLayout: typeof writeRuntimeLayout;
    testChinesePathWrite: typeof testChinesePathWrite;
    inspectChinesePathWrite: typeof inspectChinesePathWrite;
    safeDecodeURIComponent: typeof safeDecodeURIComponent;
    sanitizeDownloadName: typeof sanitizeDownloadName;
    getContentDispositionFileName: typeof getContentDispositionFileName;
    ensureExtension: typeof ensureExtension;
    hasZipMagic: typeof hasZipMagic;
    validateDownloadedFile: typeof validateDownloadedFile;
    getDownloadFileName: typeof getDownloadFileName;
    downloadToRuntime: typeof downloadToRuntime;
    psCommandArg: typeof psCommandArg;
    formatLocalNpmCommand: typeof formatLocalNpmCommand;
    getNoProxyEnvOverrides: typeof getNoProxyEnvOverrides;
    runNpmConfigGet: typeof runNpmConfigGet;
    runNpmCommand: typeof runNpmCommand;
    collectNpmInstallDiagnostics: typeof collectNpmInstallDiagnostics;
    collectNpmProxyCandidates: typeof collectNpmProxyCandidates;
    diagnoseNpmProxy: typeof diagnoseNpmProxy;
    repairNpmProxyConfig: typeof repairNpmProxyConfig;
    commandListForNpmProxyFix: typeof commandListForNpmProxyFix;
    buildNpmInstallFailureGuide: typeof buildNpmInstallFailureGuide;
    getBlockedLocalTaskStatus: typeof getBlockedLocalTaskStatus;
    fileSha256: typeof fileSha256;
    readLocalDeployManifest: typeof readLocalDeployManifest;
    backupLocalDeployFile: typeof backupLocalDeployFile;
    writeTrackedLocalFile: typeof writeTrackedLocalFile;
    writeLocalDeployManifest: typeof writeLocalDeployManifest;
    getProjectDependencyStatus: typeof getProjectDependencyStatus;
    getAiKeyStatus: typeof getAiKeyStatus;
    getNapcatLoginHint: typeof getNapcatLoginHint;
    resolveKoishiListenPort: any;
    getLocalNapcatDeployStatus: typeof getLocalNapcatDeployStatus;
    getLocalKoishiDeployStatus: typeof getLocalKoishiDeployStatus;
    getLocalNpmInstallStatus: typeof getLocalNpmInstallStatus;
    buildLocalReadyCheck: typeof buildLocalReadyCheck;
    buildLocalConfigPreview: typeof buildLocalConfigPreview;
    deleteLocalConfigFiles: typeof deleteLocalConfigFiles;
    psQuote: typeof psQuote;
    validateNapcatInstallDir: typeof validateNapcatInstallDir;
    httpsGetJson: typeof httpsGetJson;
    pickNapcatWindowsAsset: typeof pickNapcatWindowsAsset;
    findFilesRecursive: typeof findFilesRecursive;
    cleanupRuntimeInstallStaging: typeof cleanupRuntimeInstallStaging;
    extractZipArchive: typeof extractZipArchive;
    runNapcatInstallerIfPresent: typeof runNapcatInstallerIfPresent;
    findNapcatCopyRoot: typeof findNapcatCopyRoot;
    buildNapcatManualSteps: typeof buildNapcatManualSteps;
    downloadNapcatWindowsRelease: typeof downloadNapcatWindowsRelease;
    pickNodeWindowsRelease: typeof pickNodeWindowsRelease;
    findExtractedNodeRoot: typeof findExtractedNodeRoot;
    installPortableNodeWindows: typeof installPortableNodeWindows;
    getNapcatStartEntry: typeof getNapcatStartEntry;
    prepareNpmInstallRun: typeof prepareNpmInstallRun;
};
export = _default;
