interface SharedMessageEntry {
    role?: string;
    userId?: string;
    content?: string;
}
declare function calculateRetaliationScore(cleanInput: string, userId: string, channelSharedCache: Map<string, SharedMessageEntry[]>, channelKey: string): Promise<number>;
declare const _default: {
    calculateRetaliationScore: typeof calculateRetaliationScore;
};
export = _default;
