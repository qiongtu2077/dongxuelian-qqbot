interface SkillHubBaseItem {
    name: string;
    kind: string;
    description?: string;
}
type SkillHubItem = SkillHubBaseItem & {
    enabled: boolean;
};
declare function listSkillHubItems(query?: unknown): SkillHubItem[];
declare function findSkillHubItem(name: unknown): SkillHubBaseItem | null;
declare function setSkillHubEnabled(name: unknown, enabled: unknown): Promise<SkillHubItem>;
declare function formatSkillHubItems(items?: SkillHubItem[]): string;
declare const _default: {
    listSkillHubItems: typeof listSkillHubItems;
    findSkillHubItem: typeof findSkillHubItem;
    setSkillHubEnabled: typeof setSkillHubEnabled;
    formatSkillHubItems: typeof formatSkillHubItems;
};
export = _default;
