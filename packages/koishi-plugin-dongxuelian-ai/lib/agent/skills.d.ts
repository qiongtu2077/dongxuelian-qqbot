interface SkillFrontmatter {
    [key: string]: string;
}
interface AgentSkill {
    kind: string;
    file: string;
    name: string;
    description: string;
    dir: string;
    path: string;
    directorySkill: boolean;
    references: string[];
    hasReferences: boolean;
}
interface ReadAgentSkillOptions {
    file?: unknown;
    maxChars?: unknown;
}
interface ReadAgentSkillResult {
    name: string;
    kind: string;
    description: string;
    file: string;
    primaryFile: string;
    references: string[];
    content: string;
    chars: number;
    truncated: boolean;
}
interface FindRelevantAgentSkillsOptions {
    limit?: unknown;
}
interface BuildAgentSkillSummaryOptions {
    query?: unknown;
    relevantLimit?: unknown;
}
declare function parseFrontmatter(text: unknown): SkillFrontmatter;
declare function stripFrontmatter(text?: unknown): string;
declare function listAgentSkills(): AgentSkill[];
declare function findAgentSkill(name: unknown): AgentSkill | null;
declare function readAgentSkill(name: unknown, options?: ReadAgentSkillOptions): ReadAgentSkillResult;
declare function findRelevantAgentSkills(query?: unknown, options?: FindRelevantAgentSkillsOptions): AgentSkill[];
declare function buildAgentSkillSummary(enabledNames?: unknown[], options?: BuildAgentSkillSummaryOptions): string;
declare const _default: {
    listAgentSkills: typeof listAgentSkills;
    findAgentSkill: typeof findAgentSkill;
    findRelevantAgentSkills: typeof findRelevantAgentSkills;
    readAgentSkill: typeof readAgentSkill;
    parseFrontmatter: typeof parseFrontmatter;
    buildAgentSkillSummary: typeof buildAgentSkillSummary;
    stripFrontmatter: typeof stripFrontmatter;
};
export = _default;
