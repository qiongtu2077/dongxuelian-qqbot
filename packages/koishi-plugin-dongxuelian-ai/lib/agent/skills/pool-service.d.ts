interface SkillPoolEntry {
    name: string;
    description?: string;
    version?: string;
    source?: string;
    installedAt?: string;
    path?: string;
    scanResult?: {
        safe?: boolean;
        scannedAt?: string;
    };
}
interface SkillPoolManifest {
    schema: 'skill-pool-manifest.v1';
    skills: Record<string, SkillPoolEntry>;
}
interface SkillMeta {
    name: string;
    description: string;
    version?: string;
    author?: string;
    raw: string;
}
interface InstallPoolOptions {
    source?: string;
    force?: boolean;
}
interface PoolScanResult {
    safe: boolean;
    findings?: unknown[];
    whitelisted?: boolean;
    maxSeverity?: string;
    scannedAt: string;
}
interface PoolOperationResult {
    ok: boolean;
    name?: string;
    error?: string;
    scanResult?: PoolScanResult;
}
declare function readPoolManifest(): Promise<SkillPoolManifest>;
declare function parseSkillMeta(skillDir: string): SkillMeta | null;
declare function installToPool(skillDir: string, { source, force }?: InstallPoolOptions): Promise<PoolOperationResult>;
declare function removeFromPool(name: string): Promise<PoolOperationResult>;
declare function listPoolSkills(): Promise<SkillPoolEntry[]>;
declare function getPoolSkillInfo(name: string): Promise<SkillPoolEntry | null>;
declare function syncBuiltinSkills(): Promise<{
    synced: number;
}>;
declare const _default: {
    POOL_MANIFEST_FILE: string;
    readPoolManifest: typeof readPoolManifest;
    installToPool: typeof installToPool;
    removeFromPool: typeof removeFromPool;
    listPoolSkills: typeof listPoolSkills;
    getPoolSkillInfo: typeof getPoolSkillInfo;
    syncBuiltinSkills: typeof syncBuiltinSkills;
    parseSkillMeta: typeof parseSkillMeta;
};
export = _default;
