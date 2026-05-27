declare function normalizeVoiceRate(value: unknown): number | null;
declare function loadRandomVoiceRateCache(): Promise<Map<string, number>>;
declare function getRandomVoiceRate(channelKey: string): number;
declare function setRandomVoiceRate(channelKey: string, rate: unknown): Promise<boolean>;
declare function resetRandomVoiceRate(channelKey: string): Promise<boolean>;
declare function shouldTriggerRandomVoiceByRate(channelKey: string, randomFn?: () => number): boolean;
declare const _default: {
    DEFAULT_RANDOM_VOICE_RATE: number;
    normalizeVoiceRate: typeof normalizeVoiceRate;
    loadRandomVoiceRateCache: typeof loadRandomVoiceRateCache;
    getRandomVoiceRate: typeof getRandomVoiceRate;
    setRandomVoiceRate: typeof setRandomVoiceRate;
    resetRandomVoiceRate: typeof resetRandomVoiceRate;
    shouldTriggerRandomVoiceByRate: typeof shouldTriggerRandomVoiceByRate;
};
export = _default;
