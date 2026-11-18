import type { ModelTimeBudget } from '../core/model-request-context';
export declare const CHAT_TURN_LIMITS: Readonly<{
    normal: 60000;
    record: 180000;
    queue: 45000;
    randomQueue: 20000;
    forward: 10000;
    topic: 8000;
    vision: 90000;
    visionPrimary: 60000;
    visionFallback: 30000;
    textPrimary: 40000;
    textFallback: 30000;
    normalFallbackReserve: 10000;
    recordFallbackReserve: 30000;
    normalSend: 3000;
    recordSend: 5000;
    cleanup: 2000;
}>;
export interface TurnIdentity {
    channelKey: string;
    messageId?: string;
    random?: boolean;
}
export type TurnEvent = Record<string, string | number | boolean | null | undefined>;
export interface TurnStage {
    signal: AbortSignal;
    deadline: number;
    close(): void;
}
export declare class ChatTurnBudget {
    readonly identity: TurnIdentity;
    private readonly log?;
    readonly id: `${string}-${string}-${string}-${string}-${string}`;
    readonly controller: AbortController;
    readonly createdAt: number;
    readonly signal: AbortSignal;
    random: boolean;
    recordImages: boolean;
    preprocessMs: number;
    queuedAt: number | null;
    startedAt: number | null;
    deadline: number;
    reason: string;
    stage: string;
    finished: boolean;
    imagesRead: number;
    forwardUnavailable: boolean;
    imagesTotal: number;
    submittedSends: number;
    pendingSends: number;
    private timer?;
    private validity?;
    private work;
    constructor(identity: TurnIdentity, log?: ((event: TurnEvent) => void) | undefined, validity?: () => boolean);
    select(recordImages: boolean, random?: boolean): void;
    enqueue(validity?: () => boolean): void;
    start(validity?: () => boolean): void;
    remaining(): number;
    assertActive(): void;
    modelBudget(): ModelTimeBudget;
    sendWindow(): number;
    openStage(name: string, maximumMs: number, reserveMs?: number): TurnStage;
    own<T>(promise: Promise<T>): Promise<T>;
    drain(): Promise<void>;
    cancel(reason: string): void;
    finish(): void;
    event(event: string, detail?: TurnEvent): void;
}
export declare function cancelChatTurnStages(): Promise<void>;
export declare function runWithChatTurn<T>(turn: ChatTurnBudget, fn: () => T): T;
export declare function outsideChatTurn<T>(fn: () => T): T;
export declare function currentChatTurn(): ChatTurnBudget | undefined;
export declare function assertChatTurnActive(): void;
export declare function sendWithChatTurn<T>(send: () => T | Promise<T>): Promise<T>;
export declare function delayWithSignal(ms: number, signal?: AbortSignal): Promise<void>;
export declare function waitWithSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T>;
