/**
 * MODULE: 人格 schema 解析与校验。
 * 职责: 统一解析 persona/core/mode/lore 文档 frontmatter，输出只读诊断。
 * 边界: 不读写文件、不调用模型、不改变线上人格行为。
 * 状态: 无。
 */
interface PersonaMeta {
    schema?: unknown;
    name?: unknown;
    will?: unknown;
    nsfw?: unknown;
    hostile_capable?: unknown;
    voice_asset_id?: unknown;
    voice_id?: unknown;
    voice?: unknown;
    [key: string]: unknown;
}
interface PersonaSchemaContext {
    type?: string;
    hasFrontmatter?: boolean;
    file?: string;
}
interface PersonaFrontmatterDocument {
    meta: PersonaMeta;
    rawMeta: Record<string, string>;
    body: string;
    hasFrontmatter: boolean;
    frontmatterText: string;
    blocks: string[];
}
type PersonaDiagnosticLevel = 'error' | 'warning' | 'info';
interface PersonaDiagnostic {
    level: PersonaDiagnosticLevel;
    code: string;
    message: string;
    [key: string]: unknown;
}
declare function normalizePersonaSchemaScalar(value?: unknown): string | boolean | null;
declare function parsePersonaSchemaFrontmatter(content?: string): PersonaFrontmatterDocument;
declare function stripPersonaFrontmatter(content?: string): string;
declare function createPersonaDiagnostic(level: PersonaDiagnosticLevel, code: string, message: string, details?: Record<string, unknown>): PersonaDiagnostic;
declare function parsePersonaNumber(value: unknown): number;
declare function parsePersonaStringList(value: unknown): string[];
declare function getPersonaSchemaKnownFields(): string[];
declare function validatePersonaMeta(meta?: PersonaMeta, context?: PersonaSchemaContext): PersonaDiagnostic[];
declare function parsePersonaDocument(content?: string, context?: PersonaSchemaContext): {
    type: string;
    file: string;
    schemaVersion: number;
    hasFrontmatter: boolean;
    frontmatterText: string;
    meta: PersonaMeta;
    rawMeta: Record<string, string>;
    body: string;
    diagnostics: PersonaDiagnostic[];
    warnings: PersonaDiagnostic[];
};
declare const _default: {
    PERSONA_SCHEMA_VERSION: number;
    PERSONA_SCHEMA_KNOWN_FIELDS: readonly string[];
    PERSONA_SCHEMA_ALLOWED_TYPES: readonly string[];
    PERSONA_SCHEMA_WILL_MIN: number;
    PERSONA_SCHEMA_WILL_MAX: number;
    normalizePersonaSchemaScalar: typeof normalizePersonaSchemaScalar;
    parsePersonaSchemaFrontmatter: typeof parsePersonaSchemaFrontmatter;
    stripPersonaFrontmatter: typeof stripPersonaFrontmatter;
    createPersonaDiagnostic: typeof createPersonaDiagnostic;
    parsePersonaNumber: typeof parsePersonaNumber;
    parsePersonaStringList: typeof parsePersonaStringList;
    getPersonaSchemaKnownFields: typeof getPersonaSchemaKnownFields;
    validatePersonaMeta: typeof validatePersonaMeta;
    parsePersonaDocument: typeof parsePersonaDocument;
};
export = _default;
