interface DiagnosticsContext {
    [key: string]: unknown;
}
interface DiagnosticInput {
    channelKey?: string;
    randomVoiceRate?: number;
    [key: string]: unknown;
}
interface StickerShadowPlan {
    type?: string;
    [key: string]: unknown;
}
type DiagnosticResult = unknown;
declare function logReplyTimingDiagnostic(ctx: DiagnosticsContext, input?: DiagnosticInput): DiagnosticResult;
declare function logAffectRouterDiagnostic(ctx: DiagnosticsContext, input?: DiagnosticInput): DiagnosticResult;
declare function buildAffectRouterDiagnosticForShadow(input?: DiagnosticInput): DiagnosticResult;
declare function logAffectRouterDiagnosticForOutputShadow(ctx: DiagnosticsContext, input?: DiagnosticInput): DiagnosticResult;
declare function logStickerShadowPlan(ctx: DiagnosticsContext, plan: StickerShadowPlan | null | undefined): void;
declare function logStickerShadowIngestDiagnostic(ctx: DiagnosticsContext, input?: DiagnosticInput): DiagnosticResult;
declare function logStickerShadowSendDiagnostic(ctx: DiagnosticsContext, input?: DiagnosticInput): boolean | null;
declare const _default: {
    logReplyTimingDiagnostic: typeof logReplyTimingDiagnostic;
    logAffectRouterDiagnostic: typeof logAffectRouterDiagnostic;
    buildAffectRouterDiagnosticForShadow: typeof buildAffectRouterDiagnosticForShadow;
    logAffectRouterDiagnosticForOutputShadow: typeof logAffectRouterDiagnosticForOutputShadow;
    logStickerShadowPlan: typeof logStickerShadowPlan;
    logStickerShadowIngestDiagnostic: typeof logStickerShadowIngestDiagnostic;
    logStickerShadowSendDiagnostic: typeof logStickerShadowSendDiagnostic;
};
export = _default;
