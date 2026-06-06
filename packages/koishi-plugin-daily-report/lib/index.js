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
const { renderReport, assertRenderEnvironment, } = require('./html-renderer');
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
const SEND_RETRY_DELAY_MS = parsePositiveInt(process.env.DAILY_REPORT_SEND_RETRY_DELAY_MS, 800, 0, 10000);
const TEXT_FALLBACK_MAX_CHARS = parsePositiveInt(process.env.DAILY_REPORT_TEXT_FALLBACK_MAX_CHARS, 1800, 600, 4000);
function parsePositiveInt(value, fallback, min, max) {
    const parsed = parseInt(String(value), 10);
    if (!Number.isFinite(parsed))
        return fallback;
    return Math.max(min, Math.min(max, parsed));
}
// 将未知错误压成稳定的日志字符串。
function getErrorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
// 用于发送重试前的短延迟，避免 OneBot 瞬时无响应时直接放弃文本提示。
function delay(ms) {
    if (ms <= 0)
        return Promise.resolve();
    return new Promise(resolve => setTimeout(resolve, ms));
}
// 把长文本裁剪到 OneBot 更容易接受的范围内。
function clampText(text, maxChars) {
    if (text.length <= maxChars)
        return text;
    return `${text.slice(0, Math.max(0, maxChars - 18))}\n……内容已截断`;
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
// 在 AI 分析前检查 Chromium 渲染环境，避免低内存时浪费 AI 调用。
function preflightRenderEnvironment() {
    if (typeof assertRenderEnvironment !== 'function')
        return;
    assertRenderEnvironment();
}
// 拼接有限长度的文字版日报，作为图片渲染失败时的降级输出。
function buildTextFallbackReport(data, analysis, failure, modeLabel) {
    const lines = [
        `${modeLabel}文字版`,
        `图片渲染失败：${failure.userMessage}`,
        `日期：${data.date || '未知'}`,
        `消息：${Number(data.totalMessages || 0)} 条`,
        `活跃成员：${Number(data.activeMembers || 0)} 人`,
        `表情：${Number(data.emojiCount || 0)} 个`,
        `总字数：${Number(data.totalChars || 0)} 字`,
        `高峰：${data.peakHour || '未知'}`,
    ];
    const topMembers = Array.isArray(data.topMembers) ? data.topMembers.slice(0, 5) : [];
    if (topMembers.length) {
        lines.push('', '活跃群友：');
        for (let i = 0; i < topMembers.length; i++) {
            const member = topMembers[i];
            lines.push(`${i + 1}. ${member.name || '群友'}：${Number(member.msgCount || 0)} 条`);
        }
    }
    const topics = Array.isArray(analysis.topics) ? analysis.topics.slice(0, 3) : [];
    if (topics.length) {
        lines.push('', '话题摘要：');
        for (const topic of topics)
            lines.push(`- ${topic.title || '话题'}：${topic.summary || '无摘要'}`);
    }
    const quotes = Array.isArray(analysis.goldenQuotes) ? analysis.goldenQuotes.slice(0, 2) : [];
    if (quotes.length) {
        lines.push('', '今日金句：');
        for (const quote of quotes)
            lines.push(`- ${quote.sender || '群友'}：${quote.content || ''}${quote.reason ? `（${quote.reason}）` : ''}`);
    }
    const titles = Array.isArray(analysis.userTitles) ? analysis.userTitles.slice(0, 3) : [];
    if (titles.length) {
        lines.push('', '群友画像：');
        for (const item of titles)
            lines.push(`- ${item.name || '群友'}：${item.title || '称号'}${item.reason ? `，${item.reason}` : ''}`);
    }
    if (analysis.qualityReview) {
        lines.push('', '群聊锐评：', `${analysis.qualityReview.title || '今日锐评'}：${analysis.qualityReview.summary || '暂无总结'}`);
    }
    return clampText(lines.join('\n'), TEXT_FALLBACK_MAX_CHARS);
}
// 将 AI 分析阶段的降级信息打到日志里，方便回查是哪一层出了偏差。
function logAnalysisWarnings(ctx, modeLabel, analysis) {
    const warnings = analysis?.meta?.warnings;
    if (!Array.isArray(warnings) || !warnings.length)
        return;
    ctx.logger('daily-report').warn(`${modeLabel}分析降级: ${warnings.join(' | ')}`);
}
// 安全发送文字版降级日报，失败时只记录日志，不再抛出到主流程。
async function sendTextFallbackReport(ctx, session, data, analysis, failure, modeLabel) {
    const message = buildTextFallbackReport(data, analysis, failure, modeLabel);
    const sent = await safeSendDailyReport(ctx, session, message, '文字降级日报');
    if (sent)
        ctx.logger('daily-report').warn(`${modeLabel}图片渲染失败，已发送文字降级日报[${failure.kind}]`);
    return sent;
}
// 包装 session.send，记录耗时并对文本消息做一次短重试。
async function safeSendDailyReport(ctx, session, message, label = 'message') {
    const channelKey = session.guildId || session.channelId || 'private';
    const startedAt = Date.now();
    try {
        await session.send(message);
        ctx.logger('daily-report').info(`${label}发送成功: channel=${channelKey}, elapsed=${Date.now() - startedAt}ms`);
        return true;
    }
    catch (error) {
        const firstError = getErrorMessage(error);
        ctx.logger('daily-report').warn(`${label}发送失败: channel=${channelKey}, elapsed=${Date.now() - startedAt}ms, error=${firstError}`);
        if (typeof message !== 'string')
            return false;
        await delay(SEND_RETRY_DELAY_MS);
        const retryStartedAt = Date.now();
        try {
            await session.send(message);
            ctx.logger('daily-report').info(`${label}重试发送成功: channel=${channelKey}, elapsed=${Date.now() - retryStartedAt}ms`);
            return true;
        }
        catch (retryError) {
            ctx.logger('daily-report').warn(`${label}重试发送失败: channel=${channelKey}, elapsed=${Date.now() - retryStartedAt}ms, error=${getErrorMessage(retryError)}`);
            return false;
        }
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
            let analysis = {};
            try {
                try {
                    preflightRenderEnvironment();
                }
                catch (err) {
                    const failure = classifyRenderError(err);
                    ctx.logger('daily-report').error(`${modeLabel}渲染预检失败[${failure.kind}]: ${getErrorMessage(err)}`);
                    failureBackoff.set(channelKey, Date.now());
                    await sendTextFallbackReport(ctx, session, data, {}, failure, modeLabel);
                    return;
                }
                const started = await safeSendDailyReport(ctx, session, 'Thinking......', '生成中提示');
                if (!started)
                    return;
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
                const fallbackSent = await sendTextFallbackReport(ctx, session, data, analysis, failure, modeLabel);
                if (!fallbackSent)
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
