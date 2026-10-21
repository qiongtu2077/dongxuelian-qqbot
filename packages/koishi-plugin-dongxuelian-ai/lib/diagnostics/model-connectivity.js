"use strict";
/**
 * MODULE: 状态查询的微量文字连通性探测。
 * 职责: 对显示中的文字节点逐个发出 1 词元请求，区分响应、截断和失败。
 * 边界: 不走备用链、不重试、不触发业务告警；不发送用户上下文，不修改模型配置。
 * 状态: 单份配置指纹缓存保留 60 秒，同配置并发查询共用一次探测。
 */
const { createHash } = require('crypto');
const { resolveCapabilityRuntimeSteps } = require('../core/ai-capability-config');
const { admitTask } = require('../resource-scheduler/admission');
const { acquireResourceGate } = require('../resource-gate/gate');
const CACHE_TTL_MS = 60000;
const PROBE_TIMEOUT_MS = 5000;
let cache = null;
let pending = null;
// --- 单节点探测 --- //
// 解析当前运行时使用的 Chat Completions 响应，不将 HTTP 成功直接当作模型可用。
function classifyProbePayload(payload) {
    if (!payload || typeof payload !== 'object')
        return '返回格式异常，连通性未确认';
    const data = payload;
    const first = Array.isArray(data.choices) ? data.choices[0] : undefined;
    const output = data.usage?.completion_tokens;
    const usage = typeof output === 'number' && Number.isSafeInteger(output) && output >= 0
        ? `｜输出用量 ${output} 词元${output > 1 ? '（超过请求上限）' : ''}` : '｜用量未报告';
    if (typeof first?.message?.content === 'string' && first.message.content.trim())
        return '已连通，已返回文本' + usage;
    if (first?.message && first.finish_reason === 'length')
        return '已连通，长度截断（未验证完整回答）' + usage;
    return '接口已响应，但未返回有效文本或截断标记' + usage;
}
// 将状态码转换为固定说明，不把上游正文、网址或凭据带入群聊。
function describeProbeHttp(status) {
    const reasons = {
        400: '请求被拒绝，微量参数是否受支持需进一步检查',
        401: '认证失败', 403: '权限不足', 404: '模型或接口不存在',
        429: '请求受限',
    };
    return `HTTP ${status}：${reasons[status] || (status >= 500 ? '上游服务错误' : '请求未成功')}`;
}
// 请求输出上限为 1 词元，实际用量由上游报告；超时覆盖响应体读取并始终清理计时器。
async function probeTextStep(step) {
    if (step.chatProtocol !== 'openai-chat') {
        return { index: step.priorityIndex, detail: '未检测：当前协议尚无微量探针', latency: 0 };
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
    const start = Date.now();
    let detail;
    try {
        const response = await fetch(`${step.baseURL.replace(/\/+$/, '')}/chat/completions`, {
            method: 'POST', redirect: 'manual', signal: controller.signal,
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${step.apiKey}` },
            body: JSON.stringify({ model: step.model, messages: [{ role: 'user', content: 'Hi' }], max_tokens: 1, stream: false }),
        });
        if (!response.ok) {
            await response.body?.cancel();
            detail = describeProbeHttp(response.status);
        }
        else {
            try {
                detail = classifyProbePayload(await response.json());
            }
            catch {
                detail = controller.signal.aborted ? '检测超时（5 秒），当前连通性未确认' : '返回格式异常，连通性未确认';
            }
        }
    }
    catch {
        detail = controller.signal.aborted ? '检测超时（5 秒），当前连通性未确认' : '网络请求失败，当前连通性未确认';
    }
    finally {
        clearTimeout(timer);
    }
    return { index: step.priorityIndex, detail, latency: Date.now() - start };
}
// --- 资源准入与缓存 --- //
// 获得诊断任务准入和资源锁后最多并发两个请求，不为状态查询排队等锁。
async function runProbeBatch(steps) {
    const taskId = `status-connectivity-${process.pid}-${Date.now()}`;
    const admission = admitTask({
        taskId, kind: 'diagnostic_probe', source: 'ai-status', channelKey: 'diagnostics',
        userId: 'status-query', exclusive: true, priority: 30, deferable: false,
        queueTimeoutMs: 0, runTimeoutMs: 15000,
    });
    if (admission.decision !== 'run_now')
        return null;
    let gate;
    try {
        gate = await acquireResourceGate({
            taskId, kind: 'diagnostic_probe', owner: 'ai-status', channelKey: 'diagnostics',
            userId: 'status-query', priority: 30, timeoutMs: 15000, waitTimeoutMs: 0,
            memAvailableMb: admission.memAvailableMb, step: 'connectivity_probe',
        });
    }
    catch {
        return null;
    }
    try {
        const results = [];
        for (let index = 0; index < steps.length; index += 2) {
            results.push(...await Promise.all(steps.slice(index, index + 2).map(probeTextStep)));
        }
        return { completedAt: Date.now(), results };
    }
    finally {
        gate.release('status-connectivity-complete');
    }
}
// 格式化带年龄的检测结果；序号与状态回复中的文字模型顺序一一对应。
function formatProbeReport(report, reused) {
    const age = Math.max(0, Math.floor((Date.now() - report.completedAt) / 1000));
    return [
        `文字连通性（${reused ? `缓存，${age} 秒前` : '本次检测'}；每模型请求输出上限 1 词元）`,
        ...report.results.map(result => `${result.index + 1}. ${result.detail}${result.latency ? `｜${result.latency} ms` : ''}`),
        '完整回答、识图和语音未检测。输入与思考仍有开销，实际用量以上游计量为准。',
    ];
}
// 使用准确配置及凭据指纹隔离缓存；资源受限时只读缓存，不发起新请求。
async function runTextConnectivityCheck(maxModels, allowProbe) {
    let steps;
    try {
        steps = resolveCapabilityRuntimeSteps('text').filter(step => step.priorityIndex < maxModels);
    }
    catch {
        return ['文字连通性：未检测，模型配置读取失败'];
    }
    if (!steps.length)
        return ['文字连通性：未检测，没有已配置密钥的文字模型'];
    const key = createHash('sha256').update(JSON.stringify(steps)).digest('hex');
    if (cache?.key === key && Date.now() - cache.report.completedAt < CACHE_TTL_MS)
        return formatProbeReport(cache.report, true);
    if (pending?.key === key) {
        const report = await pending.promise;
        return report ? formatProbeReport(report, true) : ['文字连通性：未检测，资源准入未放行'];
    }
    if (!allowProbe)
        return ['文字连通性：未检测，维护、任务占用或资源不足时暂停探测'];
    if (pending)
        return ['文字连通性：其他配置正在检测，请稍后查询'];
    const promise = runProbeBatch(steps);
    pending = { key, promise };
    try {
        const report = await promise;
        if (!report)
            return ['文字连通性：未检测，资源准入未放行'];
        cache = { key, report };
        return formatProbeReport(report, false);
    }
    finally {
        pending = null;
    }
}
module.exports = { runTextConnectivityCheck };
