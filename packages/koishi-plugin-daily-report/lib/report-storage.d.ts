type DocumentKind = 'snapshot' | 'unit' | 'catalog' | 'ledger';
type SnapshotBodyEncoding = 'snapshot-fragment-text-1' | 'snapshot-fragment-pages-1';
type ReportBodyEncoding = SnapshotBodyEncoding | 'catalog-sections-1' | 'unit-record-fragments-1';
interface StoreOptions {
    taskId: string;
    channelKey: string;
    deadlineMs: number;
    assertActive(): void;
    assertLease(): void;
    now?: () => number;
}
export interface StoredReportDocument {
    id: string;
    kind: DocumentKind;
    createdAtMs: number;
    metadata: unknown;
    records: unknown[];
}
export interface StoredCatalogPageInspection {
    id: string;
    createdAtMs: number;
    metadata: unknown;
    recordCount: number;
    pages: Array<{
        id: string;
        index: number;
        records: unknown[] | null;
    }>;
}
export interface ReportUnitLocatorMetadata {
    version: 'classification-cache-1' | 'classification-cache-2' | 'stage-cache-1';
    requestIdentity: string;
    policyIdentity: string;
    lastRouteIdentity: string;
}
interface ReportUnitLocator {
    id: string;
    createdAtMs: number;
    metadata: ReportUnitLocatorMetadata;
}
export type ReportPreanalysisControlKey = {
    kind: 'anchor';
} | {
    kind: 'day';
    date: string;
};
export interface StoredReportPreanalysisControl {
    identity: string;
    value: unknown;
    createdAtMs: number;
    updatedAtMs: number;
    retainUntilMs: number | null;
}
export declare class ReportStoredDataError extends Error {
    constructor(message: string);
}
export declare function projectReportUnitLocator(metadata: unknown): ReportUnitLocatorMetadata | null;
export declare class PagedReportStore {
    private readonly options;
    readonly taskIdentity: Readonly<{
        taskId: string;
        channelKey: string;
        deadlineMs: number;
    }>;
    private readonly group;
    private readonly groupDir;
    private readonly pinFile;
    private readonly now;
    constructor(options: StoreOptions);
    private assertWritable;
    private objectFile;
    private commitFile;
    private readCommit;
    private nextPin;
    private publish;
    private findSnapshotTextPages;
    private encodeSnapshotBodies;
    private reserve;
    writeTaskArtifact(requestIdentity: string, success: boolean, value: Record<string, unknown>): void;
    currentTimeMs(): number;
    readPreanalysisControl(key: ReportPreanalysisControlKey): StoredReportPreanalysisControl | null;
    listPreanalysisControlKeys(): ReportPreanalysisControlKey[];
    writePreanalysisControl(key: ReportPreanalysisControlKey, expectedIdentity: string | null, value: unknown): StoredReportPreanalysisControl;
    commit(kind: DocumentKind, metadata: unknown, records: readonly unknown[], validate: (metadata: unknown, records: readonly unknown[]) => void, encoding?: ReportBodyEncoding): string;
    list(kind: DocumentKind): {
        candidates: Array<{
            id: string;
            createdAtMs: number;
            metadata: unknown;
        }>;
        invalidIds: string[];
    };
    listUnitLocators(): {
        candidates: ReportUnitLocator[];
        invalidIds: string[];
        publishable: boolean;
    };
    inspectCatalogPages(id: string): StoredCatalogPageInspection | null;
    inspect(id: string, kind: DocumentKind, validate: (metadata: unknown, records: readonly unknown[]) => void): StoredReportDocument | null;
    read(id: string, kind: DocumentKind, validate: (metadata: unknown, records: readonly unknown[]) => void): StoredReportDocument | null;
}
export {};
