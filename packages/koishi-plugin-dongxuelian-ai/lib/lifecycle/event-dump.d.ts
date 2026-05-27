interface EventDumpSession {
    platform?: string;
    type?: string;
    subtype?: string;
    selfId?: string;
    userId?: string;
    channelId?: string;
    guildId?: string;
    messageId?: string;
    content?: string;
    author?: unknown;
    quote?: unknown;
    event?: unknown;
}
interface ArmedEventDumpState {
    armedAt: number;
    armedBy: string;
}
declare function getArmedEventDump(channelKey?: string): ArmedEventDumpState | null;
declare function armEventDump(session: EventDumpSession): ArmedEventDumpState;
declare function clearArmedEventDump(channelKey?: string): void;
declare function dumpSessionEvent(session: EventDumpSession, analyzed: unknown, plain: unknown, memoryText: unknown): Promise<string>;
declare const _default: {
    getArmedEventDump: typeof getArmedEventDump;
    armEventDump: typeof armEventDump;
    clearArmedEventDump: typeof clearArmedEventDump;
    dumpSessionEvent: typeof dumpSessionEvent;
};
export = _default;
