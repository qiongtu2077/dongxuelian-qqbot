type ProfileRecord = Record<string, unknown>;
declare function sanitizePersonaProfileKey(value?: unknown): string;
declare function safePersonaProfileFile(userId: string, channelKey: string, rootDir?: string): string;
declare function readLegacyPersonaProfileData({ userId, channelKey, rootDir }?: {
    userId?: string;
    channelKey?: string;
    rootDir?: string;
}): Promise<ProfileRecord | null>;
declare const _default: {
    MAX_PROFILE_SOURCE_FILE_BYTES: number;
    sanitizePersonaProfileKey: typeof sanitizePersonaProfileKey;
    safePersonaProfileFile: typeof safePersonaProfileFile;
    readLegacyPersonaProfileData: typeof readLegacyPersonaProfileData;
};
export = _default;
