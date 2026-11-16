type ForwardGetter = (id: string) => Promise<unknown>;
interface ForwardImageMessage {
    messageId: string;
    message: Array<{
        type: string;
        data: Record<string, unknown>;
    }>;
}
declare function createForwardImageReader(getter: ForwardGetter): {
    getForwardMsg: (id: string) => Promise<unknown>;
    collectImages: (rootId: string) => Promise<ForwardImageMessage[]>;
};
declare const _default: {
    createForwardImageReader: typeof createForwardImageReader;
};
export = _default;
