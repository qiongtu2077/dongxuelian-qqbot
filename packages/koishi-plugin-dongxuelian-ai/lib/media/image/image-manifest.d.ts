type ImageGroup = 'quoted' | 'current';
interface ImageAlias {
    group: ImageGroup;
    ordinal: number;
    originalMessageId: string;
    mediaIndex: number;
}
interface ImageTarget {
    id: string;
    channelKey: string;
    conversationKey: string;
    originalMessageId: string;
    mediaIndex: number;
    sourceKind: 'image' | 'attachment';
    platformId: string;
    url: string;
    file: string | null;
    fileName: string;
    declaredSize: number | null;
    declaredMime: string;
    timestamp?: number;
    aliases: ImageAlias[];
}
interface ImageMessageView {
    messageId?: unknown;
    content?: unknown;
    timestamp?: number;
    elements?: unknown[];
    message?: unknown[];
    event?: {
        message?: unknown[] | {
            elements?: unknown[];
        };
    };
}
declare function parseImageMediaSegments(view: ImageMessageView): Array<{
    type: string;
    data: Record<string, unknown>;
}>;
declare function collectMessageImageTargets(view: ImageMessageView, context: {
    channelKey: string;
    conversationKey: string;
    group: ImageGroup;
}): ImageTarget[];
declare function collectImageManifest(session: ImageMessageView & {
    quote?: ImageMessageView;
}, channelKey: string, conversationKey: string, includeQuote?: boolean): ImageTarget[];
declare const _default: {
    parseImageMediaSegments: typeof parseImageMediaSegments;
    collectMessageImageTargets: typeof collectMessageImageTargets;
    collectImageManifest: typeof collectImageManifest;
};
export = _default;
