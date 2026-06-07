interface ReportMessage {
    time?: string;
    ts?: number;
    user?: string;
    userId?: string | number;
    content?: string;
}
interface TopMember {
    userId: string | number;
    name: string;
    msgCount: number;
    firstMsg?: string;
    lastMsg?: string;
}
interface ReportData {
    date: string;
    totalMessages: number;
    activeMembers: number;
    emojiCount: number;
    totalChars: number;
    hourlyActivity: number[];
    peakHour: string;
    topMembers: TopMember[];
    messages: ReportMessage[];
    analysisMessages: ReportMessage[];
    sampledMessages: number;
    truncatedMessages: number;
    precomputedContext?: string;
    precomputedCoverageRate?: number;
}
/** 判断消息时间戳是否属于本次日报日期，且不晚于当前生成时刻。 */
declare function isMessageInReportDay(msg: ReportMessage | null | undefined, today: string, now?: number): boolean;
declare function messageHourShanghai(msg: ReportMessage | null | undefined): number;
declare function collectReportData(channelKey: unknown): ReportData | null;
declare function buildPrecomputedContext(finalInput: Record<string, unknown> | null): string;
/** 统计 CQ、XML、可读 QQ 表情标记和 Unicode emoji 数量。 */
declare function countEmojiInContent(content: unknown): number;
declare function processMessages(messages: ReportMessage[], today: string, now?: number): ReportData | null;
declare const _default: {
    collectReportData: typeof collectReportData;
    processMessages: typeof processMessages;
    messageHourShanghai: typeof messageHourShanghai;
    isMessageInReportDay: typeof isMessageInReportDay;
    countEmojiInContent: typeof countEmojiInContent;
    buildPrecomputedContext: typeof buildPrecomputedContext;
};
export = _default;
