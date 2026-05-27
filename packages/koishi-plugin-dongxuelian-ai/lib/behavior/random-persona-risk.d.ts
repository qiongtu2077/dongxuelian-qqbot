interface PersonaResolution {
    source?: string;
    name?: string;
}
declare function getGroupPersonaName(channelKey: string): string;
declare function isPersonaSwitchRisky(personaResolution: PersonaResolution | null | undefined, groupPersonaName: string): boolean;
declare const _default: {
    getGroupPersonaName: typeof getGroupPersonaName;
    isPersonaSwitchRisky: typeof isPersonaSwitchRisky;
};
export = _default;
