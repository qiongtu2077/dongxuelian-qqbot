declare function extractFrontmatterText(content?: string): string;
declare function hasFrontmatter(content?: string): boolean;
declare function migrateMissingLoreFrontmatter(sourceDir: string, targetDir: string): number;
declare function ensureRuntimeSkillSeeds(): void;
declare function resetRuntimeSkillSeedSyncForTest(): void;
declare const _default: {
    PACKAGE_SKILLS_SEED_DIR: string;
    SKILL_SEED_PARTS: string[];
    extractFrontmatterText: typeof extractFrontmatterText;
    hasFrontmatter: typeof hasFrontmatter;
    migrateMissingLoreFrontmatter: typeof migrateMissingLoreFrontmatter;
    ensureRuntimeSkillSeeds: typeof ensureRuntimeSkillSeeds;
    resetRuntimeSkillSeedSyncForTest: typeof resetRuntimeSkillSeedSyncForTest;
};
export = _default;
