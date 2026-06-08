type ToolCommand = 'node' | 'npm' | 'npx';
type LocalToolEnv = NodeJS.ProcessEnv;
interface LocalToolEnvOptions {
    env?: Record<string, string | undefined>;
    cwd?: string;
    shell?: boolean;
}
interface ProxyEndpoint {
    raw: string;
    hostname: string;
    port: number;
    protocol: string;
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
interface PortState {
    available: boolean;
    status: 'invalid' | 'free' | 'occupied' | 'denied' | 'unknown';
    reason: string;
}
declare function getCommandVersion(command: string): string;
declare function getCommandPath(command: string): string;
declare function getPortableNodeDir(): string;
declare function getPortableToolPath(command: ToolCommand): string;
declare function getLocalToolEnv(extra?: LocalToolEnvOptions['env']): LocalToolEnv;
declare function getToolVersion(toolPath: string): string;
declare function getLocalToolCommand(command: ToolCommand): string;
declare function getLocalTaskOptions(options?: LocalToolEnvOptions): {
    env: NodeJS.ProcessEnv;
    cwd?: string;
    shell?: boolean;
};
declare function normalizeProxyValue(value: unknown): string;
declare function parseProxyEndpoint(value: unknown): ProxyEndpoint | null;
declare function redactProxyValue(value: unknown): string;
declare function isLoopbackProxyHost(hostname: unknown): boolean;
declare function isProjectOwnedTool(toolPath: string): boolean;
declare function getCommandInfo(command: ToolCommand, minMajor?: number): CommandInfo;
declare function checkPortState(port: unknown): PortState;
declare function checkPortAvailable(port: unknown): boolean;
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
