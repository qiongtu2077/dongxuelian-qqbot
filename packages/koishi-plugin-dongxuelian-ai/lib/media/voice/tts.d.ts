interface TtsFailure {
    code: string;
    message: string;
    status?: number;
    model?: string;
    declaredMime?: string;
    bytes?: number;
    [key: string]: unknown;
}
interface TtsDiagnostics {
    lastError?: TtsFailure;
    lastSend?: Record<string, unknown>;
}
interface TtsLogger {
    warn(message: string): void;
}
interface TtsOptions {
    voice?: string;
    style?: unknown;
    diagnostics?: TtsDiagnostics;
    onDiagnostic?: (failure: TtsFailure) => void;
    logger?: TtsLogger;
    context?: string;
    tempFileTtlMs?: number;
    plan?: PersonaRuntimePlanLike;
}
interface PersonaRuntimePlanLike {
    name?: string | null;
    voice?: {
        rawId?: string;
        assetId?: string;
        style?: string;
    };
}
interface ResolvedPersonaVoice {
    voice: string;
    style: string;
}
interface AudioBufferWithMime extends Buffer {
    mimeType?: string;
}
interface TtsSessionLike {
    send(content: unknown): unknown | Promise<unknown>;
}
declare function getMimoriumKey(): Promise<string>;
declare function sanitizeTtsStyle(value: unknown, fallback?: string): string;
declare function composeTtsStyle(baseStyle: unknown, temporaryStyle: unknown): string;
declare function detectAudioMime(buffer: unknown): string;
declare function synthesizeSpeech(text: unknown, options?: TtsOptions): Promise<AudioBufferWithMime | null>;
declare function sendVoiceMessage(session: TtsSessionLike, audioBuf: AudioBufferWithMime | Buffer | null | undefined, options?: TtsOptions): Promise<boolean>;
declare function resolvePersonaVoice(personaName: unknown, options?: TtsOptions): ResolvedPersonaVoice;
declare function extractVoiceStyle(replyText: unknown): string | null;
declare function stripVoiceStyleTag(text: unknown): string;
declare function getBuiltinVoices(): string[];
declare function isChannelOnCooldown(channelKey: string): boolean;
declare function markChannelCooldown(channelKey: string): void;
declare function shouldTriggerRandomVoice(channelKey: string, randomFn?: () => number): boolean;
declare const _default: {
    synthesizeSpeech: typeof synthesizeSpeech;
    sendVoiceMessage: typeof sendVoiceMessage;
    resolvePersonaVoice: typeof resolvePersonaVoice;
    sanitizeTtsStyle: typeof sanitizeTtsStyle;
    composeTtsStyle: typeof composeTtsStyle;
    extractVoiceStyle: typeof extractVoiceStyle;
    stripVoiceStyleTag: typeof stripVoiceStyleTag;
    getBuiltinVoices: typeof getBuiltinVoices;
    isChannelOnCooldown: typeof isChannelOnCooldown;
    markChannelCooldown: typeof markChannelCooldown;
    shouldTriggerRandomVoice: typeof shouldTriggerRandomVoice;
    getMimoriumKey: typeof getMimoriumKey;
    detectAudioMime: typeof detectAudioMime;
    getRandomVoiceRate: (channelKey: string) => number;
    BUILTIN_VOICES: string[];
    DEFAULT_VOICE: string;
    NEUTRAL_TTS_STYLE: string;
    MAX_TTS_TEXT_LENGTH: number;
    MAX_TTS_STYLE_LENGTH: number;
    RANDOM_VOICE_RATE: number;
    CHANNEL_COOLDOWN_MS: number;
};
export = _default;
