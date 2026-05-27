interface VoiceFileInfo {
    filename: string;
    filePath: string;
    size: number;
    mtime: number;
    mimeType: string;
    missing: boolean;
}
interface VoiceAsset {
    id: string;
    personaName: string;
    displayName: string;
    description: string;
    filename: string;
    mimeType: string;
    size: number;
    mtime: number;
    sampleText: string;
    createdAt: string;
    updatedAt: string;
    missing: boolean;
}
interface PersonaVoiceConfig {
    name?: string;
    voice?: string;
    voiceAssetId?: string;
}
interface DeleteVoiceAssetResult {
    asset: VoiceAsset;
    deleted: string[];
}
declare function sanitizeVoiceAssetId(value?: unknown): string;
declare function getAudioExtFromMime(mimeType?: unknown): string;
declare function getAudioMimeFromFilename(filename: unknown, fallback?: string): string;
declare function createVoiceAssetId(personaName?: unknown, existingAssets?: VoiceAsset[] | null): string;
declare function buildVoiceAssetFilename(assetId: unknown, mimeType?: unknown): string;
declare function listVoiceAssets(personaConfigs?: PersonaVoiceConfig[]): VoiceAsset[];
declare function findVoiceAsset(assetIdOrName: unknown, personaConfigs?: PersonaVoiceConfig[]): VoiceAsset | null;
declare function upsertVoiceAsset(meta?: Record<string, unknown>): VoiceAsset;
declare function listVoiceAssetReferences(assetOrId: VoiceAsset | unknown, personaConfigs?: PersonaVoiceConfig[]): string[];
declare function updateVoiceAssetMetadata(assetIdOrName: unknown, patch?: Record<string, unknown>, personaConfigs?: PersonaVoiceConfig[]): VoiceAsset | null;
declare function deleteVoiceAsset(assetIdOrName: unknown, personaConfigs?: PersonaVoiceConfig[]): DeleteVoiceAssetResult | null;
declare function resolveVoiceSampleFile(personaName: unknown, voiceAssetId?: unknown): (VoiceAsset & VoiceFileInfo) | null;
declare const _default: {
    sanitizeVoiceAssetId: typeof sanitizeVoiceAssetId;
    createVoiceAssetId: typeof createVoiceAssetId;
    buildVoiceAssetFilename: typeof buildVoiceAssetFilename;
    getAudioExtFromMime: typeof getAudioExtFromMime;
    getAudioMimeFromFilename: typeof getAudioMimeFromFilename;
    listVoiceAssets: typeof listVoiceAssets;
    findVoiceAsset: typeof findVoiceAsset;
    listVoiceAssetReferences: typeof listVoiceAssetReferences;
    upsertVoiceAsset: typeof upsertVoiceAsset;
    updateVoiceAssetMetadata: typeof updateVoiceAssetMetadata;
    deleteVoiceAsset: typeof deleteVoiceAsset;
    resolveVoiceSampleFile: typeof resolveVoiceSampleFile;
    DEFAULT_SAMPLE_TEXT: string;
    MAX_VOICE_SAMPLE_BYTES: number;
    MIN_VOICE_SAMPLE_BYTES: number;
};
export = _default;
