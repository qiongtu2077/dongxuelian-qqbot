declare function isFileQuickReadIntent(text?: string): boolean;
declare function resolveFileQuickReadReply(channelKey: string, preferredMessageId?: string): Promise<string>;
declare const _default: {
    isFileQuickReadIntent: typeof isFileQuickReadIntent;
    resolveFileQuickReadReply: typeof resolveFileQuickReadReply;
};
export = _default;
