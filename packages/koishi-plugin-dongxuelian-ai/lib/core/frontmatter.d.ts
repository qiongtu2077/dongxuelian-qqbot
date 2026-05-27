/**
 * MODULE: Markdown frontmatter parsing.
 * 职责: 解析文件开头连续的 frontmatter block，兼容 LF/CRLF 与中段 BOM。
 * 边界: 不读写文件，不校验 schema。
 */
interface ParseFrontmatterOptions {
    normalizeValue?: (value: string) => string;
    firstWins?: boolean;
}
interface ParsedFrontmatterLines {
    meta: Record<string, string>;
    rawMeta: Record<string, string>;
}
interface ParsedFrontmatterDocument extends ParsedFrontmatterLines {
    body: string;
    hasFrontmatter: boolean;
    frontmatterText: string;
    blocks: string[];
}
declare function normalizeFrontmatterSource(content?: string): string;
declare function parseFrontmatterLines(frontmatterText?: string, options?: ParseFrontmatterOptions): ParsedFrontmatterLines;
declare function parseFrontmatterDocument(content?: string, options?: ParseFrontmatterOptions): ParsedFrontmatterDocument;
declare const _default: {
    normalizeFrontmatterSource: typeof normalizeFrontmatterSource;
    parseFrontmatterLines: typeof parseFrontmatterLines;
    parseFrontmatterDocument: typeof parseFrontmatterDocument;
};
export = _default;
