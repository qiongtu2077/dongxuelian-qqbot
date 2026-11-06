interface RareVoiceLogContext {
    logger(name: string): {
        info(message: string): void;
        warn(message: string): void;
    };
}
interface RareVoiceLogSession {
    guildId?: string;
    channelId?: string;
    userId?: string;
    messageId?: string;
    isDirect?: boolean;
    author?: {
        id?: string;
    };
}
interface RareVoiceEvent {
    stage: 'decision' | 'send_start' | 'send_skipped' | 'send_result';
    reason: string;
    route?: 'chat' | 'random' | 'delayed_random';
    rareConfirmed?: boolean | null;
    rate?: number;
    draw?: number | null;
    selected?: boolean;
    sent?: boolean;
    handled?: boolean;
    bytes?: number;
    elapsedMs?: number;
    messageIds?: string[];
    errorCode?: string;
    error?: string;
    gateDecision?: string;
    gateReason?: string;
}
declare function logRareVoiceEvent(ctx: RareVoiceLogContext, session: RareVoiceLogSession, event: RareVoiceEvent): void;
declare function shouldTriggerRareVoiceWithDiagnostics(ctx: RareVoiceLogContext, session: RareVoiceLogSession, meta?: {
    rareConfirmed?: boolean;
}, route?: NonNullable<RareVoiceEvent['route']>, random?: () => number): boolean;
declare const _default: {
    logRareVoiceEvent: typeof logRareVoiceEvent;
    shouldTriggerRareVoiceWithDiagnostics: typeof shouldTriggerRareVoiceWithDiagnostics;
};
export = _default;
