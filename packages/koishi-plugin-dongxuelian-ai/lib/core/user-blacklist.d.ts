declare function loadUserBlacklist(force?: boolean): Promise<Set<string>>;
declare function setBlacklistFingerprint(value: string): void;
declare const _default: {
    loadUserBlacklist: typeof loadUserBlacklist;
    setBlacklistFingerprint: typeof setBlacklistFingerprint;
};
export = _default;
