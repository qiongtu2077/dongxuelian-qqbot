interface PersonaGroupEntry {
    persona?: string;
    [key: string]: unknown;
}
interface PersonaMeta {
    name?: unknown;
    description?: unknown;
    [key: string]: unknown;
}
interface AvailablePersona {
    name: unknown;
    description: unknown;
    file: string;
    type: string;
    dir: string;
}
type PersonaGroupsCache = Record<string, PersonaGroupEntry>;
type PersonaUsersCache = Record<string, string>;
declare function atomicWriteJson(filePath: string, data: unknown): void;
declare function loadPersonaGroups(): void;
declare function getGroupPersona(channelKey: string): PersonaGroupEntry | null;
declare function setGroupPersona(channelKey: string, personaName: string | undefined): void;
declare function resetGroupPersona(channelKey: string): void;
declare function loadPersonaUsers(): void;
declare function getUserPersona(userId: string): string | null;
declare function setUserPersona(userId: string, personaName: string): void;
declare function resetUserPersona(userId: string): void;
declare function resolvePersona(channelKey: string, userId: string): {
    source: string;
    name: string | null;
};
declare function parsePersonaFrontmatter(content: string): PersonaMeta;
declare function getAvailablePersonals({ userFacing }?: {
    userFacing?: boolean;
}): AvailablePersona[];
declare function loadPersonalSkill(personaName: string): string | null;
declare const _default: {
    personaGroupsCache: PersonaGroupsCache;
    personaUsersCache: PersonaUsersCache;
    atomicWriteJson: typeof atomicWriteJson;
    loadPersonaGroups: typeof loadPersonaGroups;
    getGroupPersona: typeof getGroupPersona;
    setGroupPersona: typeof setGroupPersona;
    resetGroupPersona: typeof resetGroupPersona;
    loadPersonaUsers: typeof loadPersonaUsers;
    getUserPersona: typeof getUserPersona;
    setUserPersona: typeof setUserPersona;
    resetUserPersona: typeof resetUserPersona;
    resolvePersona: typeof resolvePersona;
    parsePersonaFrontmatter: typeof parsePersonaFrontmatter;
    getAvailablePersonals: typeof getAvailablePersonals;
    loadPersonalSkill: typeof loadPersonalSkill;
};
export = _default;
