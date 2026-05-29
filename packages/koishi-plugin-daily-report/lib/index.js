"use strict";
/**
 * MODULE: 群聊日报插件入口。
 * 职责: 通过中间件拦截消息，识别并处理日报命令。
 * 边界: 不自己管理白名单，复用主插件的 summary-whitelist.json。
 */
const { h } = require('koishi');
const fs = require('fs');
const path = require('path');
const { TIMEOUTS, DATA_DIR } = require('./config');
const { collectReportData } = require('./data-collector');
const { analyzeWithAI } = require('./ai-analyzer');
const { renderReport } = require('./html-renderer');
let flushTodayCacheToDisk = () => { };
try {
    ({ flushTodayCacheToDisk } = require('../../koishi-plugin-dongxuelian-ai/lib/conversation'));
}
catch {
    /* 独立安装路径异常时仅跳过 flush */
}
// 冷却机制
const cooldown = new Map();
const failureBackoff = new Map();
const inFlightReports = new Map();
const FAILURE_BACKOFF_MS = 10 * 1000;
const MAX_RUNTIME_MAP_ENTRIES = 500;
function getErrorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
function trimTimedMap(map, now, maxAgeMs) {
    for (const [key, value] of map) {
        const ts = Number(value || 0);
        if (!ts || now - ts > maxAgeMs)
            map.delete(key);
    }
    if (map.size <= MAX_RUNTIME_MAP_ENTRIES)
        return;
    const ordered = Array.from(map.entries()).sort((a, b) => Number(a[1] || 0) - Number(b[1] || 0));
    for (const [key] of ordered.slice(0, map.size - MAX_RUNTIME_MAP_ENTRIES))
        map.delete(key);
}
function trimRuntimeMaps(now = Date.now()) {
    trimTimedMap(cooldown, now, TIMEOUTS.cooldown * 2);
    trimTimedMap(failureBackoff, now, FAILURE_BACKOFF_MS * 6);
    trimTimedMap(inFlightReports, now, 10 * 60 * 1000);
}
// 将渲染错误按层级归类，方便日志和用户提示分开处理。
function classifyRenderError(err) {
    const message = String(err?.message || err || '');
    if (/available memory is too low for Chromium render/i.test(message)) {
        return { kind: 'memory', userMessage: '日报渲染失败：服务器可用内存不足，请稍后再试。' };
    }
    if (/未找到Chrome\/Chromium浏览器/i.test(message)) {
        return { kind: 'browser', userMessage: '日报渲染失败：未找到 Chrome/Chromium。' };
    }
    if (/daily report render queue timeout/i.test(message)) {
        return { kind: 'queue-timeout', userMessage: '日报渲染排队超时，请稍后再试。' };
    }
    if (/render HTML is too large/i.test(message)) {
        return { kind: 'html-too-large', userMessage: '日报内容太长，暂时无法渲染。' };
    }
    if (/AbortError|timed out|timeout/i.test(message)) {
        return { kind: 'timeout', userMessage: '日报生成超时了，请稍后再试。' };
    }
    return { kind: 'unknown', userMessage: '详细日报生成失败了，请稍后再试。' };
}
// 将 AI 分析阶段的降级信息打到日志里，方便回查是哪一层出了偏差。
function logAnalysisWarnings(ctx, modeLabel, analysis) {
    const warnings = analysis?.meta?.warnings;
    if (!Array.isArray(warnings) || !warnings.length)
        return;
    ctx.logger('daily-report').warn(`${modeLabel}分析降级: ${warnings.join(' | ')}`);
}
async function safeSendDailyReport(ctx, session, message, label = 'message') {
    try {
        await session.send(message);
        return true;
    }
    catch (error) {
        ctx.logger('daily-report').warn(`${label}发送失败: ${getErrorMessage(error)}`);
        return false;
    }
}
// 白名单缓存（避免每次同步读文件）
let whitelistCache = null;
let whitelistCacheTime = 0;
const WHITELIST_CACHE_TTL = 60000; // 1分钟刷新
function getWhitelist() {
    const now = Date.now();
    if (whitelistCache && now - whitelistCacheTime < WHITELIST_CACHE_TTL) {
        return whitelistCache;
    }
    if (!DATA_DIR) {
        whitelistCache = [];
        return whitelistCache;
    }
    try {
        const raw = fs.readFileSync(path.join(DATA_DIR, 'summary-whitelist.json'), 'utf8');
        const arr = JSON.parse(raw);
        whitelistCache = Array.isArray(arr) ? arr.map(String) : [];
    }
    catch {
        whitelistCache = [];
    }
    whitelistCacheTime = now;
    return whitelistCache;
}
const name = 'daily-report';
function apply(ctx) {
    ctx.on('ready', () => {
        ctx.logger('daily-report').info('daily-report loaded');
    });
    ctx.middleware(async (session, next) => {
        const content = String(session.content || '').trim();
        const isFull = content === '群聊详细日报' || content === '/群聊详细日报';
        const isBasic = content === '群聊日报' || content === '/群聊日报';
        if (isFull || isBasic) {
            const channelKey = session.guildId || session.channelId || 'private';
            if (!session.guildId) {
                await safeSendDailyReport(ctx, session, '这个命令只能在群里使用。', '群聊限制提示');
                return;
            }
            // 白名单检查
            const whitelist = getWhitelist();
            if (!whitelist.includes(String(channelKey))) {
                await safeSendDailyReport(ctx, session, '本群未启用日报功能，请联系管理员添加白名单。', '白名单提示');
                return;
            }
            if (inFlightReports.has(channelKey)) {
                await safeSendDailyReport(ctx, session, '这个群的日报正在生成中，请稍后再试。', '并发提示');
                return;
            }
            // 冷却检查
            trimRuntimeMaps();
            const lastReport = cooldown.get(channelKey) || 0;
            if (Date.now() - lastReport < TIMEOUTS.cooldown) {
                await safeSendDailyReport(ctx, session, '日报生成太频繁了，1分钟后再试。', '冷却提示');
                return;
            }
            const lastFailure = failureBackoff.get(channelKey) || 0;
            if (Date.now() - lastFailure < FAILURE_BACKOFF_MS) {
                await safeSendDailyReport(ctx, session, '刚刚生成失败了，稍等几秒再重试。', '失败退避提示');
                return;
            }
            // 与内存 today-cache 对齐后再读盘（避免条数/时间与「今日情绪」不一致）
            try {
                if (typeof flushTodayCacheToDisk === 'function')
                    flushTodayCacheToDisk(channelKey);
            }
            catch (e) {
                ctx.logger('daily-report').warn(`flush today-cache failed: ${getErrorMessage(e)}`);
            }
            // 收集数据
            const data = collectReportData(channelKey);
            if (!data || data.messages.length === 0) {
                await safeSendDailyReport(ctx, session, '今天还没有收录足够消息，稍后再试。', '空数据提示');
                return;
            }
            // 发送提示
            const modeLabel = isFull ? '详细日报' : '日报';
            inFlightReports.set(channelKey, Date.now());
            try {
                const started = await safeSendDailyReport(ctx, session, 'Thinking......', '生成中提示');
                if (!started)
                    return;
                let analysis = {};
                if (isFull) {
                    try {
                        analysis = await analyzeWithAI(data, true);
                        logAnalysisWarnings(ctx, modeLabel, analysis);
                    }
                    catch (err) {
                        ctx.logger('daily-report').error(`${modeLabel}AI分析失败: ${getErrorMessage(err)}`);
                        failureBackoff.set(channelKey, Date.now());
                        await safeSendDailyReport(ctx, session, `${modeLabel}分析失败了，请稍后再试。`, 'AI失败提示');
                        return;
                    }
                }
                const imageBuffer = await renderReport(data, analysis);
                const base64 = imageBuffer.toString('base64');
                const imageSent = await safeSendDailyReport(ctx, session, h.image(`data:image/png;base64,${base64}`), '日报图片');
                if (!imageSent) {
                    failureBackoff.set(channelKey, Date.now());
                    return;
                }
                cooldown.set(channelKey, Date.now());
                failureBackoff.delete(channelKey);
                ctx.logger('daily-report').info(`${modeLabel}生成成功: ${data.date}, ${data.totalMessages}条消息`);
            }
            catch (err) {
                const failure = classifyRenderError(err);
                ctx.logger('daily-report').error(`${modeLabel}生成失败[${failure.kind}]: ${getErrorMessage(err)}`);
                failureBackoff.set(channelKey, Date.now());
                await safeSendDailyReport(ctx, session, failure.userMessage, '失败提示');
            }
            finally {
                inFlightReports.delete(channelKey);
                trimRuntimeMaps();
            }
            return;
        }
        return next();
    });
}
const _test = {
    cooldown,
    failureBackoff,
    inFlightReports,
    trimRuntimeMaps,
    safeSendDailyReport,
};
module.exports = { name, apply, _test };
