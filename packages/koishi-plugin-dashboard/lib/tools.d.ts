interface LocalToolEnvOptions {
    env?: Record<string, string>;
}
declare function getCommandVersion(command: any): any;
declare function getCommandPath(command: any): any;
declare function getPortableNodeDir(): any;
declare function getPortableToolPath(command: any): any;
declare function getLocalToolEnv(extra?: {}): {};
declare function getToolVersion(toolPath: any): any;
declare function getLocalToolCommand(command: any): any;
declare function getLocalTaskOptions(options?: LocalToolEnvOptions): {
    env: {};
};
declare function normalizeProxyValue(value: any): string;
declare function parseProxyEndpoint(value: any): {
    raw: string;
    hostname: string;
    port: number;
    protocol: string;
};
declare function redactProxyValue(value: any): string;
declare function isLoopbackProxyHost(hostname: any): boolean;
declare function isProjectOwnedTool(toolPath: any): any;
declare function getCommandInfo(command: any, minMajor?: number): {
    found: boolean;
    version: any;
    source: string;
    sourcePath: any;
    ownedByProject: any;
    ok: boolean;
    reason: string;
};
declare function checkPortState(port: any): {
    available: boolean;
    status: string;
    reason: string;
};
declare function checkPortAvailable(port: any): boolean;
declare function resolveKoishiListenPort(): number;
declare const _default: {
    getCommandVersion: typeof getCommandVersion;
    getCommandPath: typeof getCommandPath;
    getPortableNodeDir: typeof getPortableNodeDir;
    getPortableToolPath: typeof getPortableToolPath;
    getLocalToolEnv: typeof getLocalToolEnv;
    getToolVersion: typeof getToolVersion;
    getLocalToolCommand: typeof getLocalToolCommand;
    getLocalTaskOptions: typeof getLocalTaskOptions;
    normalizeProxyValue: typeof normalizeProxyValue;
    parseProxyEndpoint: typeof parseProxyEndpoint;
    redactProxyValue: typeof redactProxyValue;
    isLoopbackProxyHost: typeof isLoopbackProxyHost;
    isProjectOwnedTool: typeof isProjectOwnedTool;
    getCommandInfo: typeof getCommandInfo;
    checkPortState: typeof checkPortState;
    checkPortAvailable: typeof checkPortAvailable;
    resolveKoishiListenPort: typeof resolveKoishiListenPort;
};
export = _default;
