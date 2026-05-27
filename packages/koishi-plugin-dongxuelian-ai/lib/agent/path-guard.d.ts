interface ExistingPathGuardResult {
    abs: string;
    real: string;
    roots: string[];
}
interface NewPathGuardResult {
    abs: string;
    realParent: string;
    roots: string[];
}
declare function isAgentPathInside(target: unknown, root: unknown): boolean;
declare function assertNotWriteBlockedBasename(target: unknown, label?: string): void;
declare function getAgentPathDefaultRoots(): string[];
declare function getAgentPathAllowedRoots(): Promise<string[]>;
declare function assertExistingAgentPathInsideRoots(target: unknown, label?: string): Promise<ExistingPathGuardResult>;
declare function assertNewAgentPathInsideRoots(target: unknown, label?: string, createDirectories?: boolean): Promise<NewPathGuardResult>;
declare function resolveAgentDefaultRoot(): Promise<string>;
declare const _default: {
    isAgentPathInside: typeof isAgentPathInside;
    getAgentPathAllowedRoots: typeof getAgentPathAllowedRoots;
    getAgentPathDefaultRoots: typeof getAgentPathDefaultRoots;
    assertNotWriteBlockedBasename: typeof assertNotWriteBlockedBasename;
    assertExistingAgentPathInsideRoots: typeof assertExistingAgentPathInsideRoots;
    assertNewAgentPathInsideRoots: typeof assertNewAgentPathInsideRoots;
    resolveAgentDefaultRoot: typeof resolveAgentDefaultRoot;
};
export = _default;
