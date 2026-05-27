declare function isFileQuickReadIntent(text?: string): boolean;
declare function resolveFileQuickReadReply(channelKey: string): Promise<string>;
declare const _default: {
    isFileQuickReadIntent: typeof isFileQuickReadIntent;
    resolveFileQuickReadReply: typeof resolveFileQuickReadReply;
};
export = _default;
