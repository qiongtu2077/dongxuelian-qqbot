"use strict";
/** 日报输入收集：按提交窗口扫描原始索引，统计全窗口并选择最新分析消息。 */
const { parseBoundedInt: parsePositiveInt } = require('./config-utils');
const { loadManagementModule } = require('koishi-plugin-dongxuelian-ai/lib/public/management-runtime');
const { getShanghaiHourFromTs, formatShanghaiTime24h } = loadManagementModule('core.utils');
const { createReportPeriod, isTimestampInReportPeriod } = loadManagementModule('daily.reportPeriod');
const { readReportRecords } = loadManagementModule('daily.reportRecords');
const MAX_ANALYSIS_MESSAGES = parsePositiveInt(process.env.DAILY_REPORT_MAX_ANALYSIS_MESSAGES, 4000, 200, 10000);
const EMOJI_PATTERNS = [/\[CQ:(?:face|mface)\b[^\]]*\]/gi, /<(?:face|mface)\b[^>]*\/?>/gi, /【QQ表情[^】]*】/g, /\p{Extended_Pictographic}/gu];
// --- 消息与统计 ---
// 保留旧显示时间字符串的小时解析；业务日期只能由明确时间戳判断。
function hourFromLegacyTimeString(timeStr) {
    if (typeof timeStr !== 'string')
        return NaN;
    const match = timeStr.trim().match(/^(\d{1,2}):(\d{2})/);
    if (!match)
        return NaN;
    let hour = Number(match[1]);
    const suffix = timeStr.slice(match[0].length).toUpperCase();
    if (suffix.includes('PM') && hour < 12)
        hour += 12;
    if (suffix.includes('AM') && hour === 12)
        hour = 0;
    return hour >= 0 && hour < 24 ? hour : NaN;
}
// 计算消息北京时间小时，原始输入有时间戳时不依赖显示字符串。
function messageHourShanghai(message) {
    if (typeof message?.ts === 'number' && Number.isFinite(message.ts))
        return getShanghaiHourFromTs(message.ts);
    return hourFromLegacyTimeString(message?.time);
}
// 检查测试或直接调用提供的日期与四点业务日是否一致。
function isMessageInReportDay(message, reportDate, cutoffMs = Date.now()) {
    const period = createReportPeriod(cutoffMs);
    return period.reportDate === reportDate && isTimestampInReportPeriod(Number(message?.ts), period);
}
// 统计现有可读 QQ 表情、协议表情和 Unicode 表情数量。
function countEmojiInContent(content) {
    const text = String(content || '');
    let count = 0;
    for (const pattern of EMOJI_PATTERNS) {
        pattern.lastIndex = 0;
        count += (text.match(pattern) || []).length;
    }
    return count;
}
// 把已收录正文和已知媒体提示转成模型输入，不额外触发下载或识图。
function sourceRecordToMessage(record) {
    const mediaText = record.media.map(item => item.type === 'voice' ? '【已收录语音提示】' : item.type === 'message_record' ? '【已收录转发消息提示】' : '【已收录媒体提示】').join('');
    return { messageId: record.messageId, ts: record.timestamp, time: formatShanghaiTime24h(record.timestamp), user: record.userName || '群友', userId: record.userId, content: record.text + mediaText };
}
// 建立只保存数值与成员汇总的统计状态，正文候选由读取器有界保留。
function createReportStats() {
    return { totalMessages: 0, emojiCount: 0, totalChars: 0, hourlyActivity: new Array(24).fill(0), members: new Map() };
}
// 累积窗口统计；乱序写入时按真实时间维护成员首次与末次发言。
function accumulateMessage(stats, message) {
    stats.totalMessages += 1;
    stats.emojiCount += countEmojiInContent(message.content);
    stats.totalChars += String(message.content || '').replace(/\[CQ:[^\]]+\]/g, '').replace(/<(?:face|mface)\b[^>]*\/?>/gi, '').replace(/https?:\/\/\S+/g, '').replace(/【[^】]*】/g, '').trim().length;
    const hour = messageHourShanghai(message);
    if (Number.isInteger(hour) && hour >= 0 && hour < 24)
        stats.hourlyActivity[hour] += 1;
    const uid = message.userId || message.user || 'unknown';
    const ts = Number(message.ts);
    let member = stats.members.get(uid);
    if (!member) {
        member = { userId: uid, name: message.user || '群友', msgCount: 0, firstMsg: message.time, lastMsg: message.time, firstTs: ts, lastTs: ts };
        stats.members.set(uid, member);
    }
    member.msgCount += 1;
    if (ts < member.firstTs) {
        member.firstTs = ts;
        member.firstMsg = message.time;
    }
    if (ts >= member.lastTs) {
        member.lastTs = ts;
        member.lastMsg = message.time;
        member.name = message.user || member.name;
    }
}
// 将全窗口统计与独立入选记录组合成同一份日报数据。
function finishReportData(stats, period, messages, sourceCompleteness) {
    if (!stats.totalMessages)
        return null;
    const topMembers = [...stats.members.values()].sort((a, b) => b.msgCount - a.msgCount).slice(0, 20).map(({ firstTs, lastTs, ...member }) => member);
    const peak = stats.hourlyActivity.indexOf(Math.max(...stats.hourlyActivity));
    const prefix = String(peak).padStart(2, '0');
    return {
        date: period.reportDate, reportPeriod: period, totalMessages: stats.totalMessages, activeMembers: stats.members.size,
        emojiCount: stats.emojiCount, totalChars: stats.totalChars, hourlyActivity: stats.hourlyActivity, peakHour: `${prefix}:00-${prefix}:59`, topMembers,
        messages, analysisMessages: messages, sampledMessages: messages.length, truncatedMessages: stats.totalMessages - messages.length,
        windowMessageCount: stats.totalMessages, selectedMessageCount: messages.length, excludedByLimitCount: stats.totalMessages - messages.length, sourceCompleteness,
    };
}
// --- 固定窗口入口 ---
// 扫描两份自然日原始索引；预计算文本不再作为日报话题分析输入。
function collectReportData(channelKey, period = createReportPeriod(Date.now())) {
    const stats = createReportStats();
    const result = readReportRecords(String(channelKey), period, { maxMessages: MAX_ANALYSIS_MESSAGES, onRecord: record => accumulateMessage(stats, sourceRecordToMessage(record)) });
    const messages = result.records.map(record => ({ ...sourceRecordToMessage(record), analysisId: record.analysisId }));
    return finishReportData(stats, period, messages, result.sourceCompleteness);
}
// 对已提供的消息使用相同四点窗口、稳定排序和末尾上限，供行为测试与明确调用方使用。
function processMessages(messages, reportDate, cutoffMs = Date.now()) {
    const period = createReportPeriod(cutoffMs);
    if (period.reportDate !== reportDate)
        throw new Error('日报日期与发起时间不一致');
    const stats = createReportStats();
    const seen = new Set();
    const valid = messages.filter(message => {
        if (!isTimestampInReportPeriod(Number(message.ts), period))
            return false;
        if (message.messageId && seen.has(message.messageId))
            return false;
        if (message.messageId)
            seen.add(message.messageId);
        return true;
    }).map((message, order) => ({ message, order })).sort((a, b) => Number(a.message.ts) - Number(b.message.ts) || a.order - b.order).map(item => item.message);
    for (const message of valid)
        accumulateMessage(stats, message);
    const selected = valid.slice(-MAX_ANALYSIS_MESSAGES).map((message, index) => ({ ...message, analysisId: index + 1 }));
    return finishReportData(stats, period, selected, 'legacy_unknown');
}
module.exports = { collectReportData, processMessages, messageHourShanghai, isMessageInReportDay, countEmojiInContent };
