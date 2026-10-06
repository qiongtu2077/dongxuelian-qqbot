declare const createReportPeriod: typeof import("koishi-plugin-dongxuelian-ai/lib/daily-precompute/report-period").createReportPeriod;
type ReportPeriod = ReturnType<typeof createReportPeriod>;
interface ReportMessage {
    analysisId?: number;
    messageId?: string;
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
    reportPeriod: ReportPeriod;
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
    windowMessageCount: number;
    selectedMessageCount: number;
    excludedByLimitCount: number;
    sourceCompleteness: 'complete' | 'incomplete' | 'legacy_unknown';
}
declare function messageHourShanghai(message: ReportMessage | null | undefined): number;
declare function isMessageInReportDay(message: ReportMessage | null | undefined, reportDate: string, cutoffMs?: number): boolean;
declare function countEmojiInContent(content: unknown): number;
declare function collectReportData(channelKey: unknown, period?: ReportPeriod): ReportData | null;
declare function processMessages(messages: ReportMessage[], reportDate: string, cutoffMs?: number): ReportData | null;
declare const _default: {
    collectReportData: typeof collectReportData;
    processMessages: typeof processMessages;
    messageHourShanghai: typeof messageHourShanghai;
    isMessageInReportDay: typeof isMessageInReportDay;
    countEmojiInContent: typeof countEmojiInContent;
};
export = _default;
