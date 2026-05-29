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
}
declare function messageHourShanghai(msg: ReportMessage | null | undefined): number;
declare function collectReportData(channelKey: unknown): ReportData | null;
declare function processMessages(messages: ReportMessage[], today: string): ReportData | null;
declare const _default: {
    collectReportData: typeof collectReportData;
    processMessages: typeof processMessages;
    messageHourShanghai: typeof messageHourShanghai;
};
export = _default;
