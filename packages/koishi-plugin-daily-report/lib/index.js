"use strict";
/**
 * MODULE: 群聊日报插件入口。
 * 职责: 通过中间件拦截消息，识别并处理日报命令。
 * 边界: 不自己管理白名单，复用主插件的 summary-whitelist.json。
 */
const fs = require('fs');
const path = require('path');
const { TIMEOUTS, DATA_DIR } = require('./config');
const { getErrorMessage } = require('./error-utils');
const { parseBoundedInt: parsePositiveInt } = require('./config-utils');
const { loadManagementModule } = require('koishi-plugin-dongxuelian-ai/lib/public/management-runtime');
let flushTodayCacheToDisk = () => { };
try {
    ({ flushTodayCacheToDisk } = loadManagementModule('core.conversation'));
}
catch {
    /* 独立安装路径异常时仅跳过 flush */
}
let resourceRuntimeCache;
// 动态加载资源子系统运行时，避免 daily-report 编译期依赖新模块声明文件。
function getResourceRuntime(ctx) {
    if (resourceRuntimeCache !== undefined)
        return resourceRuntimeCache;
    try {
        resourceRuntimeCache = {
            admission: loadManagementModule('resource.admission'),
            tasks: loadManagementModule('resource.taskStore'),
        };
    }
    catch (error) {
        resourceRuntimeCache = null;
        if (ctx)
            ctx.logger('daily-report').warn(`resource runtime unavailable: ${getErrorMessage(error)}`);
    }
    return resourceRuntimeCache;
}
// 冷却机制
const cooldown = new Map();
const failureBackoff = new Map();
const inFlightReports = new Map();
const FAILURE_BACKOFF_MS = 10 * 1000;
const MAX_RUNTIME_MAP_ENTRIES = 500;
const SEND_RETRY_DELAY_MS = parsePositiveInt(process.env.DAILY_REPORT_SEND_RETRY_DELAY_MS, 800, 0, 10000);
const MAINTENANCE_REPLY_FALLBACK = '优化中';
// 将未知错误压成稳定的日志字符串。
// 用于发送重试前的短延迟，避免 OneBot 瞬时无响应时直接放弃文本提示。
function delay(ms) {
    if (ms <= 0)
        return Promise.resolve();
    return new Promise(resolve => setTimeout(resolve, ms));
}
// 读取全局维护模式文案；文件不存在时返回 null，表示走正常日报流程。
function readMaintenanceReplyText() {
    if (!DATA_DIR)
        return null;
    try {
        const raw = fs.readFileSync(path.join(DATA_DIR, 'ai-paused.txt'), 'utf8');
        return raw.trim() || MAINTENANCE_REPLY_FALLBACK;
    }
    catch {
        return null;
    }
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
// 将频道、用户等字段压成可用于 taskId 的短片段。
function safeResourceIdPart(value, fallback = 'unknown') {
    return String(value || fallback).replace(/[^a-zA-Z0-9_.:-]/g, '_').slice(0, 120) || fallback;
}
// 生成日报任务 ID，供 S1、S2、S0 串联同一个任务。
function createDailyReportTaskId(channelKey, detail) {
    return `daily_report-${Date.now()}-${safeResourceIdPart(channelKey)}-${detail ? 'detail' : 'basic'}`;
}
// 从 Koishi session 中提取日报触发用户 ID。
function getDailyReportUserId(session) {
    const value = session.userId ||
        session.author?.id ||
        session.event?.user?.id;
    return String(value || '');
}
// 构造 S1/S2 共用的日报任务预算。
function buildDailyReportBudget(taskId, channelKey, userId, detail) {
    return {
        taskId,
        kind: 'daily_report',
        source: 'koishi-worker',
        channelKey: String(channelKey || ''),
        userId,
        exclusive: true,
        priority: detail ? 20 : 25,
        minMemMb: 400,
        degradable: true,
        deferable: true,
        fallbacks: ['daily_report_text'],
        queueTimeoutMs: 600000,
        runTimeoutMs: 600000,
    };
}
// 按资源决策给用户发送固定、低成本提示。
async function sendDailyAdmissionNotice(ctx, session, decision, reason) {
    if (decision === 'queue') {
        await safeSendDailyReport(ctx, session, '日报已加入队列，前方有重任务时会按顺序生成。', '日报排队提示');
        return;
    }
    if (decision === 'defer') {
        await safeSendDailyReport(ctx, session, '日报已延期，资源恢复后继续生成。', '日报延期提示');
        return;
    }
    if (decision === 'reject') {
        await safeSendDailyReport(ctx, session, `当前资源不足，日报暂时不能生成。${reason ? `\n原因：${reason}` : ''}`, '日报拒绝提示');
    }
}
// 向 S2 写入日报任务；实际生成和发送由 daily-worker + result-notifier 完成。
function submitDailyResourceTask(runtime, taskId, channelKey, userId, detail) {
    return runtime.tasks.submitResourceTask({
        id: taskId,
        kind: 'daily_report',
        source: 'koishi-worker',
        channelKey: String(channelKey || ''),
        userId,
        priority: detail ? 20 : 25,
        timeoutMs: 600000,
        payload: { detail },
        notify: { target: 'qq-group', channelKey: String(channelKey || ''), status: 'pending' },
    });
}
// 检查同群是否已有未完成日报任务，避免 S2 队列被重复命令刷爆。
function findOpenDailyReportTask(runtime, channelKey) {
    const statuses = ['pending', 'claiming', 'running', 'deferred'];
    const direct = runtime.tasks.findResourceTaskByKindAndChannel?.('daily_report', String(channelKey || ''), statuses);
    if (direct)
        return direct;
    const tasks = runtime.tasks.listResourceTasks({ statuses, limit: 1000 });
    return tasks.find(task => String(task.kind || '') === 'daily_report' &&
        String(task.channelKey || '') === String(channelKey || '') &&
        !['done', 'failed', 'cancelled'].includes(String(task.status || ''))) || null;
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
            const maintenanceText = readMaintenanceReplyText();
            if (maintenanceText) {
                await safeSendDailyReport(ctx, session, maintenanceText, '维护模式提示');
                return;
            }
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
            // 与内存 today-cache 对齐后再交给 worker 读取，避免 worker 看不到刚进入内存的消息。
            try {
                if (typeof flushTodayCacheToDisk === 'function')
                    flushTodayCacheToDisk(channelKey);
            }
            catch (e) {
                ctx.logger('daily-report').warn(`flush today-cache failed: ${getErrorMessage(e)}`);
            }
            const modeLabel = isFull ? '详细日报' : '日报';
            inFlightReports.set(channelKey, Date.now());
            const userId = getDailyReportUserId(session);
            const taskId = createDailyReportTaskId(channelKey, isFull);
            const resourceRuntime = getResourceRuntime(ctx);
            try {
                if (!resourceRuntime) {
                    await safeSendDailyReport(ctx, session, '资源任务系统暂不可用，日报不会在主进程里生成，请稍后再试。', '资源系统缺失提示');
                    return;
                }
                const openTask = findOpenDailyReportTask(resourceRuntime, channelKey);
                if (openTask) {
                    await safeSendDailyReport(ctx, session, `${modeLabel}已在后台队列中，请等待完成后自动发回结果。\n任务：${String(openTask.id || '')}`, '日报重复提交提示');
                    return;
                }
                const budget = buildDailyReportBudget(taskId, channelKey, userId, isFull);
                const admission = resourceRuntime.admission.admitTask(budget);
                const task = submitDailyResourceTask(resourceRuntime, taskId, channelKey, userId, isFull);
                if (admission.decision === 'reject' || admission.decision === 'silent_drop') {
                    resourceRuntime.tasks.failTask(task, new Error(String(admission.reason || admission.decision)), { level: 'L4', mode: 'rejected', reason: admission.reason || admission.decision });
                    await sendDailyAdmissionNotice(ctx, session, 'reject', String(admission.reason || ''));
                    return;
                }
                if (admission.decision === 'defer') {
                    resourceRuntime.tasks.deferTask(task, String(admission.reason || 'resource defer'));
                    await sendDailyAdmissionNotice(ctx, session, 'defer', String(admission.reason || ''));
                    return;
                }
                cooldown.set(channelKey, Date.now());
                failureBackoff.delete(channelKey);
                await safeSendDailyReport(ctx, session, `${modeLabel}已提交后台任务，完成后会自动发回结果。\n任务：${taskId}`, '日报后台任务提示');
                ctx.logger('daily-report').info(`${modeLabel}已提交后台 worker: task=${taskId}, channel=${channelKey}, admission=${String(admission.decision || 'run_now')}`);
            }
            catch (err) {
                ctx.logger('daily-report').error(`${modeLabel}提交后台任务失败: ${getErrorMessage(err)}`);
                failureBackoff.set(channelKey, Date.now());
                await safeSendDailyReport(ctx, session, `${modeLabel}提交后台任务失败了，请稍后再试。`, '日报提交失败提示');
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
