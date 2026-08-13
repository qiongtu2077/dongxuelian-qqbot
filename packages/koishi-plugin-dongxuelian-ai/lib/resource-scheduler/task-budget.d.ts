/**
 * MODULE: S1 任务预算定义。
 * 职责: 将业务入口提交的任务需求归一为资源预算。
 * 边界: 不读取系统状态，不做准入决策。
 */
declare const RESOURCE_TASK_KIND: {
    readonly DAILY_REPORT: "daily_report";
    readonly DAILY_REPORT_RENDER: "daily_report_render";
    readonly DAILY_SUMMARY: "daily_summary";
    readonly AGENT_TASK: "agent_task";
    readonly DASHBOARD_AGENT: "dashboard_agent";
    readonly AGENT_MEMORY: "agent_memory";
    readonly AGENT_MEMORY_COMPACTION: "agent_memory_compaction";
    readonly CONVERSATION_SUMMARY: "conversation_summary";
    readonly SENSITIVE_CACHE_ANALYSIS: "sensitive_cache_analysis";
    readonly EMOTION_RENDER: "emotion_render";
    readonly BROWSER_ACTION: "browser_action";
    readonly VOICE_TTS_GENERATION: "voice_tts_generation";
    readonly DIAGNOSTIC_PROBE: "diagnostic_probe";
    readonly MCP_LOCAL_CHECK: "mcp_local_check";
    readonly EXTERNAL_VIDEO_DOWNLOAD: "external_video_download";
    readonly PET_BRIDGE_CHAT: "pet_bridge_chat";
    readonly MEDIA_IMAGE_ANALYSIS: "media_image_analysis";
    readonly MEDIA_FILE_ANALYSIS: "media_file_analysis";
    readonly MEDIA_VOICE_TRANSCRIPTION: "media_voice_transcription";
    readonly STATUS_QUERY: "status_query";
    readonly NORMAL_CHAT: "normal_chat";
};
type KnownResourceTaskKind = typeof RESOURCE_TASK_KIND[keyof typeof RESOURCE_TASK_KIND];
type ResourceTaskKind = KnownResourceTaskKind | string;
interface TaskBudgetInput {
    taskId?: string;
    kind?: ResourceTaskKind;
    source?: string;
    channelKey?: string;
    userId?: string;
    exclusive?: boolean;
    priority?: number;
    minMemMb?: number;
    degradable?: boolean;
    deferable?: boolean;
    fallbacks?: string[];
    queueTimeoutMs?: number;
    runTimeoutMs?: number;
}
interface TaskBudget extends TaskBudgetInput {
    taskId: string;
    source: string;
    channelKey: string;
    userId: string;
    exclusive: boolean;
    priority: number;
    minMemMb: number;
    degradable: boolean;
    deferable: boolean;
    fallbacks: string[];
    queueTimeoutMs: number;
    runTimeoutMs: number;
}
declare function normalizeTaskBudget(input: TaskBudgetInput): TaskBudget;
declare const _default: {
    DEFAULT_BUDGETS: Record<string, Partial<TaskBudget>>;
    normalizeTaskBudget: typeof normalizeTaskBudget;
};
export = _default;
