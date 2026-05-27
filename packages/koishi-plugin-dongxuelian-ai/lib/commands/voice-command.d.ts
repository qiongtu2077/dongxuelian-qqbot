/**
 * MODULE: 语音合成命令。
 * 边界: 只处理命令匹配、文本长度校验和语音发送调用；不写对话历史，不改 conversation，不调聊天模型。
 * 状态: 无自有 Map/Cache；TTS 冷却和临时文件状态由 tts.js 自己管理。
 */
interface VoiceLogger {
    warn: (message: string) => void;
}
interface VoiceRuntime {
    ctx?: {
        logger?: (name: string) => VoiceLogger;
    };
}
interface VoiceSessionLike {
    send: (content: unknown) => unknown | Promise<unknown>;
    quote?: {
        content?: unknown;
    };
}
interface VoiceCommandState {
    plain: string;
    channelKey: string;
    currentUserId: string;
}
declare function handleVoiceCommand(session: VoiceSessionLike, state: VoiceCommandState, runtime?: VoiceRuntime): Promise<{
    matched: true;
    response?: unknown;
} | {
    matched: false;
}>;
declare const _default: {
    handleVoiceCommand: typeof handleVoiceCommand;
};
export = _default;
