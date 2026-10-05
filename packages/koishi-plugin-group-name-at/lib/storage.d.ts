import { ScopeStore } from './scope-schema';
export type { StoreMember, AliasEntry, ScopeStore } from './scope-schema';
export { setAliasEntry } from './scope-schema';
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
