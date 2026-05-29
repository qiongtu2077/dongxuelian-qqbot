interface LoggerLike {
    info(...args: unknown[]): void;
    warn(...args: unknown[]): void;
    error(...args: unknown[]): void;
}
interface DailyReportContextLike {
    on(event: 'ready', handler: () => unknown): unknown;
    middleware(handler: (session: DailyReportSessionLike, next: () => unknown) => unknown): unknown;
    logger(name: string): LoggerLike;
}
interface DailyReportSessionLike {
    content?: string;
    guildId?: string | number;
    channelId?: string | number;
    send(message: unknown): Promise<unknown>;
}
declare function trimRuntimeMaps(now?: number): void;
declare function safeSendDailyReport(ctx: DailyReportContextLike, session: DailyReportSessionLike, message: unknown, label?: string): Promise<boolean>;
declare function apply(ctx: DailyReportContextLike): void;
declare const _default: {
    name: string;
    apply: typeof apply;
    _test: {
        cooldown: Map<string | number, number>;
        failureBackoff: Map<string | number, number>;
        inFlightReports: Map<string | number, number>;
        trimRuntimeMaps: typeof trimRuntimeMaps;
        safeSendDailyReport: typeof safeSendDailyReport;
    };
};
export = _default;
