"use strict";
/**
 * MODULE: API 健康检查。
 * 职责: 依次测试各已配置供应商的连通性，返回状态报告。
 * 边界: 不修改 conversation，不修改运行时配置。只读探测。
 */
const { PROVIDERS, DEEPSEEK_KEY_FILE, DASHSCOPE_KEY_FILE, GLM_KEY_FILE, MIMORIUM_KEY_FILE, KEY_FILE } = require('../core/constants');
const { loadConfig } = require('../core/runtime-config');
const { requestChatCompletions } = require('../core/api');
const { admitTask } = require('../resource-scheduler/admission');
const { acquireResourceGate } = require('../resource-gate/gate');
const fsp = require('fs/promises');
const HEALTH_CACHE_TTL = 60000;
const PROBE_TIMEOUT = 5000;
const DIAGNOSTIC_PROBE_KIND = 'diagnostic_probe';
let healthCache = null;
let healthCacheTs = 0;
// 生成一次管理员诊断探针的短生命周期 taskId，便于 S0/S1 事件追踪。
function buildDiagnosticTaskId() {
    return `${DIAGNOSTIC_PROBE_KIND}-${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
}
// 资源门控不放行时返回低成本诊断报告，避免继续调用模型探针。
function buildResourceGateHealthReport(now, config, reason) {
    return {
        ts: now,
        activeProvider: config.provider,
        activeModel: config.model,
        results: [{
                provider: 'resource-gate',
                status: 'fail',
                reason,
                latency: 0,
            }],
    };
}
function buildProbeConfig(providerId, baseURL, model, apiKey) {
    return {
        provider: providerId,
        baseURL: baseURL.replace(/\/+$/, ''),
        model: model || Object.values(PROVIDERS).flatMap(p => p.models)[0]?.id || 'gpt-4o-mini',
        apiKey,
        searchEnabled: false,
    };
}
function getHealthCheckResultContent(resultObj) {
    return typeof resultObj === 'string' ? resultObj : (resultObj.type === 'text' ? resultObj.content : '');
}
async function testProvider(providerId, providerDef, allKeys) {
    const keyField = providerId === 'deepseek' ? allKeys.deepseekKey
        : providerId === 'dashscope' ? allKeys.dashscopeKey
            : providerId === 'glm' ? allKeys.glmKey
                : providerId === 'mimorium' ? allKeys.mimoriumKey
                    : allKeys.defaultKey;
    if (!keyField || !keyField.trim()) {
        return { provider: providerDef?.name || providerId, status: 'skip', reason: 'key文件为空', latency: 0 };
    }
    const model = providerDef?.models[0]?.id;
    if (!model) {
        return { provider: providerDef?.name || providerId, status: 'skip', reason: '无可用模型', latency: 0 };
    }
    const probeConfig = buildProbeConfig(providerId, providerDef.baseURL, model, keyField.trim());
    const start = Date.now();
    try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT);
        const resultObj = await requestChatCompletions([{ role: 'user', content: 'hi' }], probeConfig, { max_tokens: 1, signal: controller.signal });
        clearTimeout(timer);
        const latency = Date.now() - start;
        const result = getHealthCheckResultContent(resultObj);
        if (result) {
            return { provider: providerDef.name, status: 'ok', latency };
        }
        return { provider: providerDef.name, status: 'fail', reason: '无返回值', latency };
    }
    catch (err) {
        const latency = Date.now() - start;
        const error = err instanceof Error ? err : null;
        const msg = String(error?.message || err);
        if (msg.includes('abort') || msg.includes('timeout')) {
            return { provider: providerDef.name, status: 'fail', reason: '超时', latency };
        }
        if (msg.includes('401'))
            return { provider: providerDef.name, status: 'fail', reason: '401 认证失败', latency };
        if (msg.includes('429'))
            return { provider: providerDef.name, status: 'fail', reason: '429 限流', latency };
        if (msg.includes('40'))
            return { provider: providerDef.name, status: 'fail', reason: `${msg.slice(0, 30)}`, latency };
        return { provider: providerDef.name, status: 'fail', reason: msg.slice(0, 40), latency };
    }
}
async function readHealthKeyFile(file) {
    try {
        return (await fsp.readFile(file, 'utf8')).trim();
    }
    catch {
        return '';
    }
}
async function runHealthCheck(force = false) {
    const now = Date.now();
    if (!force && healthCache && now - healthCacheTs < HEALTH_CACHE_TTL) {
        return healthCache;
    }
    const config = await loadConfig();
    const taskId = buildDiagnosticTaskId();
    const admission = admitTask({
        taskId,
        kind: DIAGNOSTIC_PROBE_KIND,
        source: 'koishi-health-check',
        channelKey: 'diagnostics',
        userId: 'admin',
        exclusive: true,
        priority: 30,
        deferable: false,
        queueTimeoutMs: 5000,
        runTimeoutMs: 120000,
    });
    if (admission.decision !== 'run_now') {
        return buildResourceGateHealthReport(now, config, admission.reason || 'diagnostic probe rejected by resource scheduler');
    }
    let gateHandle = null;
    try {
        gateHandle = await acquireResourceGate({
            taskId,
            kind: DIAGNOSTIC_PROBE_KIND,
            owner: 'koishi-health-check',
            channelKey: 'diagnostics',
            userId: 'admin',
            priority: 30,
            timeoutMs: 120000,
            waitTimeoutMs: 5000,
            pollMs: 500,
            memAvailableMb: admission.memAvailableMb,
            step: 'diagnostic_prepare',
        });
    }
    catch (error) {
        return buildResourceGateHealthReport(now, config, error instanceof Error ? error.message : String(error || 'diagnostic probe lock rejected'));
    }
    const defaultKey = config.apiKey;
    try {
        gateHandle.updateStep('diagnostic_read_keys', admission.memAvailableMb);
        const [deepseekKey, dashscopeKey, glmKey, mimoriumKey] = await Promise.all([
            readHealthKeyFile(DEEPSEEK_KEY_FILE),
            readHealthKeyFile(DASHSCOPE_KEY_FILE),
            readHealthKeyFile(GLM_KEY_FILE),
            readHealthKeyFile(MIMORIUM_KEY_FILE),
        ]);
        const results = [];
        for (const [providerId, providerDef] of Object.entries(PROVIDERS)) {
            gateHandle.updateStep(`diagnostic_${providerId}`, admission.memAvailableMb);
            const r = await testProvider(providerId, providerDef, { defaultKey, deepseekKey, dashscopeKey, glmKey, mimoriumKey });
            results.push(r);
        }
        const report = {
            ts: now,
            activeProvider: config.provider,
            activeModel: config.model,
            results,
        };
        healthCache = report;
        healthCacheTs = now;
        return report;
    }
    finally {
        gateHandle.release('diagnostic-finally');
    }
}
function formatHealthReport(report) {
    const lines = ['AI诊断', '─────────────────'];
    for (const r of report.results) {
        const icon = r.status === 'ok' ? '✅' : r.status === 'skip' ? '⏸' : '❌';
        const detail = r.status === 'ok' ? `${r.latency}ms` : r.reason;
        lines.push(`  ${icon} ${r.provider}　${detail}`);
    }
    lines.push('─────────────────');
    lines.push(`当前在用：${report.activeProvider} / ${report.activeModel}`);
    return lines.join('\n');
}
function resetHealthCache() {
    healthCache = null;
    healthCacheTs = 0;
}
module.exports = {
    runHealthCheck,
    formatHealthReport,
    resetHealthCache,
};
