"use strict";
/**
 * MODULE: S5 低成本状态回复。
 * 职责: 展示真实资源模式与四能力配置顺序，按需附加受控的微量文字探测。
 * 边界: 不修改模型配置，不执行管理操作。
 * 状态: 进程内共享两分钟查询冷却，首次受理即占用，重复查询不续期。
 */
const { readResourceSnapshot } = require('../resource-scheduler/resource-snapshot');
const { getResourceGateStatus } = require('../resource-gate/gate');
const { AI_CAPABILITIES, loadCapabilityConfigSync, getProviderCatalogEntry, isProviderKeyConfigured } = require('../core/ai-capability-config');
const { runTextConnectivityCheck } = require('../diagnostics/model-connectivity');
const { formatRecentModelDiagnostic } = require('../core/request-diagnostics');
const { loadRuntimeSettings, getRandomTriggerBaseRate, getRandomWhitelistStatus } = require('../behavior/runtime-settings');
const { getGroupPersona } = require('../persona/persona');
const { RANDOM_TRIGGER_WARMUP, RANDOM_TRIGGER_RAMP } = require('../core/constants');
const { formatPercent } = require('../core/utils');
const CAPABILITY_LABELS = {
    text: '文字', vision: '识图', 'voice-asr': '语音识别', 'voice-tts': '语音合成',
};
const MAX_STATUS_MODELS_PER_CAPABILITY = 4;
const AI_STATUS_COOLDOWN_MS = 120000;
let aiStatusAvailableAt = 0;
const RESOURCE_TASK_LABELS = {
    daily_report: '日报生成',
    daily_report_render: '日报渲染',
    daily_summary: '日报摘要',
    agent_task: 'Agent 任务',
    dashboard_agent: '控制台 Agent 任务',
    agent_memory: '记忆整理',
    agent_memory_compaction: '记忆压缩',
    conversation_summary: '对话摘要',
    sensitive_cache_analysis: '敏感内容分析',
    emotion_render: '表情渲染',
    browser_action: '浏览器操作',
    voice_tts_generation: '语音生成',
    diagnostic_probe: '诊断检查',
    mcp_local_check: '本地检查',
    external_video_download: '外部视频下载',
    pet_bridge_chat: '宠物桥接聊天',
    media_image_analysis: '图片分析',
    media_file_analysis: '文件分析',
    media_voice_transcription: '语音转写',
    status_query: '状态查询',
    normal_chat: '普通聊天',
};
// --- 状态文案 --- //
// 格式化内存展示。
function formatMemory(available, total) {
    if (typeof available !== 'number')
        return '暂无数据';
    return typeof total === 'number' ? `${available} / ${total} MB` : `${available} MB`;
}
// 将正在执行的内部任务转换为群聊可读的中文描述。
function formatRunningTask(meta) {
    if (!meta)
        return '无';
    const kind = String(meta.kind || '');
    if (kind === 'external_video_download')
        return '外部视频下载（正在下载 B 站视频）';
    return `${RESOURCE_TASK_LABELS[kind] || '其他任务'}（正在执行）`;
}
// 依据入口使用的资源模式说明当前限制，不把服务在线等同于上游模型健康。
function formatRuntimeMode(snapshot) {
    if (snapshot.botMode === 'maintenance')
        return '维护中，业务已暂停';
    if (snapshot.botMode === 'critical')
        return '内存不足，聊天与工具已暂停';
    if (snapshot.botMode === 'report_silent')
        return '正在生成日报，主动回复暂停';
    if (snapshot.botMode === 'busy')
        return '任务执行中，主动回复暂停';
    return '在线';
}
// 一次读取四能力配置；展示确切模型标识和缺失密钥，配置异常也保留资源状态。
function formatCapabilityModels() {
    try {
        const { config } = loadCapabilityConfigSync();
        const providers = new Map();
        return AI_CAPABILITIES.map(capability => {
            const steps = config.priorities[capability];
            if (!steps.length)
                return `${CAPABILITY_LABELS[capability]}：未配置`;
            const models = steps.slice(0, MAX_STATUS_MODELS_PER_CAPABILITY).map((step, index) => {
                if (!providers.has(step.provider)) {
                    const provider = getProviderCatalogEntry(step.provider);
                    providers.set(step.provider, { name: provider?.name || '未知供应商', configured: isProviderKeyConfigured(step.provider) });
                }
                const provider = providers.get(step.provider);
                // 保留编号与真实配置顺序；缺少密钥的节点会被运行时跳过，不能伪装成首选可用模型。
                const name = `${provider.name} / ${step.model}`.replace(/\s+/g, ' ').slice(0, 96);
                return `${index + 1}. ${name}${provider.configured ? '' : '（缺少密钥，跳过）'}`;
            });
            if (steps.length > MAX_STATUS_MODELS_PER_CAPABILITY)
                models.push(`另 ${steps.length - MAX_STATUS_MODELS_PER_CAPABILITY} 项见控制台`);
            return `${CAPABILITY_LABELS[capability]}：${models.join(' → ')}`;
        });
    }
    catch {
        // 配置校验错误含用户自定义值；状态消息只给操作提示，不回传原始错误或凭据。
        return ['模型配置：读取失败，请管理员到控制台检查'];
    }
}
// --- 状态回复 --- //
// 资源查询保持只读；AI状态在资源允许时附加最多四个文字节点的微量探测。
async function buildResourceStatusReply(checkConnectivity = false, channelKey = '') {
    if (checkConnectivity) {
        const now = Date.now();
        const remainingSeconds = Math.ceil((aiStatusAvailableAt - now) / 1000);
        if (remainingSeconds > 0)
            return `查询冷却倒计时${remainingSeconds}秒`;
        // 在任何异步探测前占用窗口，避免跨群并发重复消耗；冷却回复不重置截止时间。
        aiStatusAvailableAt = now + AI_STATUS_COOLDOWN_MS;
    }
    const snapshot = readResourceSnapshot();
    const gate = getResourceGateStatus();
    const resource = snapshot.memAvailableMb === null ? '内存未知'
        : snapshot.resourceState === 'red' ? '内存不足'
            : snapshot.resourceState === 'yellow' ? '内存偏紧' : '内存充足';
    const models = formatCapabilityModels();
    const occupancy = typeof snapshot.memTotalMb === 'number' && snapshot.memTotalMb > 0 && typeof snapshot.memAvailableMb === 'number'
        ? `内存占用${Math.round((1 - snapshot.memAvailableMb / snapshot.memTotalMb) * 100)}%｜` : '';
    const groupSettings = [];
    if (checkConnectivity && channelKey) {
        await loadRuntimeSettings();
        const baseRate = getRandomTriggerBaseRate(channelKey);
        groupSettings.push('', `当前群人格：${getGroupPersona(channelKey)?.persona || '默认'}`, `当前群基础触发率：${formatPercent(baseRate)}`, `当前群白名单状态：${getRandomWhitelistStatus(channelKey) ? '允许主动回复' : '未允许主动回复'}`, `随机触发率规则：${RANDOM_TRIGGER_WARMUP}条内${formatPercent(baseRate)}，${RANDOM_TRIGGER_WARMUP}条后每条+${formatPercent(RANDOM_TRIGGER_RAMP)}（最高100%）`);
    }
    const connectivity = checkConnectivity
        ? await runTextConnectivityCheck(MAX_STATUS_MODELS_PER_CAPABILITY, snapshot.botMode === 'normal' && snapshot.resourceState === 'green')
        : ['此查询未检测模型连通性；发送“AI状态”可进行微量文字探测。'];
    return [
        '莲莲 · AI状态',
        `运行：${formatRuntimeMode(snapshot)}`,
        `任务：${formatRunningTask(gate.meta)}`,
        `资源：${occupancy}${resource}｜可用 ${formatMemory(snapshot.memAvailableMb, snapshot.memTotalMb)}`,
        '',
        '模型顺序（按配置排列）',
        ...models,
        ...groupSettings,
        '',
        ...connectivity,
        ...(checkConnectivity ? ['', formatRecentModelDiagnostic()] : []),
    ].join('\n');
}
// AI状态使用适配器已确认的合并记录接口；冷却与不支持记录的适配器返回普通文字。
async function buildStatusCommandReply(session, checkConnectivity = true) {
    const groupId = session.isDirect ? '' : String(session.guildId || session.channelId || '');
    const text = await buildResourceStatusReply(checkConnectivity, groupId);
    if (!checkConnectivity || text.startsWith('查询冷却倒计时'))
        return text;
    const internal = session.bot?.internal;
    const target = groupId || String(session.userId || '');
    const sender = groupId ? internal?.sendGroupForwardMsg : internal?.sendPrivateForwardMsg;
    if (target && typeof sender === 'function') {
        const nodes = [{ type: 'node', data: { name: '东雪莲pro', uin: String(session.selfId || session.bot?.selfId || '10000'), content: text } }];
        try {
            if (await sender.call(internal, target, nodes))
                return undefined;
        }
        catch { /* 记录发送失败时保留可读状态回复。 */ }
    }
    return text;
}
module.exports = {
    buildResourceStatusReply,
    buildStatusCommandReply,
};
