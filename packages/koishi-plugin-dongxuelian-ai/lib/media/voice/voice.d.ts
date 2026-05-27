interface VoiceSegment {
    type?: string;
    data?: {
        url?: unknown;
        file?: unknown;
    };
}
interface VoiceSessionLike {
    content?: string;
    messageId?: string | number;
    event?: {
        message?: VoiceSegment[];
    };
}
interface VoicePayload {
    url: string;
    file: string | null;
}
interface VoiceConfig {
    apiKey: string;
    model?: string;
    provider?: string;
    baseURL?: string;
    [key: string]: unknown;
}
declare function extractVoicePayload(session: VoiceSessionLike | null | undefined): VoicePayload | null;
declare function downloadVoiceFile(url: string, destPath: string): Promise<string | null>;
declare function convertToWav(srcPath: string): Promise<string | null>;
declare function callModelAsr(wavPath: string, config: VoiceConfig): Promise<string>;
declare function transcribeVoice(session: VoiceSessionLike | null | undefined, config: VoiceConfig): Promise<string | null>;
declare const _default: {
    extractVoicePayload: typeof extractVoicePayload;
    downloadVoiceFile: typeof downloadVoiceFile;
    convertToWav: typeof convertToWav;
    callModelAsr: typeof callModelAsr;
    transcribeVoice: typeof transcribeVoice;
};
export = _default;
