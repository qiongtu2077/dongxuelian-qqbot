import type { IncomingMessage, ServerResponse } from 'http';
type ToolsModule = typeof import('./tools');
type NapcatModule = typeof import('./napcat');
type DeployStateModule = typeof import('./deploy-state');
type LocalTaskKey = Parameters<DeployStateModule['getTaskPublicStatus']>[0];
type LocalTaskPublicStatus = ReturnType<DeployStateModule['getTaskPublicStatus']>;
type CommandInfo = ReturnType<ToolsModule['getCommandInfo']>;
type PortState = ReturnType<ToolsModule['checkPortState']>;
type NapcatDetection = ReturnType<NapcatModule['detectNapcatInstallation']>;
type NapcatStartEntry = ReturnType<NapcatModule['getNapcatStartEntry']>;
interface UnsupportedPortState extends Record<string, unknown> {
    available: false;
    status: 'unsupported';
    reason: string;
}
type LocalDeployPortState = PortState | UnsupportedPortState;
interface CopyWorkspaceResourceOptions {
    replace?: boolean;
}
interface RuntimeLayoutOptions {
    includeNapcat?: boolean;
    includeNodeModules?: boolean;
}
interface LocalWorkDirSafety {
    ok: boolean;
    isTempRuntime: boolean;
    reasons: string[];
    projectDir: string;
    runtimeDir: string;
    workspaceRoot: string;
    resourceRoot: string;
    packaged: boolean;
}
interface LocalDeployTarget {
    kind: string;
    scope: string;
    platform: NodeJS.Platform;
    arch: string;
    hostname: string;
    projectDir: string;
    runtimeDir: string;
    workspace: LocalWorkDirSafety;
    isWindowsBackend: boolean;
    isLocalDeployer: boolean;
    canRunWindowsLocalDeploy: boolean;
    blocked: boolean;
    blockedReason: string;
    guidance: string;
}
interface RuntimeWorkspaceResult {
    ok: true;
    skipped: boolean;
    workspaceRoot: string;
    resourceRoot: string;
    version?: string;
}
interface ChinesePathWriteResult {
    ok: boolean;
    message?: string;
}
interface DownloadOptions {
    redirects?: number;
    minBytes?: number;
    expectedExt?: string;
    expectedContentType?: string;
    preferredName?: string;
    [key: string]: unknown;
}
interface DownloadResult {
    path: string;
    size: number;
    name: string;
}
type DownloadCallback = (err: Error | null, filePath?: string, detail?: unknown) => void;
interface RunNpmOptions {
    env?: Record<string, string>;
    cwd?: string;
    timeout?: number;
}
interface ProxyEndpointLike {
    raw: string;
    hostname: string;
    port: number;
    protocol: string;
}
type PortStateLike = PortState | {
    status: string;
    [key: string]: unknown;
};
interface BlockedLocalTaskExtra extends Record<string, unknown> {
    blocked: true;
    localDeployTarget: LocalDeployTarget;
    running: false;
    message: string;
}
interface LocalNapcatDeployStatus extends LocalTaskPublicStatus {
    found: boolean;
    installation: NapcatDetection;
    running: boolean;
    webuiPort: LocalDeployPortState;
    onebotPort: LocalDeployPortState;
    webuiUrl: string;
    tokenAvailable: boolean;
    login: LoginHint;
}
interface LocalKoishiDeployStatus extends LocalTaskPublicStatus {
    running: boolean;
    port: LocalDeployPortState;
    loaded: boolean;
    url: string;
}
interface BlockedDependencyStatus {
    ready: false;
    reason: string;
}
interface LocalNpmInstallStatus extends LocalTaskPublicStatus {
    dependencies: ProjectDependencyStatus | BlockedDependencyStatus;
    failureGuide?: NpmInstallFailureGuide | null;
}
interface BlockedCommandStatus {
    ok?: false;
    found?: false;
    reason: string;
}
interface LocalReadyCheck {
    ok: true;
    blocked: boolean;
    localDeployTarget: LocalDeployTarget;
    basicReady: boolean;
    fullyReady: boolean;
    checks: LocalReadyChecks;
    node: CommandInfo | BlockedCommandStatus;
    npm: CommandInfo | BlockedCommandStatus;
    dependencies: ProjectDependencyStatus | BlockedDependencyStatus;
    localConfig: LocalConfigPreview;
    napcat: LocalNapcatDeployStatus;
    koishi: LocalKoishiDeployStatus;
    aiKey: AiKeyStatus;
    dashboardUrl: string;
    koishiUrl: string;
    napcatUrl: string;
    message: string;
}
interface NpmProxyCandidate extends ProxyEndpointLike {
    source: 'env' | 'npm config';
    key: string;
}
interface NpmStaleLoopbackProxyCandidate extends NpmProxyCandidate {
    portState: PortStateLike;
}
interface NpmRepairAction {
    command: string;
    ok: boolean;
    message?: string;
}
type NpmInstallFailureCode = 'NPM_PROXY_REFUSED' | 'NPM_DNS_FAILED' | 'NPM_TIMEOUT' | 'NPM_CERT_FAILED' | 'NPM_PERMISSION_FAILED' | 'NPM_AUTH_FAILED' | 'NPM_FAILED';
interface NpmInstallFailureGuide {
    code: NpmInstallFailureCode;
    title: string;
    summary: string;
    fixSteps: string[];
    commands: string[];
    diagnostics: NpmDiagnostics;
}
interface NpmProxyDiagnosis {
    candidates?: NpmProxyCandidate[];
    loopback?: NpmProxyCandidate[];
    staleLoopback?: NpmStaleLoopbackProxyCandidate[];
    shouldBypass?: boolean;
    reason?: string;
    [key: string]: unknown;
}
interface NpmRepairState {
    forced?: boolean;
    automatic?: boolean;
    envClearedForRetry?: boolean;
    reason?: string;
    actions?: NpmRepairAction[];
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
interface TrackedLocalDeployFile extends LocalDeployManifestFile {
    action: string;
    backup: string;
    beforeHash: string;
}
interface ProjectDependencyStatus {
    ready: boolean;
    nodeModules: {
        exists: boolean;
        path: string;
    };
    packageLock: {
        exists: boolean;
        path: string;
    };
    packages: Record<string, boolean>;
    missing: string[];
    reason: string;
}
interface AiKeyStatus {
    provider: string;
    configured: boolean;
    path: string;
    reason: string;
}
interface LoginHint {
    status: string;
    reason: string;
}
interface LocalReadyChecks {
    node: boolean;
    npm: boolean;
    dependencies: boolean;
    localConfig: boolean;
    napcatInstalled: boolean;
    napcatStarted: boolean;
    onebotPort: boolean;
    koishiStarted: boolean;
    aiKey: boolean;
}
interface LocalConfigPreviewFile extends Record<string, unknown> {
    path: string;
    action: string;
    reason?: string;
    size?: number;
    sha256?: string;
}
interface LocalConfigPreview {
    ok: boolean;
    files: LocalConfigPreviewFile[];
    protected: LocalConfigPreviewFile[];
    manifest?: {
        exists: boolean;
        path: string;
    };
}
interface DeleteLocalConfigResult {
    ok: boolean;
    deleted: LocalConfigPreviewFile[];
    kept: LocalConfigPreviewFile[];
    errors: LocalConfigPreviewFile[];
}
interface ArchiveExtractAttempt {
    method: string;
    code: unknown;
    error: string;
}
interface ArchiveExtractResult {
    method: string;
    attempts: ArchiveExtractAttempt[];
    archivePath: string;
    destinationDir: string;
    size: number;
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
interface NapcatInstallerResult {
    ran: boolean;
    ok: boolean;
    path?: string;
    reason: string;
}
interface PortableNodeAsset {
    version: string;
    arch: string;
    fileName: string;
    url: string;
}
type JsonCallback = (err: Error | null, data?: unknown) => void;
type InstallCallback = (err: Error | null, detail?: Record<string, unknown>) => void;
declare function isBlockedDownloadHost(hostname: unknown): boolean;
declare function getLocalWorkDirSafety(): LocalWorkDirSafety;
declare function getLocalDeployTarget(): LocalDeployTarget;
declare function requireWindowsLocalDeployTarget(req: IncomingMessage, res: ServerResponse): boolean;
declare function ensureWritableDir(dir: string): void;
declare function copyWorkspaceResource(sourceRoot: string, targetRoot: string, relativePath: string, options?: CopyWorkspaceResourceOptions): boolean;
declare function ensurePackagedWorkspace(options?: RuntimeLayoutOptions): RuntimeWorkspaceResult;
declare function writeRuntimeLayout(options?: RuntimeLayoutOptions): void;
declare function testChinesePathWrite(dir: string): ChinesePathWriteResult;
declare function inspectChinesePathWrite(dir: string): ChinesePathWriteResult;
declare function safeDecodeURIComponent(value: string): string;
declare function sanitizeDownloadName(name: unknown, fallback?: string): string;
declare function getContentDispositionFileName(header: unknown): string;
declare function ensureExtension(name: string, ext: unknown): string;
declare function hasZipMagic(filePath: string): boolean;
declare function validateDownloadedFile(filePath: string, options?: DownloadOptions): DownloadResult;
declare function getDownloadFileName(parsed: URL, response: IncomingMessage, options?: DownloadOptions): string;
declare function downloadToRuntime(url: string | URL, options?: DownloadOptions | DownloadCallback, callback?: DownloadCallback): void;
declare function psCommandArg(value: unknown): string;
declare function formatLocalNpmCommand(args?: string[]): string;
declare function getNoProxyEnvOverrides(): Record<string, string>;
declare function runNpmConfigGet(name: string): string;
declare function runNpmCommand(args: string[], options?: RunNpmOptions): string;
declare function collectNpmInstallDiagnostics(force?: boolean): NpmDiagnostics;
declare function collectNpmProxyCandidates(diagnostics?: NpmDiagnostics): NpmProxyCandidate[];
declare function diagnoseNpmProxy(diagnostics?: NpmDiagnostics): NpmProxyDiagnosis;
declare function repairNpmProxyConfig(env?: Record<string, string>): NpmRepairAction[];
declare function commandListForNpmProxyFix(hasNpmProxy: boolean, hasEnvProxy: boolean): string[];
declare function buildNpmInstallFailureGuide(logLines?: string[] | string, diagnostics?: NpmDiagnostics | null): NpmInstallFailureGuide | null;
declare function getBlockedLocalTaskStatus<TExtra extends Record<string, unknown>>(key: LocalTaskKey, extra: TExtra): LocalTaskPublicStatus & BlockedLocalTaskExtra & TExtra;
declare function fileSha256(filePath: string): string;
declare function readLocalDeployManifest(): LocalDeployManifest;
declare function backupLocalDeployFile(filePath: string, rel: string, timestamp: number): string;
declare function writeTrackedLocalFile(rel: string, content: unknown, options: Partial<LocalDeployManifestFile>, timestamp: number): TrackedLocalDeployFile;
declare function writeLocalDeployManifest(manifest: LocalDeployManifest): void;
declare function getProjectDependencyStatus(): ProjectDependencyStatus;
declare function getAiKeyStatus(providerInput?: string): AiKeyStatus;
declare function getNapcatLoginHint(): LoginHint;
declare function getLocalNapcatDeployStatus(): LocalNapcatDeployStatus;
declare function getLocalKoishiDeployStatus(): LocalKoishiDeployStatus;
declare function getLocalNpmInstallStatus(): LocalNpmInstallStatus;
declare function buildLocalReadyCheck(): LocalReadyCheck;
declare function buildLocalConfigPreview(): LocalConfigPreview;
declare function deleteLocalConfigFiles(): DeleteLocalConfigResult;
declare function psQuote(value: unknown): string;
declare function validateNapcatInstallDir(input: unknown): string;
declare function httpsGetJson(url: string, callback: JsonCallback, redirects?: number): void;
declare function pickNapcatWindowsAsset(release?: GithubRelease): GithubReleaseAsset | null;
declare function findFilesRecursive(root: string, matcher: (name: string, fullPath: string) => boolean, maxDepth?: number, maxCount?: number): string[];
declare function cleanupRuntimeInstallStaging(prefix: string): void;
declare function extractZipArchive(archivePath: string, destinationDir: string): ArchiveExtractResult;
declare function runNapcatInstallerIfPresent(stagingDir: string): NapcatInstallerResult;
declare function findNapcatCopyRoot(stagingDir: string): string;
declare function buildNapcatManualSteps(archivePath: string, installDir: string): string[];
declare function downloadNapcatWindowsRelease(installDir: string, callback: InstallCallback): void;
declare function pickNodeWindowsRelease(releases: unknown): PortableNodeAsset;
declare function findExtractedNodeRoot(stagingDir: string): string;
declare function installPortableNodeWindows(callback: InstallCallback): void;
declare function getNapcatStartEntry(): NapcatStartEntry;
declare function prepareNpmInstallRun(options?: PrepareNpmInstallOptions): {
    env: Record<string, string>;
    diagnostics: NpmDiagnostics;
    repair: NpmRepairState;
};
declare const _default: {
    MAX_DOWNLOAD_BYTES: number;
    MAX_DEPLOY_TASK_LOG_BYTES: number;
    MAX_DEPLOY_UPLOAD_BYTES: number;
    MAX_DOWNLOAD_REDIRECTS: number;
    MAX_JSON_RESPONSE_BYTES: number;
    HASH_CHUNK_BYTES: number;
    validateDeployServer: typeof import("./remote-target").validateDeployServer;
    validateDeployAppDir: typeof import("./remote-target").validateDeployAppDir;
    validateDeployTarget: typeof import("./remote-target").validateDeployTarget;
    remoteJoin: typeof import("./remote-target").remoteJoin;
    sshCommand: typeof import("./remote-target").sshCommand;
    scpRemoteTarget: typeof import("./remote-target").scpRemoteTarget;
    scpCommand: typeof import("./remote-target").scpCommand;
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
    resolveKoishiListenPort: () => number;
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
