declare function isPathSafe(targetPath: string, baseDir: string): boolean;
declare function validateSkillName(name: unknown): boolean;
declare function ensureDir(dir: string): Promise<void>;
declare function readJsonSafe<T>(filePath: string, fallback: T): Promise<T>;
declare function readJsonSafe<T = null>(filePath: string, fallback?: T): Promise<T | null>;
declare function copyDir(src: string, dest: string): Promise<void>;
declare function removeDir(dir: string): Promise<void>;
declare const _default: {
    SKILL_POOL_DIR: string;
    WORKSPACE_DIR: string;
    isPathSafe: typeof isPathSafe;
    validateSkillName: typeof validateSkillName;
    ensureDir: typeof ensureDir;
    atomicWriteJson: (filePath: string, data: unknown) => Promise<void>;
    readJsonSafe: typeof readJsonSafe;
    copyDir: typeof copyDir;
    removeDir: typeof removeDir;
};
export = _default;
