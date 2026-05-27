interface PersonaDiagnosticItem {
    level: 'error' | 'warning' | 'info';
    code: string;
    message: string;
    field?: string;
    [key: string]: unknown;
}
interface PersonaDocument {
    type: string;
    file: string;
    schemaVersion?: number;
    hasFrontmatter?: boolean;
    meta: Record<string, unknown>;
    rawMeta?: Record<string, unknown>;
    body?: string;
    diagnostics: PersonaDiagnosticItem[];
    warnings?: PersonaDiagnosticItem[];
}
interface ScanPersonaDocumentsOptions {
    scanDirs?: Array<[string, string]>;
    resolveVoiceSampleFile?: (name: string, voiceAssetId?: unknown) => unknown;
}
interface PersonaDiagnosticSummary {
    totalDocuments: number;
    totals: {
        error: number;
        warning: number;
        info: number;
    };
    byType: Record<string, number>;
}
declare function readPersonaDiagnosticText(file: string): string;
declare function listPersonaDiagnosticFiles(dir: string): string[];
declare function getPersonaDocumentName(doc?: Partial<PersonaDocument>): string;
declare function getDiagnosticLoreRefs(meta?: Record<string, unknown>): string[];
declare function buildPersonaDiagnosticIndexes(documents?: PersonaDocument[]): {
    loreByName: Map<string, PersonaDocument>;
    docsByName: Map<string, PersonaDocument[]>;
};
declare function addCrossDocumentDiagnostics(documents?: PersonaDocument[], options?: ScanPersonaDocumentsOptions): void;
declare function summarizePersonaDiagnostics(documents?: PersonaDocument[]): PersonaDiagnosticSummary;
declare function scanPersonaDocuments(options?: ScanPersonaDocumentsOptions): {
    ok: boolean;
    documents: PersonaDocument[];
    summary: PersonaDiagnosticSummary;
};
declare function formatPersonaDiagnosticReport(result?: {
    documents?: PersonaDocument[];
    summary?: PersonaDiagnosticSummary;
}): string;
declare const _default: {
    PERSONA_DIAGNOSTIC_SCAN_DIRS: readonly (readonly [string, string])[];
    PERSONA_SKILL_FILE_RE: RegExp;
    MAX_PERSONA_DIAGNOSTIC_FILE_BYTES: number;
    readPersonaDiagnosticText: typeof readPersonaDiagnosticText;
    listPersonaDiagnosticFiles: typeof listPersonaDiagnosticFiles;
    getPersonaDocumentName: typeof getPersonaDocumentName;
    getDiagnosticLoreRefs: typeof getDiagnosticLoreRefs;
    buildPersonaDiagnosticIndexes: typeof buildPersonaDiagnosticIndexes;
    addCrossDocumentDiagnostics: typeof addCrossDocumentDiagnostics;
    summarizePersonaDiagnostics: typeof summarizePersonaDiagnostics;
    scanPersonaDocuments: typeof scanPersonaDocuments;
    formatPersonaDiagnosticReport: typeof formatPersonaDiagnosticReport;
};
export = _default;
