"use strict";
/**
 * MODULE: AI 插件公开管理运行时。
 * 职责: 为 Dashboard、日报等受信调用方提供稳定的模块契约与惰性加载入口。
 * 边界: 只暴露已登记的管理域能力，不接受文件路径或任意模块名。
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.loadManagementModule = loadManagementModule;
exports.listManagementModules = listManagementModules;
const MANAGEMENT_MODULE_PATHS = {
    'core.api': '../core/api',
    'core.constants': '../core/constants',
    'core.conversation': '../conversation',
    'core.frontmatter': '../core/frontmatter',
    'core.providerRegistry': '../core/provider-registry',
    'core.redactor': '../core/redactor',
    'core.runtimeConfig': '../core/runtime-config',
    'core.utils': '../core/utils',
    'agent.config': '../agent/config',
    'agent.cron': '../agent/cron',
    'agent.messages': '../agent/messages',
    'agent.pathGuard': '../agent/path-guard',
    'agent.pending': '../agent/pending',
    'agent.personaContext': '../agent/persona-context',
    'agent.planEngine': '../agent/plan/plan-engine',
    'agent.planRunner': '../agent/plan/plan-runner',
    'agent.planStore': '../agent/plan/plan-store',
    'agent.push': '../agent/push',
    'agent.queue': '../agent/queue',
    'agent.router': '../agent/router',
    'agent.safety': '../agent/safety',
    'agent.sessions': '../agent/sessions',
    'agent.shellGuard': '../agent/tools/shell-guard',
    'agent.skills': '../agent/skills',
    'agent.stats': '../agent/stats',
    'agent.toolRegistry': '../agent/tools/registry',
    'agent.workerSubmission': '../agent/worker-submission',
    'media.persona': '../persona/persona',
    'media.personaDiagnostics': '../persona/persona-diagnostics',
    'media.tts': '../media/voice/tts',
    'media.ttsResource': '../media/voice/tts-resource',
    'media.voiceAssets': '../media/voice/voice-assets',
    'resource.activityLease': '../resource-scheduler/resource-activity-lease',
    'resource.admission': '../resource-scheduler/admission',
    'resource.agentPayload': '../resource-workers/agent-payload',
    'resource.files': '../resource-common/files',
    'resource.gate': '../resource-gate/gate',
    'resource.mediaQueue': '../media/backpressure/media-queue',
    'resource.precomputeStatus': '../daily-precompute/precompute-status',
    'resource.resultNotifier': '../resource-workers/result-notifier',
    'resource.serverModePolicy': '../resource-scheduler/server-mode-policy',
    'resource.snapshot': '../resource-scheduler/resource-snapshot',
    'resource.systemProtection': '../resource-system/system-protection',
    'resource.taskStore': '../resource-workers/task-store',
    'resource.workerSupervisor': '../resource-workers/worker-supervisor',
    'daily.summaryMerge': '../daily-precompute/daily-summary-merge',
};
// 按公开标识惰性加载受信管理模块，并拒绝任何未登记的运行时输入。
function loadManagementModule(name) {
    const modulePath = MANAGEMENT_MODULE_PATHS[name];
    if (!modulePath)
        throw new Error(`unknown management module: ${String(name)}`);
    return require(modulePath);
}
// 返回公开模块标识，供契约测试和诊断页面核对边界完整性。
function listManagementModules() {
    return Object.keys(MANAGEMENT_MODULE_PATHS);
}
