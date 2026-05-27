/**
 * MODULE: 文件安全检查。
 * 职责: 白名单/黑名单/大小限制/文件名清洗/内容防注入包裹。
 * 边界: 纯函数，不做 IO、不发消息。
 */
interface FileCheckResult {
    allowed: boolean;
    reason?: string;
    category?: string;
    ext: string;
}
declare function getExtension(fileName: unknown): string;
declare function sanitizeFileName(fileName: unknown): string;
declare function checkFile(fileName: unknown, fileSize: unknown): FileCheckResult;
declare function wrapFileContent(fileName: unknown, content: unknown, maxChars?: number): string;
declare function unwrapFileContent(text?: string): {
    fileName: string;
    content: string;
};
declare function summarizeFileContentForChat(text?: string, fallbackName?: string): string;
declare const _default: {
    MAX_FILE_SIZE: number;
    TEXT_EXTENSIONS: Set<string>;
    BINARY_DOC_EXTENSIONS: Set<string>;
    BLOCKED_EXTENSIONS: Set<string>;
    getExtension: typeof getExtension;
    sanitizeFileName: typeof sanitizeFileName;
    checkFile: typeof checkFile;
    wrapFileContent: typeof wrapFileContent;
    unwrapFileContent: typeof unwrapFileContent;
    summarizeFileContentForChat: typeof summarizeFileContentForChat;
};
export = _default;
