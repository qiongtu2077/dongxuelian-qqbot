/**
 * MODULE: AI 插件公开管理运行时。
 * 职责: 为 Dashboard、日报等受信调用方提供稳定的模块契约与惰性加载入口。
 * 边界: 只暴露已登记的管理域能力，不接受文件路径或任意模块名。
 */

export interface ManagementModuleMap {
  'core.api': typeof import('../core/api')
  'core.constants': typeof import('../core/constants')
  'core.conversation': typeof import('../conversation')
  'core.frontmatter': typeof import('../core/frontmatter')
  'core.providerRegistry': typeof import('../core/provider-registry')
  'core.redactor': typeof import('../core/redactor')
  'core.runtimeConfig': typeof import('../core/runtime-config')
  'core.utils': typeof import('../core/utils')
  'agent.config': typeof import('../agent/config')
  'agent.cron': typeof import('../agent/cron')
  'agent.messages': typeof import('../agent/messages')
  'agent.pathGuard': typeof import('../agent/path-guard')
  'agent.pending': typeof import('../agent/pending')
  'agent.personaContext': typeof import('../agent/persona-context')
  'agent.planEngine': typeof import('../agent/plan/plan-engine')
  'agent.planRunner': typeof import('../agent/plan/plan-runner')
  'agent.planStore': typeof import('../agent/plan/plan-store')
  'agent.push': typeof import('../agent/push')
  'agent.queue': typeof import('../agent/queue')
  'agent.router': typeof import('../agent/router')
  'agent.safety': typeof import('../agent/safety')
  'agent.sessions': typeof import('../agent/sessions')
  'agent.shellGuard': typeof import('../agent/tools/shell-guard')
  'agent.skills': typeof import('../agent/skills')
  'agent.stats': typeof import('../agent/stats')
  'agent.toolRegistry': typeof import('../agent/tools/registry')
  'agent.workerSubmission': typeof import('../agent/worker-submission')
  'media.persona': typeof import('../persona/persona')
  'media.personaDiagnostics': typeof import('../persona/persona-diagnostics')
  'media.tts': typeof import('../media/voice/tts')
  'media.ttsResource': typeof import('../media/voice/tts-resource')
  'media.voiceAssets': typeof import('../media/voice/voice-assets')
  'resource.activityLease': typeof import('../resource-scheduler/resource-activity-lease')
  'resource.admission': typeof import('../resource-scheduler/admission')
  'resource.agentPayload': typeof import('../resource-workers/agent-payload')
  'resource.files': typeof import('../resource-common/files')
  'resource.gate': typeof import('../resource-gate/gate')
  'resource.mediaQueue': typeof import('../media/backpressure/media-queue')
  'resource.precomputeStatus': typeof import('../daily-precompute/precompute-status')
  'resource.resultNotifier': typeof import('../resource-workers/result-notifier')
  'resource.serverModePolicy': typeof import('../resource-scheduler/server-mode-policy')
  'resource.snapshot': typeof import('../resource-scheduler/resource-snapshot')
  'resource.systemProtection': typeof import('../resource-system/system-protection')
  'resource.taskStore': typeof import('../resource-workers/task-store')
  'resource.workerSupervisor': typeof import('../resource-workers/worker-supervisor')
  'daily.summaryMerge': typeof import('../daily-precompute/daily-summary-merge')
}

export type ManagementModuleName = keyof ManagementModuleMap
export type ManagementModule<Name extends ManagementModuleName> = ManagementModuleMap[Name]

const MANAGEMENT_MODULE_PATHS: Record<ManagementModuleName, string> = {
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
}

// 按公开标识惰性加载受信管理模块，并拒绝任何未登记的运行时输入。
export function loadManagementModule<Name extends ManagementModuleName>(name: Name): ManagementModule<Name> {
  const modulePath = MANAGEMENT_MODULE_PATHS[name]
  if (!modulePath) throw new Error(`unknown management module: ${String(name)}`)
  return require(modulePath) as ManagementModule<Name>
}

// 返回公开模块标识，供契约测试和诊断页面核对边界完整性。
export function listManagementModules(): ManagementModuleName[] {
  return Object.keys(MANAGEMENT_MODULE_PATHS) as ManagementModuleName[]
}
