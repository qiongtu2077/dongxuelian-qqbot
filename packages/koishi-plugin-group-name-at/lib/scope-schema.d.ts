/**
 * MODULE: group-name-at bidirectional scope schema.
 * 职责: 维护群内用户与昵称/集合的双向索引，转换旧数据和第二版存储格式。
 * 边界: 不访问文件、不查询 QQ 资料、不发送消息。
 * 状态: 所有索引属于传入的群数据，无模块级缓存。
 */
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
    version: number;
    scopeId: string;
    users: Record<string, string[]>;
    aliases: Record<string, AliasEntry>;
    updatedAt: string;
}
type MemberDetails = Omit<StoreMember, 'userId'>;
interface StoredScope {
    version: number;
    scopeId: string;
    users: Record<string, string[]>;
    aliases: Record<string, string[]>;
    memberDetails: Record<string, Record<string, MemberDetails>>;
    updatedAt: string;
}
export declare const STORE_VERSION = 2;
export declare function setAliasEntry(store: ScopeStore, alias: string, entry: AliasEntry | null): void;
export declare function normalizeScopeStore(scopeId: string, data: unknown): ScopeStore;
export declare function serializeScopeStore(store: ScopeStore): StoredScope;
export {};
