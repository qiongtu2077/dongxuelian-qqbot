export interface StoreMember {
    userId: string;
    displayName?: string;
    createdBy?: string;
    createdAt?: string;
}
export interface AliasEntry {
    members: StoreMember[];
}
export interface ScopeStore {
    version?: number;
    scopeId?: string;
    aliases: Record<string, AliasEntry>;
    updatedAt?: string;
}
export declare const LEGACY_DATA_FILE: string;
export declare const SCOPE_DATA_DIR: string;
export declare const USE_LEGACY_STORE: boolean;
export declare const DATA_FILE: string;
export declare class StoreAccessError extends Error {
    code: string;
    userMessage: string;
    cause: unknown;
    constructor(userMessage: string, cause: unknown);
}
export declare function createStoreAccessError(userMessage: string, cause: unknown): StoreAccessError;
export declare function safeScopeFileName(scopeId?: string): string;
export declare function ensureStore(): Promise<void>;
export declare function loadScopeStore(scopeIdInput: string): Promise<ScopeStore>;
export declare function persistScopeStore(scopeIdInput: string): Promise<void>;
