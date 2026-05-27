"use strict";
/* ==========================================================================
 * MODULE: plugin-lifecycle
 * 职责: 注册插件 ready / dispose 生命周期、启动期缓存恢复与周期性敏感扫描。
 * 边界: 不注册消息 middleware、不发送消息、不处理聊天/随机/Agent 路由决策。
 * 状态: 仅持有 sensitiveTimer；其他定时器由 startup-schedulers / agent cron 自己持有。
 * ========================================================================== */
const fsSync = require('fs');
const path = require('path');
const { DATA_DIR, PLUGIN_VERSION, THINKING_MODE_FILE, POLITICAL_DETECT_FILE, } = require('../core/constants');
const { readTextFile, readJsonFile, todayCst, } = require('../core/utils');
const { loadConfig, setThinkingEnabled, } = require('../core/runtime-config');
const { loadRuntimeSettings, } = require('../behavior/runtime-settings');
const { loadSkills, loadSkillsContentCache, } = require('../chat');
const { loadStickerCache, } = require('../reply/reply');
const { loadPersonaGroups, loadPersonaUsers, } = require('../persona/persona');
const { loadRepeatConfig, } = require('../behavior/repeat');
const { loadRandomVoiceRateCache, } = require('../behavior/random-voice-rate');
const { channelTodayCache, trimChannelRuntimeCaches, cleanupDailyStatsFiles, analyzeChannelSensitive, } = require('../conversation');
const { scheduleDailyStatsCleanup, scheduleExpressionHarvest, clearStartupSchedulers, } = require('./startup-schedulers');
const { clearChannelQueues, } = require('./channel-task-queue');
const { clearRandomPendingState, } = require('../behavior/random-state');
const agentConfig = require('../agent/config');
const agentCron = require('../agent/cron');
function getLifecycleErrorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
function restoreTodayCacheEntry(key, data) {
    if (!data || data.date !== todayCst() || !Array.isArray(data.messages) || data.messages.length <= 0)
        return;
    channelTodayCache.set(key, { date: data.date, messages: data.messages.slice(-3000), updatedAt: Date.now() });
}
function restoreTodayCache() {
    try {
        const files = fsSync.readdirSync(DATA_DIR).filter(f => f.startsWith('today-cache-') && f.endsWith('.json'));
        const today = todayCst();
        for (const fileName of files) {
            try {
                const raw = fsSync.readFileSync(path.join(DATA_DIR, fileName), 'utf8');
                const data = JSON.parse(raw);
                if (data && data.date === today && Array.isArray(data.messages) && data.messages.length > 0) {
                    const key = fileName.replace('today-cache-', '').replace('.json', '');
                    restoreTodayCacheEntry(key, data);
                }
            }
            catch { /* non-critical: skip one unreadable today-cache file during best-effort startup restore */
            }
        }
    }
    catch { /* non-critical: missing data dir or cache listing failure only disables startup cache restore */
    }
}
function registerPluginLifecycle(ctx, options = {}) {
    const { agentEngine, configureAgentQueue } = options;
    ctx.on('ready', async () => {
        await loadRuntimeSettings(true);
        await loadConfig(true);
        await loadSkills();
        await loadSkillsContentCache();
        setThinkingEnabled((await readTextFile(THINKING_MODE_FILE).catch(() => '')).trim() === 'on');
        loadStickerCache();
        loadPersonaGroups();
        loadRepeatConfig();
        loadPersonaUsers();
        await loadRandomVoiceRateCache();
        restoreTodayCache();
        trimChannelRuntimeCaches();
        cleanupDailyStatsFiles().catch(error => ctx.logger('dongxuelian-ai').warn(`daily stats cleanup failed: ${getLifecycleErrorMessage(error)}`));
        scheduleDailyStatsCleanup(ctx);
        scheduleExpressionHarvest(ctx);
        try {
            const config = agentConfig.getAgentConfig();
            if (typeof configureAgentQueue === 'function')
                configureAgentQueue(config.queue || {});
            const bot = Array.isArray(ctx.bots) ? ctx.bots[0] : ctx.bot;
            const count = await agentCron.startCronScheduler({ bot, engine: agentEngine });
            if (config.cron?.enabled)
                ctx.logger('dongxuelian-ai').info(`agent cron scheduler restored ${count} task(s)`);
        }
        catch (error) {
            ctx.logger('dongxuelian-ai').warn(`agent cron scheduler restore failed: ${getLifecycleErrorMessage(error)}`);
        }
        ctx.logger('dongxuelian-ai').info(`dongxuelian-ai ${PLUGIN_VERSION} loaded`);
    });
    const sensitiveTimer = setInterval(async () => {
        try {
            const enabled = await readJsonFile(POLITICAL_DETECT_FILE, []);
            if (Array.isArray(enabled)) {
                for (const channelKey of enabled) {
                    analyzeChannelSensitive(channelKey).catch(error => ctx.logger('dongxuelian-ai').warn(`sensitive scan failed: ${getLifecycleErrorMessage(error)}`));
                }
            }
        }
        catch (error) {
            ctx.logger('dongxuelian-ai').warn(`sensitive scan scheduler failed: ${getLifecycleErrorMessage(error)}`);
        }
    }, 1800000);
    ctx.on('dispose', () => {
        clearInterval(sensitiveTimer);
        try {
            agentCron.stopCronScheduler();
        }
        catch (error) {
            ctx.logger('dongxuelian-ai').warn(`agent cron scheduler stop failed: ${getLifecycleErrorMessage(error)}`);
        }
        clearChannelQueues();
        clearRandomPendingState();
        clearStartupSchedulers();
    });
}
module.exports = {
    restoreTodayCacheEntry,
    restoreTodayCache,
    registerPluginLifecycle,
};
