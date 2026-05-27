type SkillSeverity = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW' | 'SAFE';
interface SkillFinding {
    file?: string;
    rule?: string;
    category: string;
    severity: SkillSeverity;
    description: string;
}
interface SkillScanResult {
    safe: boolean;
    findings: SkillFinding[];
    whitelisted?: boolean;
    maxSeverity: SkillSeverity;
    scannedAt: string;
}
declare function hashFileContent(content: string | Buffer): string;
/**
 * MODULE: computeDirectoryHash
 * 职责: 按与扫描器相同的文件枚举顺序拼接目录下各文件字节内容，计算完整 SHA-256（hex）。
 * 边界: 仅统计 listSkillFiles 命中的文件；不跟随目录软链本身（与子目录/文件布局与扫描阶段一致）。
 */
declare function computeDirectoryHash(dirPath: string): string;
/**
 * MODULE: addToWhitelist
 * 职责: 将解析后的目录路径写入白名单并记录当前目录内容哈希与元数据；原子落盘。
 * 边界: 不校验 reason 内容；目录须存在且可哈希。
 */
declare function addToWhitelist(dirPath: string, reason: unknown): Promise<void>;
/**
 * MODULE: removeFromWhitelist
 * 职责: 从白名单中移除指定目录键并原子写回；无此项则为空操作。
 * 边界: 按 canonicalWhitelistKey 匹配，与 addToWhitelist 一致。
 */
declare function removeFromWhitelist(dirPath: string): Promise<void>;
declare function scanSkillDirectory(skillDir: string): SkillScanResult;
declare function scanSkillFile(filePath: string): SkillScanResult;
declare const _default: {
    scanSkillDirectory: typeof scanSkillDirectory;
    scanSkillFile: typeof scanSkillFile;
    hashFileContent: typeof hashFileContent;
    computeDirectoryHash: typeof computeDirectoryHash;
    addToWhitelist: typeof addToWhitelist;
    removeFromWhitelist: typeof removeFromWhitelist;
    SCAN_RULES: {
        id: string;
        category: string;
        severity: string;
        pattern: RegExp;
        description: string;
    }[];
    SEVERITY_ORDER: {
        CRITICAL: number;
        HIGH: number;
        MEDIUM: number;
        LOW: number;
        SAFE: number;
    };
    MAX_SKILL_FILE_SIZE: number;
    MAX_SKILL_FILES: number;
};
export = _default;
