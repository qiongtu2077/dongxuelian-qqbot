interface ImageSession {
    content?: string;
    _visionUrls?: unknown;
    _visionFile?: unknown;
    _isVisionRequest?: unknown;
    _visionTargetMessageId?: unknown;
    _visionTargetChannelKey?: unknown;
    quote?: {
        messageId?: string;
    };
    [key: string]: unknown;
}
interface ImageTurnBase {
    targetMessageId: string;
    targetChannelKey: string;
    candidateMessageIds?: string[];
}
interface ImageTurnDiagnostic {
    source: 'explicit-image' | 'random-image' | 'history-tool';
    target: string;
    demandId: string;
}
type ImageTurnResult = ImageTurnBase & ({
    status: 'none' | 'pending' | 'unavailable' | 'selection';
} | {
    status: 'reused';
    diagnostic: ImageTurnDiagnostic;
    analysis: string;
} | {
    status: 'owned';
    diagnostic: ImageTurnDiagnostic;
    complete(analysis: string): Promise<void>;
    release(): Promise<void>;
});
declare function prepareImageTurn(session: ImageSession, options: {
    question: string;
    randomTriggered: boolean;
}): Promise<ImageTurnResult>;
declare function messagesContainImage(messages: Array<{
    content?: unknown;
}>): boolean;
declare const _default: {
    prepareImageTurn: typeof prepareImageTurn;
    messagesContainImage: typeof messagesContainImage;
};
export = _default;
