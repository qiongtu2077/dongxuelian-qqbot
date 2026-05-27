interface IncomingSession {
    userId?: string;
    author?: {
        id?: string;
    };
    username?: string;
    content?: string;
    isDirect?: boolean;
    messageId?: string;
    guildId?: string;
    channelId?: string;
    event?: {
        message?: Array<{
            type?: string;
            data?: {
                url?: unknown;
                file?: unknown;
                [key: string]: unknown;
            };
            [key: string]: unknown;
        }>;
    };
    elements?: unknown[];
}
interface IncomingAnalysis {
    hasVisual?: boolean;
    hasFile?: boolean;
    hasAudio?: boolean;
    [key: string]: unknown;
}
interface IncomingContext {
    [key: string]: unknown;
    logger?: (name: string) => {
        warn?: (message: string) => void;
    };
}
interface ImageArtifactOptions {
    ctx: IncomingContext | null | undefined;
    session: IncomingSession;
    analyzed: IncomingAnalysis;
    plain: string;
    content: string;
    channelKey: string;
}
interface IncomingMessageArtifactOptions extends ImageArtifactOptions {
    directAt?: boolean;
}
declare function handleIncomingMessageArtifacts({ ctx, session, analyzed, plain, content, channelKey, directAt }: IncomingMessageArtifactOptions): Promise<string>;
declare const _default: {
    handleIncomingMessageArtifacts: typeof handleIncomingMessageArtifacts;
};
export = _default;
