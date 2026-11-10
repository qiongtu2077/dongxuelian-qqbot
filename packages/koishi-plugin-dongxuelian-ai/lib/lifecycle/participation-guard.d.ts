import type { ParticipationSession } from '../core/participation-policy';
export interface GuardBot {
    platform?: string;
    dispatch?: (session: ParticipationSession) => unknown;
    internal?: object | null;
}
interface GuardContext {
    bots?: GuardBot[];
    on(event: 'bot-connect', handler: (bot: GuardBot) => void): unknown;
    on(event: 'dispose', handler: () => void): unknown;
    logger(name: string): {
        warn(message: string): void;
    };
}
export declare class ParticipationDisabledError extends Error {
    readonly code = "PARTICIPATION_DISABLED";
    constructor();
}
export declare function installParticipationGuard(ctx: GuardContext): void;
export {};
