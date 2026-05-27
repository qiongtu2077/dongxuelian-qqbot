/** 判断本次罕见触发是否走固定语音分支。 */
declare function shouldTriggerRareVoice(meta?: {
    rareConfirmed?: boolean;
}, random?: () => number): boolean;
/** 找到固定语音 MP4；优先固定文件名，否则使用资源目录里唯一的 MP4。 */
declare function resolveRareVoiceSource(): string | null;
/** 准备可发送的固定语音 WAV 缓存路径。 */
declare function prepareRareVoiceWav(): Promise<string | null>;
/** 读取可发送的罕见固定语音 Buffer；失败时返回 null 交给文字回复回退。 */
declare function readRareVoiceAudioBuffer(): Promise<Buffer | null>;
declare const _default: {
    shouldTriggerRareVoice: typeof shouldTriggerRareVoice;
    readRareVoiceAudioBuffer: typeof readRareVoiceAudioBuffer;
    resolveRareVoiceSource: typeof resolveRareVoiceSource;
    prepareRareVoiceWav: typeof prepareRareVoiceWav;
    RARE_VOICE_RATE: number;
    RARE_VOICE_ASSET_DIR: string;
    RARE_VOICE_PREFERRED_FILE: string;
    RARE_VOICE_WAV_CACHE: string;
    MAX_RARE_VOICE_WAV_BYTES: number;
};
export = _default;
