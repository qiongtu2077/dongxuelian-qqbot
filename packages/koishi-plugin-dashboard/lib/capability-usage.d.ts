/**
 * MODULE: 按能力和日期区间聚合模型用量。
 * 职责: 校验北京时间日期边界，同步汇总每日、供应商和模型统计。
 * 边界: 纯数据计算，不读写文件，不推断无能力标识的历史记录。
 */
export interface UsageStat {
    key: string;
    label: string;
    provider?: string;
    total: number;
    requests: number;
    input: number;
    output: number;
    cacheCreation: number;
    cacheRead: number;
    readableRequests: number;
    unreadableRequests: number;
}
export interface UsageDateQuery {
    startDate?: string | null;
    endDate?: string | null;
}
export declare function isUsageDate(value: string): boolean;
export declare function aggregateCapabilityUsage(root: Record<string, unknown>, capability: string, query?: UsageDateQuery): {
    capability: string;
    range: {
        startDate: string;
        endDate: string;
        timeZone: string;
    };
    summary: UsageStat;
    days: {
        providers: Record<string, UsageStat>;
        models: Record<string, UsageStat>;
        key: string;
        label: string;
        provider?: string;
        total: number;
        requests: number;
        input: number;
        output: number;
        cacheCreation: number;
        cacheRead: number;
        readableRequests: number;
        unreadableRequests: number;
        date: string;
    }[];
    availableRange: {
        startDate: string;
        endDate: string;
    } | null;
    providers: UsageStat[];
    models: UsageStat[];
    readable: boolean;
    unavailable: boolean;
};
