interface SegmentSession {
    content?: unknown;
    event?: {
        message?: unknown[] | {
            elements?: unknown[];
        };
    };
    elements?: unknown[];
}
interface ImageRef {
    url: string;
    file: string;
    [key: string]: unknown;
}
interface FileRef {
    name: string;
    file: string;
    url: string;
    size: number;
    mime: string;
    fileName?: unknown;
    filename?: unknown;
    id?: unknown;
    fileId?: unknown;
    file_id?: unknown;
    mimeType?: unknown;
    [key: string]: unknown;
}
interface VoiceRef {
    url: string;
    file: string;
    [key: string]: unknown;
}
declare function decodeEntityAttribute(value?: unknown): string;
declare function extractAttrValue(tag?: unknown, name?: string): string;
declare function extractCqAttrValue(body?: unknown, name?: string): string;
declare function extractImageRefFromContent(content?: unknown): ImageRef;
declare function appendUniqueSegments(target: unknown[], segments: unknown): void;
declare function getMessageSegments(session?: SegmentSession): unknown[];
declare function normalizeSegmentData(segment?: unknown): Record<string, unknown>;
declare function extractFileRefFromContent(content?: unknown): FileRef | null;
declare function getFileSegmentData(session?: SegmentSession): Record<string, unknown> | FileRef | null;
declare function extractVoiceRefFromContent(content?: unknown): VoiceRef | null;
declare function getVoiceSegmentData(session?: SegmentSession): Record<string, unknown> | VoiceRef | null;
declare const _default: {
    decodeEntityAttribute: typeof decodeEntityAttribute;
    extractAttrValue: typeof extractAttrValue;
    extractCqAttrValue: typeof extractCqAttrValue;
    extractImageRefFromContent: typeof extractImageRefFromContent;
    appendUniqueSegments: typeof appendUniqueSegments;
    getMessageSegments: typeof getMessageSegments;
    normalizeSegmentData: typeof normalizeSegmentData;
    extractFileRefFromContent: typeof extractFileRefFromContent;
    getFileSegmentData: typeof getFileSegmentData;
    extractVoiceRefFromContent: typeof extractVoiceRefFromContent;
    getVoiceSegmentData: typeof getVoiceSegmentData;
};
export = _default;
