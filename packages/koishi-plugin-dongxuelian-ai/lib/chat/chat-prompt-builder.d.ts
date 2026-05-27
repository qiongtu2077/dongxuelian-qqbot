/**
 * MODULE: 聊天 prompt 片段构造器。
 * 职责: 只构造 messages/system note 等纯文本片段，帮助 chat.js 缩小主流程体积。
 * 边界: 不读写文件、不访问模型、不读取对话历史、不修改传入数组。
 * 状态: 无。
 */
interface ChatPromptMessage {
    role: string;
    content: string;
}
interface LoreRouteItem {
    id?: string;
    label?: string;
    text?: string;
}
interface LoreRouteResult {
    included?: LoreRouteItem[];
}
interface LoreMessageOptions {
    personaLore?: string;
    skillsContentCache?: Record<string, string>;
    cleanInput?: string;
    shouldInjectLore?: (text: string) => boolean;
    shouldInjectTerraLore?: (text: string) => boolean;
    routeResult?: LoreRouteResult | null;
}
interface SearchRuleOptions {
    searchEnabled?: boolean;
}
interface SearchCapability {
    supported?: boolean;
}
interface ShortFollowUpOptions {
    isFollowUp?: boolean;
}
interface RareContextOptions {
    rareConfirmed?: boolean;
    retaliationLevel?: number;
    rareProvocation?: boolean;
}
interface ConversationSummaryDisk {
    summary?: string;
    summaryTotal?: number;
}
interface PoliticalSensitiveOptions {
    detectList?: string[];
    channelKey?: string;
    cleanInput?: string;
    sensitiveKeywordsRe?: RegExp;
}
declare function createChatPromptBaseMessages(systemPrompt: string, dynamicTimePrompt: string): ChatPromptMessage[];
declare function testChatPromptRegex(pattern: RegExp | null | undefined, text: string): boolean;
declare function createChatPromptNsfwMessage(personaName?: string, personaSkillContent?: string): ChatPromptMessage | null;
declare function resolveChatPromptPersonaLore(personaName?: string, personaSkillContent?: string): string;
declare function createChatPromptLoreMessage({ personaLore, skillsContentCache, cleanInput, shouldInjectLore, shouldInjectTerraLore, routeResult }?: LoreMessageOptions): ChatPromptMessage | null;
declare function createChatPromptSearchRuleMessage(configForSearch?: SearchRuleOptions, searchCap?: SearchCapability): ChatPromptMessage | null;
declare function createChatPromptRandomContextMessage(randomTriggered: boolean): ChatPromptMessage | null;
declare function createChatPromptForwardSummaryMessage(forwardSummaryText?: string): ChatPromptMessage | null;
declare function createChatPromptShortFollowUpMessage(cleanInput: string, recentAssistant?: string, options?: ShortFollowUpOptions): ChatPromptMessage | null;
declare function createChatPromptGenerationRequestMessage(cleanInput: string, generationRequestRe: RegExp): ChatPromptMessage | null;
declare function createChatPromptRareContextMessage({ rareConfirmed, retaliationLevel, rareProvocation }?: RareContextOptions): ChatPromptMessage | null;
declare function createChatPromptConversationSummaryMessage(convDisk?: ConversationSummaryDisk | null): ChatPromptMessage | null;
declare function createChatPromptMemoryMessage(memorySummary?: string): ChatPromptMessage | null;
declare function createChatPromptHistoryBackgroundMessage(historyAsBackground?: string): ChatPromptMessage | null;
declare function createChatPromptSeriousQuestionMessage(cleanInput: string, seriousKeywords: RegExp, retaliationLevel: number): ChatPromptMessage | null;
declare function createChatPromptUncertainQuestionMessage(cleanInput: string, uncertainKeywords: RegExp, retaliationLevel: number): ChatPromptMessage | null;
declare function createChatPromptPoliticalSensitiveMessage({ detectList, channelKey, cleanInput, sensitiveKeywordsRe }?: PoliticalSensitiveOptions): ChatPromptMessage | null;
declare function createChatPromptHostileEvaluationMessage(isEvaluationRequest: ((text: string) => boolean) | null | undefined, cleanInput: string, hostile: boolean): ChatPromptMessage | null;
declare function createChatPromptPlainUserMessage(isolatedUserMessage: string): ChatPromptMessage;
declare const _default: {
    testChatPromptRegex: typeof testChatPromptRegex;
    createChatPromptBaseMessages: typeof createChatPromptBaseMessages;
    createChatPromptNsfwMessage: typeof createChatPromptNsfwMessage;
    resolveChatPromptPersonaLore: typeof resolveChatPromptPersonaLore;
    createChatPromptLoreMessage: typeof createChatPromptLoreMessage;
    createChatPromptSearchRuleMessage: typeof createChatPromptSearchRuleMessage;
    createChatPromptRandomContextMessage: typeof createChatPromptRandomContextMessage;
    createChatPromptForwardSummaryMessage: typeof createChatPromptForwardSummaryMessage;
    createChatPromptShortFollowUpMessage: typeof createChatPromptShortFollowUpMessage;
    createChatPromptGenerationRequestMessage: typeof createChatPromptGenerationRequestMessage;
    createChatPromptRareContextMessage: typeof createChatPromptRareContextMessage;
    createChatPromptConversationSummaryMessage: typeof createChatPromptConversationSummaryMessage;
    createChatPromptMemoryMessage: typeof createChatPromptMemoryMessage;
    createChatPromptHistoryBackgroundMessage: typeof createChatPromptHistoryBackgroundMessage;
    createChatPromptSeriousQuestionMessage: typeof createChatPromptSeriousQuestionMessage;
    createChatPromptUncertainQuestionMessage: typeof createChatPromptUncertainQuestionMessage;
    createChatPromptPoliticalSensitiveMessage: typeof createChatPromptPoliticalSensitiveMessage;
    createChatPromptHostileEvaluationMessage: typeof createChatPromptHostileEvaluationMessage;
    createChatPromptPlainUserMessage: typeof createChatPromptPlainUserMessage;
};
export = _default;
