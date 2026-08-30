type DeployMode = 'install' | 'update';
interface DeployTargetInput {
    server?: unknown;
    appDir?: unknown;
    mode?: unknown;
}
export interface DeployTarget extends DeployTargetInput {
    server: string;
    appDir: string;
    mode: DeployMode;
}
interface ScpOptions {
    recursive?: boolean;
}
export declare function validateDeployServer(server: unknown): string;
export declare function validateDeployAppDir(appDir: unknown): string;
export declare function validateDeployTarget(cfg?: DeployTargetInput): DeployTarget;
export declare function remoteJoin(base: unknown, ...parts: unknown[]): string;
export declare function sshCommand(server: unknown, remoteCmd: unknown): string;
export declare function scpRemoteTarget(server: unknown, remotePath: unknown): string;
export declare function scpCommand(source: unknown, target: unknown, options?: ScpOptions): string;
export {};
