type ImageSource = 'explicit-image' | 'random-image' | 'history-tool';
interface ImageRequestOptions {
    source: ImageSource;
    question?: string;
    force?: boolean;
    waitMs?: number;
}
interface ImageDiagnostic {
    source: ImageSource;
    target: string;
    demandId: string;
}
type ImageRequestResult = {
    status: 'owned';
    diagnostic: ImageDiagnostic;
    complete(analysis: string): Promise<void>;
    release(): Promise<void>;
} | {
    status: 'reused';
    diagnostic: ImageDiagnostic;
    analysis: string;
} | {
    status: 'pending' | 'unavailable';
};
declare function hasActiveImageRequest(channelKey: string, messageId: string): boolean;
declare function acquireImageRequest(channelKey: string, messageId: string, options: ImageRequestOptions): Promise<ImageRequestResult>;
declare function cleanupImageRequests(): Promise<void>;
declare const _default: {
    acquireImageRequest: typeof acquireImageRequest;
    cleanupImageRequests: typeof cleanupImageRequests;
    hasActiveImageRequest: typeof hasActiveImageRequest;
};
export = _default;
