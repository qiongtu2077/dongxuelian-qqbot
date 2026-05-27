interface RepeatSession {
    isDirect?: boolean;
    content?: string;
    event?: {
        message?: unknown[] | {
            elements?: unknown[];
            content?: unknown[];
        };
    };
}
interface RepeatCandidate {
    key: string;
    reply: string;
    kind: string;
    supported: boolean;
    reason?: string;
}
interface RepeatAnalysis {
    hasFile?: boolean;
    hasEmbed?: boolean;
    hasMessageRecordCue?: boolean;
    hasVisual?: boolean;
}
declare function loadRepeatConfig(): void;
declare function getRepeatEnabledCache(): Record<string, boolean>;
declare function clearRepeatState(channelKey: string): void;
declare function pruneRepeatState(now?: number): void;
declare function getRepeatStateSize(): number;
declare function setRepeatEnabled(channelKey: string, enabled: boolean): void;
declare function buildRepeatCandidate(session: RepeatSession, plain: string, analyzed?: RepeatAnalysis): RepeatCandidate;
declare function checkGroupRepeat(session: RepeatSession, candidate: RepeatCandidate | null | undefined, channelKey: string, currentUserId: string, now?: number): RepeatCandidate | null;
declare const _default: {
    loadRepeatConfig: typeof loadRepeatConfig;
    setRepeatEnabled: typeof setRepeatEnabled;
    getRepeatEnabledCache: typeof getRepeatEnabledCache;
    clearRepeatState: typeof clearRepeatState;
    pruneRepeatState: typeof pruneRepeatState;
    getRepeatStateSize: typeof getRepeatStateSize;
    buildRepeatCandidate: typeof buildRepeatCandidate;
    checkGroupRepeat: typeof checkGroupRepeat;
};
export = _default;
