/**
 * MODULE: 资源任务 kind 共享词汇表。
 * 职责: 提供资源子系统通用任务 kind 常量和纯分类 predicate。
 * 边界: 不包含预算、准入、队列、锁或 worker 执行器注册逻辑。
 */
declare function normalizeResourceTaskKind(kind: unknown): string;
declare function isStatusQueryKind(kind: unknown): boolean;
declare function isNormalChatKind(kind: unknown): boolean;
declare function isImageMediaTaskKind(kind: unknown): boolean;
declare function isFileMediaTaskKind(kind: unknown): boolean;
declare function isVoiceMediaTaskKind(kind: unknown): boolean;
declare function isMediaTaskKind(kind: unknown): boolean;
declare function isChromiumTaskKind(kind: unknown): boolean;
declare function isDailyReportKind(kind: unknown): boolean;
declare function canRunInRedStateByKind(kind: unknown): boolean;
declare function isBackgroundLlmTaskKind(kind: unknown): boolean;
declare function shouldYieldToToolActiveKind(kind: unknown): boolean;
declare const _default: {
    RESOURCE_TASK_KIND: {
        readonly DAILY_REPORT: "daily_report";
        readonly DAILY_REPORT_RENDER: "daily_report_render";
        readonly DAILY_REPORT_SUMMARY: "daily_report_summary";
        readonly DAILY_SUMMARY: "daily_summary";
        readonly AGENT_TASK: "agent_task";
        readonly DASHBOARD_AGENT: "dashboard_agent";
        readonly AGENT_MEMORY: "agent_memory";
        readonly AGENT_MEMORY_COMPACTION: "agent_memory_compaction";
        readonly EXPRESSION_HARVEST: "expression_harvest";
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
    normalizeResourceTaskKind: typeof normalizeResourceTaskKind;
    isStatusQueryKind: typeof isStatusQueryKind;
    isNormalChatKind: typeof isNormalChatKind;
    isImageMediaTaskKind: typeof isImageMediaTaskKind;
    isFileMediaTaskKind: typeof isFileMediaTaskKind;
    isVoiceMediaTaskKind: typeof isVoiceMediaTaskKind;
    isMediaTaskKind: typeof isMediaTaskKind;
    isChromiumTaskKind: typeof isChromiumTaskKind;
    isDailyReportKind: typeof isDailyReportKind;
    canRunInRedStateByKind: typeof canRunInRedStateByKind;
    isBackgroundLlmTaskKind: typeof isBackgroundLlmTaskKind;
    shouldYieldToToolActiveKind: typeof shouldYieldToToolActiveKind;
};
export = _default;
