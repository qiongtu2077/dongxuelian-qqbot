"use strict";
/**
 * MODULE: 按能力和日期区间聚合模型用量。
 * 职责: 校验北京时间日期边界，同步汇总每日、供应商和模型统计。
 * 边界: 纯数据计算，不读写文件，不推断无能力标识的历史记录。
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.isUsageDate = isUsageDate;
exports.aggregateCapabilityUsage = aggregateCapabilityUsage;
const STAT_FIELDS = ['total', 'requests', 'input', 'output', 'cacheCreation', 'cacheRead', 'readableRequests', 'unreadableRequests'];
// --- 日期边界 ---
// 严格检查公历日期，拒绝自动进位后的无效日期和时间字符串。
function isUsageDate(value) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith('0000'))
        return false;
    const date = new Date(value + 'T00:00:00.000Z');
    return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
// 返回与用量写入端一致的北京时间日期。
function todayShanghai() {
    return new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
}
// 将可选起止日期解析为闭区间；不指定时查询全部已有记录。
function resolveDateRange(query, dates) {
    const hasStart = query.startDate !== undefined && query.startDate !== null;
    const hasEnd = query.endDate !== undefined && query.endDate !== null;
    if (hasStart !== hasEnd)
        throw new Error('请同时提供开始日期和结束日期');
    if (hasStart && (!isUsageDate(query.startDate) || !isUsageDate(query.endDate)))
        throw new Error('日期格式必须为有效的 YYYY-MM-DD');
    const startDate = hasStart ? query.startDate : dates[0] || todayShanghai();
    const endDate = hasEnd ? query.endDate : dates[dates.length - 1] || todayShanghai();
    if (startDate > endDate)
        throw new Error('开始日期不能晚于结束日期');
    return { startDate, endDate, timeZone: 'Asia/Shanghai' };
}
// --- 统计聚合 ---
// 判断持久化节点是否为统计对象。
function isStatObject(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}
// 创建一个可累计的用量统计行。
function createUsageStat(key) {
    return { key, label: key, total: 0, requests: 0, input: 0, output: 0, cacheCreation: 0, cacheRead: 0, readableRequests: 0, unreadableRequests: 0 };
}
// 将持久化数值累加到目标行，零 Token 请求仍保留可读性标记。
function addUsageStat(target, source) {
    for (const field of STAT_FIELDS) {
        const value = Number(source[field] || 0);
        if (Number.isFinite(value) && value > 0)
            target[field] += value;
    }
    if (typeof source.provider === 'string')
        target.provider = source.provider;
}
// 同时累计一个日期的分布节点与整个查询区间的分布，保证统计口径一致。
function aggregateDistribution(source, rows) {
    const dayRows = Object.create(null);
    if (!isStatObject(source))
        return dayRows;
    for (const [key, value] of Object.entries(source)) {
        if (!isStatObject(value))
            continue;
        const dayRow = createUsageStat(key);
        addUsageStat(dayRow, value);
        dayRows[key] = dayRow;
        const row = rows.get(key) || createUsageStat(key);
        addUsageStat(row, value);
        rows.set(key, row);
    }
    return dayRows;
}
// 按同一日期闭区间聚合指定能力，保留空区间和不可读取 Token 的请求数。
function aggregateCapabilityUsage(root, capability, query = {}) {
    const sources = new Map();
    for (const date of Object.keys(root).sort()) {
        if (!isUsageDate(date))
            continue;
        const day = root[date];
        if (!isStatObject(day) || !isStatObject(day.capabilities))
            continue;
        const source = day.capabilities[capability];
        if (isStatObject(source))
            sources.set(date, source);
    }
    const dates = [...sources.keys()];
    const range = resolveDateRange(query, dates);
    const providers = new Map();
    const models = new Map();
    const summary = createUsageStat('summary');
    const days = [...sources].filter(([date]) => date >= range.startDate && date <= range.endDate).map(([date, source]) => {
        const total = createUsageStat(date);
        addUsageStat(total, source);
        addUsageStat(summary, source);
        return { date, ...total, providers: aggregateDistribution(source.providers, providers), models: aggregateDistribution(source.models, models) };
    });
    return {
        capability, range, summary, days,
        availableRange: dates.length ? { startDate: dates[0], endDate: dates[dates.length - 1] } : null,
        providers: [...providers.values()], models: [...models.values()],
        readable: summary.readableRequests > 0,
        unavailable: summary.unreadableRequests > 0 && summary.readableRequests === 0,
    };
}
