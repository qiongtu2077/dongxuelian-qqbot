interface FallbackSession {
    channelId?: string;
    userId?: string;
}
interface PersonaFallbackMessage {
    role: 'system' | 'user';
    content: string;
}
interface GeneratePersonaFallbackOptions {
    session?: FallbackSession;
    systemPrompt?: string;
    currentUserMessage?: string;
    userName?: string;
    reason?: string;
    maxChars?: number;
    callModel?: (messages: PersonaFallbackMessage[], isRandom?: boolean, options?: Record<string, unknown>) => Promise<unknown>;
    isRandom?: boolean;
}
declare function normalizeModelText(result: unknown): string;
declare function isUnsafeFallbackText(session: FallbackSession | undefined, text?: string): boolean;
declare function cleanPersonaFallbackReply(session: FallbackSession | undefined, text?: string, userName?: string, maxChars?: number): string;
declare function buildPersonaFallbackMessages(systemPrompt: string, currentUserMessage: string, reason?: string): PersonaFallbackMessage[];
declare function generatePersonaFallbackReply({ session, systemPrompt, currentUserMessage, userName, reason, maxChars, callModel, isRandom, }: GeneratePersonaFallbackOptions): Promise<string>;
declare const _default: {
    normalizeModelText: typeof normalizeModelText;
    isUnsafeFallbackText: typeof isUnsafeFallbackText;
    cleanPersonaFallbackReply: typeof cleanPersonaFallbackReply;
    buildPersonaFallbackMessages: typeof buildPersonaFallbackMessages;
    generatePersonaFallbackReply: typeof generatePersonaFallbackReply;
};
export = _default;
