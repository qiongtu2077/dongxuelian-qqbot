/**
 * MODULE: S5 命令分类器。
 * 职责: 将入站消息归类为日报、状态、Agent、普通聊天或媒体事件。
 * 边界: 不读取资源状态，不执行任何业务逻辑。
 */
type BotCommandType = 'daily_command' | 'status_command' | 'agent_command' | 'normal_chat' | 'media_event';
interface ClassifyCommandInput {
    plain?: string;
    analyzed?: {
        hasVisual?: boolean;
        hasFile?: boolean;
        hasAudio?: boolean;
        hasEmbed?: boolean;
    };
}
declare function isDailyCommand(plain: string): boolean;
declare function isStatusCommand(plain: string): boolean;
declare function isAgentCommand(plain: string): boolean;
declare function isMediaEvent(analyzed: ClassifyCommandInput['analyzed']): boolean;
declare function classifyCommand(input?: ClassifyCommandInput): BotCommandType;
declare const _default: {
    classifyCommand: typeof classifyCommand;
    isDailyCommand: typeof isDailyCommand;
    isStatusCommand: typeof isStatusCommand;
    isAgentCommand: typeof isAgentCommand;
    isMediaEvent: typeof isMediaEvent;
};
export = _default;
