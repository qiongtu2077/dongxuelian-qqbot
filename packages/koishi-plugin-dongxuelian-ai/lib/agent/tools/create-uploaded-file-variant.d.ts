interface UploadedFileVariantParams {
    messageId?: unknown;
    activeFileMessageId?: unknown;
    keyword?: unknown;
    name?: unknown;
    fileName?: unknown;
    title?: unknown;
    send?: unknown;
    sendBack?: unknown;
    replace?: unknown;
    [key: string]: unknown;
}
interface UploadedFileEntry {
    messageId?: string;
    fileName: string;
    ext: string;
    localPath: string | null;
    skipped: boolean;
    skipReason: string | null;
    userId: string;
}
interface UploadedFileVariantContext {
    channelKey?: string;
    activeFileMessageId?: unknown;
    isDirect?: boolean;
    explicitFileTarget?: unknown;
    publicFileTaskEvidence?: unknown;
    activeScenePublicFileTask?: unknown;
    allowCrossUserFileVariant?: unknown;
    fileTargetEvidence?: unknown;
    userId?: string;
    [key: string]: unknown;
}
interface CreatedUploadedFileVariant {
    sourceMessageId: string;
    sourceName?: string;
    path: string;
    name: string;
    size: number;
}
declare function resolveTargetFileName(params?: UploadedFileVariantParams, entry?: Partial<UploadedFileEntry>): string;
declare function createVariant(params?: UploadedFileVariantParams, context?: UploadedFileVariantContext): Promise<CreatedUploadedFileVariant>;
declare function executeCreateUploadedFileVariant(params?: UploadedFileVariantParams, context?: UploadedFileVariantContext): Promise<string>;
declare const _default: {
    definition: {
        name: string;
        description: string;
        parameters: {
            type: string;
            properties: {
                messageId: {
                    type: string;
                    description: string;
                };
                keyword: {
                    type: string;
                    description: string;
                };
                name: {
                    type: string;
                    description: string;
                };
                sendBack: {
                    type: string;
                    description: string;
                };
                replace: {
                    type: string;
                    description: string;
                    properties: {
                        from: {
                            type: string;
                        };
                        to: {
                            type: string;
                        };
                    };
                };
            };
            required: string[];
        };
    };
    execute: typeof executeCreateUploadedFileVariant;
    createVariant: typeof createVariant;
    resolveTargetFileName: typeof resolveTargetFileName;
    dangerous: boolean;
    defaultChannels: string[];
};
export = _default;
