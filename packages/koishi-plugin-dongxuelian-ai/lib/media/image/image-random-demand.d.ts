interface RandomImageAuthorization {
    token: string;
    expiresAt: number;
}
declare function readRandomImageAuthorization(value: unknown): RandomImageAuthorization | null;
declare function revokeRandomImageDemand(channelKey: string): void;
declare function clearRandomImageDemands(): void;
declare function createRandomImageDemand(channelKey: string, messageId: string, expiresAt: number): RandomImageAuthorization | null;
declare function isRandomImageDemandValid(channelKey: string, messageId: string, value: unknown): boolean;
declare function cleanupRandomImageDemands(): void;
declare const _default: {
    createRandomImageDemand: typeof createRandomImageDemand;
    readRandomImageAuthorization: typeof readRandomImageAuthorization;
    isRandomImageDemandValid: typeof isRandomImageDemandValid;
    revokeRandomImageDemand: typeof revokeRandomImageDemand;
    clearRandomImageDemands: typeof clearRandomImageDemands;
    cleanupRandomImageDemands: typeof cleanupRandomImageDemands;
};
export = _default;
