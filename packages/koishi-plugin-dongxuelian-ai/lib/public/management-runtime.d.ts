/**
 * MODULE: AI 插件公开管理运行时。
 * 职责: 为 Dashboard、日报等受信调用方提供稳定的模块契约与惰性加载入口。
 * 边界: 只暴露已登记的管理域能力，不接受文件路径或任意模块名。
 */
export interface ManagementModuleMap {
    'core.api': typeof import('../core/api');
    'core.constants': typeof import('../core/constants');
    'core.conversation': typeof import('../conversation');
    'core.frontmatter': typeof import('../core/frontmatter');
    'core.providerRegistry': typeof import('../core/provider-registry');
    'core.redactor': typeof import('../core/redactor');
    'core.runtimeConfig': typeof import('../core/runtime-config');
    'core.utils': typeof import('../core/utils');
    'agent.config': typeof import('../agent/config');
    'agent.cron': typeof import('../agent/cron');
    'agent.messages': typeof import('../agent/messages');
    'agent.pathGuard': typeof import('../agent/path-guard');
    'agent.pending': typeof import('../agent/pending');
    'agent.personaContext': typeof import('../agent/persona-context');
    'agent.planEngine': typeof import('../agent/plan/plan-engine');
    'agent.planRunner': typeof import('../agent/plan/plan-runner');
    'agent.planStore': typeof import('../agent/plan/plan-store');
    'agent.push': typeof import('../agent/push');
    'agent.queue': typeof import('../agent/queue');
    'agent.router': typeof import('../agent/router');
    'agent.safety': typeof import('../agent/safety');
    'agent.sessions': typeof import('../agent/sessions');
    'agent.shellGuard': typeof import('../agent/tools/shell-guard');
    'agent.skills': typeof import('../agent/skills');
    'agent.stats': typeof import('../agent/stats');
    'agent.toolRegistry': typeof import('../agent/tools/registry');
    'agent.workerSubmission': typeof import('../agent/worker-submission');
    'media.persona': typeof import('../persona/persona');
    'media.personaDiagnostics': typeof import('../persona/persona-diagnostics');
    'media.tts': typeof import('../media/voice/tts');
    'media.ttsResource': typeof import('../media/voice/tts-resource');
    'media.voiceAssets': typeof import('../media/voice/voice-assets');
    'resource.activityLease': typeof import('../resource-scheduler/resource-activity-lease');
    'resource.admission': typeof import('../resource-scheduler/admission');
    'resource.agentPayload': typeof import('../resource-workers/agent-payload');
    'resource.files': typeof import('../resource-common/files');
    'resource.gate': typeof import('../resource-gate/gate');
    'resource.mediaQueue': typeof import('../media/backpressure/media-queue');
    'resource.precomputeStatus': typeof import('../daily-precompute/precompute-status');
    'resource.resultNotifier': typeof import('../resource-workers/result-notifier');
    'resource.serverModePolicy': typeof import('../resource-scheduler/server-mode-policy');
    'resource.snapshot': typeof import('../resource-scheduler/resource-snapshot');
    'resource.systemProtection': typeof import('../resource-system/system-protection');
    'resource.taskStore': typeof import('../resource-workers/task-store');
    'resource.workerSupervisor': typeof import('../resource-workers/worker-supervisor');
    'daily.summaryMerge': typeof import('../daily-precompute/daily-summary-merge');
}
export type ManagementModuleName = keyof ManagementModuleMap;
export type ManagementModule<Name extends ManagementModuleName> = ManagementModuleMap[Name];
export declare function loadManagementModule<Name extends ManagementModuleName>(name: Name): ManagementModule<Name>;
export declare function listManagementModules(): ManagementModuleName[];
