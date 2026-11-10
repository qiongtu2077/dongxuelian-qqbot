export interface ParticipationPolicy {
    version: 1;
    privateEnabled: boolean;
    groups: Record<string, boolean>;
}
export interface ParticipationSession {
    event?: {
        channel?: unknown;
    };
    isDirect?: boolean;
    guildId?: string | number;
    channelId?: string | number;
    subtype?: string;
}
export declare const PARTICIPATION_POLICY_FILE: string;
export declare const GROUP_ID_PATTERN: RegExp;
export declare function validateParticipationPolicy(value: unknown): ParticipationPolicy;
export declare function readParticipationPolicy(): ParticipationPolicy;
export declare function isGroupParticipationEnabled(groupId: string | number): boolean;
export declare function isSessionParticipationEnabled(session: ParticipationSession): boolean;
export declare function isOneBotActionAllowed(action: string, params: Record<string, unknown>): boolean;
