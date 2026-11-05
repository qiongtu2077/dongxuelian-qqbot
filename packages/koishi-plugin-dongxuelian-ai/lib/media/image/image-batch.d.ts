import imageManifest = require('./image-manifest');
type Target = ReturnType<typeof imageManifest.collectImageManifest>[number];
type ReadState = 'ready' | 'read' | 'reused' | 'too_large' | 'failed' | 'unsupported' | 'cancelled';
interface TargetResult {
    target: Target;
    state: ReadState;
    reason: string;
    bytes?: number;
    mime?: string;
    width?: number;
    height?: number;
    animated?: boolean;
    hash?: string;
    batch?: number;
}
interface VisionLimits {
    count: number;
    bodyBytes: number;
    encodedImageBytes: number;
    minDimension: number;
    maxDimension: number;
}
declare function getVisionInputLimits(model: string): VisionLimits;
declare function partitionImageTargets(targets: TargetResult[], limits: VisionLimits, promptBytes?: number): TargetResult[][];
declare function imageTargetLabel(target: Target): string;
declare function collectExplicitImageTargets(session: Parameters<typeof imageManifest.collectImageManifest>[0], channelKey: string, conversationKey: string): Promise<Target[]>;
declare function readExplicitImageEvidence(targets: Target[], question: string, options?: {
    canContinue?: () => boolean;
    signal?: AbortSignal;
}): Promise<{
    evidence: string;
    notice: string;
    results: TargetResult[];
    batches: number;
    deadline: number;
}>;
declare const _default: {
    getVisionInputLimits: typeof getVisionInputLimits;
    partitionImageTargets: typeof partitionImageTargets;
    imageTargetLabel: typeof imageTargetLabel;
    collectExplicitImageTargets: typeof collectExplicitImageTargets;
    readExplicitImageEvidence: typeof readExplicitImageEvidence;
};
export = _default;
