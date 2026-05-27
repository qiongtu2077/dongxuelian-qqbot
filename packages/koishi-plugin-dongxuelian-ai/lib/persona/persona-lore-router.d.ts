interface LorePlan {
    lore?: {
        primary?: unknown;
        refs?: unknown[];
    };
}
interface SkillsContentCache {
    [key: string]: unknown;
}
interface LoreEntry {
    id?: string;
    label?: string;
    description?: string;
    scope?: string;
    keywords?: string[];
    usesLegacyKeywords?: boolean;
    summary?: string;
    maxChars?: number;
    priority?: number;
    content?: string;
    meta?: Record<string, unknown>;
    order?: number;
}
interface LoreSelection {
    text: string;
    truncated: boolean;
    source?: string;
}
interface RoutePersonaLoreOptions {
    cleanInput?: string;
    userText?: string;
    skillsContentCache?: SkillsContentCache;
    personaLore?: string;
    plan?: LorePlan | null;
    totalBudget?: unknown;
    promptBudget?: {
        lore?: unknown;
    };
}
declare function normalizeLoreText(value?: unknown, maxLength?: number): string;
declare function normalizeLoreId(value?: unknown): string;
declare function normalizeLoreScope(value?: unknown): string;
declare function normalizeLoreMaxChars(value: unknown, fallback?: number): number;
declare function normalizeLorePriority(value: unknown): number;
declare function normalizeLoreKeywords(value: unknown): string[];
declare function getLegacyLoreKeywords(loreId: string): string[];
declare function normalizeLoreEntry(loreId: unknown, skillsContentCache?: SkillsContentCache): LoreEntry;
declare function resolvePersonaLoreIds({ personaLore, plan }?: {
    personaLore?: string;
    plan?: LorePlan | null;
}): string[];
declare function findMatchedLoreKeywords(userText?: string, keywords?: string[]): string[];
declare function splitLoreChunks(content?: string): string[];
declare function truncateLoreText(text?: string, maxChars?: unknown): {
    text: string;
    truncated: boolean;
};
declare function selectLoreText(entry?: LoreEntry, matchedKeywords?: string[]): LoreSelection;
declare function routePersonaLore(options?: RoutePersonaLoreOptions): {
    ok: boolean;
    included: Record<string, unknown>[];
    omitted: Record<string, unknown>[];
    totalBudget: number;
    usedChars: number;
    remainingChars: number;
};
declare const _default: {
    DEFAULT_LORE_MAX_CHARS: number;
    DEFAULT_TOTAL_LORE_BUDGET: number;
    normalizeLoreText: typeof normalizeLoreText;
    normalizeLoreId: typeof normalizeLoreId;
    normalizeLoreScope: typeof normalizeLoreScope;
    normalizeLoreMaxChars: typeof normalizeLoreMaxChars;
    normalizeLorePriority: typeof normalizeLorePriority;
    normalizeLoreKeywords: typeof normalizeLoreKeywords;
    getLegacyLoreKeywords: typeof getLegacyLoreKeywords;
    normalizeLoreEntry: typeof normalizeLoreEntry;
    resolvePersonaLoreIds: typeof resolvePersonaLoreIds;
    findMatchedLoreKeywords: typeof findMatchedLoreKeywords;
    splitLoreChunks: typeof splitLoreChunks;
    truncateLoreText: typeof truncateLoreText;
    selectLoreText: typeof selectLoreText;
    routePersonaLore: typeof routePersonaLore;
};
export = _default;
