interface SegmentLike {
    type?: string;
    data?: {
        url?: unknown;
        file?: unknown;
    };
}
interface VisionSessionLike {
    content?: string;
    quote?: {
        content?: unknown;
        message?: SegmentLike[];
    };
    event?: {
        message?: SegmentLike[];
    };
    _visionUrls?: unknown;
    _visionFile?: unknown;
    _isVisionRequest?: unknown;
    [key: string]: unknown;
}
interface VisionPayload {
    urls: string[];
    file: string | null;
}
interface AnalyzedMessageFlags {
    hasVisual?: boolean;
    hasFile?: boolean;
    hasEmbed?: boolean;
}
interface PrepareVisionContext {
    content?: unknown;
    allowCurrentMessage?: boolean;
    includeQuote?: boolean;
}
interface VisionConfig {
    provider?: string;
    model?: string;
}
interface VisionMessage {
    role: string;
    content: string | Array<Record<string, unknown>>;
}
interface AppendVisionOptions {
    promptText?: string;
    readFailReply?: string;
    inaccessibleReply?: string;
    identifyFailReply?: string;
}
interface VisionContext {
    provider?: string;
    model?: string;
    promptText: string;
    injectedIndex: number;
}
interface AppendVisionResult {
    ok: boolean;
    reply?: string;
    visionContext?: VisionContext;
}
declare function markSessionForVision(session: VisionSessionLike | null | undefined, urls?: unknown[], file?: unknown): boolean;
declare function getVisionPayload(session: VisionSessionLike | null | undefined): VisionPayload;
declare function isVisionSession(session: VisionSessionLike | null | undefined): boolean;
declare function clearVisionSession(session: VisionSessionLike | null | undefined): void;
declare function prepareVisionRequest(session: VisionSessionLike, analyzed?: AnalyzedMessageFlags, context?: PrepareVisionContext): boolean;
declare function appendVisionMessage(messages: VisionMessage[], session: VisionSessionLike, config: VisionConfig, ctx: {
    logger: (name: string) => {
        warn: (message: string) => void;
    };
}, options?: AppendVisionOptions): Promise<AppendVisionResult>;
declare function isVisionBlindnessReply(reply?: string): boolean;
declare function downgradeVisionMessageToText(messages: VisionMessage[], visionContext: Partial<VisionContext> | null | undefined, fallbackText: string): boolean;
declare const _default: {
    VISION_SESSION_KEYS: string[];
    markSessionForVision: typeof markSessionForVision;
    isVisionSession: typeof isVisionSession;
    getVisionPayload: typeof getVisionPayload;
    clearVisionSession: typeof clearVisionSession;
    prepareVisionRequest: typeof prepareVisionRequest;
    appendVisionMessage: typeof appendVisionMessage;
    isVisionBlindnessReply: typeof isVisionBlindnessReply;
    downgradeVisionMessageToText: typeof downgradeVisionMessageToText;
};
export = _default;
