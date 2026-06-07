interface VoiceEntry {
    url: string;
    file: string | null;
    conversationKey: string;
    userId: string;
    ts: number;
    transcribed: boolean;
    transcript: string | null;
    transcriptionStatus: string;
}
interface StoreVoiceMeta {
    url?: unknown;
    file?: unknown;
    conversationKey?: unknown;
    userId?: unknown;
}
declare function storeVoice(channelKey: string, messageId: string, meta?: StoreVoiceMeta): Promise<boolean>;
declare function getVoiceEntry(channelKey: string, messageId: string): Promise<VoiceEntry | null>;
declare function getCachedTranscript(channelKey: string, messageId: string): Promise<string | null>;
declare function markVoiceTranscribed(channelKey: string, messageId: string, transcript: unknown): Promise<boolean>;
declare function markVoiceTranscriptionUnavailable(channelKey: string, messageId: string, status?: unknown): Promise<boolean>;
declare const _default: {
    VOICE_HISTORY_DIR: string;
    storeVoice: typeof storeVoice;
    getVoiceEntry: typeof getVoiceEntry;
    getCachedTranscript: typeof getCachedTranscript;
    markVoiceTranscribed: typeof markVoiceTranscribed;
    markVoiceTranscriptionUnavailable: typeof markVoiceTranscriptionUnavailable;
};
export = _default;
