export interface ModelTimeBudget {
    deadline: number;
    primaryMs: number;
    fallbackMs: number;
    fallbackReserveMs: number;
}
export interface ModelRequestContext {
    signal: AbortSignal;
    deadline: number;
    assertActive(): void;
    sendWindow(): number;
    modelBudget(): ModelTimeBudget;
    extendTextFallback(): void;
    own<T>(promise: Promise<T>): Promise<T>;
    event(name: string, detail?: Record<string, string | number | boolean | null | undefined>): void;
}
export declare function runWithModelRequestContext<T>(context: ModelRequestContext, fn: () => T): T;
export declare function outsideModelRequestContext<T>(fn: () => T): T;
export declare function currentModelRequestContext(): ModelRequestContext | undefined;
