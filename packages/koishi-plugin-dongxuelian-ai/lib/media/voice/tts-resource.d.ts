interface VoiceTtsLogger {
    warn(message: string): void;
}
interface VoiceTtsGateOptions<T> {
    taskId?: string;
    source?: string;
    owner?: string;
    channelKey?: string;
    userId?: string;
    context?: string;
    priority?: number;
    waitTimeoutMs?: number;
    runTimeoutMs?: number;
    logger?: VoiceTtsLogger | null;
    run: () => Promise<T>;
}
interface VoiceTtsGateResult<T> {
    ok: boolean;
    value?: T;
    decision: string;
    reason: string;
    resourceState?: string;
    botMode?: string;
}
declare function buildVoiceTtsTaskId(input: VoiceTtsGateOptions<unknown>): string;
declare function runVoiceTtsWithResourceGate<T>(options: VoiceTtsGateOptions<T>): Promise<VoiceTtsGateResult<T>>;
declare const _default: {
    VOICE_TTS_TASK_KIND: string;
    buildVoiceTtsTaskId: typeof buildVoiceTtsTaskId;
    runVoiceTtsWithResourceGate: typeof runVoiceTtsWithResourceGate;
};
export = _default;
