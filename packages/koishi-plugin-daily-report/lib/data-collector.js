"use strict";
/**
 * MODULE: 数据收集模块。
 * 职责: 读取今日缓存，计算统计数据。无缓存时返回null。
 */
const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('./config');
const { todayCst, getShanghaiHourFromTs, safeChannelKey } = require('../../koishi-plugin-dongxuelian-ai/lib/core/utils');
const MAX_CACHE_FILE_BYTES = parsePositiveInt(process.env.DAILY_REPORT_MAX_CACHE_FILE_BYTES, 8 * 1024 * 1024, 512 * 1024, 64 * 1024 * 1024);
const MAX_ANALYSIS_MESSAGES = parsePositiveInt(process.env.DAILY_REPORT_MAX_ANALYSIS_MESSAGES, 2000, 200, 10000);
const CQ_EMOJI_RE = /\[CQ:(?:face|mface)\b[^\]]*\]/gi;
const XML_EMOJI_RE = /<(?:face|mface)\b[^>]*\/?>/gi;
const TEXT_EMOJI_RE = /【QQ表情[^】]*】/g;
const UNICODE_EMOJI_RE = /\p{Extended_Pictographic}/gu;
function parsePositiveInt(value, fallback, min, max) {
    const parsed = parseInt(String(value), 10);
    if (!Number.isFinite(parsed))
        return fallback;
    return Math.max(min, Math.min(max, parsed));
}
/** 计算上海日历日边界，用于把 today-cache 中跨日恢复的消息过滤掉。 */
function getShanghaiDayBounds(today) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(today || '')))
        return null;
    const startMs = Date.parse(`${today}T00:00:00.000+08:00`);
    const endMs = Date.parse(`${today}T23:59:59.999+08:00`);
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs))
        return null;
    return { startMs, endMs };
}
/** 判断消息时间戳是否属于本次日报日期，且不晚于当前生成时刻。 */
function isMessageInReportDay(msg, today, now = Date.now()) {
    const ts = Number(msg && msg.ts);
    if (!Number.isFinite(ts) || ts <= 0)
        return false;
    const bounds = getShanghaiDayBounds(today);
    if (!bounds)
        return false;
    const cappedEnd = Math.min(bounds.endMs, Number.isFinite(now) ? now : Date.now());
    return ts >= bounds.startMs && ts <= cappedEnd;
}
/** 旧缓存 time 字符串解析为 0–23（尽力兼容 24h / 12h en-US） */
function hourFromLegacyTimeString(timeStr) {
    if (!timeStr || typeof timeStr !== 'string')
        return NaN;
    const s = timeStr.trim();
    const m24 = s.match(/^(\d{1,2}):(\d{2})/);
    if (!m24)
        return NaN;
    let h = parseInt(m24[1], 10);
    const rest = s.slice(m24[0].length).toUpperCase();
    if (rest.includes('PM') && h < 12)
        h += 12;
    if (rest.includes('AM') && h === 12)
        h = 0;
    if (h >= 0 && h < 24)
        return h;
    return NaN;
}
function messageHourShanghai(msg) {
    if (msg && typeof msg.ts === 'number' && Number.isFinite(msg.ts)) {
        const h = getShanghaiHourFromTs(msg.ts);
        if (!isNaN(h) && h >= 0 && h < 24)
            return h;
    }
    return hourFromLegacyTimeString(msg && msg.time);
}
function collectReportData(channelKey) {
    if (!DATA_DIR)
        return null;
    const rawKey = String(channelKey);
    const key = rawKey ? safeChannelKey(rawKey) : rawKey;
    const today = todayCst();
    const cacheFile = path.join(DATA_DIR, `today-cache-${key}.json`);
    let cache = null;
    try {
        const stat = fs.statSync(cacheFile);
        if (!stat.isFile() || stat.size > MAX_CACHE_FILE_BYTES)
            return null;
        const raw = fs.readFileSync(cacheFile, 'utf8');
        cache = JSON.parse(raw);
    }
    catch {
        return null;
    }
    if (!cache || !cache.messages || !Array.isArray(cache.messages) || cache.messages.length === 0) {
        return null;
    }
    const data = processMessages(cache.messages, today);
    if (!data)
        return null;
    attachPrecomputedContext(data, rawKey);
    return data;
}
// 动态读取 S3 final-input；不可用时保持日报旧路径。
function readPrecomputedFinalInput(date, channelKey) {
    try {
        const base = '../../koishi-plugin-dongxuelian-ai/lib';
        const merge = require(`${base}/daily-precompute/daily-summary-merge`);
        const status = require(`${base}/daily-precompute/precompute-status`);
        const generated = merge && typeof merge.mergeDailyFinalInput === 'function'
            ? merge.mergeDailyFinalInput(date, channelKey)
            : null;
        if (generated && typeof generated === 'object')
            return generated;
        if (status && typeof status.readDailyFinalInput === 'function')
            return status.readDailyFinalInput(date, channelKey);
    }
    catch {
        /* non-critical: S3 precompute is an optimization, today-cache remains authoritative fallback */
    }
    return null;
}
// 将 S3 final-input 压成日报 AI 可直接使用的短上下文。
function buildPrecomputedContext(finalInput) {
    if (!finalInput)
        return '';
    const lines = [];
    const slotCount = Number(finalInput.slotCount || 0);
    const totalMessages = Number(finalInput.totalMessages || 0);
    const coveredMessages = Number(finalInput.coveredMessages || 0);
    const coverageRate = Number(finalInput.coverageRate || 0);
    lines.push(`[S3预计算] slot=${slotCount}, total=${totalMessages}, covered=${coveredMessages}, coverage=${coverageRate}`);
    const keywords = Array.isArray(finalInput.keywords) ? finalInput.keywords.map(String).filter(Boolean).slice(0, 30) : [];
    if (keywords.length)
        lines.push(`关键词：${keywords.join('、')}`);
    const slots = Array.isArray(finalInput.slots) ? finalInput.slots.slice(0, 20) : [];
    if (slots.length) {
        lines.push('分片统计：');
        for (const raw of slots) {
            const slot = raw && typeof raw === 'object' ? raw : {};
            const stats = slot.stats && typeof slot.stats === 'object' ? slot.stats : {};
            const slotKeywords = Array.isArray(slot.keywords) ? slot.keywords.map(String).filter(Boolean).slice(0, 8).join('、') : '';
            lines.push(`- ${slot.slotId || 'slot'}：消息${slot.messageCount || 0}，活跃${stats.activeUsers || 0}，媒体${stats.mediaCount || 0}${slotKeywords ? `，关键词${slotKeywords}` : ''}`);
        }
    }
    const tail = Array.isArray(finalInput.uncoveredTail) ? finalInput.uncoveredTail.slice(-80) : [];
    if (tail.length) {
        lines.push('未覆盖尾部消息：');
        for (const raw of tail) {
            const msg = raw && typeof raw === 'object' ? raw : {};
            lines.push(`[${msg.userName || msg.userId || '群友'}] ${String(msg.text || '').slice(0, 120)}`);
        }
    }
    return lines.join('\n').slice(0, 12000);
}
// 给 ReportData 附加 S3 预计算上下文。
function attachPrecomputedContext(data, channelKey) {
    const finalInput = readPrecomputedFinalInput(data.date, channelKey);
    const context = buildPrecomputedContext(finalInput);
    if (!context)
        return;
    data.precomputedContext = context;
    data.precomputedCoverageRate = Number(finalInput && finalInput.coverageRate || 0);
}
/** 统计 CQ、XML、可读 QQ 表情标记和 Unicode emoji 数量。 */
function countEmojiInContent(content) {
    const text = String(content || '');
    if (!text)
        return 0;
    let total = 0;
    for (const re of [CQ_EMOJI_RE, XML_EMOJI_RE, TEXT_EMOJI_RE, UNICODE_EMOJI_RE]) {
        re.lastIndex = 0;
        total += (text.match(re) || []).length;
    }
    return total;
}
function processMessages(messages, today, now = Date.now()) {
    const reportMessages = (Array.isArray(messages) ? messages : []).filter(msg => isMessageInReportDay(msg, today, now));
    if (!reportMessages.length)
        return null;
    const totalMessages = reportMessages.length;
    const analysisMessages = reportMessages.length > MAX_ANALYSIS_MESSAGES ? reportMessages.slice(-MAX_ANALYSIS_MESSAGES) : reportMessages;
    const memberMap = new Map();
    for (const msg of reportMessages) {
        const uid = msg.userId || msg.user || 'unknown';
        if (!memberMap.has(uid)) {
            memberMap.set(uid, { userId: uid, name: msg.user || '群友', msgCount: 0, firstMsg: msg.time, lastMsg: msg.time });
        }
        const m = memberMap.get(uid);
        if (!m)
            continue;
        m.msgCount++;
        if (msg.time)
            m.lastMsg = msg.time;
    }
    const activeMembers = memberMap.size;
    if (activeMembers === 0)
        return null;
    const topMembers = [...memberMap.values()]
        .sort((a, b) => b.msgCount - a.msgCount)
        .slice(0, 20);
    let emojiCount = 0;
    for (const msg of reportMessages)
        emojiCount += countEmojiInContent(msg.content);
    let totalChars = 0;
    for (const msg of reportMessages) {
        if (!msg.content)
            continue;
        const text = msg.content
            .replace(/\[CQ:[^\]]+\]/g, '')
            .replace(/<(?:face|mface)\b[^>]*\/?>/gi, '')
            .replace(/https?:\/\/\S+/g, '')
            .replace(/【[^】]*】/g, '')
            .trim();
        totalChars += text.length;
    }
    const hourlyActivity = new Array(24).fill(0);
    for (const msg of reportMessages) {
        const hour = messageHourShanghai(msg);
        if (!isNaN(hour) && hour >= 0 && hour < 24) {
            hourlyActivity[hour]++;
        }
    }
    let maxHour = 0;
    let maxCount = 0;
    for (let i = 0; i < 24; i++) {
        if (hourlyActivity[i] > maxCount) {
            maxCount = hourlyActivity[i];
            maxHour = i;
        }
    }
    const peakHour = `${String(maxHour).padStart(2, '0')}:00-${String(maxHour).padStart(2, '0')}:59`;
    return {
        date: today,
        totalMessages,
        activeMembers,
        emojiCount,
        totalChars,
        hourlyActivity,
        peakHour,
        topMembers,
        messages: analysisMessages,
        analysisMessages,
        sampledMessages: analysisMessages.length,
        truncatedMessages: Math.max(0, reportMessages.length - analysisMessages.length),
    };
}
module.exports = { collectReportData, processMessages, messageHourShanghai, isMessageInReportDay, countEmojiInContent, buildPrecomputedContext };
